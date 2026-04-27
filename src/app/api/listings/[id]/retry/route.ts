import { NextRequest, NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { createAndPublishListing } from '@/lib/ebay/inventory'

export const POST = withAuth(async (_req, userId, params) => {
  const db = getSupabaseAdminClient()
  const { data: listing } = await db
    .from('listings')
    .select('*')
    .eq('id', params!.id)
    .eq('user_id', userId)
    .single()

  if (!listing) return apiError('Listing not found', 404)
  if (listing.status === 'active') return apiError('Listing already active', 409)

  await db.from('listings').update({
    status: 'submitting',
    attempt_count: listing.attempt_count + 1,
    last_attempted_at: new Date().toISOString(),
  }).eq('id', params!.id)

  try {
    const { listingId, listingUrl } = await createAndPublishListing({
      userId,
      sku: listing.sku ?? `SKU-${Date.now()}`,
      title: listing.title,
      description: listing.description ?? '',
      price: listing.price ?? 0,
      currency: listing.currency,
      quantity: listing.quantity,
      condition: listing.condition ?? 'USED_EXCELLENT',
      categoryId: listing.category_id ?? '1',
      fulfillmentPolicyId: '',
      paymentPolicyId: '',
      returnPolicyId: '',
    })

    await db.from('listings').update({
      ebay_item_id: listingId,
      ebay_listing_url: listingUrl,
      status: 'active',
      listed_at: new Date().toISOString(),
      error_message: null,
    }).eq('id', params!.id)

    return NextResponse.json({ success: true, ebay_item_id: listingId })
  } catch (err) {
    await db.from('listings').update({ status: 'failed', error_message: String(err) }).eq('id', params!.id)
    return apiError(`Retry failed: ${err}`, 502)
  }
})
