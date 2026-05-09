import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { mergeBatchesSchema } from '@/lib/validators/upload'
import { resolveGroupCode } from '@/lib/ocr/group-resolver'
import { withContext } from '@/lib/log'
import type { OcrCandidate } from '@/types/ocr'

export const POST = withAuth(async (req, userId) => {
  const log = withContext({ scope: 'batch.merge', user_id: userId })
  const tStart = Date.now()

  let body: unknown
  try {
    body = await req.json()
  } catch (err) {
    log.warn('invalid json body', { err })
    return apiError('Invalid JSON body', 400)
  }

  const parsed = mergeBatchesSchema.safeParse(body)
  if (!parsed.success) {
    log.warn('merge schema validation failed', { err: parsed.error.message })
    return apiError(parsed.error.message, 422)
  }

  const { batch_ids } = parsed.data
  const db = getSupabaseAdminClient()

  const { data: batches, error: loadErr } = await db
    .from('upload_batches')
    .select('id, user_id, upload_session_id, status, created_at')
    .in('id', batch_ids)

  if (loadErr) {
    log.error('failed to load batches', { err: loadErr })
    return apiError('Failed to load batches', 500)
  }

  if (!batches || batches.length !== batch_ids.length) {
    log.warn('merge target missing', { requested: batch_ids.length, found: batches?.length ?? 0 })
    return apiError('One or more batches not found', 404)
  }

  if (batches.some((b) => b.user_id !== userId)) {
    log.warn('merge unauthorized', { batch_ids })
    return apiError('Unauthorized', 403)
  }
  if (batches.some((b) => b.status !== 'awaiting_review')) {
    log.warn('merge on unexpected status', { statuses: batches.map((b) => b.status) })
    return apiError('All batches must be in awaiting_review state', 409)
  }
  const sessionId = batches[0].upload_session_id
  if (batches.some((b) => b.upload_session_id !== sessionId)) {
    log.warn('merge across sessions blocked', { batch_ids })
    return apiError('All batches must belong to the same upload session', 409)
  }

  // Survivor = oldest. Reparent images, recompute resolver, hard-delete losers.
  const sorted = [...batches].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  )
  const survivor = sorted[0]
  const losers = sorted.slice(1).map((b) => b.id)

  await db.from('images').update({ batch_id: survivor.id }).in('batch_id', losers)

  // Re-resolve dominant code over the combined OCR result set.
  const { data: imgs } = await db.from('images').select('id').eq('batch_id', survivor.id)
  const imageIds = (imgs ?? []).map((i) => i.id)

  const { data: ocrRows } = await db
    .from('ocr_results')
    .select('id, image_id, extracted_code, confidence, all_candidates')
    .in('image_id', imageIds)

  const resolved = resolveGroupCode({
    ocrResults: (ocrRows ?? []).map((r) => ({
      id: r.id,
      image_id: r.image_id,
      extracted_code: r.extracted_code,
      confidence: r.confidence,
      all_candidates: (r.all_candidates as unknown as OcrCandidate[]) ?? [],
    })),
  })

  await db
    .from('upload_batches')
    .update({
      total_images: imageIds.length,
      processed: imageIds.length,
      winning_ocr_result_id: resolved.winningOcrResultId,
      final_code: resolved.winningCode,
    })
    .eq('id', survivor.id)

  await db.from('upload_batches').delete().in('id', losers)

  // Refresh session group count.
  if (sessionId) {
    const { count } = await db
      .from('upload_batches')
      .select('id', { count: 'exact', head: true })
      .eq('upload_session_id', sessionId)
    await db.from('upload_sessions').update({ group_count: count ?? 0 }).eq('id', sessionId)
  }

  log.info('merge complete', {
    session_id: sessionId,
    survivor_id: survivor.id,
    removed_count: losers.length,
    images_in_survivor: imageIds.length,
    winning_code: resolved.winningCode,
    dur_ms: Date.now() - tStart,
  })

  return NextResponse.json({ survivor_id: survivor.id, removed: losers })
})
