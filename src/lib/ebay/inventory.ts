import axios from 'axios'
import { createEbayClient, isEbayErrorCode } from './client'
import { describeEbayError } from './error'
import { getOrCreateMerchantLocationKey, invalidateLocationCache } from './location'
import { withContext } from '@/lib/log'
import { isMotorsCategoryId } from './taxonomy'
import type { EbayInventoryItem, EbayOffer } from '@/types/ebay'

/**
 * 25002 is a generic "user error" code that eBay overloads for several
 * unrelated conditions (duplicate SKU, missing country, missing aspects, …).
 * Distinguish them via the `parameters[].name` field on the response body.
 */
interface EbayApiErrorBody {
  errors?: Array<{
    errorId?: number
    message?: string
    longMessage?: string
    parameters?: Array<{ name?: string; value?: string }>
  }>
}

function getEbayErrorBody(err: unknown): EbayApiErrorBody | undefined {
  if (!axios.isAxiosError(err)) return undefined
  return err.response?.data as EbayApiErrorBody | undefined
}

function ebayErrorHasParam(err: unknown, errorId: number, paramName: string): boolean {
  const body = getEbayErrorBody(err)
  const match = body?.errors?.find((e) => e.errorId === errorId)
  if (!match) return false
  return (match.parameters ?? []).some(
    (p) => p.name?.trim().toLowerCase() === paramName.toLowerCase(),
  )
}

function ebayErrorMessageMatches(err: unknown, errorId: number, re: RegExp): boolean {
  const body = getEbayErrorBody(err)
  const match = body?.errors?.find((e) => e.errorId === errorId)
  if (!match) return false
  return re.test(match.message ?? '') || re.test(match.longMessage ?? '')
}

// Valid Sell-API condition enum values. Anything outside this set triggers
// eBay errorId=2004 "Could not serialize field [condition]".
// https://developer.ebay.com/api-docs/sell/inventory/types/slr:ConditionEnum
const VALID_CONDITIONS = new Set([
  'NEW',
  'LIKE_NEW',
  'NEW_OTHER',
  'NEW_WITH_DEFECTS',
  'MANUFACTURER_REFURBISHED',
  'CERTIFIED_REFURBISHED',
  'EXCELLENT_REFURBISHED',
  'VERY_GOOD_REFURBISHED',
  'GOOD_REFURBISHED',
  'SELLER_REFURBISHED',
  'USED_EXCELLENT',
  'USED_VERY_GOOD',
  'USED_GOOD',
  'USED_ACCEPTABLE',
  'FOR_PARTS_OR_NOT_WORKING',
])

// Browse-API returns human-readable strings ("Used", "Pre-owned", "For parts
// or not working"); the Sell API requires the strict enum above. Map common
// variants → enum, then fall back to USED_EXCELLENT as a safe default.
// Client rule: never publish as "New" — every item is a used OEM part, so any
// NEW-family value (old drafts, manual edits, Browse matches) is clamped to
// USED_EXCELLENT (conditionId 3000, displayed as plain "Used").
export function normalizeCondition(raw: string | null | undefined): string {
  const normalized = toConditionEnum(raw)
  return normalized.startsWith('NEW') ? 'USED_EXCELLENT' : normalized
}

function toConditionEnum(raw: string | null | undefined): string {
  if (!raw) return 'USED_EXCELLENT'
  const upper = raw.toString().trim().toUpperCase().replace(/[\s-]+/g, '_')

  // Already a valid enum (e.g. caller passed USED_EXCELLENT).
  if (VALID_CONDITIONS.has(upper)) return upper

  // Common Browse-API / human-readable variants.
  const map: Record<string, string> = {
    USED: 'USED_EXCELLENT',
    PRE_OWNED: 'USED_EXCELLENT',
    PREOWNED: 'USED_EXCELLENT',
    OPEN_BOX: 'NEW_OTHER',
    'NEW_OTHER_(SEE_DETAILS)': 'NEW_OTHER',
    NEW_OTHER_SEE_DETAILS: 'NEW_OTHER',
    REFURBISHED: 'SELLER_REFURBISHED',
    'CERTIFIED_-_REFURBISHED': 'CERTIFIED_REFURBISHED',
    FOR_PARTS: 'FOR_PARTS_OR_NOT_WORKING',
    NOT_WORKING: 'FOR_PARTS_OR_NOT_WORKING',
    BRAND_NEW: 'NEW',
  }
  if (map[upper]) return map[upper]

  // Heuristic fallbacks for anything unrecognized.
  if (upper.startsWith('NEW')) return 'NEW'
  if (upper.includes('REFURB')) return 'SELLER_REFURBISHED'
  if (upper.includes('PART') || upper.includes('NOT_WORK') || upper.includes('BROKEN')) {
    return 'FOR_PARTS_OR_NOT_WORKING'
  }
  return 'USED_EXCELLENT'
}

interface CreateListingParams {
  userId: string
  sku: string
  title: string
  description: string
  price: number
  currency: string
  quantity: number
  condition: string
  /** Free-text condition statement (spec: "Original {Brand} part…"). */
  conditionDescription?: string
  /** Item specifics (Brand, Placement, Color, Part Number, OEM, Warranty, Case). */
  aspects?: Record<string, string[]>
  categoryId: string
  fulfillmentPolicyId: string
  paymentPolicyId: string
  returnPolicyId: string
  /** Store category path (spec: "Inventory"). */
  storeCategory?: string
  imageUrls: string[]
}

export async function createOrUpdateInventoryItem(
  userId: string,
  sku: string,
  item: EbayInventoryItem,
  marketplaceId?: string,
) {
  const log = withContext({ scope: 'ebay.inventory.item', user_id: userId, sku })
  log.info('Creating/updating inventory item', {
    title_len: item.product?.title?.length ?? 0,
    description_len: item.product?.description?.length ?? 0,
    images: item.product?.imageUrls?.length ?? 0,
    condition: item.condition,
    quantity: item.availability?.shipToLocationAvailability?.quantity ?? null,
  })
  const client = createEbayClient(userId)
  const started = Date.now()
  try {
    await client.put(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, item, {
      headers: marketplaceId ? { 'X-EBAY-C-MARKETPLACE-ID': marketplaceId } : undefined,
    })
    log.info('Inventory item created/updated', { dur_ms: Date.now() - started })
  } catch (err) {
    const { summary, ctx } = describeEbayError(err)
    log.error('Failed to create inventory item', {
      ...ctx,
      dur_ms: Date.now() - started,
      err: summary,
    })
    throw err
  }
}

export async function createOffer(userId: string, offer: EbayOffer): Promise<string> {
  const log = withContext({ scope: 'ebay.inventory.offer', user_id: userId, sku: offer.sku })
  log.info('Creating offer', {
    category_id: offer.categoryId,
    marketplace: offer.marketplaceId,
    merchant_location_key: offer.merchantLocationKey,
    price: offer.pricingSummary?.price?.value,
    currency: offer.pricingSummary?.price?.currency,
    quantity: offer.availableQuantity,
    fulfillment_policy_id: offer.listingPolicies?.fulfillmentPolicyId,
    payment_policy_id: offer.listingPolicies?.paymentPolicyId,
    return_policy_id: offer.listingPolicies?.returnPolicyId,
  })
  const client = createEbayClient(userId)
  const started = Date.now()
  try {
    const res = await client.post<{ offerId: string }>('/sell/inventory/v1/offer', offer, {
      headers: {
        'X-EBAY-C-MARKETPLACE-ID': offer.marketplaceId,
      },
    })
    log.info('Offer created', { offer_id: res.data.offerId, dur_ms: Date.now() - started })
    return res.data.offerId
  } catch (err) {
    // 25002 is overloaded by eBay across many distinct conditions
    // ("duplicate SKU", "missing country", "missing aspects", …). Only handle
    // the duplicate-SKU case here; everything else must propagate unchanged
    // so the caller sees the real reason.
    const looksLikeDuplicateSku =
      isEbayErrorCode(err, 25002) &&
      (ebayErrorHasParam(err, 25002, 'sku') ||
        ebayErrorMessageMatches(err, 25002, /already\s+(exists|has).+offer|offer.+already\s+exists/i))

    if (looksLikeDuplicateSku) {
      log.warn('SKU already has offer — fetching existing', { error_id: 25002 })
      const listRes = await client.get<{ offers: Array<{ offerId: string }> }>(
        '/sell/inventory/v1/offer',
        { params: { sku: offer.sku } },
      )
      const existingOfferId = listRes.data.offers?.[0]?.offerId
      if (existingOfferId) {
        log.info('Updating existing offer', { offer_id: existingOfferId })
        await client.put(`/sell/inventory/v1/offer/${existingOfferId}`, offer)
        return existingOfferId
      }
    }
    const { summary, ctx } = describeEbayError(err)
    log.error('Failed to create offer', {
      ...ctx,
      dur_ms: Date.now() - started,
      err: summary,
    })
    throw err
  }
}

export async function updateOffer(
  userId: string,
  offerId: string,
  offer: EbayOffer,
): Promise<void> {
  const log = withContext({ scope: 'ebay.inventory.offer.update', user_id: userId, offer_id: offerId })
  log.info('Updating offer', { merchant_location_key: offer.merchantLocationKey })
  const client = createEbayClient(userId)
  await client.put(`/sell/inventory/v1/offer/${offerId}`, offer, {
    headers: {
      'X-EBAY-C-MARKETPLACE-ID': offer.marketplaceId,
    },
  })
}

/** Looks up the live offerId for a SKU. Returns null if the SKU has no offer. */
export async function getOfferIdBySku(userId: string, sku: string): Promise<string | null> {
  const client = createEbayClient(userId)
  const res = await client.get<{ offers: Array<{ offerId: string }> }>(
    '/sell/inventory/v1/offer',
    { params: { sku } },
  )
  return res.data.offers?.[0]?.offerId ?? null
}

/**
 * Fetches the offer exactly as eBay currently has it on file. Used as the
 * base for a targeted update (e.g. recategorize) instead of rebuilding the
 * offer from our own DB row, which can drift from a price/quantity change
 * made directly in Seller Hub since publish.
 */
export async function getOffer(userId: string, offerId: string): Promise<EbayOffer & { offerId: string }> {
  const client = createEbayClient(userId)
  const res = await client.get<EbayOffer & { offerId: string }>(`/sell/inventory/v1/offer/${offerId}`)
  return res.data
}

export async function publishOffer(userId: string, offerId: string, marketplaceId?: string): Promise<string> {
  const log = withContext({ scope: 'ebay.inventory.publish', user_id: userId, offer_id: offerId })
  log.info('Publishing offer')
  const client = createEbayClient(userId)
  const started = Date.now()
  try {
    const res = await client.post<{ listingId: string }>(
      `/sell/inventory/v1/offer/${offerId}/publish`,
      undefined,
      {
        headers: marketplaceId ? { 'X-EBAY-C-MARKETPLACE-ID': marketplaceId } : undefined,
      }
    )
    log.info('Offer published', {
      ebay_listing_id: res.data.listingId,
      dur_ms: Date.now() - started,
    })
    return res.data.listingId
  } catch (err) {
    const { summary, ctx } = describeEbayError(err)
    log.error('Failed to publish offer', {
      ...ctx,
      dur_ms: Date.now() - started,
      err: summary,
    })
    throw err
  }
}

export async function createAndPublishListing(
  params: CreateListingParams,
): Promise<{ listingId: string; listingUrl: string }> {
  const {
    userId, sku, title, description, price, currency,
    quantity, condition, conditionDescription, aspects, categoryId,
    fulfillmentPolicyId, paymentPolicyId, returnPolicyId, storeCategory,
    imageUrls,
  } = params

  const log = withContext({ scope: 'ebay.inventory', user_id: userId, sku })

  // Surface obviously-bad inputs *before* we burn an eBay API call. These were
  // the silent killers behind retries that always returned HTTP 400.
  const missing: string[] = []
  if (!fulfillmentPolicyId) missing.push('fulfillmentPolicyId')
  if (!paymentPolicyId) missing.push('paymentPolicyId')
  if (!returnPolicyId) missing.push('returnPolicyId')
  if (!categoryId) missing.push('categoryId')
  if (!title) missing.push('title')
  if (!Number.isFinite(price) || price <= 0) missing.push('price')
  if (missing.length > 0) {
    const err = new Error(
      `createAndPublishListing called with empty/invalid: ${missing.join(', ')}`,
    )
    log.error('Refusing to call eBay with invalid payload', { missing, title_len: title?.length ?? 0, price })
    throw err
  }

  log.info('createAndPublishListing START', {
    title_len: title.length,
    description_len: description.length,
    price,
    currency,
    quantity,
    condition,
    category_id: categoryId,
    images: imageUrls.length,
    fulfillment_policy_id: fulfillmentPolicyId,
    payment_policy_id: paymentPolicyId,
    return_policy_id: returnPolicyId,
  })

  const normalizedCondition = normalizeCondition(condition)
  if (normalizedCondition !== condition) {
    log.info('Normalized condition for Sell API', {
      raw: condition,
      normalized: normalizedCondition,
    })
  }

  const inventoryItem: EbayInventoryItem = {
    sku,
    product: {
      title,
      description,
      ...(aspects && Object.keys(aspects).length > 0 ? { aspects } : {}),
      ...(imageUrls.length > 0 ? { imageUrls } : {}),
    },
    condition: normalizedCondition,
    ...(conditionDescription ? { conditionDescription } : {}),
    availability: { shipToLocationAvailability: { quantity } },
  }

  const resolvedMarketplaceId = isMotorsCategoryId(categoryId)
    ? 'EBAY_MOTORS_US'
    : (process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US')

  await createOrUpdateInventoryItem(userId, sku, inventoryItem, resolvedMarketplaceId)

  // Resolve (or auto-create) the seller's inventory location. Without this
  // the Sell API rejects the offer with errorId=25002 "No <Item.Country>".
  const merchantLocationKey = await getOrCreateMerchantLocationKey(userId)
  log.info('Resolved merchantLocationKey', { merchant_location_key: merchantLocationKey })

  const offer: EbayOffer = {
    sku,
    marketplaceId: resolvedMarketplaceId,
    format: 'FIXED_PRICE',
    availableQuantity: quantity,
    categoryId,
    merchantLocationKey,
    listingPolicies: { fulfillmentPolicyId, paymentPolicyId, returnPolicyId },
    pricingSummary: { price: { value: price.toFixed(2), currency } },
    ...(storeCategory ? { storeCategoryNames: [storeCategory] } : {}),
  }

  const offerId = await createOffer(userId, offer)

  let listingId: string
  try {
    listingId = await publishOffer(userId, offerId, resolvedMarketplaceId)
  } catch (publishErr) {
    // Self-heal the publish failures that the prior layers can miss: the
    // memoized merchantLocationKey no longer refers to a usable location.
    // Two known shapes, both reported as the overloaded 25002:
    //   - "No <Item.Country> exists" — the location lost its country (e.g. a
    //     manual edit in Seller Hub, or it never had one and listLocations
    //     didn't expose that).
    //   - "Location information not found" — the key doesn't resolve at all,
    //     which is what you get after the app user reconnects a *different*
    //     eBay seller account: the cached key belongs to the old account.
    // Both are fixed the same way — invalidate, re-resolve, re-PUT the offer
    // with the new key, retry once. Matching on "location" too matters because
    // the cache has no TTL: without a retry the bad key would be re-sent on
    // every subsequent publish until the process restarted.
    const isStaleLocationError =
      isEbayErrorCode(publishErr, 25002) &&
      (ebayErrorHasParam(publishErr, 25002, 'Item.Country') ||
        ebayErrorMessageMatches(publishErr, 25002, /Item\.Country/i) ||
        ebayErrorMessageMatches(publishErr, 25002, /location/i))
    if (!isStaleLocationError) throw publishErr

    log.warn('publish failed with a location error — re-resolving location and retrying once', {
      offer_id: offerId,
      previous_merchant_location_key: merchantLocationKey,
      ebay_error: describeEbayError(publishErr).summary,
    })
    invalidateLocationCache(userId)
    const freshKey = await getOrCreateMerchantLocationKey(userId)
    if (freshKey !== merchantLocationKey) {
      log.info('Location resolved to a different key after invalidation', {
        from: merchantLocationKey,
        to: freshKey,
      })
    }
    await updateOffer(userId, offerId, { ...offer, merchantLocationKey: freshKey })
    listingId = await publishOffer(userId, offerId, resolvedMarketplaceId)
  }

  const domain = process.env.EBAY_ENVIRONMENT === 'sandbox' ? 'sandbox.ebay.com' : 'ebay.com'
  const listingUrl = `https://www.${domain}/itm/${listingId}`

  log.info('createAndPublishListing DONE', { ebay_listing_id: listingId, ebay_listing_url: listingUrl })
  return { listingId, listingUrl }
}

export async function endListing(userId: string, listingId: string) {
  const client = createEbayClient(userId)
  await client.post(`/sell/inventory/v1/offer/${listingId}/withdraw`)
}
