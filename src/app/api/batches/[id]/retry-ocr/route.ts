import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { TesseractPool, recognizeFromBuffer } from '@/lib/ocr/pool'
import { resolveGroupCode } from '@/lib/ocr/group-resolver'
import { withContext } from '@/lib/log'
import type { Json } from '@/types/supabase'
import type { OcrCandidate } from '@/types/ocr'

const OCR_CONCURRENCY = 4

/**
 * Re-run OCR on every image in a batch, replacing the existing ocr_results rows
 * and recomputing the winning code.
 */
export const POST = withAuth(async (_req, userId, params) => {
  const batchId = params!.id
  const log = withContext({ scope: 'batch.retry-ocr', user_id: userId, batch_id: batchId })
  const tStart = Date.now()

  // Top-level guard so any uncaught throw — Supabase outage, OOM during arrayBuffer,
  // unexpected exception inside Tesseract.js — surfaces as a real error message
  // to the client instead of an opaque "500".
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
    .select('id, storage_path')
    .eq('batch_id', batchId)

  if (imgErr) {
    log.error('failed to load images', { err: imgErr })
    return apiError(`Failed to read batch images: ${imgErr.message}`, 500)
  }
  if (!images || images.length === 0) {
    log.warn('no images to OCR')
    return apiError('No images to OCR', 422)
  }

  log.info('retry start', { total: images.length })

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
  const { error: deleteErr } = await db
    .from('ocr_results')
    .delete()
    .in('image_id', images.map((i) => i.id))
  if (deleteErr) {
    log.error('failed to delete stale ocr_results', { err: deleteErr })
    // Continue — per-image insert will fail (unique constraint) but other images
    // can still produce useful results. Surface in final summary.
  }

  const ocrRows: Array<{
    id: string
    image_id: string
    extracted_code: string | null
    confidence: number | null
    all_candidates: OcrCandidate[]
  }> = []

  const failures: Array<{ image_id: string; reason: string }> = []
  const pool = new TesseractPool(Math.min(OCR_CONCURRENCY, images.length))
  try {
    try {
      await pool.init()
    } catch (err) {
      log.error('Tesseract pool init failed', { err })
      const msg = err instanceof Error ? err.message : String(err)
      return apiError(`OCR worker init failed: ${msg}`, 500)
    }

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
          throw new Error(`ocr_results insert failed: ${insertErr?.message ?? 'no row returned'}`)
        }

        ocrRows.push({
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
        log.error('retry ocr image failed', {
          image_id: image.id,
          err,
          dur_ms: Date.now() - tImg,
        })
      }
    })
  } finally {
    try {
      await pool.terminate()
    } catch (err) {
      log.warn('pool termination failed', { err })
    }
  }

  // If every image failed, the retry is useless — surface that as an error so the
  // user sees something actionable rather than a silent "still no code".
  if (ocrRows.length === 0) {
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

  const resolved = resolveGroupCode({ ocrResults: ocrRows })

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
    ocr_rows: ocrRows.length,
    failures: failures.length,
    winning_code: resolved.winningCode,
    had_consensus: resolved.hadConsensus,
    dur_ms: Date.now() - tStart,
  })

  return NextResponse.json({
    success: true,
    final_code: resolved.winningCode,
    winning_ocr_result_id: resolved.winningOcrResultId,
    images_processed: ocrRows.length,
    images_total: images.length,
    images_failed: failures.length,
  })
}
