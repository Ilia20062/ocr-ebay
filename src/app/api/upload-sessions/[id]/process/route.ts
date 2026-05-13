import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { TesseractPool, recognizeWithFallback } from '@/lib/ocr/pool'
import { resolveGroupCode } from '@/lib/ocr/group-resolver'
import {
  userHasEbayConnection,
  validateCandidatesWithEbay,
  type CandidateCache,
} from '@/lib/ebay/validate-candidates'
import { enqueueRetry } from '@/lib/retry'
import { clusterByTime } from '@/lib/grouping/timeCluster'
import { pickLabelCandidate, pickLabelCandidates } from '@/lib/grouping/labelPicker'
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

interface ClusterImage {
  id: string
  filename: string
  capturedAt: Date | null
  storage_path: string
}

type OcrRow = {
  id: string
  image_id: string
  extracted_code: string | null
  confidence: number | null
  all_candidates: OcrCandidate[]
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
      images.map<ClusterImage>((i) => ({
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

    // Pre-check eBay once per session — avoids hitting the DB/token-refresh
    // path on every cluster when the user hasn't connected yet. The validator
    // re-checks per call too, but this lets us log the mode up-front.
    const ebayConnected = await userHasEbayConnection(userId)
    const candidateCache: CandidateCache = new Map()
    log.info('candidate validation mode', { ebay_connected: ebayConnected })

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
    let totalImagesOcrd = 0 // For visibility: how many images we actually OCR'd vs total uploaded
    for (const cluster of clusters) {
      const cIdx = clusterIdx++
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
        log.error('batch insert failed — skipping cluster', {
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
        log.error('failed to reparent images onto batch', {
          cluster_idx: cIdx,
          batch_id: batch.id,
          err: reparentErr,
        })
      }

      // ─── Two-phase OCR ────────────────────────────────────────────────────
      // Phase 1: run OCR only on bare .jpg files (close-ups of the molded code).
      // Phase 2 (fallback): if Phase 1 produced no code, OCR everything else.
      // ─────────────────────────────────────────────────────────────────────
      const labelCandidates = pickLabelCandidates(cluster)
      const phase1Images = labelCandidates.length > 0 ? labelCandidates : cluster
      const phase1Ocr = await runOcrOnImages(pool!, phase1Images, batch.id, sessionId, userId)
      totalImagesOcrd += phase1Images.length

      // We fall through to phase 2 not just when no code was extracted, but also
      // when phase 1 returned no rows at all (Tesseract crashed on every label)
      // or returned only empty text (image had no readable text). Anything that
      // could plausibly be improved by OCRing more images.
      const phase1HasCode = phase1Ocr.some((r) => r.extracted_code)
      const phase1HadAnyText = phase1Ocr.some(
        (r) => (r.all_candidates && r.all_candidates.length > 0) || r.extracted_code,
      )
      let ocrRows: OcrRow[] = phase1Ocr

      const skippedSomeImages =
        labelCandidates.length > 0 && labelCandidates.length < cluster.length

      if (!phase1HasCode && skippedSomeImages) {
        const remaining = cluster.filter((c) => !labelCandidates.find((l) => l.id === c.id))
        log.info('phase 1 produced no code — running phase 2 fallback', {
          cluster_idx: cIdx,
          batch_id: batch.id,
          phase1_count: phase1Images.length,
          phase1_had_any_text: phase1HadAnyText,
          phase2_count: remaining.length,
        })
        const phase2Ocr = await runOcrOnImages(pool!, remaining, batch.id, sessionId, userId)
        ocrRows = [...phase1Ocr, ...phase2Ocr]
        totalImagesOcrd += remaining.length
      }

      // Stage F: pick label candidate (informs the ✨ thumbnail badge). Use
      // measured OCR confidence when we have it.
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

      const initialResolved = resolveGroupCode({ ocrResults: ocrRows })

      // eBay-validate the resolver output when connected. This re-ranks
      // candidates by Browse-API match count and swaps the winner if a
      // strict majority of hits points to an alternative. Silent no-op when
      // eBay isn't connected — the OCR winner stands.
      let resolved = initialResolved
      let validationSwapped = false
      if (ebayConnected && initialResolved.winningCode) {
        try {
          const outcome = await validateCandidatesWithEbay(userId, initialResolved, {
            cache: candidateCache,
          })
          resolved = outcome.reranked
          validationSwapped = outcome.swapped
        } catch (err) {
          // Validator catches per-candidate errors internally; outer catch is
          // only for a top-level failure (token-refresh blowup, etc).
          log.warn('candidate validation failed — falling back to OCR winner', {
            cluster_idx: cIdx,
            batch_id: batch.id,
            err,
          })
        }
      }

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

      log.info('cluster done', {
        cluster_idx: cIdx,
        cluster_size: cluster.length,
        batch_id: batch.id,
        ocr_rows: ocrRows.length,
        ocr_skipped: cluster.length - ocrRows.length,
        winning_code: resolved.winningCode,
        ebay_validated: ebayConnected,
        ebay_swapped: validationSwapped,
        original_code: validationSwapped ? initialResolved.winningCode : undefined,
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
      images_total: images.length,
      images_ocrd: totalImagesOcrd,
      ocr_savings_pct: Math.round((1 - totalImagesOcrd / images.length) * 100),
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

/**
 * OCR a set of images via the shared pool, write per-image ocr_results rows,
 * update image status, return the inserted rows. Errors per-image are logged
 * + written to images.error_message + enqueued for retry; the caller still
 * receives a (possibly empty) array.
 */
async function runOcrOnImages(
  pool: TesseractPool,
  images: ClusterImage[],
  batchId: string,
  sessionId: string,
  userId: string,
): Promise<OcrRow[]> {
  if (images.length === 0) return []

  const log = withContext({
    scope: 'session.process.ocr',
    user_id: userId,
    session_id: sessionId,
    batch_id: batchId,
  })
  const db = getSupabaseAdminClient()
  const ocrRows: OcrRow[] = []
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

      // Promoted from debug to info — visible in normal `next dev` console.
      // text_len = 0 means Tesseract crashed silently or hit the timeout.
      // text_len > 30 with no top_code means Tesseract read text but the
      // regex/scoring didn't find anything resembling a part number — log a
      // text snippet so we can see what was actually on the image.
      const textLen = ocrResult.extractedText.length
      const candCount = ocrResult.candidates.length
      log.info('image ocr done', {
        image_id: image.id,
        filename: image.filename,
        bytes: buffer.length,
        text_len: textLen,
        candidate_count: candCount,
        top_code: ocrResult.topCandidate?.text ?? null,
        top_conf: ocrResult.topCandidate ? Number(ocrResult.topCandidate.confidence.toFixed(2)) : null,
        dur_ms: Date.now() - tImg,
      })
      if (textLen === 0) {
        log.warn('Tesseract returned empty text — possible worker crash or unreadable image', {
          image_id: image.id,
          filename: image.filename,
          bytes: buffer.length,
          mime: blob.type || 'image/jpeg',
        })
      } else if (!ocrResult.topCandidate && textLen > 30) {
        log.warn('Tesseract read text but extracted no code — extraction or label issue', {
          image_id: image.id,
          filename: image.filename,
          text_len: textLen,
          text_sample: ocrResult.extractedText.slice(0, 120).replace(/\s+/g, ' '),
        })
      }
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
