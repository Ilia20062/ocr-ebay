import { encrypt, decrypt } from '@/lib/encryption'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { refreshAccessToken } from './auth'
import { invalidateAccountCaches } from './account-cache'
import type { EbayConnection } from '@/types/database'

// In-memory access-token cache. Without this, every eBay API call paid a
// Supabase round-trip + 2× AES-256-GCM decrypt to fetch the access token from
// `ebay_connections`. A single session-process run can fire 100+ Browse-API
// calls; the cache cuts that to one DB read + 2 decrypts per token lifetime.
//
// Refresh-on-write: saveConnection / deleteConnection invalidate the entry.
// Refresh-on-expiry: getFreshAccessToken refreshes ~5 minutes before the
// stored expiry, both in the cache check and on a DB-fetched value.
interface CachedToken {
  accessToken: string
  expiresAt: number // epoch ms
}
const tokenCache = new Map<string, CachedToken>()
const REFRESH_BUFFER_MS = 5 * 60 * 1000

export async function getDecryptedConnection(userId: string): Promise<EbayConnection | null> {
  const db = getSupabaseAdminClient()
  const { data, error } = await db
    .from('ebay_connections')
    .select('*')
    .eq('user_id', userId)
    .single()

  if (error || !data) return null

  return {
    ...data,
    access_token: decrypt(data.access_token),
    refresh_token: decrypt(data.refresh_token),
  }
}

/**
 * Persists an eBay connection for `userId`.
 *
 * `opts.sameAccount` must be set by callers that are re-saving tokens for the
 * *already connected* account (i.e. a routine refresh). Everything else — the
 * OAuth callback, the manual code exchange — may be attaching a different eBay
 * seller account to the same app user, so we drop the account-scoped caches.
 * Defaulting to `false` means a caller that forgets errs on the safe side.
 *
 * Getting this wrong is not theoretical: the memoized `merchantLocationKey` is
 * keyed by app userId, so a stale entry from a previously connected account
 * makes every publish fail with `errorId=25002 Location information not found`.
 */
export async function saveConnection(
  userId: string,
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  ebayUserId?: string,
  opts?: { sameAccount?: boolean },
) {
  const db = getSupabaseAdminClient()
  const expiresAtMs = Date.now() + expiresIn * 1000
  const tokenExpiresAt = new Date(expiresAtMs).toISOString()

  await db.from('ebay_connections').upsert({
    user_id: userId,
    access_token: encrypt(accessToken),
    refresh_token: encrypt(refreshToken),
    token_expires_at: tokenExpiresAt,
    ebay_user_id: ebayUserId ?? null,
    marketplace_id: process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US',
  }, { onConflict: 'user_id' })

  // Keep the cache in step with the fresh token. New tokens here are always
  // safe to memoize — we just wrote them.
  tokenCache.set(userId, { accessToken, expiresAt: expiresAtMs })

  // A connect/reconnect may have swapped which eBay seller account this app
  // user is bound to; anything memoized against the old one is now wrong.
  if (!opts?.sameAccount) invalidateAccountCaches(userId)
}

export async function getFreshAccessToken(userId: string): Promise<string> {
  // Cache hit — token still well within its lifetime.
  const cached = tokenCache.get(userId)
  if (cached && Date.now() + REFRESH_BUFFER_MS < cached.expiresAt) {
    return cached.accessToken
  }

  const connection = await getDecryptedConnection(userId)
  if (!connection) {
    tokenCache.delete(userId)
    throw new Error('EBAY_NOT_CONNECTED')
  }

  const expiresAt = new Date(connection.token_expires_at).getTime()

  if (Date.now() + REFRESH_BUFFER_MS < expiresAt) {
    tokenCache.set(userId, { accessToken: connection.access_token, expiresAt })
    return connection.access_token
  }

  // Token is expiring — refresh it. saveConnection will refresh the cache.
  const tokens = await refreshAccessToken(connection.refresh_token)
  // eBay omits refresh_token on routine refreshes; keep the existing one.
  const nextRefreshToken = tokens.refresh_token ?? connection.refresh_token
  // Same seller account — don't throw away the resolved location key.
  await saveConnection(userId, tokens.access_token, nextRefreshToken, tokens.expires_in, undefined, {
    sameAccount: true,
  })
  return tokens.access_token
}

export async function deleteConnection(userId: string) {
  const db = getSupabaseAdminClient()
  await db.from('ebay_connections').delete().eq('user_id', userId)
  tokenCache.delete(userId)
  invalidateAccountCaches(userId)
}
