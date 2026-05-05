import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { searchEbayProducts, selectBestMatch } from '@/lib/ebay/search'
import type { Json } from '@/types/supabase'

export const POST = withAuth(async (_req, userId, params) => {
  const db = getSupabaseAdminClient()
  const { data } = await db
    .from('product_searches')
    .select('id, search_query, attempt_count, upload_batches!inner(user_id)')
    .eq('id', params!.id)
    .single()

  type SearchRetry = { id: string; search_query: string; attempt_count: number; upload_batches: { user_id: string } }
  const search = data as unknown as SearchRetry | null
  if (!search || search.upload_batches.user_id !== userId) return apiError('Not found', 404)

  await db.from('product_searches').update({ status: 'pending', attempt_count: search.attempt_count + 1 }).eq('id', params!.id)

  try {
    const items = await searchEbayProducts(userId, search.search_query)
    const best = selectBestMatch(items, search.search_query)
    await db.from('product_searches').update({
      status: items.length > 0 ? 'success' : 'no_results',
      result_count: items.length,
      results_raw: items as unknown as Json,
      selected_item_id: best?.itemId ?? null,
      error_message: null,
    }).eq('id', params!.id)
    return NextResponse.json({ success: true, found: items.length })
  } catch (err) {
    await db.from('product_searches').update({ status: 'failed', error_message: String(err) }).eq('id', params!.id)
    return apiError(`Retry failed: ${err}`, 500)
  }
})
