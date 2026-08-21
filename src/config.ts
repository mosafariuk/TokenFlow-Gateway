export interface BackendConfig {
  name: string;
  url: string;
  capacityTokens: number;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for env ${name}: ${v}`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "true" || v === "1";
}

function parseBackends(raw: string | undefined): BackendConfig[] {
  if (!raw) {
    return [{ name: "vllm-0", url: "http://localhost:8001", capacityTokens: 32768 }];
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("BACKENDS must be a non-empty JSON array");
  }
  return parsed.map((b, i) => {
    if (!b.url) throw new Error(`BACKENDS[${i}] is missing "url"`);
    return {
      name: b.name ?? `backend-${i}`,
      url: String(b.url).replace(/\/$/, ""),
      capacityTokens: Number(b.capacityTokens ?? 32768)
    };
  });
}

export const config = {
  port: num("PORT", 8080),
  host: process.env.HOST ?? "0.0.0.0",
  logLevel: process.env.LOG_LEVEL ?? "info",

  adminToken: process.env.ADMIN_TOKEN ?? "",

  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  databaseUrl: process.env.DATABASE_URL ?? "postgres://tokenflow:tokenflow@localhost:5432/tokenflow",

  backends: parseBackends(process.env.BACKENDS),
  backendPollIntervalMs: num("BACKEND_POLL_INTERVAL_MS", 1000),
  backendPollRetries: num("BACKEND_POLL_RETRIES", 2),
  backendPollBackoffMs: num("BACKEND_POLL_BACKOFF_MS", 100),
  backendPollJitterMs: num("BACKEND_POLL_JITTER_MS", 100),
  backendPollTimeoutMs: num("BACKEND_POLL_TIMEOUT_MS", 2000),
  backendFailureThreshold: num("BACKEND_FAILURE_THRESHOLD", 3),

  heavyPromptThreshold: num("HEAVY_PROMPT_THRESHOLD", 2048),
  defaultMaxTokens: num("DEFAULT_MAX_TOKENS", 1024),
  queueTimeoutMs: num("QUEUE_TIMEOUT_MS", 30000),
  reservationTtlSeconds: num("RESERVATION_TTL_SECONDS", 120),

  cacheEnabled: bool("CACHE_ENABLED", true),
  cacheMaxTemperature: num("CACHE_MAX_TEMPERATURE", 0),
  cacheTtlSeconds: num("CACHE_TTL_SECONDS", 3600),

  semanticCacheEnabled: bool("SEMANTIC_CACHE_ENABLED", false),
  embeddingUrl: (process.env.EMBEDDING_URL ?? "").replace(/\/$/, ""),
  embeddingModel: process.env.EMBEDDING_MODEL ?? "mock-embed",
  embeddingDim: num("EMBEDDING_DIM", 384),
  semanticDistanceThreshold: num("SEMANTIC_DISTANCE_THRESHOLD", 0.05)
};

export type Config = typeof config;
