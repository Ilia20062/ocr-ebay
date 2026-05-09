import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { TesseractPool, recognizeWithFallback } from '@/lib/ocr/pool'
import { resolveGroupCode } from '@/lib/ocr/group-resolver'
import { enqueueRetry } from '@/lib/retry'
import { withContext } from '@/lib/log'
import type { Json } from '@/types/supabase'
import type { OcrCandidate } from '@/types/ocr'

const OCR_CONCURRENCY = 4

export const POST = withAuth(async (_req, userId, params) => {
  const batchId = params!.id
  const log = withContext({ scope: 'batch.process', user_id: userId, batch_id: batchId })
  const db = getSupabaseAdminClient()

  const { data: batch, error: batchErr } = await db
    .from('upload_batches')
    .select('*')
    .eq('id', batchId)
    .eq('user_id', userId)
    .single()

  if (batchErr || !batch) {
    log.warn('batch not found', { err: batchErr })
    return apiError('Batch not found', 404)
  }
  if (batch.status === 'processing') {
    log.warn('batch already processing')
    return apiError('Batch already processing', 409)
  }

  await db.from('upload_batches').update({ status: 'processing' }).eq('id', batchId)

  const { data: images, error: imgErr } = await db
    .from('images')
    .select('id, storage_path')
    .eq('batch_id', batchId)
    .eq('status', 'uploaded')

  if (imgErr) {
    log.error('failed to load batch images', { err: imgErr })
    return apiError('Failed to read batch images', 500)
  }

  if (!images || images.length === 0) {
    log.warn('process called on empty batch')
    await db.from('upload_batches').update({ status: 'failed' }).eq('id', batchId)
    return apiError('No images to process', 422)
  }

  await db.from('upload_batches').update({ total_images: images.length }).eq('id', batchId)

  log.info('starting background ocr', { total: images.length })
  void processGroupInBackground(images, batchId, userId, db)

  return NextResponse.json({ message: 'Processing started', total: images.length })
})

async function processGroupInBackground(
  images: Array<{ id: string; storage_path: string }>,
  batchId: string,
  userId: string,
  db: ReturnType<typeof getSupabaseAdminClient>,
) {
  const log = withContext({ scope: 'batch.process', user_id: userId, batch_id: batchId })
  const ocrRows: Array<{
    id: string
    image_id: string
    extracted_code: string | null
    confidence: number | null
    all_candidates: OcrCandidate[]
  }> = []
  let processed = 0
  const tStart = Date.now()

  const pool = new TesseractPool(Math.min(OCR_CONCURRENCY, images.length))
  try {
    try {
      await pool.init()
    } catch (err) {
      log.error('Tesseract pool init failed', { err })
      await db
        .from('upload_batches')
        .update({ status: 'failed' })
        .eq('id', batchId)
      return
    }

    await pool.map(images, async (worker, image) => {
      const tImg = Date.now()
      try {
        await db.from('images').update({ status: 'ocr_processing' }).eq('id', image.id)

        const { data: blob, error: dlError } = await db.storage.from('images').download(image.storage_path)
        if (dlError || !blob) {
          throw new Error(`download failed: ${dlError?.message ?? 'no blob'}`)
        }

        const ab = await blob.arrayBuffer()
        const buffer = Buffer.from(ab)
        const ocrResult = await recognizeWithFallback(worker, buffer, blob.type || 'image/jpeg')

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
          throw new Error(`ocr_results insert failed: ${insertErr?.message ?? 'no row'}`)
        }

        ocrRows.push({
          id: inserted.id,
          image_id: inserted.image_id,
          extracted_code: inserted.extracted_code,
          confidence: inserted.confidence,
          all_candidates: (inserted.all_candidates as unknown as OcrCandidate[]) ?? [],
        })

        await db.from('images').update({ status: 'ocr_done' }).eq('id', image.id)

        log.debug('image ocr done', {
          image_id: image.id,
          bytes: buffer.length,
          text_len: ocrResult.extractedText.length,
          top_code: ocrResult.topCandidate?.text ?? null,
          dur_ms: Date.now() - tImg,
        })
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        log.error('image ocr failed', { image_id: image.id, err, dur_ms: Date.now() - tImg })
        await db.from('images').update({ status: 'failed', error_message: errMsg }).eq('id', image.id)
        try {
          await enqueueRetry('image', image.id, errMsg)
        } catch (e) {
          log.warn('enqueueRetry failed', { image_id: image.id, err: e })
        }
      } finally {
        processed++
        await db.from('upload_batches').update({ processed }).eq('id', batchId)
      }
    })
  } finally {
    try {
      await pool.terminate()
    } catch (err) {
      log.warn('pool termination failed', { err })
    }
  }

  const resolved = resolveGroupCode({ ocrResults: ocrRows })

  await db
    .from('upload_batches')
    .update({
      status: 'awaiting_review',
      winning_ocr_result_id: resolved.winningOcrResultId,
      final_code: resolved.winningCode,
      processed,
    })
    .eq('id', batchId)

  log.info('batch awaiting review', {
    total: images.length,
    ocr_rows: ocrRows.length,
    winning_code: resolved.winningCode,
    had_consensus: resolved.hadConsensus,
    dur_ms: Date.now() - tStart,
  })
}
