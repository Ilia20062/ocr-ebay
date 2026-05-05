import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { searchEbayProducts, selectBestMatch } from '@/lib/ebay/search'
import { autoCreateListing } from '@/lib/ebay/auto-list'
import { generateListingImageUrls } from '@/lib/ebay/image-urls'
import { enqueueRetry } from '@/lib/retry'
import type { Json } from '@/types/supabase'

export const POST = withAuth(async (req, userId) => {
  const body = await req.json() as { batch_id: string; final_code: string }
  if (!body.batch_id || !body.final_code) return apiError('batch_id and final_code required', 422)

  const db = getSupabaseAdminClient()

  const { data: batch } = await db
    .from('upload_batches')
    .select('id, user_id')
    .eq('id', body.batch_id)
    .single()

  if (!batch || batch.user_id !== userId) return apiError('Batch not found', 404)

  const { data: search, error } = await db.from('product_searches').insert({
    batch_id: body.batch_id,
    search_query: body.final_code,
    status: 'pending',
  }).select().single()

  if (error || !search) return apiError('Failed to create search', 500)

  try {
    const items = await searchEbayProducts(userId, body.final_code)
    const best = selectBestMatch(items, body.final_code)

    await db.from('product_searches').update({
      status: items.length > 0 ? 'success' : 'no_results',
      result_count: items.length,
      results_raw: items as unknown as Json,
      selected_item_id: best?.itemId ?? null,
    }).eq('id', search.id)

    let listingResult
    if (best) {
      const { data: imgs } = await db
        .from('images')
        .select('id, storage_path')
        .eq('batch_id', body.batch_id)
        .order('created_at', { ascending: true })
      const imageUrls = await generateListingImageUrls(db, imgs ?? [])
      listingResult = await autoCreateListing({ userId, searchId: search.id, bestMatch: best, imageUrls })
    }

    return NextResponse.json({ ...search, items, selected: best, listingResult }, { status: 201 })
  } catch (err) {
    await db.from('product_searches').update({ status: 'failed', error_message: String(err) }).eq('id', search.id)
    await enqueueRetry('product_search', search.id, String(err))
    return apiError(`Search failed: ${err}`, 500)
  }
})

export const GET = withAuth(async (req, userId) => {
  const db = getSupabaseAdminClient()
  const url = new URL(req.url)
  const page = parseInt(url.searchParams.get('page') ?? '1')
  const limit = 20
  const offset = (page - 1) * limit

  const { data, count } = await db
    .from('product_searches')
    .select('*, upload_batches!inner(user_id)', { count: 'exact' })
    .eq('upload_batches.user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  return NextResponse.json({ data, total: count, page })
})
