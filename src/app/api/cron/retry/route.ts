import { NextResponse } from 'next/server'
import { withCron } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { runOcr } from '@/lib/ocr'
import { searchEbayProducts, selectBestMatch } from '@/lib/ebay/search'
import { markRetrySucceeded, markRetryExhausted } from '@/lib/retry'
import type { Json, Database } from '@/types/supabase'

export const POST = withCron(async () => {
  const db = getSupabaseAdminClient()

  const { data: jobs } = await db
    .from('retry_queue')
    .select('*')
    .eq('status', 'pending')
    .lte('next_retry_at', new Date().toISOString())
    .order('next_retry_at')
    .limit(20)

  if (!jobs || jobs.length === 0) return NextResponse.json({ processed: 0 })

  let succeeded = 0
  let failed = 0

  for (const job of jobs) {
    await db.from('retry_queue').update({ status: 'processing' }).eq('id', job.id)

    try {
      if (job.entity_type === 'image') {
        await retryOcr(job.entity_id, db)
      } else if (job.entity_type === 'product_search') {
        await retrySearch(job.entity_id, db)
      }

      await markRetrySucceeded(job.entity_id)
      succeeded++
    } catch {
      const nextAttempt = job.attempt_count + 1
      if (nextAttempt >= job.max_attempts) {
        await markRetryExhausted(job.entity_id)
      } else {
        const delays = [5, 15, 60]
        const delayMin = delays[Math.min(nextAttempt, delays.length - 1)]
        const nextRetry = new Date(Date.now() + delayMin * 60 * 1000).toISOString()
        await db.from('retry_queue').update({
          status: 'pending',
          attempt_count: nextAttempt,
          next_retry_at: nextRetry,
        }).eq('id', job.id)
      }
      failed++
    }
  }

  return NextResponse.json({ processed: jobs.length, succeeded, failed })
})

async function retryOcr(imageId: string, db: ReturnType<typeof getSupabaseAdminClient>) {
  const { data: image } = await db.from('images').select('storage_path, user_id').eq('id', imageId).single()
  if (!image) throw new Error('Image not found')

  const { data: signedUrl } = await db.storage.from('images').createSignedUrl(image.storage_path, 300)
  if (!signedUrl?.signedUrl) throw new Error('Cannot get signed URL')

  const result = await runOcr(signedUrl.signedUrl)

  const ocrInsert: Database['public']['Tables']['ocr_results']['Insert'] = {
    image_id: imageId,
    raw_response: result.rawResponse as unknown as Json,
    extracted_text: result.extractedText,
    extracted_code: result.topCandidate?.text ?? null,
    all_candidates: result.candidates as unknown as Json,
    confidence: result.topCandidate?.confidence ?? null,
    provider: result.provider,
    auto_approved: false,
  }
  const { error } = await db.from('ocr_results').upsert(ocrInsert)

  if (error) throw error
  await db.from('images').update({ status: 'ocr_done' }).eq('id', imageId)
}

async function retrySearch(searchId: string, db: ReturnType<typeof getSupabaseAdminClient>) {
  const { data: search } = await db
    .from('product_searches')
    .select('search_query, batch_id, upload_batches!inner(user_id)')
    .eq('id', searchId)
    .single()

  if (!search) throw new Error('Search not found')
  const rawSearch = search as unknown as { search_query: string; batch_id: string; upload_batches: { user_id: string } }
  const userId = rawSearch.upload_batches.user_id

  const items = await searchEbayProducts(userId, rawSearch.search_query)
  const best = selectBestMatch(items, rawSearch.search_query)

  await db.from('product_searches').update({
    status: items.length > 0 ? 'success' : 'no_results',
    result_count: items.length,
    results_raw: items as unknown as Json,
    selected_item_id: best?.itemId ?? null,
    error_message: null,
  }).eq('id', searchId)
}
