import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { config } from "./config.js";
import { BackendRegistry } from "./backends.js";
import { AdmissionQueue } from "./queue.js";
import { RateLimiter } from "./ratelimit.js";
import { ResponseCache } from "./cache.js";
import { ReservationManager } from "./reservations.js";
import { registerProxyRoutes } from "./routes/proxy.js";
import { registerAdminRoutes } from "./routes/admin.js";

export interface GatewayContext {
  registry: BackendRegistry;
  queue: AdmissionQueue;
  rateLimiter: RateLimiter;
  cache: ResponseCache;
  reservations: ReservationManager;
}

export function buildServer(redis: Redis): { app: FastifyInstance; ctx: GatewayContext } {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 32 * 1024 * 1024 // large prompts are the whole point
  });

  const ctx: GatewayContext = {
    registry: new BackendRegistry(config.backends, config.backendPollIntervalMs),
    queue: new AdmissionQueue(redis),
    rateLimiter: new RateLimiter(redis),
    cache: new ResponseCache(redis),
    reservations: new ReservationManager(redis)
  };

  app.get("/healthz", async () => ({
    status: "ok",
    backends: ctx.registry.backends.map((b) => ({ name: b.name, healthy: b.healthy }))
  }));

  registerProxyRoutes(app, ctx);
  registerAdminRoutes(app, ctx);

  return { app, ctx };
}
