#!/usr/bin/env node
/**
 * Read-only diagnostic for the eBay publish path.
 *
 * Pulls the seller's encrypted access token out of Supabase, calls only
 * READ-ONLY eBay endpoints (GET /location, GET /policy, GET /privilege),
 * and prints a checklist of what's set vs what's missing.
 *
 * Does NOT publish, create, or modify anything on eBay or in Supabase.
 *
 * Usage (from the project root):
 *   node scripts/ebay-publish-diagnose.mjs              # auto-pick the only user
 *   node scripts/ebay-publish-diagnose.mjs <user_id>    # specific user
 *
 * Requires the same env as the dev server: NEXT_PUBLIC_SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY, EBAY_ENVIRONMENT (sandbox|production),
 * EBAY_MARKETPLACE_ID, plus the EBAY_LOCATION_* env vars you want validated.
 */
import 'dotenv/config'
import { createDecipheriv } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
const EBAY_ENV = process.env.EBAY_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production'
const EBAY_BASE = EBAY_ENV === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com'
const EBAY_AUTH_BASE = EBAY_ENV === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com'
const MARKETPLACE = process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US'
const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET

const LOCATION_KEY = process.env.EBAY_LOCATION_KEY?.trim() || 'default-warehouse'
const LOCATION_COUNTRY = process.env.EBAY_LOCATION_COUNTRY?.trim()
const LOCATION_POSTAL = process.env.EBAY_LOCATION_POSTAL_CODE?.trim()

function bad(msg) { console.log(`  ✗ ${msg}`) }
function ok(msg)  { console.log(`  ✓ ${msg}`) }
function warn(msg){ console.log(`  ⚠ ${msg}`) }
function info(msg){ console.log(`    ${msg}`) }
function section(t){ console.log(`\n== ${t} ==`) }

if (!SUPA_URL || !SUPA_SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env')
  process.exit(2)
}
if (!ENCRYPTION_KEY) {
  console.error('Missing ENCRYPTION_KEY in .env (needed to decrypt the stored eBay token)')
  process.exit(2)
}

function decrypt(ciphertext) {
  const [ivHex, authTagHex, encryptedHex] = ciphertext.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  const encrypted = Buffer.from(encryptedHex, 'hex')
  const key = Buffer.from(ENCRYPTION_KEY, 'hex')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

async function ebayGet(token, path, params) {
  const url = new URL(path, EBAY_BASE)
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE,
      Accept: 'application/json',
    },
  })
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body }
}

async function refreshAccessToken(refreshTokenPlaintext) {
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
    throw new Error('EBAY_CLIENT_ID / EBAY_CLIENT_SECRET missing in .env — cannot refresh token')
  }
  const creds = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64')
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshTokenPlaintext,
    scope: [
      'https://api.ebay.com/oauth/api_scope/sell.inventory',
      'https://api.ebay.com/oauth/api_scope/sell.account',
      'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    ].join(' '),
  })
  const res = await fetch(`${EBAY_AUTH_BASE}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`refresh failed: HTTP ${res.status} ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

async function main() {
  const userArg = process.argv[2]
  const supa = createClient(SUPA_URL, SUPA_SERVICE_KEY, { auth: { persistSession: false } })

  section('Env')
  ok(`EBAY_ENVIRONMENT=${EBAY_ENV} → base=${EBAY_BASE}`)
  ok(`EBAY_MARKETPLACE_ID=${MARKETPLACE}`)
  if (LOCATION_COUNTRY) ok(`EBAY_LOCATION_COUNTRY=${LOCATION_COUNTRY}`); else bad('EBAY_LOCATION_COUNTRY is NOT set')
  if (LOCATION_POSTAL)  ok(`EBAY_LOCATION_POSTAL_CODE=${LOCATION_POSTAL}`); else bad('EBAY_LOCATION_POSTAL_CODE is NOT set')
  ok(`EBAY_LOCATION_KEY=${LOCATION_KEY} (env-configured key)`)

  section('Resolve user')
  // List all rows so user can pick. UNIQUE(user_id) means one row per user.
  const { data: allRows, error: listErr } = await supa
    .from('ebay_connections')
    .select('user_id, token_expires_at, ebay_user_id, created_at')
    .order('created_at', { ascending: false })
  if (listErr || !allRows || allRows.length === 0) {
    bad(`no rows in ebay_connections: ${listErr?.message ?? 'empty'}`); process.exit(1)
  }
  info(`found ${allRows.length} connected eBay account(s):`)
  for (const r of allRows) {
    const tag = r.user_id === userArg ? '→' : ' '
    info(`  ${tag} user_id=${r.user_id} ebay_user=${r.ebay_user_id ?? '?'} token_exp=${r.token_expires_at}`)
  }
  let userId = userArg
  if (!userId) {
    userId = allRows[0].user_id
    warn(`no user_id arg passed — using most recent (${userId}). Pass an arg if this is the wrong account.`)
  }
  ok(`selected user_id=${userId}`)

  const { data: conn, error: connErr } = await supa
    .from('ebay_connections')
    .select('access_token, refresh_token, token_expires_at, ebay_user_id')
    .eq('user_id', userId)
    .single()
  if (connErr || !conn) { bad(`ebay_connections lookup failed: ${connErr?.message ?? 'not found'}`); process.exit(1) }

  let accessToken
  try {
    accessToken = decrypt(conn.access_token)
  } catch (err) {
    bad(`failed to decrypt access_token: ${err.message}`); process.exit(1)
  }
  let refreshTokenPlain
  try {
    refreshTokenPlain = decrypt(conn.refresh_token)
  } catch (err) {
    bad(`failed to decrypt refresh_token: ${err.message}`); process.exit(1)
  }

  const expiresAt = new Date(conn.token_expires_at).getTime()
  const msToExpiry = expiresAt - Date.now()
  if (msToExpiry < 5 * 60 * 1000) {
    warn(`stored access token ${msToExpiry < 0 ? `expired ${Math.round(-msToExpiry/1000)}s ago` : `expires in ${Math.round(msToExpiry/1000)}s`} — refreshing now`)
    try {
      const fresh = await refreshAccessToken(refreshTokenPlain)
      accessToken = fresh.access_token
      ok(`refreshed access token (expires in ${fresh.expires_in}s)`)
    } catch (err) {
      bad(`token refresh failed: ${err.message}`)
      process.exit(1)
    }
  } else {
    ok(`access token expires in ${Math.round(msToExpiry/1000)}s (eBay user: ${conn.ebay_user_id ?? 'n/a'})`)
  }

  section('GET /sell/inventory/v1/location')
  const locs = await ebayGet(accessToken, '/sell/inventory/v1/location', { limit: 100 })
  if (locs.status >= 400) {
    bad(`HTTP ${locs.status} ${JSON.stringify(locs.body)?.slice(0, 400)}`)
  } else {
    const list = locs.body?.locations ?? []
    if (list.length === 0) {
      warn(`seller has ZERO inventory locations. The publish flow will create one from EBAY_LOCATION_* on first publish (key=${LOCATION_KEY}).`)
    } else {
      info(`${list.length} location(s) returned:`)
      for (const l of list) {
        const addr = l.location?.address ?? {}
        const usable =
          !!l.merchantLocationKey &&
          l.merchantLocationStatus !== 'DISABLED' &&
          !!addr.country?.trim()
        const tag = usable ? '✓ USABLE' : '✗ UNUSABLE'
        console.log(`\n    ${tag}  key="${l.merchantLocationKey}"`)
        info(`status=${l.merchantLocationStatus ?? '(none)'}`)
        info(`country=${addr.country ?? '(EMPTY)'}  postal=${addr.postalCode ?? '(empty)'}`)
        info(`city=${addr.city ?? '(empty)'}  state=${addr.stateOrProvince ?? '(empty)'}`)
        info(`addressLine1=${addr.addressLine1 ?? '(empty)'}`)
        if (l.merchantLocationKey === LOCATION_KEY) info(`(matches env EBAY_LOCATION_KEY)`)
        if (!usable && !addr.country?.trim()) {
          bad(`THIS is the root of "errorId=25002 No <Item.Country>" — country is empty on this location.`)
          if (l.merchantLocationKey === LOCATION_KEY && LOCATION_COUNTRY && LOCATION_POSTAL) {
            ok(`new code will repair this via POST /location/${LOCATION_KEY}/update_location_details on next publish.`)
          } else if (LOCATION_COUNTRY && LOCATION_POSTAL) {
            ok(`new code will create a fresh location with a suffixed key on next publish.`)
          } else {
            bad(`new code CANNOT repair: set EBAY_LOCATION_COUNTRY + EBAY_LOCATION_POSTAL_CODE in .env first.`)
          }
        }
      }
    }
  }

  section('GET /sell/account/v1/privilege')
  const priv = await ebayGet(accessToken, '/sell/account/v1/privilege')
  if (priv.status >= 400) {
    warn(`HTTP ${priv.status} ${JSON.stringify(priv.body)?.slice(0, 200)}`)
  } else {
    const sellingLimits = priv.body?.sellingLimit
    const registered = priv.body?.sellerRegistrationCompleted
    if (registered) ok(`sellerRegistrationCompleted=true`); else bad(`sellerRegistrationCompleted is false — the seller's account is not finished setting up on eBay. Publishing always fails until they finish in Seller Hub.`)
    if (sellingLimits) info(`sellingLimit: ${sellingLimits.amount?.value} ${sellingLimits.amount?.currency}, ${sellingLimits.quantity} items`)
  }

  section('GET business policies')
  for (const kind of ['fulfillment_policy', 'payment_policy', 'return_policy']) {
    const r = await ebayGet(accessToken, `/sell/account/v1/${kind}`, { marketplace_id: MARKETPLACE })
    if (r.status >= 400) {
      bad(`${kind}: HTTP ${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`)
    } else {
      const arr = r.body?.[`${kind.split('_')[0]}Policies`] ?? r.body?.fulfillmentPolicies ?? r.body?.paymentPolicies ?? r.body?.returnPolicies ?? []
      if (arr.length === 0) bad(`${kind}: zero policies — Seller Hub → Business Policies → create one of these.`)
      else ok(`${kind}: ${arr.length} policy(ies) — first id=${arr[0][`${kind.split('_')[0]}PolicyId`] ?? '?'}`)
    }
  }

  section('Recent draft/failed listings')
  const { data: listings } = await supa
    .from('listings')
    .select('id, title, status, category_id, attempt_count, error_message, created_at')
    .eq('user_id', userId)
    .in('status', ['draft', 'failed', 'submitting'])
    .order('created_at', { ascending: false })
    .limit(5)
  if (!listings || listings.length === 0) {
    info('(no draft/failed listings)')
  } else {
    for (const l of listings) {
      console.log(`    [${l.status}] ${l.id.slice(0,8)} "${l.title.slice(0, 60)}" cat=${l.category_id} attempts=${l.attempt_count ?? 0}`)
      if (l.error_message) info(`err: ${l.error_message.slice(0, 200)}`)
    }
  }

  section('Verdict')
  ok('diagnostic complete — see above for any ✗ marks that need fixing before next publish.')
}

main().catch((err) => {
  console.error('\nDIAGNOSTIC CRASHED:', err)
  process.exit(1)
})
