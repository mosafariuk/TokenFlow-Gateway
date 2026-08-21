import { request } from "undici";
import type { BackendConfig } from "./config.js";

export interface BackendState {
  name: string;
  url: string;
  capacityTokens: number;
  healthy: boolean;
  /** 0..1 fraction of KV cache in use, from vLLM metrics (or estimated) */
  kvCacheUsage: number;
  runningRequests: number;
  waitingRequests: number;
  lastPolledAt: number;
  /** Consecutive poll cycles in which neither /metrics nor /health answered. */
  consecutiveFailures: number;
}

/**
 * Token budget this backend can still accept, per its latest metrics.
 * Shared pending reservations (Redis) are charged against this budget
 * atomically at admission time — see ReservationManager.
 */
export function backendBudget(b: BackendState): number {
  return Math.max(0, Math.floor(b.capacityTokens * (1 - b.kvCacheUsage)));
}

/** Parse the vLLM Prometheus metrics we care about. */
export function parseVllmMetrics(text: string): {
  kvCacheUsage?: number;
  runningRequests?: number;
  waitingRequests?: number;
} {
  const out: ReturnType<typeof parseVllmMetrics> = {};
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) continue;
    const sp = line.lastIndexOf(" ");
    if (sp === -1) continue;
    const name = line.slice(0, sp);
    const value = Number(line.slice(sp + 1));
    if (!Number.isFinite(value)) continue;
    // vLLM renamed this gauge (gpu_cache_usage_perc → kv_cache_usage_perc in 0.2x); accept both.
    if (name.startsWith("vllm:kv_cache_usage_perc") || name.startsWith("vllm:gpu_cache_usage_perc")) {
      out.kvCacheUsage = value;
    }
    else if (name.startsWith("vllm:num_requests_running")) out.runningRequests = value;
    else if (name.startsWith("vllm:num_requests_waiting")) out.waitingRequests = value;
  }
  return out;
}

/** Minimal HTTP transport, injectable so polling behaviour is unit-testable. */
export type FetchText = (url: string, timeoutMs: number) => Promise<{ status: number; body: string }>;

export const undiciFetchText: FetchText = async (url, timeoutMs) => {
  const res = await request(url, { headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  return { status: res.statusCode, body: await res.body.text() };
};

export interface PollingOptions {
  /** Extra attempts per poll cycle after the first failure (default 2 → 3 attempts). */
  retries?: number;
  /** Base backoff between attempts; grows ×2 per attempt, plus up to `jitterMs` random. */
  backoffMs?: number;
  jitterMs?: number;
  /** Per-request timeout for /metrics and /health. */
  requestTimeoutMs?: number;
  /** Consecutive fully-failed poll cycles before the backend is marked unhealthy. */
  failureThreshold?: number;
  fetchText?: FetchText;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * Compute the delay before retry attempt `attempt` (1-based): exponential
 * backoff with random jitter so N gateway workers polling the same backend
 * don't retry in lockstep and amplify a transient stall.
 */
export function retryDelayMs(attempt: number, backoffMs: number, jitterMs: number, random: () => number): number {
  return backoffMs * 2 ** (attempt - 1) + Math.floor(random() * jitterMs);
}

export class BackendRegistry {
  readonly backends: BackendState[];
  private timer?: NodeJS.Timeout;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly jitterMs: number;
  private readonly requestTimeoutMs: number;
  private readonly failureThreshold: number;
  private readonly fetchText: FetchText;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(configs: BackendConfig[], private pollIntervalMs: number, opts: PollingOptions = {}) {
    this.retries = opts.retries ?? 2;
    this.backoffMs = opts.backoffMs ?? 100;
    this.jitterMs = opts.jitterMs ?? 100;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 2000;
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.fetchText = opts.fetchText ?? undiciFetchText;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.backends = configs.map((c) => ({
      name: c.name,
      url: c.url,
      capacityTokens: c.capacityTokens,
      healthy: true,
      kvCacheUsage: 0,
      runningRequests: 0,
      waitingRequests: 0,
      lastPolledAt: 0,
      consecutiveFailures: 0
    }));
  }

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One poll cycle across all backends. Public so it can be driven from tests. */
  async poll(): Promise<void> {
    await Promise.all(this.backends.map((b) => this.pollOne(b)));
  }

  private async pollOne(b: BackendState): Promise<void> {
    const metrics = await this.withRetry(() => this.fetchText(`${b.url}/metrics`, this.requestTimeoutMs));
    b.lastPolledAt = Date.now();

    if (metrics && metrics.status === 200) {
      const m = parseVllmMetrics(metrics.body);
      if (m.kvCacheUsage !== undefined) b.kvCacheUsage = Math.min(1, Math.max(0, m.kvCacheUsage));
      if (m.runningRequests !== undefined) b.runningRequests = m.runningRequests;
      if (m.waitingRequests !== undefined) b.waitingRequests = m.waitingRequests;
      b.healthy = true;
      b.consecutiveFailures = 0;
      return;
    }

    // Metrics unavailable ≠ backend down: a plain /health answer keeps it routable
    // on its last-known KV usage (never reset to 0 — that would over-admit).
    const health = await this.withRetry(() => this.fetchText(`${b.url}/health`, this.requestTimeoutMs));
    if (health && health.status === 200) {
      b.healthy = true;
      b.consecutiveFailures = 0;
      return;
    }

    // Both endpoints failed this cycle. Only a sustained outage removes the
    // backend from routing; a single timed-out cycle is treated as jitter.
    b.consecutiveFailures += 1;
    if (b.consecutiveFailures >= this.failureThreshold) b.healthy = false;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T | null> {
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await fn();
      } catch {
        if (attempt === this.retries) return null;
        await this.sleep(retryDelayMs(attempt + 1, this.backoffMs, this.jitterMs, this.random));
      }
    }
    return null;
  }
}
