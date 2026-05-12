import { createEbayClient, isEbayErrorCode } from './client'
import { describeEbayError } from './error'
import { withContext } from '@/lib/log'
import type { EbayInventoryItem, EbayOffer } from '@/types/ebay'

interface CreateListingParams {
  userId: string
  sku: string
  title: string
  description: string
  price: number
  currency: string
  quantity: number
  condition: string
  categoryId: string
  fulfillmentPolicyId: string
  paymentPolicyId: string
  returnPolicyId: string
  imageUrls: string[]
}

export async function createOrUpdateInventoryItem(
  userId: string,
  sku: string,
  item: EbayInventoryItem,
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
    await client.put(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, item)
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
    const res = await client.post<{ offerId: string }>('/sell/inventory/v1/offer', offer)
    log.info('Offer created', { offer_id: res.data.offerId, dur_ms: Date.now() - started })
    return res.data.offerId
  } catch (err) {
    // eBay error 25002: SKU already has an offer — fetch existing offer ID and update it.
    if (isEbayErrorCode(err, 25002)) {
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

export async function publishOffer(userId: string, offerId: string): Promise<string> {
  const log = withContext({ scope: 'ebay.inventory.publish', user_id: userId, offer_id: offerId })
  log.info('Publishing offer')
  const client = createEbayClient(userId)
  const started = Date.now()
  try {
    const res = await client.post<{ listingId: string }>(
      `/sell/inventory/v1/offer/${offerId}/publish`,
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
    quantity, condition, categoryId,
    fulfillmentPolicyId, paymentPolicyId, returnPolicyId,
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

  const inventoryItem: EbayInventoryItem = {
    sku,
    product: {
      title,
      description,
      ...(imageUrls.length > 0 ? { imageUrls } : {}),
    },
    condition: condition.toUpperCase().replace(/\s/g, '_'),
    availability: { shipToLocationAvailability: { quantity } },
  }

  await createOrUpdateInventoryItem(userId, sku, inventoryItem)

  const offer: EbayOffer = {
    sku,
    marketplaceId: process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US',
    format: 'FIXED_PRICE',
    availableQuantity: quantity,
    categoryId,
    listingPolicies: { fulfillmentPolicyId, paymentPolicyId, returnPolicyId },
    pricingSummary: { price: { value: price.toFixed(2), currency } },
  }

  const offerId = await createOffer(userId, offer)
  const listingId = await publishOffer(userId, offerId)
  const domain = process.env.EBAY_ENVIRONMENT === 'sandbox' ? 'sandbox.ebay.com' : 'ebay.com'
  const listingUrl = `https://www.${domain}/itm/${listingId}`

  log.info('createAndPublishListing DONE', { ebay_listing_id: listingId, ebay_listing_url: listingUrl })
  return { listingId, listingUrl }
}

export async function endListing(userId: string, listingId: string) {
  const client = createEbayClient(userId)
  await client.post(`/sell/inventory/v1/offer/${listingId}/withdraw`)
}
