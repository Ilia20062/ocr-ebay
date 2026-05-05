import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { searchEbayProducts, selectBestMatch } from '@/lib/ebay/search'
import { autoCreateListing } from '@/lib/ebay/auto-list'
import { enqueueRetry } from '@/lib/retry'
import type { Json } from '@/types/supabase'

export const POST = withAuth(async (req, userId) => {
  const body = await req.json() as { ocr_result_id: string; final_code: string }
  if (!body.ocr_result_id || !body.final_code) return apiError('ocr_result_id and final_code required', 422)

  const db = getSupabaseAdminClient()

  // Verify ownership
  const { data: ocrResult } = await db
    .from('ocr_results')
    .select('id, images!inner(user_id)')
    .eq('id', body.ocr_result_id)
    .single()

  const rawOcr = ocrResult as unknown as { id: string; images: { user_id: string } } | null
  if (!rawOcr || rawOcr.images.user_id !== userId) return apiError('OCR result not found', 404)

  const { data: search, error } = await db.from('product_searches').insert({
    ocr_result_id: body.ocr_result_id,
    search_query: body.final_code,
    status: 'pending',
  }).select().single()

  if (error) return apiError('Failed to create search', 500)

  // Run search
  try {
    const items = await searchEbayProducts(userId, body.final_code)
    const best = selectBestMatch(items, body.final_code)

    await db.from('product_searches').update({
      status: items.length > 0 ? 'success' : 'no_results',
      result_count: items.length,
      results_raw: items as unknown as Json,
      selected_item_id: best?.itemId ?? null,
    }).eq('id', search.id)

    let listingResult;
    // Auto-create eBay listing if a matching product was found
    if (best) {
      listingResult = await autoCreateListing({ userId, searchId: search.id, bestMatch: best, imageUrls: [] })
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
    .select('*, ocr_results!inner(id, images!inner(user_id))', { count: 'exact' })
    .eq('ocr_results.images.user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  return NextResponse.json({ data, total: count, page })
})
