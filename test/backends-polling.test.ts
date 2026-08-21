import { describe, expect, it } from "vitest";
import { BackendRegistry, retryDelayMs, type FetchText } from "../src/backends.js";

const METRICS = [
  'vllm:kv_cache_usage_perc{engine="0"} 0.42',
  "vllm:num_requests_running 3",
  "vllm:num_requests_waiting 1"
].join("\n");

/** Fake transport driven by a per-URL queue of outcomes: "ok" | "metrics" | "fail". */
function fakeTransport(plan: Record<string, Array<"metrics" | "health" | "fail">>) {
  const calls: string[] = [];
  const fetchText: FetchText = async (url) => {
    calls.push(url);
    const path = new URL(url).pathname;
    const next = plan[path]?.shift() ?? "fail";
    if (next === "fail") throw new Error(`simulated timeout on ${path}`);
    return { status: 200, body: next === "metrics" ? METRICS : '{"status":"ok"}' };
  };
  return { fetchText, calls };
}

function registry(fetchText: FetchText, sleeps: number[], opts: Record<string, unknown> = {}) {
  return new BackendRegistry(
    [{ name: "b0", url: "http://b0:8000", capacityTokens: 10000 }],
    1000,
    {
      fetchText,
      retries: 2,
      backoffMs: 100,
      jitterMs: 50,
      failureThreshold: 3,
      random: () => 0.5, // deterministic jitter: +25ms
      sleep: async (ms) => { sleeps.push(ms); },
      ...opts
    }
  );
}

describe("metric polling resilience", () => {
  it("retries a timed-out /metrics fetch with exponential backoff + jitter and recovers within one poll", async () => {
    const t = fakeTransport({ "/metrics": ["fail", "fail", "metrics"] });
    const sleeps: number[] = [];
    const r = registry(t.fetchText, sleeps);

    await r.poll();

    const b = r.backends[0];
    expect(t.calls.filter((u) => u.endsWith("/metrics"))).toHaveLength(3);
    expect(t.calls.some((u) => u.endsWith("/health"))).toBe(false); // never needed the fallback
    expect(sleeps).toEqual([125, 225]); // 100·2^0 + 25, 100·2^1 + 25
    expect(b.healthy).toBe(true);
    expect(b.kvCacheUsage).toBeCloseTo(0.42);
    expect(b.runningRequests).toBe(3);
    expect(b.consecutiveFailures).toBe(0);
  });

  it("keeps last-known KV usage and stays routable when only /metrics is down but /health answers", async () => {
    const t = fakeTransport({ "/metrics": ["metrics", "fail", "fail", "fail"], "/health": ["health"] });
    const r = registry(t.fetchText, []);

    await r.poll(); // healthy poll establishes kv=0.42
    await r.poll(); // metrics exhausted, health ok

    const b = r.backends[0];
    expect(b.healthy).toBe(true);
    expect(b.kvCacheUsage).toBeCloseTo(0.42); // NOT reset to 0 — that would over-admit
    expect(b.consecutiveFailures).toBe(0);
  });

  it("treats a single fully-failed poll cycle as jitter, not an outage", async () => {
    const t = fakeTransport({ "/metrics": ["metrics"] }); // everything after the first poll fails
    const r = registry(t.fetchText, []);

    await r.poll();
    await r.poll(); // metrics ×3 fail, health ×3 fail → 1 consecutive failure

    const b = r.backends[0];
    expect(b.consecutiveFailures).toBe(1);
    expect(b.healthy).toBe(true);
    expect(b.kvCacheUsage).toBeCloseTo(0.42);
  });

  it("marks the backend unhealthy only after the consecutive-failure threshold, and recovers on the next good poll", async () => {
    const t = fakeTransport({ "/metrics": ["metrics", "fail", "fail", "fail", "fail", "fail", "fail", "fail", "fail", "fail", "metrics"] });
    const r = registry(t.fetchText, []);

    await r.poll(); // ok
    await r.poll(); // failure 1
    await r.poll(); // failure 2
    expect(r.backends[0].healthy).toBe(true);
    await r.poll(); // failure 3 → threshold reached
    expect(r.backends[0].healthy).toBe(false);
    expect(r.backends[0].consecutiveFailures).toBe(3);

    await r.poll(); // metrics back
    expect(r.backends[0].healthy).toBe(true);
    expect(r.backends[0].consecutiveFailures).toBe(0);
  });

  it("gives up after the configured retries without throwing out of the poll loop", async () => {
    const t = fakeTransport({});
    const sleeps: number[] = [];
    const r = registry(t.fetchText, sleeps, { retries: 1 });

    await expect(r.poll()).resolves.toBeUndefined();
    // 2 attempts for /metrics + 2 for /health, one backoff sleep each
    expect(t.calls).toHaveLength(4);
    expect(sleeps).toEqual([125, 125]);
  });
});

describe("retryDelayMs", () => {
  it("grows exponentially and adds bounded random jitter", () => {
    expect(retryDelayMs(1, 100, 100, () => 0)).toBe(100);
    expect(retryDelayMs(2, 100, 100, () => 0)).toBe(200);
    expect(retryDelayMs(3, 100, 100, () => 0)).toBe(400);
    expect(retryDelayMs(1, 100, 100, () => 0.999)).toBe(199);
  });

  it("de-synchronises workers: identical attempts get different delays under different randomness", () => {
    const a = retryDelayMs(1, 100, 100, () => 0.1);
    const b = retryDelayMs(1, 100, 100, () => 0.9);
    expect(a).not.toBe(b);
    expect(Math.abs(a - b)).toBeLessThan(100);
  });
});
