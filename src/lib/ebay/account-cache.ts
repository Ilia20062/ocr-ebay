/**
 * Per-eBay-account caches, held here so they can be invalidated from
 * `token-manager` without an import cycle.
 *
 * Why this module exists: the location cache used to live in `location.ts`,
 * which imports `client.ts`, which imports `token-manager.ts`. Invalidating
 * the cache from `saveConnection`/`deleteConnection` would have closed that
 * loop. This file imports nothing, so both sides can depend on it.
 *
 * IMPORTANT: every value in here is scoped to *the eBay account currently
 * connected to an app user*, not to the app user alone. The map is keyed by
 * app `userId` because that is all the call sites have — which means a user
 * who disconnects one eBay account and connects another would otherwise keep
 * reading the previous account's values. Anything added here must therefore be
 * dropped in `invalidateAccountCaches` whenever the connection changes.
 */

/** app userId → merchantLocationKey resolved against the connected account. */
const locationCache = new Map<string, string>()

export function getCachedLocationKey(userId: string): string | undefined {
  return locationCache.get(userId)
}

export function setCachedLocationKey(userId: string, key: string): void {
  locationCache.set(userId, key)
}

/** Drops the memoized merchantLocationKey. Pass no arg to clear every user. */
export function invalidateLocationCache(userId?: string): void {
  if (userId) locationCache.delete(userId)
  else locationCache.clear()
}

/**
 * Clears everything scoped to a user's eBay account. Call this whenever the
 * connected account may have changed — OAuth callback, manual code exchange,
 * disconnect.
 */
export function invalidateAccountCaches(userId?: string): void {
  invalidateLocationCache(userId)
}
