import { createHash } from "node:crypto";
import { request } from "undici";
import type { Redis } from "ioredis";
import { config } from "./config.js";
import { pool } from "./db.js";
import type { CompletionRequest } from "./types.js";

/**
 * A request is cacheable only when sampling is (near-)deterministic —
 * caching a temperature-1 creative completion would pin one sample forever.
 */
export function isCacheable(body: CompletionRequest): boolean {
  if (!config.cacheEnabled) return false;
  const temperature = typeof body.temperature === "number" ? body.temperature : 1;
  return temperature <= config.cacheMaxTemperature;
}

/** Canonical text of the prompt, used for both hashing and embeddings. */
export function promptText(body: CompletionRequest): string {
  if (body.messages) {
    return body.messages
      .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
      .join("\n");
  }
  return Array.isArray(body.prompt) ? body.prompt.join("\n") : (body.prompt ?? "");
}

export function cacheKey(body: CompletionRequest): string {
  const material = JSON.stringify({
    model: body.model,
    prompt: promptText(body),
    max_tokens: body.max_tokens ?? null,
    temperature: body.temperature ?? null
  });
  return createHash("sha256").update(material).digest("hex");
}

export class ResponseCache {
  constructor(private redis: Redis) {}

  async getExact(key: string): Promise<unknown | null> {
    const raw = await this.redis.get(`cache:exact:${key}`);
    return raw ? JSON.parse(raw) : null;
  }

  async setExact(key: string, response: unknown): Promise<void> {
    await this.redis.set(`cache:exact:${key}`, JSON.stringify(response), "EX", config.cacheTtlSeconds);
  }

  async getSemantic(body: CompletionRequest): Promise<unknown | null> {
    if (!config.semanticCacheEnabled) return null;
    const embedding = await embed(promptText(body));
    if (!embedding) return null;
    const res = await pool.query(
      `SELECT response, embedding <=> $1::vector AS distance
         FROM semantic_cache
        WHERE model = $2
        ORDER BY embedding <=> $1::vector
        LIMIT 1`,
      [toVectorLiteral(embedding), body.model]
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return Number(row.distance) <= config.semanticDistanceThreshold ? row.response : null;
  }

  async setSemantic(key: string, body: CompletionRequest, response: unknown): Promise<void> {
    if (!config.semanticCacheEnabled) return;
    const embedding = await embed(promptText(body));
    if (!embedding) return;
    await pool.query(
      `INSERT INTO semantic_cache (model, request_hash, embedding, response)
       VALUES ($1, $2, $3::vector, $4)
       ON CONFLICT (request_hash) DO NOTHING`,
      [body.model, key, toVectorLiteral(embedding), JSON.stringify(response)]
    );
  }
}

function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

async function embed(text: string): Promise<number[] | null> {
  if (!config.embeddingUrl) return null;
  try {
    const res = await request(`${config.embeddingUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: config.embeddingModel, input: text }),
      headersTimeout: 5000,
      bodyTimeout: 5000
    });
    if (res.statusCode !== 200) {
      await res.body.dump();
      return null;
    }
    const data = (await res.body.json()) as { data?: Array<{ embedding: number[] }> };
    const embedding = data.data?.[0]?.embedding;
    return Array.isArray(embedding) && embedding.length === config.embeddingDim ? embedding : null;
  } catch {
    // Embedding service being down must never break the request path.
    return null;
  }
}
