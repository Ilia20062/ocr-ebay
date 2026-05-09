import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { TesseractPool, recognizeFromBuffer } from '@/lib/ocr/pool'
import { resolveGroupCode } from '@/lib/ocr/group-resolver'
import { withContext } from '@/lib/log'
import type { Json } from '@/types/supabase'
import type { OcrCandidate } from '@/types/ocr'

const OCR_CONCURRENCY = 4

type RetryImage = { id: string; storage_path: string; is_label_candidate: boolean | null }

type OcrRow = {
  id: string
  image_id: string
  extracted_code: string | null
  confidence: number | null
  all_candidates: OcrCandidate[]
}

/**
 * Re-run OCR on a batch's images.
 *
 * Two-phase: phase 1 only hits images flagged is_label_candidate = true (the
 * close-up shots that actually carry the molded code). Phase 2 fallback OCRs
 * the rest only when phase 1 produced no code. This is roughly a 5–10x speedup
 * on retry vs. running OCR on every image, and it skips the watermark false
 * positives the wide product PNGs introduce.
 */
export const POST = withAuth(async (_req, userId, params) => {
  const batchId = params!.id
  const log = withContext({ scope: 'batch.retry-ocr', user_id: userId, batch_id: batchId })
  const tStart = Date.now()

  try {
    return await runRetryOcr(batchId, userId, log, tStart)
  } catch (err) {
    log.error('retry-ocr fatal', { err, dur_ms: Date.now() - tStart })
    const msg = err instanceof Error ? err.message : String(err)
    return apiError(`Retry failed: ${msg}`, 500)
  }
})

async function runRetryOcr(
  batchId: string,
  userId: string,
  log: ReturnType<typeof withContext>,
  tStart: number,
) {
  const db = getSupabaseAdminClient()

  const { data: batch, error: batchErr } = await db
    .from('upload_batches')
    .select('id, user_id, status')
    .eq('id', batchId)
    .single()

  if (batchErr || !batch) {
    log.warn('batch not found', { err: batchErr })
    return apiError('Batch not found', 404)
  }
  if (batch.user_id !== userId) {
    log.warn('unauthorized retry attempt', { batch_owner: batch.user_id })
    return apiError('Unauthorized', 403)
  }
  if (batch.status !== 'awaiting_review') {
    log.warn('retry on unexpected status', { current_status: batch.status })
    return apiError('Batch must be in awaiting_review state', 409)
  }

  const { data: images, error: imgErr } = await db
    .from('images')
    .select('id, storage_path, is_label_candidate')
    .eq('batch_id', batchId)

  if (imgErr) {
    log.error('failed to load images', { err: imgErr })
    return apiError(`Failed to read batch images: ${imgErr.message}`, 500)
  }
  if (!images || images.length === 0) {
    log.warn('no images to OCR')
    return apiError('No images to OCR', 422)
  }

  // Partition into label-likely vs the rest.
  const labelImages = images.filter((i) => i.is_label_candidate)
  const otherImages = images.filter((i) => !i.is_label_candidate)
  // If the DB has no flagged label (legacy batch from before the column existed),
  // fall back to OCRing all images in phase 1. Better correct-but-slow than wrong.
  const phase1 = labelImages.length > 0 ? labelImages : images
  const phase1Ids = new Set(phase1.map((i) => i.id))
  const phase2 = labelImages.length > 0 ? otherImages : []

  log.info('retry start', {
    total: images.length,
    phase1_count: phase1.length,
    phase2_pending: phase2.length,
  })

  // Wipe stale OCR rows + clear the winner pointer so a new resolver pass can
  // populate them. Status stays awaiting_review so the card remains visible.
  const { error: clearErr } = await db
    .from('upload_batches')
    .update({ winning_ocr_result_id: null, final_code: null })
    .eq('id', batchId)
  if (clearErr) {
    log.error('failed to clear winner', { err: clearErr })
    return apiError(`Failed to reset batch: ${clearErr.message}`, 500)
  }

  // We only need to delete rows for images we're about to re-OCR. Other rows
  // (phase-2 images we may not touch) stay intact and feed into the resolver.
  const { error: deleteErr } = await db
    .from('ocr_results')
    .delete()
    .in('image_id', [...phase1Ids])
  if (deleteErr) {
    log.error('failed to delete stale ocr_results', { err: deleteErr })
    // Continue — duplicate-key insert below will just skip those.
  }

  const failures: Array<{ image_id: string; reason: string }> = []
  const pool = new TesseractPool(Math.min(OCR_CONCURRENCY, images.length))
  let allOcrRows: OcrRow[] = []

  try {
    try {
      await pool.init()
    } catch (err) {
      log.error('Tesseract pool init failed', { err })
      const msg = err instanceof Error ? err.message : String(err)
      return apiError(`OCR worker init failed: ${msg}`, 500)
    }

    // Phase 1
    const phase1Rows = await runPhase(pool, phase1, batchId, log, failures)
    allOcrRows = phase1Rows

    // Phase 2 only if phase 1 found nothing.
    const phase1HasCode = phase1Rows.some((r) => r.extracted_code)
    if (!phase1HasCode && phase2.length > 0) {
      log.info('phase 1 no code — running phase 2 fallback', { phase2_count: phase2.length })
      // Wipe phase 2 stale rows now (we delayed until we're sure we'll OCR them).
      const { error: del2Err } = await db
        .from('ocr_results')
        .delete()
        .in('image_id', phase2.map((i) => i.id))
      if (del2Err) log.warn('phase 2 stale-row delete failed', { err: del2Err })

      const phase2Rows = await runPhase(pool, phase2, batchId, log, failures)
      allOcrRows = [...allOcrRows, ...phase2Rows]
    } else if (phase1HasCode) {
      // Phase 2 not needed — pull the existing rows for those images so the
      // resolver sees the full set (otherwise a 1-image phase-1 result would
      // resolve correctly anyway, but this keeps the response counts honest).
      if (phase2.length > 0) {
        const { data: existingPhase2 } = await db
          .from('ocr_results')
          .select('id, image_id, extracted_code, confidence, all_candidates')
          .in('image_id', phase2.map((i) => i.id))
        if (existingPhase2) {
          allOcrRows = [
            ...allOcrRows,
            ...existingPhase2.map((r) => ({
              id: r.id,
              image_id: r.image_id,
              extracted_code: r.extracted_code,
              confidence: r.confidence,
              all_candidates: (r.all_candidates as unknown as OcrCandidate[]) ?? [],
            })),
          ]
        }
      }
    }
  } finally {
    try {
      await pool.terminate()
    } catch (err) {
      log.warn('pool termination failed', { err })
    }
  }

  // If every image we tried failed AND we have nothing to resolve from, give up.
  if (allOcrRows.length === 0) {
    log.error('retry produced no ocr rows', {
      total: images.length,
      failures: failures.length,
      first_failure: failures[0]?.reason ?? null,
      dur_ms: Date.now() - tStart,
    })
    return apiError(
      `Retry failed for all ${images.length} image${images.length === 1 ? '' : 's'}: ${
        failures[0]?.reason ?? 'unknown error'
      }`,
      500,
    )
  }

  const resolved = resolveGroupCode({ ocrResults: allOcrRows })

  const { error: finalErr } = await db
    .from('upload_batches')
    .update({
      winning_ocr_result_id: resolved.winningOcrResultId,
      final_code: resolved.winningCode,
      processed: images.length,
      total_images: images.length,
    })
    .eq('id', batchId)
  if (finalErr) {
    log.error('failed to write resolver result', { err: finalErr })
    return apiError(`Failed to update batch: ${finalErr.message}`, 500)
  }

  log.info('retry complete', {
    total: images.length,
    images_ocrd: phase1.length + (allOcrRows.length > phase1.length ? phase2.length : 0),
    ocr_rows: allOcrRows.length,
    failures: failures.length,
    winning_code: resolved.winningCode,
    had_consensus: resolved.hadConsensus,
    dur_ms: Date.now() - tStart,
  })

  return NextResponse.json({
    success: true,
    final_code: resolved.winningCode,
    winning_ocr_result_id: resolved.winningOcrResultId,
    images_processed: allOcrRows.length,
    images_total: images.length,
    images_failed: failures.length,
  })
}

async function runPhase(
  pool: TesseractPool,
  images: RetryImage[],
  batchId: string,
  log: ReturnType<typeof withContext>,
  failures: Array<{ image_id: string; reason: string }>,
): Promise<OcrRow[]> {
  if (images.length === 0) return []
  const db = getSupabaseAdminClient()
  const out: OcrRow[] = []

  await pool.map(images, async (worker, image) => {
    const tImg = Date.now()
    try {
      const { data: blob, error: dlError } = await db.storage
        .from('images')
        .download(image.storage_path)
      if (dlError || !blob) {
        throw new Error(`download failed: ${dlError?.message ?? 'no blob'}`)
      }

      const ab = await blob.arrayBuffer()
      const buffer = Buffer.from(ab)
      const ocrResult = await recognizeFromBuffer(worker, buffer, blob.type || 'image/jpeg')

      const { data: inserted, error: insertErr } = await db
        .from('ocr_results')
        .insert({
          image_id: image.id,
          raw_response: ocrResult.rawResponse as unknown as Json,
          extracted_text: ocrResult.extractedText,
          extracted_code: ocrResult.topCandidate?.text ?? null,
          all_candidates: ocrResult.candidates as unknown as Json,
          confidence: ocrResult.topCandidate?.confidence ?? null,
          provider: ocrResult.provider,
          auto_approved: false,
        })
        .select('id, image_id, extracted_code, confidence, all_candidates')
        .single()

      if (insertErr || !inserted) {
        throw new Error(`insert failed: ${insertErr?.message ?? 'no row'}`)
      }

      out.push({
        id: inserted.id,
        image_id: inserted.image_id,
        extracted_code: inserted.extracted_code,
        confidence: inserted.confidence,
        all_candidates: (inserted.all_candidates as unknown as OcrCandidate[]) ?? [],
      })

      log.debug('retry ocr done', {
        image_id: image.id,
        bytes: buffer.length,
        text_len: ocrResult.extractedText.length,
        top_code: ocrResult.topCandidate?.text ?? null,
        dur_ms: Date.now() - tImg,
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      failures.push({ image_id: image.id, reason })
      log.error('retry ocr image failed', { image_id: image.id, err, dur_ms: Date.now() - tImg })
    }
  })

  return out
}
