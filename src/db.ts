import pg from "pg";
import { config } from "./config.js";
import type { ApiKeyRecord } from "./types.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      tpm_limit INTEGER NOT NULL DEFAULT 100000,
      rpm_limit INTEGER NOT NULL DEFAULT 300,
      priority INTEGER NOT NULL DEFAULT 5,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS request_logs (
      id BIGSERIAL PRIMARY KEY,
      api_key_id UUID REFERENCES api_keys(id),
      model TEXT,
      backend TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      queued_ms INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER,
      cache_hit TEXT NOT NULL DEFAULT 'none',
      status INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS request_logs_key_time_idx
      ON request_logs (api_key_id, created_at);
  `);

  if (config.semanticCacheEnabled) {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS semantic_cache (
        id BIGSERIAL PRIMARY KEY,
        model TEXT NOT NULL,
        request_hash TEXT NOT NULL UNIQUE,
        embedding vector(${config.embeddingDim}) NOT NULL,
        response JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }
}

export async function findApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null> {
  const res = await pool.query(
    `SELECT id, name, tpm_limit, rpm_limit, priority
       FROM api_keys WHERE key_hash = $1 AND active`,
    [keyHash]
  );
  if (res.rowCount === 0) return null;
  const r = res.rows[0];
  return {
    id: r.id,
    name: r.name,
    tpmLimit: r.tpm_limit,
    rpmLimit: r.rpm_limit,
    priority: r.priority
  };
}

export interface RequestLogEntry {
  apiKeyId: string;
  model: string | null;
  backend: string | null;
  promptTokens: number;
  completionTokens: number;
  queuedMs: number;
  latencyMs: number;
  cacheHit: string;
  status: number;
}

export async function logRequest(e: RequestLogEntry): Promise<void> {
  await pool.query(
    `INSERT INTO request_logs
       (api_key_id, model, backend, prompt_tokens, completion_tokens, queued_ms, latency_ms, cache_hit, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [e.apiKeyId, e.model, e.backend, e.promptTokens, e.completionTokens, e.queuedMs, e.latencyMs, e.cacheHit, e.status]
  );
}
