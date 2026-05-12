import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { searchEbayProducts, selectBestMatch } from '@/lib/ebay/search'
import { withContext } from '@/lib/log'
import type { Json } from '@/types/supabase'

interface AxiosLikeError {
  response?: { status?: number; data?: unknown }
  message?: string
}

function describeError(err: unknown): { summary: string; status?: number; body?: unknown } {
  if (err && typeof err === 'object' && 'response' in err) {
    const e = err as AxiosLikeError
    const status = e.response?.status
    const data = e.response?.data
    return {
      summary: `HTTP ${status ?? '?'}: ${typeof data === 'string' ? data : JSON.stringify(data)}`,
      status,
      body: data,
    }
  }
  if (err instanceof Error) return { summary: err.message }
  return { summary: String(err) }
}

export const POST = withAuth(async (_req, userId, params) => {
  const searchId = params!.id
  const log = withContext({ scope: 'api.searches.retry', user_id: userId, search_id: searchId })
  const db = getSupabaseAdminClient()

  const { data, error: lookupErr } = await db
    .from('product_searches')
    .select('id, search_query, attempt_count, upload_batches!inner(user_id)')
    .eq('id', searchId)
    .single()

  type SearchRetry = {
    id: string
    search_query: string
    attempt_count: number
    upload_batches: { user_id: string }
  }
  const search = data as unknown as SearchRetry | null

  if (lookupErr || !search) {
    log.warn('Search lookup failed', { err: lookupErr?.message ?? 'not found' })
    return apiError('Not found', 404)
  }
  if (search.upload_batches.user_id !== userId) {
    log.warn('Search belongs to a different user — refusing', { owner: search.upload_batches.user_id })
    return apiError('Not found', 404)
  }

  const nextAttempt = (search.attempt_count ?? 0) + 1
  log.info('Retrying search', { attempt: nextAttempt, query: search.search_query })

  const { error: pendingErr } = await db.from('product_searches').update({
    status: 'pending',
    attempt_count: nextAttempt,
  }).eq('id', searchId)
  if (pendingErr) {
    log.error('Failed to mark search as pending', { pg_code: pendingErr.code, err: pendingErr.message })
  }

  const started = Date.now()
  try {
    const items = await searchEbayProducts(userId, search.search_query)
    const best = selectBestMatch(items, search.search_query)
    const durMs = Date.now() - started

    log.info('eBay search completed', {
      attempt: nextAttempt,
      result_count: items.length,
      best_item_id: best?.itemId ?? null,
      dur_ms: durMs,
    })

    const { error: updateErr } = await db.from('product_searches').update({
      status: items.length > 0 ? 'success' : 'no_results',
      result_count: items.length,
      results_raw: items as unknown as Json,
      selected_item_id: best?.itemId ?? null,
      error_message: null,
    }).eq('id', searchId)
    if (updateErr) {
      log.error('Failed to persist retry results', { pg_code: updateErr.code, err: updateErr.message })
    }

    return NextResponse.json({ success: true, found: items.length, attempt: nextAttempt })
  } catch (err) {
    const { summary, status, body } = describeError(err)
    log.error('Retry search threw', {
      attempt: nextAttempt,
      status_code: status,
      body_preview: typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body ?? {}).slice(0, 500),
      err: summary,
      dur_ms: Date.now() - started,
    })

    await db.from('product_searches').update({
      status: 'failed',
      error_message: summary.slice(0, 2000),
    }).eq('id', searchId)
    return apiError(`Retry failed: ${summary}`, 500)
  }
})
