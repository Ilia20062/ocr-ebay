#!/usr/bin/env node
/**
 * One-shot end-to-end publish.
 *
 * Picks a draft/failed listing for the active user, runs the full Sell-API
 * publish (PUT inventory_item → POST offer → POST publish), and updates the
 * `listings` row with the result. THIS WILL CREATE A LIVE EBAY LISTING.
 *
 * Usage:
 *   node scripts/ebay-publish-now.mjs                 # user e192b777, most-recent draft/failed
 *   node scripts/ebay-publish-now.mjs <listing_id>
 *   node scripts/ebay-publish-now.mjs <listing_id> <user_id>
 */
import 'dotenv/config'
import { createDecipheriv } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
const EBAY_ENV = process.env.EBAY_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production'
const EBAY_BASE = EBAY_ENV === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com'
const MARKETPLACE = process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US'
const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET
const LOCATION_KEY = process.env.EBAY_LOCATION_KEY?.trim() || 'default-warehouse'

const DEFAULT_USER_ID = 'e192b777-b580-4ba1-8333-a06ced3cda68'

const VALID_CONDITIONS = new Set([
  'NEW','LIKE_NEW','NEW_OTHER','NEW_WITH_DEFECTS',
  'MANUFACTURER_REFURBISHED','CERTIFIED_REFURBISHED','EXCELLENT_REFURBISHED',
  'VERY_GOOD_REFURBISHED','GOOD_REFURBISHED','SELLER_REFURBISHED',
  'USED_EXCELLENT','USED_VERY_GOOD','USED_GOOD','USED_ACCEPTABLE',
  'FOR_PARTS_OR_NOT_WORKING',
])
function normalizeCondition(raw) {
  if (!raw) return 'USED_EXCELLENT'
  const upper = String(raw).trim().toUpperCase().replace(/[\s-]+/g, '_')
  if (VALID_CONDITIONS.has(upper)) return upper
  const map = {
    USED: 'USED_EXCELLENT', PRE_OWNED: 'USED_EXCELLENT', PREOWNED: 'USED_EXCELLENT',
    OPEN_BOX: 'NEW_OTHER', 'NEW_OTHER_(SEE_DETAILS)': 'NEW_OTHER', NEW_OTHER_SEE_DETAILS: 'NEW_OTHER',
    REFURBISHED: 'SELLER_REFURBISHED', 'CERTIFIED_-_REFURBISHED': 'CERTIFIED_REFURBISHED',
    FOR_PARTS: 'FOR_PARTS_OR_NOT_WORKING', NOT_WORKING: 'FOR_PARTS_OR_NOT_WORKING', BRAND_NEW: 'NEW',
  }
  if (map[upper]) return map[upper]
  if (upper.startsWith('NEW')) return 'NEW'
  if (upper.includes('REFURB')) return 'SELLER_REFURBISHED'
  if (upper.includes('PART') || upper.includes('NOT_WORK') || upper.includes('BROKEN')) return 'FOR_PARTS_OR_NOT_WORKING'
  return 'USED_EXCELLENT'
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

async function fetchApplicationToken() {
  const creds = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64')
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'https://api.ebay.com/oauth/api_scope',
  })
  const res = await fetch(`${EBAY_BASE}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`app-token failed: HTTP ${res.status} ${text.slice(0, 500)}`)
  return JSON.parse(text).access_token
}

async function refreshAccessToken(refreshTokenPlain) {
  const creds = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64')
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshTokenPlain,
    scope: [
      'https://api.ebay.com/oauth/api_scope/sell.inventory',
      'https://api.ebay.com/oauth/api_scope/sell.account',
      'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    ].join(' '),
  })
  const res = await fetch(`${EBAY_BASE}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`refresh failed: HTTP ${res.status} ${text.slice(0, 500)}`)
  return JSON.parse(text)
}

async function ebay(token, method, path, body) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE,
    Accept: 'application/json',
    'Accept-Language': 'en-US',
    'Content-Type': 'application/json',
    'Content-Language': 'en-US',
  }
  const opts = { method, headers }
  if (body !== undefined) opts.body = JSON.stringify(body)
  const res = await fetch(new URL(path, EBAY_BASE), opts)
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { status: res.status, body: data }
}

function bail(msg, extra) {
  console.error(`\n✗ ${msg}`)
  if (extra) console.error('  ', JSON.stringify(extra, null, 2))
  process.exit(1)
}

async function main() {
  if (!SUPA_URL || !SUPA_SERVICE_KEY) bail('Supabase env missing')
  if (!ENCRYPTION_KEY) bail('ENCRYPTION_KEY missing')
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) bail('EBAY_CLIENT_ID / EBAY_CLIENT_SECRET missing')

  const listingArg = process.argv[2]
  const userArg = process.argv[3] ?? DEFAULT_USER_ID

  const supa = createClient(SUPA_URL, SUPA_SERVICE_KEY, { auth: { persistSession: false } })

  console.log(`env=${EBAY_ENV} marketplace=${MARKETPLACE} user=${userArg}`)

  // 1) Pick the listing.
  let listing
  if (listingArg) {
    const r = await supa.from('listings').select('*').eq('id', listingArg).eq('user_id', userArg).single()
    if (r.error || !r.data) bail(`listing ${listingArg} not found for user`, r.error)
    listing = r.data
  } else {
    const r = await supa
      .from('listings')
      .select('*')
      .eq('user_id', userArg)
      .in('status', ['draft', 'failed'])
      .order('created_at', { ascending: false })
      .limit(1)
    if (r.error || !r.data || r.data.length === 0) bail(`no draft/failed listing for user ${userArg}`, r.error)
    listing = r.data[0]
  }
  console.log(`\nlisting: ${listing.id}`)
  console.log(`  status=${listing.status}  attempts=${listing.attempt_count ?? 0}`)
  console.log(`  title="${listing.title}"`)
  console.log(`  price=${listing.price} ${listing.currency} cond=${listing.condition} cat=${listing.category_id} sku=${listing.sku}`)
  if (listing.status === 'active') bail('listing already active on eBay — nothing to do')

  // 2) Get a fresh access token.
  const connRes = await supa.from('ebay_connections')
    .select('access_token, refresh_token, token_expires_at')
    .eq('user_id', userArg).single()
  if (connRes.error || !connRes.data) bail('no ebay_connection for user', connRes.error)
  const refreshPlain = decrypt(connRes.data.refresh_token)
  console.log('\nrefreshing access token…')
  const fresh = await refreshAccessToken(refreshPlain)
  const accessToken = fresh.access_token
  console.log(`  ok (expires in ${fresh.expires_in}s)`)

  // 3) Verify location is usable (we won't auto-create here — diagnostic
  //    already confirmed it exists for the active user).
  console.log('\nchecking inventory location…')
  const locRes = await ebay(accessToken, 'GET', '/sell/inventory/v1/location?limit=100')
  if (locRes.status >= 400) bail(`GET /location failed`, locRes.body)
  const locs = locRes.body?.locations ?? []
  const usable = locs.find((l) =>
    !!l.location?.address?.country?.trim() &&
    l.merchantLocationStatus !== 'DISABLED'
  )
  if (!usable) bail('no usable inventory location on this eBay account', { count: locs.length, locs })
  const merchantLocationKey = usable.merchantLocationKey
  console.log(`  using merchantLocationKey="${merchantLocationKey}" country=${usable.location?.address?.country}`)

  // 4) Fetch business policies.
  console.log('\nfetching business policies…')
  const [fulfill, payment, ret] = await Promise.all([
    ebay(accessToken, 'GET', `/sell/account/v1/fulfillment_policy?marketplace_id=${MARKETPLACE}`),
    ebay(accessToken, 'GET', `/sell/account/v1/payment_policy?marketplace_id=${MARKETPLACE}`),
    ebay(accessToken, 'GET', `/sell/account/v1/return_policy?marketplace_id=${MARKETPLACE}`),
  ])
  if (fulfill.status >= 400) bail('fulfillment_policy fetch failed', fulfill.body)
  if (payment.status >= 400) bail('payment_policy fetch failed', payment.body)
  if (ret.status >= 400) bail('return_policy fetch failed', ret.body)
  const fulfillmentPolicyId = fulfill.body?.fulfillmentPolicies?.[0]?.fulfillmentPolicyId
  const paymentPolicyId    = payment.body?.paymentPolicies?.[0]?.paymentPolicyId
  const returnPolicyId     = ret.body?.returnPolicies?.[0]?.returnPolicyId
  if (!fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId) {
    bail('one or more business policies missing', { fulfillmentPolicyId, paymentPolicyId, returnPolicyId })
  }
  console.log(`  fulfillment=${fulfillmentPolicyId}  payment=${paymentPolicyId}  return=${returnPolicyId}`)

  // 5) Build image URLs using the short proxy form ${APP_URL}/api/i/<id> —
  //    matches what the live publishListing path does, keeps total URL length
  //    well under eBay's 3975-char cap (errorId=25015).
  console.log('\nresolving image URLs…')
  const APP_URL = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '')
  if (!APP_URL) bail('NEXT_PUBLIC_APP_URL must be set so eBay can fetch images via /api/i/<id>')
  let imageUrls = []
  if (listing.search_id) {
    const sr = await supa.from('product_searches').select('batch_id').eq('id', listing.search_id).single()
    if (sr.data?.batch_id) {
      const ir = await supa.from('images').select('id').eq('batch_id', sr.data.batch_id).order('created_at')
      imageUrls = (ir.data ?? []).slice(0, 24).map((i) => `${APP_URL}/api/i/${i.id}`)
    }
  }
  // Enforce the same per-URL/total caps as image-urls.ts.
  const EBAY_PER_URL = 500, EBAY_TOTAL = 3975
  const capped = []
  let totalLen = 0
  for (const u of imageUrls) {
    if (u.length > EBAY_PER_URL) continue
    if (totalLen + u.length > EBAY_TOTAL) break
    capped.push(u)
    totalLen += u.length
  }
  imageUrls = capped
  console.log(`  ${imageUrls.length} image URL(s), total ${totalLen} chars`)
  if (imageUrls.length === 0) bail('no image URLs resolved — cannot publish a listing without images')

  // 6) Build payloads.
  const sku = listing.sku ?? `SKU-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  const condition = normalizeCondition(listing.condition)
  const title = listing.title.slice(0, 80)
  const inventoryItem = {
    sku,
    product: {
      title,
      description: listing.description ?? '',
      ...(imageUrls.length > 0 ? { imageUrls } : {}),
    },
    condition,
    availability: { shipToLocationAvailability: { quantity: listing.quantity ?? 1 } },
  }
  const offer = {
    sku,
    marketplaceId: MARKETPLACE,
    format: 'FIXED_PRICE',
    availableQuantity: listing.quantity ?? 1,
    categoryId: listing.category_id,
    merchantLocationKey,
    listingPolicies: { fulfillmentPolicyId, paymentPolicyId, returnPolicyId },
    pricingSummary: { price: { value: Number(listing.price).toFixed(2), currency: listing.currency ?? 'USD' } },
  }

  // 7) Mark submitting.
  await supa.from('listings').update({
    status: 'submitting',
    sku,
    attempt_count: (listing.attempt_count ?? 0) + 1,
    last_attempted_at: new Date().toISOString(),
    error_message: null,
  }).eq('id', listing.id)

  // 8) PUT inventory_item.
  console.log('\nPUT inventory_item…')
  const invRes = await ebay(accessToken, 'PUT', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, inventoryItem)
  if (invRes.status >= 400) {
    await supa.from('listings').update({ status: 'failed', error_message: `inventory_item: ${JSON.stringify(invRes.body).slice(0,1500)}` }).eq('id', listing.id)
    bail('inventory_item PUT failed', invRes.body)
  }
  console.log('  ok')

  // 9) POST offer (handle "already has offer" by updating in place).
  console.log('POST offer…')
  let offerId
  const offerRes = await ebay(accessToken, 'POST', '/sell/inventory/v1/offer', offer)
  if (offerRes.status === 201) {
    offerId = offerRes.body?.offerId
  } else if (offerRes.status === 400 && (offerRes.body?.errors ?? []).some((e) => e.errorId === 25002 &&
    ((e.parameters ?? []).some((p) => p.name?.toLowerCase() === 'sku') || /already.*offer|offer.*already/i.test(e.message ?? '')))) {
    console.log('  SKU already has an offer — fetching existing')
    const listOff = await ebay(accessToken, 'GET', `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`)
    offerId = listOff.body?.offers?.[0]?.offerId
    if (!offerId) {
      await supa.from('listings').update({ status: 'failed', error_message: 'offer collision but no existing offer found' }).eq('id', listing.id)
      bail('offer collision but list returned no offers', listOff.body)
    }
    const upd = await ebay(accessToken, 'PUT', `/sell/inventory/v1/offer/${offerId}`, offer)
    if (upd.status >= 400) {
      await supa.from('listings').update({ status: 'failed', error_message: `offer PUT: ${JSON.stringify(upd.body).slice(0,1500)}` }).eq('id', listing.id)
      bail('offer PUT failed', upd.body)
    }
  } else {
    await supa.from('listings').update({ status: 'failed', error_message: `offer POST: ${JSON.stringify(offerRes.body).slice(0,1500)}` }).eq('id', listing.id)
    bail('offer POST failed', offerRes.body)
  }
  console.log(`  offerId=${offerId}`)

  // 10) POST publish. On 25005 (invalid/non-leaf category) — common when the
  //     seller can't list in Motors — fall back to EBAY_FALLBACK_CATEGORY_ID
  //     (or the hard-coded non-Motors leaf 14947 = Collectibles > Automobilia
  //     > Specialty & Misc) and retry once.
  console.log('POST publish…')
  let pubRes = await ebay(accessToken, 'POST', `/sell/inventory/v1/offer/${offerId}/publish`)
  let publishedCategory = offer.categoryId
  if (pubRes.status >= 400 && (pubRes.body?.errors ?? []).some((e) => e.errorId === 25005)) {
    // Ask eBay's own Taxonomy API for category suggestions matching the title,
    // then try each one in order until publish succeeds. This is what the
    // app's publishListing already does in production; mirroring it here.
    const fallback = process.env.EBAY_FALLBACK_CATEGORY_ID?.trim()
    console.log(`  category ${offer.categoryId} rejected (25005) — asking Taxonomy for valid leaves`)
    const appToken = await fetchApplicationToken()
    const tree = await ebay(appToken, 'GET', `/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${MARKETPLACE}`)
    const treeId = tree.body?.categoryTreeId
    if (!treeId) bail('could not fetch category tree id', tree.body)
    const suggestRes = await ebay(appToken, 'GET', `/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions?q=${encodeURIComponent(title)}`)
    const suggestions = (suggestRes.body?.categorySuggestions ?? [])
      .map((s) => s.category?.categoryId)
      .filter(Boolean)
    const candidates = [...suggestions, ...(fallback ? [fallback] : []), '14947']
      .filter((v, i, a) => a.indexOf(v) === i)
    console.log(`  Taxonomy suggestions: ${candidates.join(', ')}`)
    let lastErr = pubRes.body
    for (const candCategory of candidates) {
      console.log(`  trying category ${candCategory}…`)
      const invRetry = await ebay(accessToken, 'PUT', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, inventoryItem)
      if (invRetry.status >= 400) { lastErr = invRetry.body; continue }
      const updRes = await ebay(accessToken, 'PUT', `/sell/inventory/v1/offer/${offerId}`, { ...offer, categoryId: candCategory })
      if (updRes.status >= 400) { lastErr = updRes.body; continue }
      const tryPub = await ebay(accessToken, 'POST', `/sell/inventory/v1/offer/${offerId}/publish`)
      if (tryPub.status < 400) {
        pubRes = tryPub
        publishedCategory = candCategory
        break
      }
      lastErr = tryPub.body
      const errs = (tryPub.body?.errors ?? [])
      const fatal = errs.some((e) => e.errorId !== 25005 && e.errorId !== 25004)
      if (fatal) { pubRes = tryPub; break }
    }
    if (pubRes.status >= 400) {
      await supa.from('listings').update({ status: 'failed', error_message: `publish (all candidates exhausted): ${JSON.stringify(lastErr).slice(0,1500)}` }).eq('id', listing.id)
      bail(`publish failed for every Taxonomy candidate (${candidates.join(', ')}). Last error:`, lastErr)
    }
  }
  if (pubRes.status >= 400) {
    await supa.from('listings').update({ status: 'failed', error_message: `publish: ${JSON.stringify(pubRes.body).slice(0,1500)}` }).eq('id', listing.id)
    bail('publish failed', pubRes.body)
  }
  const ebayListingId = pubRes.body?.listingId
  const ebayUrl = `https://www.ebay.com/itm/${ebayListingId}`
  console.log(`  ✓ ebayListingId=${ebayListingId} (category=${publishedCategory})`)
  console.log(`  ✓ ${ebayUrl}`)

  // 11) Mark active.
  await supa.from('listings').update({
    status: 'active',
    ebay_item_id: ebayListingId,
    ebay_listing_url: ebayUrl,
    category_id: publishedCategory,
    listed_at: new Date().toISOString(),
    error_message: null,
  }).eq('id', listing.id)

  console.log(`\n✓ PUBLISHED — listing row ${listing.id} → ${ebayUrl}`)
}

main().catch((err) => {
  console.error('\nSCRIPT CRASHED:', err)
  process.exit(1)
})
