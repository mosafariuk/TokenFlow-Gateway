import { describe, expect, it } from "vitest";
import { orderCandidates } from "../src/balancer.js";
import { backendBudget, parseVllmMetrics, type BackendState } from "../src/backends.js";

function backend(name: string, kvCacheUsage: number, opts: Partial<BackendState> = {}): BackendState {
  return {
    name,
    url: `http://${name}`,
    capacityTokens: 10000,
    healthy: true,
    kvCacheUsage,
    runningRequests: 0,
    waitingRequests: 0,
    lastPolledAt: 0,
    ...opts
  };
}

const HEAVY = 2048;
const noPending = new Map<string, number>();

describe("orderCandidates", () => {
  it("orders heavy prompts toward the backend with the most free capacity", () => {
    const busy = backend("busy", 0.8); // 2000 budget
    const free = backend("free", 0.1); // 9000 budget
    expect(orderCandidates([busy, free], 3000, HEAVY, noPending).map((b) => b.name)).toEqual(["free"]);
  });

  it("orders light prompts toward the busiest backend that still fits", () => {
    const busy = backend("busy", 0.8);
    const free = backend("free", 0.1);
    expect(orderCandidates([busy, free], 100, HEAVY, noPending).map((b) => b.name)).toEqual(["busy", "free"]);
  });

  it("excludes backends that cannot fit the request", () => {
    const full = backend("full", 0.99); // 100 budget
    const free = backend("free", 0.1);
    expect(orderCandidates([full, free], 500, HEAVY, noPending).map((b) => b.name)).toEqual(["free"]);
  });

  it("returns empty when nothing fits", () => {
    const a = backend("a", 0.95);
    const b = backend("b", 0.9);
    expect(orderCandidates([a, b], 5000, HEAVY, noPending)).toEqual([]);
  });

  it("excludes unhealthy backends", () => {
    const down = backend("down", 0, { healthy: false });
    const up = backend("up", 0.5);
    expect(orderCandidates([down, up], 100, HEAVY, noPending).map((b) => b.name)).toEqual(["up"]);
  });

  it("accounts for shared pending reservations in ordering and fit", () => {
    const a = backend("a", 0); // 10000 budget
    const b = backend("b", 0.5); // 5000 budget
    const pending = new Map([["a", 9800]]); // a: 200 effective free
    expect(orderCandidates([a, b], 1000, HEAVY, pending).map((x) => x.name)).toEqual(["b"]);
    // light request that fits both: the more loaded (a) comes first
    expect(orderCandidates([a, b], 100, HEAVY, pending).map((x) => x.name)).toEqual(["a", "b"]);
  });

  it("orders heavy requests most-free-first across multiple fits", () => {
    const a = backend("a", 0.3); // 7000
    const b = backend("b", 0.1); // 9000
    const c = backend("c", 0.5); // 5000
    expect(orderCandidates([a, b, c], 4000, HEAVY, noPending).map((x) => x.name)).toEqual(["b", "a", "c"]);
  });
});

describe("backendBudget", () => {
  it("scales capacity by free KV fraction and never goes negative", () => {
    expect(backendBudget(backend("x", 0.25))).toBe(7500);
    expect(backendBudget(backend("x", 1))).toBe(0);
  });
});

describe("parseVllmMetrics", () => {
  it("extracts kv cache usage and request gauges", () => {
    const text = [
      "# HELP vllm:gpu_cache_usage_perc GPU KV-cache usage",
      'vllm:gpu_cache_usage_perc{model_name="m"} 0.42',
      "vllm:num_requests_running 3",
      "vllm:num_requests_waiting 7",
      "unrelated_metric 99"
    ].join("\n");
    const m = parseVllmMetrics(text);
    expect(m.kvCacheUsage).toBeCloseTo(0.42);
    expect(m.runningRequests).toBe(3);
    expect(m.waitingRequests).toBe(7);
  });

  it("returns empty object for garbage input", () => {
    expect(parseVllmMetrics("not metrics at all")).toEqual({});
  });
});

describe("parseVllmMetrics — modern vLLM (0.27+) metric names", () => {
  it("reads the renamed kv_cache_usage_perc gauge with engine/model labels", () => {
    const text = [
      'vllm:num_requests_running{engine="0",model_name="microsoft/Phi-3-mini-4k-instruct"} 2.0',
      'vllm:num_requests_waiting{engine="0",model_name="microsoft/Phi-3-mini-4k-instruct"} 5.0',
      'vllm:num_requests_waiting_by_reason{engine="0",model_name="m",reason="capacity"} 5.0',
      'vllm:kv_cache_usage_perc{engine="0",model_name="microsoft/Phi-3-mini-4k-instruct"} 0.3125'
    ].join("\n");
    const m = parseVllmMetrics(text);
    expect(m.kvCacheUsage).toBeCloseTo(0.3125);
    expect(m.runningRequests).toBe(2);
    expect(m.waitingRequests).toBe(5);
  });
});
