import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

const QUEUE_KEY = "gw:queue";
const POLL_INTERVAL_MS = 100;

/**
 * Redis-backed priority queue for admission control.
 *
 * Each waiting request registers a member in a sorted set scored by
 * (priority, arrival time) — lower priority number is served first, FIFO
 * within a priority class. A waiter attempts admission only while it is at
 * the head of the queue, and returns only once `tryAdmit` has actually
 * secured an atomic reservation — so a successful return IS an admission,
 * fair across every worker and replica sharing this Redis.
 */
export class AdmissionQueue {
  constructor(private redis: Redis) {}

  async depth(): Promise<number> {
    return this.redis.zcard(QUEUE_KEY);
  }

  /**
   * Wait until `tryAdmit` succeeds for this request. Resolves with the
   * admitted value and queued duration, or rejects with QueueTimeoutError /
   * QueueAbortedError.
   */
  async waitForTurn<T>(
    priority: number,
    tryAdmit: () => Promise<T | null>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ value: T; queuedMs: number }> {
    const id = randomUUID();
    const start = Date.now();
    const score = priority * 1e14 + start;
    await this.redis.zadd(QUEUE_KEY, score, id);

    try {
      while (true) {
        if (signal?.aborted) throw new QueueAbortedError();
        if (Date.now() - start > timeoutMs) throw new QueueTimeoutError();
        const head = await this.redis.zrange(QUEUE_KEY, 0, 0);
        if (head[0] === id) {
          const value = await tryAdmit();
          if (value !== null) return { value, queuedMs: Date.now() - start };
        }
        await sleep(POLL_INTERVAL_MS);
      }
    } finally {
      await this.redis.zrem(QUEUE_KEY, id).catch(() => {});
    }
  }
}

export class QueueTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for backend capacity");
  }
}

export class QueueAbortedError extends Error {
  constructor() {
    super("Client disconnected while queued");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
