import type { Redis } from "ioredis";
import type { ApiKeyRecord } from "./types.js";

export interface RateLimitResult {
  allowed: boolean;
  limit: "rpm" | "tpm" | null;
  remainingRequests: number;
  remainingTokens: number;
}

export class RateLimiter {
  constructor(private redis: Redis) {}

  /**
   * Charge one request against RPM and `estimatedTokens` against TPM.
   * Both buckets refill continuously (limit/60 per second).
   */
  async check(key: ApiKeyRecord, estimatedTokens: number): Promise<RateLimitResult> {
    const now = Date.now() / 1000;
    const [rpm, tpm] = await Promise.all([
      this.redis.tokenBucket(`rl:rpm:${key.id}`, key.rpmLimit / 60, key.rpmLimit, now, 1),
      this.redis.tokenBucket(`rl:tpm:${key.id}`, key.tpmLimit / 60, key.tpmLimit, now, estimatedTokens)
    ]);
    const rpmOk = rpm[0] === 1;
    const tpmOk = tpm[0] === 1;

    // If one bucket allowed but the other refused, refund the successful charge
    // so a blocked request doesn't burn quota.
    if (rpmOk && !tpmOk) await this.refund(`rl:rpm:${key.id}`, 1);
    if (tpmOk && !rpmOk) await this.refund(`rl:tpm:${key.id}`, estimatedTokens);

    return {
      allowed: rpmOk && tpmOk,
      limit: rpmOk ? (tpmOk ? null : "tpm") : "rpm",
      remainingRequests: Math.floor(Number(rpm[1])),
      remainingTokens: Math.floor(Number(tpm[1]))
    };
  }

  /**
   * Reconcile TPM after completion: refund over-estimation (never charge more —
   * under-estimation is absorbed, keeping the hot path to one round trip).
   */
  async reconcile(key: ApiKeyRecord, estimatedTokens: number, actualTokens: number): Promise<void> {
    const diff = estimatedTokens - actualTokens;
    if (diff > 0) await this.refund(`rl:tpm:${key.id}`, diff);
  }

  private async refund(bucketKey: string, amount: number): Promise<void> {
    // Cap is re-applied on the next tokenBucket call, so a plain increment is safe.
    await this.redis.hincrbyfloat(bucketKey, "tokens", amount);
  }
}
