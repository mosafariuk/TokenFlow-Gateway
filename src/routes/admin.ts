import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { pool } from "../db.js";
import { generateApiKey, invalidateAuthCache } from "../auth.js";
import { backendBudget } from "../backends.js";
import type { GatewayContext } from "../server.js";

function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!config.adminToken || token !== config.adminToken) {
    reply.code(401).send({ error: "invalid admin token" });
    return false;
  }
  return true;
}

export function registerAdminRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  // Create an API key. The plaintext key is returned exactly once.
  app.post("/admin/keys", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = (req.body ?? {}) as {
      name?: string; tpm_limit?: number; rpm_limit?: number; priority?: number;
    };
    if (!body.name) return reply.code(400).send({ error: "name is required" });

    const { key, keyHash, keyPrefix } = generateApiKey();
    const res = await pool.query(
      `INSERT INTO api_keys (name, key_hash, key_prefix, tpm_limit, rpm_limit, priority)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, name, key_prefix, tpm_limit, rpm_limit, priority, created_at`,
      [body.name, keyHash, keyPrefix, body.tpm_limit ?? 100000, body.rpm_limit ?? 300, body.priority ?? 5]
    );
    reply.code(201).send({ ...res.rows[0], key });
  });

  app.get("/admin/keys", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const res = await pool.query(
      `SELECT id, name, key_prefix, tpm_limit, rpm_limit, priority, active, created_at
         FROM api_keys ORDER BY created_at DESC`
    );
    reply.send(res.rows);
  });

  app.patch("/admin/keys/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      tpm_limit?: number; rpm_limit?: number; priority?: number; active?: boolean;
    };
    const res = await pool.query(
      `UPDATE api_keys SET
         tpm_limit = COALESCE($2, tpm_limit),
         rpm_limit = COALESCE($3, rpm_limit),
         priority  = COALESCE($4, priority),
         active    = COALESCE($5, active)
       WHERE id = $1
       RETURNING id, name, key_prefix, tpm_limit, rpm_limit, priority, active`,
      [id, body.tpm_limit ?? null, body.rpm_limit ?? null, body.priority ?? null, body.active ?? null]
    );
    if (res.rowCount === 0) return reply.code(404).send({ error: "key not found" });
    invalidateAuthCache();
    reply.send(res.rows[0]);
  });

  app.delete("/admin/keys/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const res = await pool.query(`UPDATE api_keys SET active = FALSE WHERE id = $1`, [id]);
    if (res.rowCount === 0) return reply.code(404).send({ error: "key not found" });
    invalidateAuthCache();
    reply.code(204).send();
  });

  // Aggregated usage per key over the last 24h.
  app.get("/admin/usage", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const res = await pool.query(`
      SELECT k.id, k.name,
             COUNT(l.id)::int AS requests,
             COALESCE(SUM(l.prompt_tokens), 0)::bigint AS prompt_tokens,
             COALESCE(SUM(l.completion_tokens), 0)::bigint AS completion_tokens,
             COUNT(l.id) FILTER (WHERE l.cache_hit <> 'none')::int AS cache_hits,
             COALESCE(AVG(l.latency_ms), 0)::int AS avg_latency_ms,
             COALESCE(AVG(l.queued_ms), 0)::int AS avg_queued_ms
        FROM api_keys k
        LEFT JOIN request_logs l
          ON l.api_key_id = k.id AND l.created_at > now() - interval '24 hours'
       GROUP BY k.id, k.name
       ORDER BY requests DESC
    `);
    reply.send(res.rows);
  });

  // Live view of backend pool + queue for operators.
  app.get("/admin/status", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const pending = await ctx.reservations.pendingFor(ctx.registry.backends);
    reply.send({
      queueDepth: await ctx.queue.depth(),
      backends: ctx.registry.backends.map((b) => {
        const pendingTokens = pending.get(b.name) ?? 0;
        return {
          name: b.name,
          url: b.url,
          healthy: b.healthy,
          kvCacheUsage: b.kvCacheUsage,
          runningRequests: b.runningRequests,
          waitingRequests: b.waitingRequests,
          pendingTokens,
          freeTokens: Math.max(0, backendBudget(b) - pendingTokens),
          capacityTokens: b.capacityTokens
        };
      })
    });
  });
}
