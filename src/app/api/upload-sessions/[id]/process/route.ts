import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { TesseractPool, recognizeFromBuffer } from '@/lib/ocr/pool'
import { resolveGroupCode } from '@/lib/ocr/group-resolver'
import { enqueueRetry } from '@/lib/retry'
import { clusterByTime } from '@/lib/grouping/timeCluster'
import { pickLabelCandidate } from '@/lib/grouping/labelPicker'
import { withContext } from '@/lib/log'
import type { Json } from '@/types/supabase'
import type { OcrCandidate } from '@/types/ocr'

const OCR_CONCURRENCY = 4

interface SessionImage {
  id: string
  storage_path: string
  original_filename: string | null
  captured_at: string | null
}

export const POST = withAuth(async (_req, userId, params) => {
  const sessionId = params!.id
  const log = withContext({ scope: 'session.process', user_id: userId, session_id: sessionId })
  const db = getSupabaseAdminClient()

  const { data: session, error: sessionErr } = await db
    .from('upload_sessions')
    .select('id, status')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .single()

  if (sessionErr || !session) {
    log.warn('session not found or not owned', { err: sessionErr })
    return apiError('Session not found', 404)
  }
  if (session.status !== 'uploading') {
    log.warn('session in unexpected state for process', { current_status: session.status })
    return apiError(`Session is not in 'uploading' state (current: ${session.status})`, 409)
  }

  const { data: images, error: imgErr } = await db
    .from('images')
    .select('id, storage_path, original_filename, captured_at')
    .eq('upload_session_id', sessionId)
    .eq('user_id', userId)

  if (imgErr) {
    log.error('failed to load session images', { err: imgErr })
    return apiError('Failed to read session images', 500)
  }

  if (!images || images.length === 0) {
    log.warn('process called on empty session')
    await db
      .from('upload_sessions')
      .update({ status: 'failed', error_message: 'No images uploaded' })
      .eq('id', sessionId)
    return apiError('No images uploaded to this session', 422)
  }

  await db
    .from('upload_sessions')
    .update({ status: 'grouping', total_images: images.length })
    .eq('id', sessionId)

  log.info('starting background processing', { total: images.length })
  void processSessionInBackground(sessionId, userId, images)

  return NextResponse.json({ message: 'Processing started', total: images.length })
})

async function processSessionInBackground(
  sessionId: string,
  userId: string,
  images: SessionImage[],
) {
  const log = withContext({ scope: 'session.process', user_id: userId, session_id: sessionId })
  const db = getSupabaseAdminClient()
  let pool: TesseractPool | null = null
  const tStart = Date.now()

  try {
    // Stage A/B: time + label-anchor clustering.
    const tCluster = Date.now()
    const clusters = clusterByTime(
      images.map((i) => ({
        id: i.id,
        filename: i.original_filename ?? '',
        capturedAt: i.captured_at ? new Date(i.captured_at) : null,
        storage_path: i.storage_path,
      })),
    )
    log.info('time-clustering complete', {
      total: images.length,
      cluster_count: clusters.length,
      dur_ms: Date.now() - tCluster,
    })

    if (clusters.length === 0) {
      log.error('clustering produced zero groups', { total: images.length })
      await db
        .from('upload_sessions')
        .update({ status: 'failed', error_message: 'Clustering produced no groups' })
        .eq('id', sessionId)
      return
    }

    await db
      .from('upload_sessions')
      .update({ status: 'processing', group_count: clusters.length })
      .eq('id', sessionId)

    // Spin up the worker pool ONCE for the whole session.
    const tPool = Date.now()
    pool = new TesseractPool(Math.min(OCR_CONCURRENCY, images.length))
    try {
      await pool.init()
    } catch (err) {
      log.error('Tesseract pool init failed — aborting session', { err })
      await db
        .from('upload_sessions')
        .update({
          status: 'failed',
          error_message: `OCR worker init failed: ${err instanceof Error ? err.message : String(err)}`,
        })
        .eq('id', sessionId)
      return
    }
    log.info('OCR pool ready', { workers: OCR_CONCURRENCY, dur_ms: Date.now() - tPool })

    let clusterIdx = 0
    let totalCodesFound = 0
    let totalNoCode = 0
    for (const cluster of clusters) {
      const cIdx = clusterIdx++
      const cLog = log // child context per cluster comes from extra fields below
      const tBatch = Date.now()

      const { data: batch, error: batchErr } = await db
        .from('upload_batches')
        .insert({
          user_id: userId,
          upload_session_id: sessionId,
          auto_grouped: true,
          status: 'processing',
          total_images: cluster.length,
          processed: 0,
        })
        .select('id')
        .single()

      if (batchErr || !batch) {
        cLog.error('batch insert failed — skipping cluster', {
          cluster_idx: cIdx,
          cluster_size: cluster.length,
          err: batchErr,
        })
        continue
      }

      const { error: reparentErr } = await db
        .from('images')
        .update({ batch_id: batch.id })
        .in('id', cluster.map((c) => c.id))
      if (reparentErr) {
        cLog.error('failed to reparent images onto batch', {
          cluster_idx: cIdx,
          batch_id: batch.id,
          err: reparentErr,
        })
        // Continue anyway — some images may still be on the batch via direct id mapping.
      }

      const ocrRows = await runOcrForCluster(
        pool,
        cluster.map((c) => ({
          id: c.id,
          storage_path: c.storage_path,
          filename: c.filename,
        })),
        batch.id,
        sessionId,
        userId,
      )

      const labelImg = pickLabelCandidate(
        cluster.map((c) => {
          const o = ocrRows.find((r) => r.image_id === c.id)
          return {
            id: c.id,
            filename: c.filename,
            capturedAt: c.capturedAt,
            topConfidence: o?.confidence ?? null,
          }
        }),
      )
      if (labelImg) {
        await db.from('images').update({ is_label_candidate: true }).eq('id', labelImg.id)
      }

      const resolved = resolveGroupCode({ ocrResults: ocrRows })
      if (resolved.winningCode) totalCodesFound++
      else totalNoCode++

      await db
        .from('upload_batches')
        .update({
          status: 'awaiting_review',
          winning_ocr_result_id: resolved.winningOcrResultId,
          final_code: resolved.winningCode,
          processed: cluster.length,
        })
        .eq('id', batch.id)

      cLog.info('cluster done', {
        cluster_idx: cIdx,
        cluster_size: cluster.length,
        batch_id: batch.id,
        ocr_rows: ocrRows.length,
        winning_code: resolved.winningCode,
        had_consensus: resolved.hadConsensus,
        label_id: labelImg?.id ?? null,
        dur_ms: Date.now() - tBatch,
      })
    }

    await db.from('upload_sessions').update({ status: 'review_ready' }).eq('id', sessionId)
    log.info('session ready for review', {
      cluster_count: clusters.length,
      codes_found: totalCodesFound,
      no_code: totalNoCode,
      dur_ms: Date.now() - tStart,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error('fatal in background processing', { err, dur_ms: Date.now() - tStart })
    await db
      .from('upload_sessions')
      .update({ status: 'failed', error_message: msg })
      .eq('id', sessionId)
  } finally {
    if (pool) {
      try {
        await pool.terminate()
      } catch (err) {
        log.warn('pool termination failed', { err })
      }
    }
  }
}

async function runOcrForCluster(
  pool: TesseractPool,
  images: Array<{ id: string; storage_path: string; filename: string }>,
  batchId: string,
  sessionId: string,
  userId: string,
): Promise<Array<{
  id: string
  image_id: string
  extracted_code: string | null
  confidence: number | null
  all_candidates: OcrCandidate[]
}>> {
  const log = withContext({
    scope: 'session.process.ocr',
    user_id: userId,
    session_id: sessionId,
    batch_id: batchId,
  })
  const db = getSupabaseAdminClient()
  const ocrRows: Array<{
    id: string
    image_id: string
    extracted_code: string | null
    confidence: number | null
    all_candidates: OcrCandidate[]
  }> = []
  let processed = 0

  await pool.map(images, async (worker, image) => {
    const tImg = Date.now()
    try {
      await db.from('images').update({ status: 'ocr_processing' }).eq('id', image.id)

      const { data: blob, error: dlError } = await db.storage
        .from('images')
        .download(image.storage_path)
      if (dlError || !blob) {
        throw new Error(
          `download failed for ${image.storage_path}: ${dlError?.message ?? 'no blob returned'}`,
        )
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

      await db.from('images').update({ status: 'ocr_done' }).eq('id', image.id)

      log.debug('image ocr done', {
        image_id: image.id,
        filename: image.filename,
        bytes: buffer.length,
        text_len: ocrResult.extractedText.length,
        top_code: ocrResult.topCandidate?.text ?? null,
        top_conf: ocrResult.topCandidate
          ? Number(ocrResult.topCandidate.confidence.toFixed(2))
          : null,
        dur_ms: Date.now() - tImg,
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      log.error('image ocr failed — enqueuing retry', {
        image_id: image.id,
        filename: image.filename,
        dur_ms: Date.now() - tImg,
        err,
      })
      await db
        .from('images')
        .update({ status: 'failed', error_message: errMsg })
        .eq('id', image.id)
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

  return ocrRows
}
