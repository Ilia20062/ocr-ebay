import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { createAndPublishListing } from '@/lib/ebay/inventory'
import { getBusinessPolicies } from '@/lib/ebay/policies'
import { generateListingImageUrls } from '@/lib/ebay/image-urls'
import { describeEbayError } from '@/lib/ebay/error'
import { enqueueRetry } from '@/lib/retry'
import { withContext } from '@/lib/log'

export const POST = withAuth(async (_req, userId, params) => {
  const listingId = params!.id
  const log = withContext({ scope: 'api.listings.retry', user_id: userId, listing_id: listingId })
  const db = getSupabaseAdminClient()

  const { data: listing, error: lookupErr } = await db
    .from('listings')
    .select('*')
    .eq('id', listingId)
    .eq('user_id', userId)
    .single()

  if (lookupErr || !listing) {
    log.warn('Listing lookup failed', { err: lookupErr?.message ?? 'not found' })
    return apiError('Listing not found', 404)
  }
  if (listing.status === 'active') {
    log.info('Listing already active — skipping retry')
    return apiError('Listing already active', 409)
  }
  if (!listing.title || !listing.price || !listing.category_id) {
    log.error('Listing missing required fields for retry', {
      has_title: !!listing.title,
      has_price: listing.price !== null,
      has_category: !!listing.category_id,
    })
    return apiError('Listing missing required fields (title, price, category)', 422)
  }

  const sku = listing.sku ?? `SKU-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  const retryLog = withContext({
    scope: 'api.listings.retry',
    user_id: userId,
    listing_id: listingId,
    search_id: listing.search_id,
    sku,
  })

  await db.from('listings').update({
    status: 'submitting',
    attempt_count: (listing.attempt_count ?? 0) + 1,
    last_attempted_at: new Date().toISOString(),
    error_message: null,
  }).eq('id', listingId)

  // Resolve business policies — the previous version of this route sent empty
  // strings and eBay rejected every retry with HTTP 400.
  let policies: Awaited<ReturnType<typeof getBusinessPolicies>>
  try {
    policies = await getBusinessPolicies(userId)
    retryLog.info('Fetched business policies', {
      fulfillment_policy_id: policies.fulfillmentPolicyId,
      payment_policy_id: policies.paymentPolicyId,
      return_policy_id: policies.returnPolicyId,
    })
  } catch (err) {
    const { summary, ctx } = describeEbayError(err)
    retryLog.error('Failed to fetch business policies', { ...ctx, err: summary })
    await db.from('listings').update({
      status: 'failed',
      error_message: `Policies: ${summary}`.slice(0, 2000),
    }).eq('id', listingId)
    revalidatePath('/listings')
    return apiError(`Retry failed: ${summary}`, 502)
  }

  // Re-derive image URLs from the originating batch so retried listings keep
  // their photos. The original retry implementation sent `imageUrls: []`.
  let imageUrls: string[] = []
  if (listing.search_id) {
    const { data: search, error: searchErr } = await db
      .from('product_searches')
      .select('batch_id')
      .eq('id', listing.search_id)
      .single()

    if (searchErr) {
      retryLog.warn('Could not load originating search for retry — proceeding without images', {
        pg_code: searchErr.code,
        err: searchErr.message,
      })
    } else if (search?.batch_id) {
      const { data: imgs, error: imgErr } = await db
        .from('images')
        .select('id, storage_path')
        .eq('batch_id', search.batch_id)
        .order('created_at', { ascending: true })

      if (imgErr) {
        retryLog.warn('Could not load images for retry — proceeding without', {
          batch_id: search.batch_id,
          err: imgErr.message,
        })
      } else {
        imageUrls = await generateListingImageUrls(db, imgs ?? [])
        retryLog.info('Re-derived image URLs for retry', {
          batch_id: search.batch_id,
          images: imageUrls.length,
        })
      }
    }
  }

  try {
    const { listingId: ebayListingId, listingUrl } = await createAndPublishListing({
      userId,
      sku,
      title: listing.title,
      description: listing.description ?? '',
      price: listing.price,
      currency: listing.currency,
      quantity: listing.quantity,
      condition: listing.condition ?? 'USED_EXCELLENT',
      categoryId: listing.category_id,
      fulfillmentPolicyId: policies.fulfillmentPolicyId,
      paymentPolicyId: policies.paymentPolicyId,
      returnPolicyId: policies.returnPolicyId,
      imageUrls,
    })

    // Note: listings.Update type omits `sku`; if listing.sku was null we used
    // a fresh SKU for this attempt and the eBay-side inventory item is keyed
    // by it. Subsequent retries will generate another SKU, which is fine —
    // each retry creates a distinct eBay offer.
    await db.from('listings').update({
      ebay_item_id: ebayListingId,
      ebay_listing_url: listingUrl,
      status: 'active',
      listed_at: new Date().toISOString(),
      error_message: null,
    }).eq('id', listingId)

    retryLog.info('Retry succeeded — listing now active', {
      ebay_listing_id: ebayListingId,
      ebay_listing_url: listingUrl,
    })

    revalidatePath('/listings')
    revalidatePath('/dashboard')
    return NextResponse.json({ success: true, ebay_item_id: ebayListingId, ebay_listing_url: listingUrl })
  } catch (err) {
    const { summary, ctx } = describeEbayError(err)
    retryLog.error('Retry publish failed', { ...ctx, err: summary })

    await db.from('listings').update({
      status: 'failed',
      error_message: summary.slice(0, 2000),
    }).eq('id', listingId)

    await enqueueRetry('listing', listingId, summary)
    revalidatePath('/listings')
    return apiError(`Retry failed: ${summary}`, 502)
  }
})
