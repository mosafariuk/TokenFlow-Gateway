import { backendBudget, type BackendState } from "./backends.js";

/**
 * Context-aware candidate ordering.
 *
 * Heavy prompts (weight >= heavyThreshold) try the backend with the MOST free
 * KV-cache first, so a large context never lands on a nearly-full GPU.
 * Light prompts try the BUSIEST backend that still fits them first, keeping
 * the freer backends open for the next heavy request (best-fit bin packing
 * rather than round-robin).
 *
 * The pending map is a snapshot used for ordering and pre-filtering only —
 * admission itself is an atomic Redis reservation (see ReservationManager),
 * so a stale snapshot can cost a retry but can never over-admit.
 */
export function orderCandidates(
  backends: BackendState[],
  weight: number,
  heavyThreshold: number,
  pending: Map<string, number>
): BackendState[] {
  const free = (b: BackendState) => backendBudget(b) - (pending.get(b.name) ?? 0);
  const fits = backends.filter((b) => b.healthy && free(b) >= weight);
  const byFreeDesc = [...fits].sort((a, b) => free(b) - free(a));
  return weight >= heavyThreshold ? byFreeDesc : byFreeDesc.reverse();
}
