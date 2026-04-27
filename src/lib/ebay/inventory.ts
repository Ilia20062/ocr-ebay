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
  const client = createEbayClient(userId)
  await client.put(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, item)
}

export async function createOffer(userId: string, offer: EbayOffer): Promise<string> {
  const client = createEbayClient(userId)
  try {
    const res = await client.post<{ offerId: string }>('/sell/inventory/v1/offer', offer)
    return res.data.offerId
  } catch (err) {
    // eBay error 25002: SKU already has an offer — fetch existing offer ID
    if (isEbayErrorCode(err, 25002)) {
      const listRes = await client.get<{ offers: Array<{ offerId: string }> }>(
        '/sell/inventory/v1/offer',
        { params: { sku: offer.sku } }
      )
      const existingOfferId = listRes.data.offers?.[0]?.offerId
      if (existingOfferId) {
        await client.put(`/sell/inventory/v1/offer/${existingOfferId}`, offer)
        return existingOfferId
      }
    }
    throw err
  }
}

export async function publishOffer(userId: string, offerId: string): Promise<string> {
  const client = createEbayClient(userId)
  const res = await client.post<{ listingId: string }>(
    `/sell/inventory/v1/offer/${offerId}/publish`
  )
  return res.data.listingId
}

export async function createAndPublishListing(params: CreateListingParams): Promise<{ listingId: string; listingUrl: string }> {
  const {
    userId, sku, title, description, price, currency,
    quantity, condition, categoryId,
    fulfillmentPolicyId, paymentPolicyId, returnPolicyId
  } = params

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

  return { listingId, listingUrl }
}

export async function endListing(userId: string, listingId: string) {
  const client = createEbayClient(userId)
  await client.post(`/sell/inventory/v1/offer/${listingId}/withdraw`)
}
