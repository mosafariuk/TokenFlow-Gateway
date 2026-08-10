import { createHash, randomBytes } from "node:crypto";
import { findApiKeyByHash } from "./db.js";
import type { ApiKeyRecord } from "./types.js";

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { record: ApiKeyRecord | null; expiresAt: number }>();

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(): { key: string; keyHash: string; keyPrefix: string } {
  const key = `tfg-${randomBytes(24).toString("base64url")}`;
  return { key, keyHash: hashKey(key), keyPrefix: key.slice(0, 8) };
}

export async function authenticate(authorization: string | undefined): Promise<ApiKeyRecord | null> {
  if (!authorization?.startsWith("Bearer ")) return null;
  const key = authorization.slice("Bearer ".length).trim();
  if (!key) return null;

  const keyHash = hashKey(key);
  const cached = cache.get(keyHash);
  if (cached && cached.expiresAt > Date.now()) return cached.record;

  const record = await findApiKeyByHash(keyHash);
  cache.set(keyHash, { record, expiresAt: Date.now() + CACHE_TTL_MS });
  return record;
}

/** Drop cached auth state (e.g. after a key is revoked via the admin API). */
export function invalidateAuthCache(): void {
  cache.clear();
}
