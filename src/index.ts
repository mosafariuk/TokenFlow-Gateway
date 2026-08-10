import { config } from "./config.js";
import { createRedis } from "./redis.js";
import { migrate, pool } from "./db.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  await migrate();

  const redis = createRedis();
  const { app, ctx } = buildServer(redis);
  ctx.registry.start();

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { backends: config.backends.map((b) => b.name) },
    "tokenflow-gateway listening"
  );

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    ctx.registry.stop();
    await app.close();
    redis.disconnect();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
