import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { createListingSchema } from '@/lib/validators/listing'
import { createAndPublishListing } from '@/lib/ebay/inventory'
import { describeEbayError } from '@/lib/ebay/error'
import { enqueueRetry } from '@/lib/retry'
import { withContext } from '@/lib/log'

export const POST = withAuth(async (req, userId) => {
  const body = await req.json()
  const parsed = createListingSchema.safeParse(body)
  if (!parsed.success) return apiError(parsed.error.message, 422)

  const db = getSupabaseAdminClient()
  const data = parsed.data

  // Verify search ownership (product_searches now hangs off the batch — see
  // migration 006 — so ownership resolves through upload_batches.user_id).
  const { data: search } = await db
    .from('product_searches')
    .select('id, upload_batches!inner(user_id)')
    .eq('id', data.search_id)
    .single()

  const rawSearch = search as unknown as { id: string; upload_batches: { user_id: string } } | null
  if (!rawSearch || rawSearch.upload_batches.user_id !== userId) return apiError('Search not found', 404)

  // Check eBay connection
  const { data: conn } = await db
    .from('ebay_connections')
    .select('id')
    .eq('user_id', userId)
    .single()

  if (!conn) return apiError('eBay not connected', 403, 'EBAY_NOT_CONNECTED')

  // Create draft listing record
  const sku = `SKU-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  const { data: listing, error } = await db.from('listings').insert({
    search_id: data.search_id,
    user_id: userId,
    title: data.title,
    description: data.description,
    price: data.price,
    currency: data.currency,
    quantity: data.quantity,
    condition: data.condition,
    category_id: data.category_id,
    sku,
    status: 'submitting',
    last_attempted_at: new Date().toISOString(),
  }).select().single()

  if (error) return apiError('Failed to create listing', 500)

  // Publish to eBay
  try {
    const { listingId, listingUrl } = await createAndPublishListing({
      userId,
      sku,
      title: data.title,
      description: data.description ?? '',
      price: data.price,
      currency: data.currency,
      quantity: data.quantity,
      condition: data.condition,
      categoryId: data.category_id,
      fulfillmentPolicyId: data.fulfillment_policy_id,
      paymentPolicyId: data.payment_policy_id,
      returnPolicyId: data.return_policy_id,
      imageUrls: [],
    })

    await db.from('listings').update({
      ebay_item_id: listingId,
      ebay_listing_url: listingUrl,
      status: 'active',
      listed_at: new Date().toISOString(),
    }).eq('id', listing.id)

    revalidatePath('/listings')
    revalidatePath('/dashboard')
    return NextResponse.json({ ...listing, ebay_item_id: listingId, ebay_listing_url: listingUrl, status: 'active' }, { status: 201 })
  } catch (err) {
    const { summary, ctx } = describeEbayError(err)
    withContext({
      scope: 'api.listings.create',
      user_id: userId,
      listing_id: listing.id,
      search_id: data.search_id,
      sku,
    }).error('Publish to eBay failed', { ...ctx, err: summary })

    await db.from('listings').update({
      status: 'failed',
      error_message: summary.slice(0, 2000),
    }).eq('id', listing.id)
    await enqueueRetry('listing', listing.id, summary)
    revalidatePath('/listings')
    return apiError(`eBay listing failed: ${summary}`, 502)
  }
})

export const GET = withAuth(async (req, userId) => {
  const db = getSupabaseAdminClient()
  const url = new URL(req.url)
  const page = parseInt(url.searchParams.get('page') ?? '1')
  const status = url.searchParams.get('status')
  const limit = 20
  const offset = (page - 1) * limit

  let query = db
    .from('listings')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (status) query = query.eq('status', status)

  const { data, count } = await query
  return NextResponse.json({ data, total: count, page })
})
