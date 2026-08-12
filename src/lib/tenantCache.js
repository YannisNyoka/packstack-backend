// Small in-memory cache for slug/domain -> tenant lookups. Tenant metadata
// changes rarely, so this avoids a DB round trip on every single request
// just to resolve routing. TTL-based, not size-bounded (tenant count is
// small at this scale) - revisit if that stops being true.

const TTL_MS = 60_000;
const cache = new Map();

export function getCachedTenant(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

export function setCachedTenant(key, value) {
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

export function invalidateCachedTenant(key) {
  cache.delete(key);
}

export function clearTenantCache() {
  cache.clear();
}
