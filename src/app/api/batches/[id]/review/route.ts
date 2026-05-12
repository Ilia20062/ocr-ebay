import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { batchReviewSchema } from '@/lib/validators/upload'
import { searchEbayProducts, selectBestMatch } from '@/lib/ebay/search'
import { autoCreateListing, type AutoListResult } from '@/lib/ebay/auto-list'
import { generateListingImageUrls } from '@/lib/ebay/image-urls'
import { enqueueRetry } from '@/lib/retry'
import { withContext } from '@/lib/log'
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

  // Reuse an existing search row for this batch (e.g. left over from a prior failed attempt).
  // If none exists, create one. Either way we end up with a single row per batch.
  const { data: existingSearch } = await db
    .from('product_searches')
    .select('*')
    .eq('batch_id', batchId)
    .maybeSingle()

  let search = existingSearch
  if (search) {
    debug(`Reusing existing product_searches row ${search.id} (status=${search.status}, attempt_count=${search.attempt_count})`)
    const { data: updated, error: updateErr } = await db
      .from('product_searches')
      .update({
        search_query: finalCode,
        status: 'pending',
        attempt_count: (search.attempt_count ?? 1) + 1,
        error_message: null,
      })
      .eq('id', search.id)
      .select()
      .single()
    if (updateErr || !updated) {
      debug(`Failed to reset product_searches row: ${updateErr?.message ?? 'unknown'}`)
      await db.from('upload_batches').update({ status: 'awaiting_review' }).eq('id', batchId)
      return NextResponse.json({ success: true, searchResult: 'search_error', debugLog })
    }
    search = updated
  } else {
    const { data: created, error: searchErr } = await db
      .from('product_searches')
      .insert({ batch_id: batchId, search_query: finalCode, status: 'pending' })
      .select()
      .single()
    if (searchErr || !created) {
      debug(`Failed to create product_searches row: ${searchErr?.message ?? 'unknown'}`)
      await db.from('upload_batches').update({ status: 'awaiting_review' }).eq('id', batchId)
      return NextResponse.json({ success: true, searchResult: 'search_error', debugLog })
    }
    search = created
  }

  let searchResult: 'found' | 'not_found' | 'no_code' | 'search_error' = 'no_code'
  let listingResult: AutoListResult | undefined
  const searchDebug: { itemCount?: number; bestMatchTitle?: string; bestMatchId?: string } = {}

  try {
    debug(`Calling searchEbayProducts(query="${finalCode}")`)
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
        batchId,
        bestMatch: best,
        imageUrls,
      })

      // Only mark listed/failed when an actual listing was attempted.
      await db
        .from('upload_batches')
        .update({ status: listingResult.success ? 'listed' : 'awaiting_review' })
        .eq('id', batchId)
      if (!listingResult.success) {
        debug(`Listing failed; batch left at awaiting_review so you can retry.`)
      }

      // Invalidate caches so /listings shows the new row on the next nav and
      // /dashboard counts update. Without this the App Router serves the stale
      // client-side cache and the user sees an empty listings page.
      revalidatePath('/listings')
      revalidatePath('/dashboard')
      withContext({
        scope: 'api.batches.review',
        user_id: userId,
        batch_id: batchId,
        search_id: search.id,
      }).info('Revalidated /listings and /dashboard after auto-list', {
        listing_success: listingResult.success,
        listing_id: listingResult.listingId,
        listing_url: listingResult.listingUrl,
        err: listingResult.error,
      })
    } else {
      // No match on eBay — keep the batch reviewable so the user can override or discard.
      searchResult = 'not_found'
      await db.from('upload_batches').update({ status: 'awaiting_review' }).eq('id', batchId)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error && err.stack ? err.stack.split('\n').slice(0, 6).join('\n') : ''
    debug(`Search/list error: ${msg}`)
    if (stack) debug(`Stack:\n${stack}`)
    searchResult = 'search_error'
    await enqueueRetry('product_search', search.id, msg)
    // Leave batch in awaiting_review on transient failure so the user can retry.
    await db.from('upload_batches').update({ status: 'awaiting_review' }).eq('id', batchId)
  }

  // /review reflects batch state (we just changed it); the dashboard counts
  // searches & batches and should also refresh.
  revalidatePath('/review')
  revalidatePath('/batches')
  revalidatePath('/dashboard')

  return NextResponse.json({
    success: true,
    searchResult,
    searchDebug,
    listingResult,
    debugLog,
  })
})
