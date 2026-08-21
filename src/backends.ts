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

export class BackendRegistry {
  readonly backends: BackendState[];
  private timer?: NodeJS.Timeout;

  constructor(configs: BackendConfig[], private pollIntervalMs: number) {
    this.backends = configs.map((c) => ({
      name: c.name,
      url: c.url,
      capacityTokens: c.capacityTokens,
      healthy: true,
      kvCacheUsage: 0,
      runningRequests: 0,
      waitingRequests: 0,
      lastPolledAt: 0
    }));
  }

  start(): void {
    void this.pollAll();
    this.timer = setInterval(() => void this.pollAll(), this.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async pollAll(): Promise<void> {
    await Promise.all(this.backends.map((b) => this.pollOne(b)));
  }

  private async pollOne(b: BackendState): Promise<void> {
    try {
      const res = await request(`${b.url}/metrics`, {
        headersTimeout: 2000,
        bodyTimeout: 2000
      });
      if (res.statusCode !== 200) throw new Error(`metrics status ${res.statusCode}`);
      const body = await res.body.text();
      const m = parseVllmMetrics(body);
      if (m.kvCacheUsage !== undefined) b.kvCacheUsage = Math.min(1, Math.max(0, m.kvCacheUsage));
      if (m.runningRequests !== undefined) b.runningRequests = m.runningRequests;
      if (m.waitingRequests !== undefined) b.waitingRequests = m.waitingRequests;
      b.healthy = true;
      b.lastPolledAt = Date.now();
    } catch {
      // Metrics endpoint down ≠ backend down; fall back to /health.
      try {
        const res = await request(`${b.url}/health`, { headersTimeout: 2000, bodyTimeout: 2000 });
        b.healthy = res.statusCode === 200;
        await res.body.dump();
      } catch {
        b.healthy = false;
      }
      b.lastPolledAt = Date.now();
    }
  }
}
