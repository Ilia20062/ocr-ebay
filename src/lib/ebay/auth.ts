import type { EbayTokenResponse } from '@/types/ebay'

const EBAY_AUTH_URL = process.env.EBAY_ENVIRONMENT === 'sandbox'
  ? 'https://auth.sandbox.ebay.com/oauth2/authorize'
  : 'https://auth.ebay.com/oauth2/authorize'

const EBAY_TOKEN_URL = process.env.EBAY_ENVIRONMENT === 'sandbox'
  ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
  : 'https://api.ebay.com/identity/v1/oauth2/token'

/**
 * The scopes we request at authorization AND re-request on every refresh.
 *
 * These MUST stay a single list. Previously the refresh call passed a narrower
 * string (inventory + account only), and eBay honours the `scope` parameter on
 * a refresh_token grant by *downgrading* the issued token to exactly what you
 * ask for. That silently dropped:
 *   - `api_scope` (the base scope the Browse API needs) — so eBay product
 *     search broke roughly two hours after connecting, once the first refresh
 *     landed, and stayed broken until the user reconnected.
 *   - `sell.fulfillment`.
 *
 * `commerce.identity.readonly` lets us record which eBay account is connected
 * (see fetchEbayUserId) — needed so the marketplace account-deletion webhook
 * can match a notification back to a row.
 */
const SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
].join(' ')

export function buildAuthorizationUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.EBAY_CLIENT_ID!,
    redirect_uri: process.env.EBAY_REDIRECT_URI!,
    response_type: 'code',
    scope: SCOPES,
    state,
  })
  return `${EBAY_AUTH_URL}?${params.toString()}`
}

export async function exchangeCodeForTokens(code: string): Promise<EbayTokenResponse> {
  const credentials = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString('base64')

  const res = await fetch(EBAY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.EBAY_REDIRECT_URI!,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`eBay token exchange failed: ${res.status} ${body}`)
  }

  return res.json() as Promise<EbayTokenResponse>
}

const EBAY_API_BASE = process.env.EBAY_ENVIRONMENT === 'sandbox'
  ? 'https://apiz.sandbox.ebay.com'
  : 'https://apiz.ebay.com'

/**
 * Resolves the eBay username behind an access token, for `ebay_connections.
 * ebay_user_id`. Two things depend on that column being populated:
 *   - the settings page showing *which* seller account is connected;
 *   - the MARKETPLACE_ACCOUNT_DELETION webhook, which matches notifications
 *     to rows by eBay user id and is a no-op while the column is null.
 *
 * Deliberately non-fatal: a connection that works for listing shouldn't be
 * rejected because this lookup failed. Tokens granted before
 * commerce.identity.readonly was requested will 403 here and return null —
 * those rows stay null until the user reconnects.
 *
 * Note this endpoint lives on apiz.ebay.com, not api.ebay.com.
 * https://developer.ebay.com/api-docs/commerce/identity/resources/user/methods/getUser
 */
export async function fetchEbayUserId(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${EBAY_API_BASE}/commerce/identity/v1/user/`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { username?: string; userId?: string }
    return body.username ?? body.userId ?? null
  } catch {
    return null
  }
}

export async function refreshAccessToken(refreshToken: string): Promise<EbayTokenResponse> {
  const credentials = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString('base64')

  const res = await fetch(EBAY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    // `scope` is deliberately omitted. eBay treats it as a *downgrade* request
    // on a refresh_token grant, so passing a partial list silently strips
    // scopes off the new token (see the SCOPES comment above). Omitting it
    // reissues the token with exactly the scopes the user originally granted —
    // which is also the only safe option for connections made before
    // commerce.identity.readonly was added, since asking for a scope that
    // wasn't in the original grant fails with invalid_scope.
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`eBay token refresh failed: ${res.status} ${body}`)
  }

  return res.json() as Promise<EbayTokenResponse>
}
