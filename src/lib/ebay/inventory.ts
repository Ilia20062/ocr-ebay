import { createEbayClient, isEbayErrorCode } from './client'
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
}

export async function createOrUpdateInventoryItem(
  userId: string,
  sku: string,
  item: EbayInventoryItem
) {
  console.log(`[inventory] Creating/updating inventory item: sku=${sku}`)
  console.log(`[inventory] Item payload: ${JSON.stringify(item)}`)
  const client = createEbayClient(userId)
  try {
    await client.put(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, item)
    console.log(`[inventory] ✅ Inventory item created/updated: ${sku}`)
  } catch (err) {
    let detail = String(err)
    if (err && typeof err === 'object' && 'response' in err) {
      const axiosErr = err as { response?: { status?: number; data?: unknown } }
      detail = `HTTP ${axiosErr.response?.status}: ${JSON.stringify(axiosErr.response?.data)}`
    }
    console.error(`[inventory] ❌ Failed to create inventory item: ${detail}`)
    throw err
  }
}

export async function createOffer(userId: string, offer: EbayOffer): Promise<string> {
  console.log(`[inventory] Creating offer: ${JSON.stringify(offer)}`)
  const client = createEbayClient(userId)
  try {
    const res = await client.post<{ offerId: string }>('/sell/inventory/v1/offer', offer)
    console.log(`[inventory] ✅ Offer created: offerId=${res.data.offerId}`)
    return res.data.offerId
  } catch (err) {
    // eBay error 25002: SKU already has an offer — fetch existing offer ID
    if (isEbayErrorCode(err, 25002)) {
      console.log(`[inventory] SKU already has offer, fetching existing...`)
      const listRes = await client.get<{ offers: Array<{ offerId: string }> }>(
        '/sell/inventory/v1/offer',
        { params: { sku: offer.sku } }
      )
      const existingOfferId = listRes.data.offers?.[0]?.offerId
      if (existingOfferId) {
        console.log(`[inventory] Updating existing offer: ${existingOfferId}`)
        await client.put(`/sell/inventory/v1/offer/${existingOfferId}`, offer)
        return existingOfferId
      }
    }
    let detail = String(err)
    if (err && typeof err === 'object' && 'response' in err) {
      const axiosErr = err as { response?: { status?: number; data?: unknown } }
      detail = `HTTP ${axiosErr.response?.status}: ${JSON.stringify(axiosErr.response?.data)}`
    }
    console.error(`[inventory] ❌ Failed to create offer: ${detail}`)
    throw err
  }
}

export async function publishOffer(userId: string, offerId: string): Promise<string> {
  console.log(`[inventory] Publishing offer: ${offerId}`)
  const client = createEbayClient(userId)
  try {
    const res = await client.post<{ listingId: string }>(
      `/sell/inventory/v1/offer/${offerId}/publish`
    )
    console.log(`[inventory] ✅ Offer published: listingId=${res.data.listingId}`)
    return res.data.listingId
  } catch (err) {
    let detail = String(err)
    if (err && typeof err === 'object' && 'response' in err) {
      const axiosErr = err as { response?: { status?: number; data?: unknown } }
      detail = `HTTP ${axiosErr.response?.status}: ${JSON.stringify(axiosErr.response?.data)}`
    }
    console.error(`[inventory] ❌ Failed to publish offer: ${detail}`)
    throw err
  }
}

export async function createAndPublishListing(params: CreateListingParams): Promise<{ listingId: string; listingUrl: string }> {
  const {
    userId, sku, title, description, price, currency,
    quantity, condition, categoryId,
    fulfillmentPolicyId, paymentPolicyId, returnPolicyId
  } = params

  console.log(`[inventory] === createAndPublishListing START ===`)
  console.log(`[inventory] params: sku=${sku}, title="${title}", price=${price} ${currency}, qty=${quantity}, condition=${condition}, category=${categoryId}`)
  console.log(`[inventory] policies: fulfillment=${fulfillmentPolicyId}, payment=${paymentPolicyId}, return=${returnPolicyId}`)

  const inventoryItem: EbayInventoryItem = {
    sku,
    product: { title, description },
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

  console.log(`[inventory] === createAndPublishListing DONE === url=${listingUrl}`)
  return { listingId, listingUrl }
}

export async function endListing(userId: string, listingId: string) {
  const client = createEbayClient(userId)
  await client.post(`/sell/inventory/v1/offer/${listingId}/withdraw`)
}
