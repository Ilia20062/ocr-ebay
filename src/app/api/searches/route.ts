import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { searchEbayProducts, selectBestMatch } from '@/lib/ebay/search'
import { autoCreateDraftListing } from '@/lib/ebay/auto-list'
import { generateListingImageUrls } from '@/lib/ebay/image-urls'
import { enqueueRetry } from '@/lib/retry'
import { withContext } from '@/lib/log'
import type { Json } from '@/types/supabase'

interface AxiosLikeError {
  response?: { status?: number; data?: unknown }
  message?: string
  code?: string
}

/** Coerce an unknown thrown value (often an axios error with a JSON response) into a useful string. */
function describeError(err: unknown): { summary: string; status?: number; body?: unknown } {
  if (err && typeof err === 'object' && ('response' in err || 'code' in err || 'message' in err)) {
    const e = err as AxiosLikeError
    const status = e.response?.status
    const data = e.response?.data
    if (status !== undefined) {
      return {
        summary: `HTTP ${status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`,
        status,
        body: data,
      }
    }
    if (e.message) return { summary: e.message }
  }
  if (err instanceof Error) return { summary: err.message }
  return { summary: String(err) }
}

export const POST = withAuth(async (req, userId) => {
  const log = withContext({ scope: 'api.searches.create', user_id: userId })

  let body: { batch_id?: string; final_code?: string }
  try {
    body = (await req.json()) as { batch_id?: string; final_code?: string }
  } catch (err) {
    log.warn('Invalid JSON body', { err })
    return apiError('Invalid JSON body', 400)
  }

  if (!body.batch_id || !body.final_code) {
    log.warn('Missing batch_id or final_code', { has_batch: !!body.batch_id, has_code: !!body.final_code })
    return apiError('batch_id and final_code required', 422)
  }

  const db = getSupabaseAdminClient()
  const reqLog = withContext({
    scope: 'api.searches.create',
    user_id: userId,
    batch_id: body.batch_id,
    query: body.final_code,
  })

  const { data: batch, error: batchErr } = await db
    .from('upload_batches')
    .select('id, user_id')
    .eq('id', body.batch_id)
    .single()

  if (batchErr || !batch) {
    reqLog.warn('Batch lookup failed', { err: batchErr?.message ?? 'not found' })
    return apiError('Batch not found', 404)
  }
  if (batch.user_id !== userId) {
    reqLog.warn('Batch belongs to a different user — refusing', { owner: batch.user_id })
    return apiError('Batch not found', 404)
  }

  const { data: search, error: insertErr } = await db.from('product_searches').insert({
    batch_id: body.batch_id,
    search_query: body.final_code,
    status: 'pending',
  }).select().single()

  if (insertErr || !search) {
    reqLog.error('Failed to create product_searches row', {
      pg_code: insertErr?.code,
      err: insertErr?.message ?? 'unknown',
    })
    return apiError('Failed to create search', 500)
  }

  const searchLog = withContext({
    scope: 'api.searches.create',
    user_id: userId,
    batch_id: body.batch_id,
    search_id: search.id,
    query: body.final_code,
  })

  searchLog.info('Running eBay search')
  const searchStart = Date.now()

  try {
    const items = await searchEbayProducts(userId, body.final_code)
    const best = selectBestMatch(items, body.final_code)
    const searchDur = Date.now() - searchStart

    searchLog.info('eBay search completed', {
      result_count: items.length,
      best_item_id: best?.itemId ?? null,
      best_title: best?.title?.slice(0, 80) ?? null,
      dur_ms: searchDur,
    })

    const { error: updateErr } = await db.from('product_searches').update({
      status: items.length > 0 ? 'success' : 'no_results',
      result_count: items.length,
      results_raw: items as unknown as Json,
      selected_item_id: best?.itemId ?? null,
    }).eq('id', search.id)
    if (updateErr) {
      searchLog.error('Failed to persist search results', {
        pg_code: updateErr.code,
        err: updateErr.message,
      })
    }

    let listingResult
    if (best) {
      const { data: imgs, error: imgErr } = await db
        .from('images')
        .select('id, storage_path')
        .eq('batch_id', body.batch_id)
        .order('is_label_candidate', { ascending: true })
        .order('created_at', { ascending: true })

      if (imgErr) {
        searchLog.warn('Failed to load images for listing', { err: imgErr.message })
      }

      const imageUrls = await generateListingImageUrls(db, imgs ?? [])
      searchLog.info('Image URLs prepared', { images: imageUrls.length })

      listingResult = await autoCreateDraftListing({
        userId,
        searchId: search.id,
        batchId: body.batch_id,
        bestMatch: best,
        imageUrls,
      })

      if (!listingResult.success) {
        searchLog.warn('Draft creation returned failure', { err: listingResult.error })
      }
    } else {
      searchLog.warn('No best match — skipping auto-list')
    }

    return NextResponse.json({ ...search, items, selected: best, listingResult }, { status: 201 })
  } catch (err) {
    const { summary, status, body: errBody } = describeError(err)
    searchLog.error('eBay search threw', {
      status_code: status,
      body_preview: typeof errBody === 'string' ? errBody.slice(0, 500) : JSON.stringify(errBody ?? {}).slice(0, 500),
      err: summary,
      dur_ms: Date.now() - searchStart,
    })

    await db.from('product_searches').update({
      status: 'failed',
      error_message: summary.slice(0, 2000),
    }).eq('id', search.id)
    await enqueueRetry('product_search', search.id, summary)
    return apiError(`Search failed: ${summary}`, 500)
  }
})

export const GET = withAuth(async (req, userId) => {
  const db = getSupabaseAdminClient()
  const url = new URL(req.url)
  const page = parseInt(url.searchParams.get('page') ?? '1')
  const limit = 20
  const offset = (page - 1) * limit

  const { data, count, error } = await db
    .from('product_searches')
    .select('*, upload_batches!inner(user_id)', { count: 'exact' })
    .eq('upload_batches.user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) {
    withContext({ scope: 'api.searches.list', user_id: userId }).error('Failed to list searches', {
      pg_code: error.code,
      err: error.message,
    })
    return apiError('Failed to list searches', 500)
  }

  return NextResponse.json({ data, total: count, page })
})
