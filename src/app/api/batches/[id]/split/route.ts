import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { splitBatchSchema } from '@/lib/validators/upload'
import { resolveGroupCode } from '@/lib/ocr/group-resolver'
import { withContext } from '@/lib/log'
import type { OcrCandidate } from '@/types/ocr'

export const POST = withAuth(async (req, userId, params) => {
  const sourceBatchId = params!.id
  const log = withContext({ scope: 'batch.split', user_id: userId, batch_id: sourceBatchId })
  const tStart = Date.now()

  let body: unknown
  try {
    body = await req.json()
  } catch (err) {
    log.warn('invalid json body', { err })
    return apiError('Invalid JSON body', 400)
  }

  const parsed = splitBatchSchema.safeParse(body)
  if (!parsed.success) {
    log.warn('split schema validation failed', { err: parsed.error.message })
    return apiError(parsed.error.message, 422)
  }

  const { image_ids } = parsed.data
  const db = getSupabaseAdminClient()

  const { data: source, error: sourceErr } = await db
    .from('upload_batches')
    .select('id, user_id, upload_session_id, status, auto_grouped')
    .eq('id', sourceBatchId)
    .single()

  if (sourceErr || !source) {
    log.warn('source batch not found', { err: sourceErr })
    return apiError('Batch not found', 404)
  }
  if (source.user_id !== userId) {
    log.warn('split unauthorized', { batch_owner: source.user_id })
    return apiError('Unauthorized', 403)
  }
  if (source.status !== 'awaiting_review') {
    log.warn('split on unexpected status', { current_status: source.status })
    return apiError('Batch must be in awaiting_review state', 409)
  }

  // Verify the requested images all belong to the source batch.
  const { data: requested, error: imgErr } = await db
    .from('images')
    .select('id, batch_id')
    .in('id', image_ids)

  if (imgErr) {
    log.error('failed to load requested images', { err: imgErr })
    return apiError('Failed to load images', 500)
  }
  if (!requested || requested.length !== image_ids.length) {
    log.warn('split target images missing', { requested: image_ids.length, found: requested?.length ?? 0 })
    return apiError('One or more images not found', 404)
  }
  if (requested.some((i) => i.batch_id !== sourceBatchId)) {
    log.warn('split contains images from another batch')
    return apiError('All images must belong to the source batch', 422)
  }

  // Don't allow moving every image — that would leave the source empty.
  const { count: sourceTotal } = await db
    .from('images')
    .select('id', { count: 'exact', head: true })
    .eq('batch_id', sourceBatchId)
  if ((sourceTotal ?? 0) <= image_ids.length) {
    log.warn('split would empty source batch', { source_total: sourceTotal, moving: image_ids.length })
    return apiError('Cannot move all images — at least one must remain in the source batch', 422)
  }

  // Create the new sibling batch.
  const { data: newBatch, error: insertErr } = await db
    .from('upload_batches')
    .insert({
      user_id: userId,
      upload_session_id: source.upload_session_id,
      auto_grouped: source.auto_grouped,
      status: 'awaiting_review',
      total_images: image_ids.length,
      processed: image_ids.length,
    })
    .select('id')
    .single()

  if (insertErr || !newBatch) {
    log.error('failed to create split batch', { err: insertErr })
    return apiError('Failed to create split batch', 500)
  }

  const { error: reparentErr } = await db.from('images').update({ batch_id: newBatch.id }).in('id', image_ids)
  if (reparentErr) {
    log.error('failed to reparent images onto new batch', { new_batch_id: newBatch.id, err: reparentErr })
    return apiError('Failed to move images', 500)
  }

  // Re-resolve both batches.
  await reresolve(db, sourceBatchId)
  await reresolve(db, newBatch.id)

  // Refresh session group count.
  if (source.upload_session_id) {
    const { count } = await db
      .from('upload_batches')
      .select('id', { count: 'exact', head: true })
      .eq('upload_session_id', source.upload_session_id)
    await db
      .from('upload_sessions')
      .update({ group_count: count ?? 0 })
      .eq('id', source.upload_session_id)
  }

  log.info('split complete', {
    session_id: source.upload_session_id,
    new_batch_id: newBatch.id,
    moved: image_ids.length,
    dur_ms: Date.now() - tStart,
  })

  return NextResponse.json({ source_id: sourceBatchId, new_batch_id: newBatch.id })
})

async function reresolve(
  db: ReturnType<typeof getSupabaseAdminClient>,
  batchId: string,
): Promise<void> {
  const { data: imgs } = await db.from('images').select('id').eq('batch_id', batchId)
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
    .eq('id', batchId)
}
