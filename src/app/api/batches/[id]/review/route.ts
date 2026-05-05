import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { batchReviewSchema } from '@/lib/validators/upload'
import { searchEbayProducts, selectBestMatch } from '@/lib/ebay/search'
import { autoCreateListing, type AutoListResult } from '@/lib/ebay/auto-list'
import { generateListingImageUrls } from '@/lib/ebay/image-urls'
import { enqueueRetry } from '@/lib/retry'
import type { Json } from '@/types/supabase'

export const PATCH = withAuth(async (req, userId, params) => {
  const debugLog: string[] = []
  const debug = (msg: string) => {
    const ts = new Date().toISOString()
    debugLog.push(`[${ts}] ${msg}`)
    console.log(`[batch-review] ${msg}`)
  }

  const batchId = params!.id
  debug(`PATCH /api/batches/${batchId}/review — user=${userId}`)

  const body = await req.json()
  const parsed = batchReviewSchema.safeParse(body)
  if (!parsed.success) return apiError(parsed.error.message, 422)
  const { action, manual_override } = parsed.data

  const db = getSupabaseAdminClient()

  const { data: batch } = await db
    .from('upload_batches')
    .select('*')
    .eq('id', batchId)
    .eq('user_id', userId)
    .single()

  if (!batch) return apiError('Batch not found', 404)
  if (batch.status !== 'awaiting_review') {
    return apiError(`Batch is in status ${batch.status}; review not allowed`, 409)
  }

  if (action === 'discard') {
    await db.from('upload_batches').update({ status: 'discarded' }).eq('id', batchId)
    debug('Batch discarded')
    return NextResponse.json({ success: true, discarded: true, debugLog })
  }

  if (action === 'approve' && !batch.final_code) {
    return apiError('Cannot approve — no code detected. Use override.', 422)
  }

  const finalCode = action === 'override' ? manual_override! : batch.final_code!
  debug(`Approved code: "${finalCode}"`)

  await db
    .from('upload_batches')
    .update({ status: 'approved', final_code: finalCode })
    .eq('id', batchId)

  const { data: images } = await db
    .from('images')
    .select('id, storage_path')
    .eq('batch_id', batchId)
    .order('created_at', { ascending: true })

  const groupImages = images ?? []
  debug(`${groupImages.length} image(s) in group`)

  const { data: search, error: searchErr } = await db
    .from('product_searches')
    .insert({ batch_id: batchId, search_query: finalCode, status: 'pending' })
    .select()
    .single()

  if (searchErr || !search) {
    debug(`Failed to create product_searches row: ${searchErr?.message ?? 'unknown'}`)
    await db.from('upload_batches').update({ status: 'failed' }).eq('id', batchId)
    return NextResponse.json({
      success: true,
      searchResult: 'search_error',
      debugLog,
    })
  }

  let searchResult: 'found' | 'not_found' | 'no_code' | 'search_error' = 'no_code'
  let listingResult: AutoListResult | undefined
  const searchDebug: { itemCount?: number; bestMatchTitle?: string; bestMatchId?: string } = {}

  try {
    const items = await searchEbayProducts(userId, finalCode)
    debug(`eBay returned ${items.length} item(s)`)
    searchDebug.itemCount = items.length

    const best = selectBestMatch(items, finalCode)

    await db
      .from('product_searches')
      .update({
        status: items.length > 0 ? 'success' : 'no_results',
        result_count: items.length,
        results_raw: items as unknown as Json,
        selected_item_id: best?.itemId ?? null,
      })
      .eq('id', search.id)

    if (best) {
      searchDebug.bestMatchTitle = best.title
      searchDebug.bestMatchId = best.itemId
      searchResult = 'found'

      const imageUrls = await generateListingImageUrls(db, groupImages)
      debug(`Signed ${imageUrls.length} image URL(s) for eBay`)

      listingResult = await autoCreateListing({
        userId,
        searchId: search.id,
        bestMatch: best,
        imageUrls,
      })

      await db
        .from('upload_batches')
        .update({ status: listingResult.success ? 'listed' : 'failed' })
        .eq('id', batchId)
    } else {
      searchResult = 'not_found'
      await db.from('upload_batches').update({ status: 'failed' }).eq('id', batchId)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    debug(`Search/list error: ${msg}`)
    searchResult = 'search_error'
    await enqueueRetry('product_search', search.id, msg)
    await db.from('upload_batches').update({ status: 'failed' }).eq('id', batchId)
  }

  return NextResponse.json({
    success: true,
    searchResult,
    searchDebug,
    listingResult,
    debugLog,
  })
})
