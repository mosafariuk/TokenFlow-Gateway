import type { Redis } from "ioredis";
import { config } from "./config.js";
import { backendBudget, type BackendState } from "./backends.js";

const key = (name: string) => `gw:pending:${name}`;

/**
 * Cross-process backend capacity reservations, backed by atomic Redis Lua.
 *
 * Every gateway worker (PM2 cluster) and every gateway replica shares one
 * pending-token counter per backend, so a reservation admitted anywhere is
 * visible everywhere before the next request is admitted. The counter carries
 * a TTL refreshed on every reserve/release: if a worker dies mid-request and
 * never releases, the orphaned tokens expire instead of pinning the backend
 * "full" forever. Until then the error is in the safe direction — the gateway
 * queues more than strictly necessary, never over-admits.
 */
export class ReservationManager {
  constructor(private redis: Redis) {}

  /** Snapshot of shared pending totals — used for ordering only, never admission. */
  async pendingFor(backends: BackendState[]): Promise<Map<string, number>> {
    if (backends.length === 0) return new Map();
    const vals = await this.redis.mget(backends.map((b) => key(b.name)));
    return new Map(backends.map((b, i) => [b.name, Number(vals[i] ?? 0)]));
  }

  async tryReserve(b: BackendState, weight: number): Promise<boolean> {
    const ok = await this.redis.reserveTokens(
      key(b.name),
      weight,
      backendBudget(b),
      config.reservationTtlSeconds
    );
    return ok === 1;
  }

  async release(b: BackendState, weight: number): Promise<void> {
    await this.redis
      .releaseTokens(key(b.name), weight, config.reservationTtlSeconds)
      .catch(() => {}); // a failed release is what the TTL backstop is for
  }
}
