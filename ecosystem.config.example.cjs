// PM2 production config — copy to ecosystem.config.cjs and edit.
// Admission control, queueing, and rate limits are Redis-coordinated, so
// cluster mode is safe: all workers share one capacity ledger.
module.exports = {
  apps: [
    {
      name: "tokenflow",
      script: "dist/index.js",
      exec_mode: "cluster",
      instances: "max", // one worker per hardware thread
      env: {
        NODE_ENV: "production",
        PORT: 8080,
        HOST: "0.0.0.0",
        LOG_LEVEL: "info",
        ADMIN_TOKEN: "REPLACE-WITH-LONG-RANDOM-SECRET",
        REDIS_URL: "redis://127.0.0.1:6379",
        DATABASE_URL: "postgres://tokenflow:tokenflow@127.0.0.1:5432/tokenflow",
        BACKENDS: JSON.stringify([
          { name: "vllm-0", url: "http://10.0.0.10:8000", capacityTokens: 262144 },
          { name: "vllm-1", url: "http://10.0.0.11:8000", capacityTokens: 262144 }
        ]),
        CACHE_ENABLED: "true",
        SEMANTIC_CACHE_ENABLED: "false"
      }
    }
  ]
};
