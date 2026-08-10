import { Redis } from "ioredis";
import { config } from "./config.js";

export function createRedis(): Redis {
  const redis = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true
  });

  // Token bucket: refill at `rate` tokens/sec up to `burst`, spend `cost` if available.
  redis.defineCommand("tokenBucket", {
    numberOfKeys: 1,
    lua: `
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = burst end
if ts == nil then ts = now end
tokens = math.min(burst, tokens + math.max(0, now - ts) * rate)
local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', key, 3600)
return {allowed, tostring(tokens)}
`
  });

  // Atomic cross-worker capacity reservation (check-and-reserve).
  // A reservation succeeds only if the backend's shared pending total plus this
  // request's weight fits within the caller's metric-derived budget. The TTL is
  // a crash backstop: it can only fail conservative (capacity looks scarcer than
  // it is, so requests queue) — never toward over-admission.
  redis.defineCommand("reserveTokens", {
    numberOfKeys: 1,
    lua: `
local pending = tonumber(redis.call('GET', KEYS[1]) or '0')
local weight = tonumber(ARGV[1])
local budget = tonumber(ARGV[2])
if pending + weight > budget then
  return 0
end
redis.call('INCRBY', KEYS[1], weight)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1
`
  });

  // Release a reservation, clamped at zero (a clamp can only make the gateway
  // admit more readily, and only after an unmatched release, which the clamp
  // itself corrects).
  redis.defineCommand("releaseTokens", {
    numberOfKeys: 1,
    lua: `
local v = redis.call('DECRBY', KEYS[1], tonumber(ARGV[1]))
if v < 0 then
  redis.call('SET', KEYS[1], '0')
  v = 0
end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return v
`
  });

  return redis;
}

declare module "ioredis" {
  interface RedisCommander<Context> {
    tokenBucket(key: string, rate: number, burst: number, now: number, cost: number): Promise<[number, string]>;
    reserveTokens(key: string, weight: number, budget: number, ttlSeconds: number): Promise<number>;
    releaseTokens(key: string, weight: number, ttlSeconds: number): Promise<number>;
  }
}
