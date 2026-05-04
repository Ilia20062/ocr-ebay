import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { createAndPublishListing } from './inventory'
import { getBusinessPolicies } from './policies'
import { enqueueRetry } from '@/lib/retry'
import type { EbayItemSummary } from '@/types/ebay'

interface AutoListParams {
  userId: string
  searchId: string
  bestMatch: EbayItemSummary
}

/**
 * Automatically creates and publishes an eBay listing from a product search result.
 * Called after a successful product search during the review flow.
 *
 * Steps:
 * 1. Fetch seller's eBay business policies
 * 2. Create a draft listing record in the database
 * 3. Publish to eBay via Inventory API
 * 4. Update the listing record with the eBay item ID and URL
 *
 * On failure, the listing is marked as 'failed' and enqueued for retry.
 */
export async function autoCreateListing({ userId, searchId, bestMatch }: AutoListParams) {
  const db = getSupabaseAdminClient()
  const sku = `SKU-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`

  const title = bestMatch.title.slice(0, 80) // eBay max 80 chars
  const price = parseFloat(bestMatch.price.value)
  const currency = bestMatch.price.currency || 'USD'
  const condition = bestMatch.condition || 'USED_EXCELLENT'
  const categoryId = bestMatch.categories?.[0]?.categoryId || ''

  // Create draft listing in DB first
  const { data: listing, error: insertError } = await db.from('listings').insert({
    search_id: searchId,
    user_id: userId,
    title,
    description: `${title} - Listed automatically via OCR-CRM`,
    price,
    currency,
    quantity: 1,
    condition,
    category_id: categoryId,
    sku,
    status: 'submitting',
    last_attempted_at: new Date().toISOString(),
  }).select().single()

  if (insertError || !listing) {
    console.error('[auto-list] Failed to create draft listing:', insertError)
    return
  }

  try {
    // Fetch business policies from eBay
    const policies = await getBusinessPolicies(userId)

    // Publish to eBay
    const { listingId, listingUrl } = await createAndPublishListing({
      userId,
      sku,
      title,
      description: `${title} - Listed automatically via OCR-CRM`,
      price,
      currency,
      quantity: 1,
      condition,
      categoryId,
      fulfillmentPolicyId: policies.fulfillmentPolicyId,
      paymentPolicyId: policies.paymentPolicyId,
      returnPolicyId: policies.returnPolicyId,
    })

    // Mark as active
    await db.from('listings').update({
      ebay_item_id: listingId,
      ebay_listing_url: listingUrl,
      status: 'active',
      listed_at: new Date().toISOString(),
    }).eq('id', listing.id)

    console.log(`[auto-list] ✅ Listed on eBay: ${listingUrl}`)
  } catch (err) {
    const errMsg = String(err)
    console.error(`[auto-list] ❌ Failed to list on eBay:`, errMsg)

    await db.from('listings').update({
      status: 'failed',
      error_message: errMsg,
    }).eq('id', listing.id)

    await enqueueRetry('listing', listing.id, errMsg)
  }
}
