import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import {
  type TesseractPool,
  recognizeWithFallback,
  getSharedTesseractPool,
} from '@/lib/ocr/pool'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300
import { resolveGroupCode } from '@/lib/ocr/group-resolver'
import { extractBatchNumber } from '@/lib/ocr/code-extractor'
import { runGoogleVisionOcr } from '@/lib/ocr/google-vision'
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

/**
 * Read the seller's case/batch number from the batch's first (case-number)
 * image. Uses Google Vision for the raw text (a clear printed number), then
 * `extractBatchNumber` to pull the integer while rejecting warranty/date noise.
 * Best-effort: returns null if Vision is unavailable or no number is found —
 * every null path is logged so a missed SKU is diagnosable from the batch_id
 * instead of silently falling back to a random `SKU-<timestamp>` (see
 * `auto-list.ts`'s `sku` fallback).
 */
async function extractCaseNumber(image: ClusterImage, batchId?: string): Promise<string | null> {
  const log = withContext({ scope: 'session.process.case-number', batch_id: batchId ?? null, filename: image.filename })
  if (!process.env.GOOGLE_VISION_API_KEY) {
    log.warn('GOOGLE_VISION_API_KEY not set — cannot read case number, will fall back to a generated SKU')
    return null
  }
  try {
    const db = getSupabaseAdminClient()
    const { data: blob, error } = await db.storage.from('images').download(image.storage_path)
    if (error || !blob) {
      log.warn('Could not download case-number image — will fall back to a generated SKU', { err: error })
      return null
    }
    const buf = Buffer.from(await blob.arrayBuffer())
    const result = await runGoogleVisionOcr(buf.toString('base64'), blob.type || 'image/jpeg')
    const caseNumber = extractBatchNumber(result.extractedText)
    if (!caseNumber) {
      log.warn('Vision OCR ran but no case number pattern matched — will fall back to a generated SKU', {
        extracted_text_preview: result.extractedText?.slice(0, 200) ?? null,
      })
    }
    return caseNumber
  } catch (err) {
    log.error('Case-number OCR threw — will fall back to a generated SKU', { err })
    return null
  }
}

async function processSessionInBackground(
  sessionId: string,
  userId: string,
  images: SessionImage[],
) {
  const log = withContext({ scope: 'session.process', user_id: userId, session_id: sessionId })
  const db = getSupabaseAdminClient()
  // The pool is a module-level singleton — survives across upload sessions
  // so we don't pay the ~5-10s worker init + langdata download on every
  // upload. First caller in this process eats the cost; subsequent uploads
  // get an already-warm pool. We never call .terminate() — process exit
  // cleans up.
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
    try {
      pool = await getSharedTesseractPool()
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
    log.info('OCR pool ready', { dur_ms: Date.now() - tPool })

    let totalCodesFound = 0
    let totalNoCode = 0
    let totalImagesOcrd = 0 // For visibility: how many images we actually OCR'd vs total uploaded

    // Process clusters in parallel. The Tesseract pool's idle-queue makes
    // concurrent map() calls safe (workers serialize per-recognize), and the
    // 4 workers stay saturated by images drawn from any cluster — so wall-time
    // for an N-cluster session approaches `(total_images / pool_size) * per_image`
    // rather than the previous serial sum. Cap parallelism at CLUSTER_CONCURRENCY
    // to bound DB write fan-out (each cluster does an insert + a few updates).
    const CLUSTER_CONCURRENCY = 4

    async function processCluster(cluster: ClusterImage[], cIdx: number): Promise<void> {
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
        return
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

      // ─── Batch-number image ───────────────────────────────────────────────
      // Per the workflow, the FIRST image (by capture time) is the seller's
      // case-number sticker ("3718 Parts Out…"). Read the case/batch number
      // from it (used as the listing SKU) and EXCLUDE it from part-code
      // detection — only the remaining images (esp. the last close-up) carry the
      // actual part number. Single-image batches keep their one image for code.
      // ─────────────────────────────────────────────────────────────────────
      const sortedByTime = [...cluster].sort(
        (a, b) => (a.capturedAt?.getTime() ?? 0) - (b.capturedAt?.getTime() ?? 0),
      )
      const batchNumberImage = sortedByTime[0]
      const caseNumber = await extractCaseNumber(batchNumberImage, batch.id)
      // Exclude the first image from part-code detection when it IS a case
      // sticker (a case number was read from it) — even in a 1-image batch, so a
      // lone sticker resolves to "no code extracted" rather than a junk code
      // like "AT1S.3718". When the first image has no case number (it's a normal
      // product/close-up photo), keep it in the code set.
      const codeCluster = caseNumber
        ? cluster.filter((c) => c.id !== batchNumberImage.id)
        : cluster

      // ─── Two-phase OCR ────────────────────────────────────────────────────
      // Phase 1: run OCR only on bare .jpg files (close-ups of the molded code).
      //   We pass skipBarcode=true because phase-1 inputs are molded plastic
      //   close-ups that don't carry printed barcodes — saves the zxing
      //   pre-pass cost on the common path.
      // Phase 2 (fallback): if Phase 1 produced no code, OCR up to PHASE2_CAP
      //   of the remaining images by capturedAt. Previously OCR'd every
      //   remaining PNG which is a latency cliff on clusters of 10+ PNGs.
      // ─────────────────────────────────────────────────────────────────────
      const PHASE2_CAP = 3
      const labelCandidates = pickLabelCandidates(codeCluster)
      const phase1Images = labelCandidates.length > 0 ? labelCandidates : codeCluster
      const phase1IsLabels = labelCandidates.length > 0
      const phase1Ocr = await runOcrOnImages(
        pool!,
        phase1Images,
        batch.id,
        sessionId,
        userId,
        { skipBarcode: phase1IsLabels },
      )
      totalImagesOcrd += phase1Images.length

      const phase1HasCode = phase1Ocr.some((r) => r.extracted_code)
      const phase1HadAnyText = phase1Ocr.some(
        (r) => (r.all_candidates && r.all_candidates.length > 0) || r.extracted_code,
      )
      let ocrRows: OcrRow[] = phase1Ocr

      const skippedSomeImages =
        labelCandidates.length > 0 && labelCandidates.length < codeCluster.length

      if (!phase1HasCode && skippedSomeImages) {
        const remainingAll = codeCluster.filter(
          (c) => !labelCandidates.find((l) => l.id === c.id),
        )
        // Earliest-first by capturedAt — labels are typically shot last, so the
        // earliest PNGs are the wide product shots most likely to carry a
        // printed code.
        const remaining = remainingAll
          .slice()
          .sort((a, b) => (a.capturedAt?.getTime() ?? 0) - (b.capturedAt?.getTime() ?? 0))
          .slice(0, PHASE2_CAP)
        log.info('phase 1 produced no code — running phase 2 fallback', {
          cluster_idx: cIdx,
          batch_id: batch.id,
          phase1_count: phase1Images.length,
          phase1_had_any_text: phase1HadAnyText,
          phase2_eligible: remainingAll.length,
          phase2_count: remaining.length,
          phase2_capped: remainingAll.length > remaining.length,
        })
        const phase2Ocr = await runOcrOnImages(
          pool!,
          remaining,
          batch.id,
          sessionId,
          userId,
          { skipBarcode: false },
        )
        ocrRows = [...phase1Ocr, ...phase2Ocr]
        totalImagesOcrd += remaining.length
      }

      // Stage F: pick label candidate (informs the ✨ thumbnail badge). Use
      // measured OCR confidence when we have it.
      const labelImg = pickLabelCandidate(
        codeCluster.map((c) => {
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
            // We already verified eBay is connected at session start
            // (ebayConnected above). Skip the per-cluster recheck — saves a
            // DB read + 2 AES decrypts per cluster.
            skipConnectionCheck: true,
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
          final_code: resolved.winningCode, // null => "no code extracted" in review
          case_number: caseNumber,
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

    // Bounded-concurrency runner: each "slot" pulls the next cluster index
    // until exhausted. CLUSTER_CONCURRENCY parallel slots → at most that many
    // clusters in flight at once.
    let nextCluster = 0
    const slots = Array.from(
      { length: Math.min(CLUSTER_CONCURRENCY, clusters.length) },
      async () => {
        while (true) {
          const idx = nextCluster++
          if (idx >= clusters.length) return
          await processCluster(clusters[idx], idx)
        }
      },
    )
    await Promise.all(slots)

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
  }
  // No pool.terminate() — the pool is a process-wide singleton and is
  // reused by subsequent uploads. It is freed on process exit.
}

/**
 * OCR a set of images via the shared pool, write all ocr_results rows in ONE
 * multi-row insert at the end, return the inserted rows. Errors per-image are
 * logged + written to images.error_message + enqueued for retry.
 *
 * Pipeline shape:
 *   1. Prefetch all Supabase blobs in parallel with bounded concurrency. The
 *      previous shape awaited a download inside each pool.map() worker, which
 *      meant up to N workers (N = pool size) sat idle on HTTP every time. Now
 *      a separate fetch fan-out runs in the background and workers consume
 *      buffers as soon as they land.
 *   2. pool.map runs recognizeWithFallback on the resolved buffer.
 *
 * Per-image status updates ('ocr_processing' / 'ocr_done') and the per-image
 * `upload_batches.processed` counter were removed.
 */
const DOWNLOAD_CONCURRENCY = 12

interface RunOcrOptions {
  /** Pass-through to recognizeWithFallback — see RecognizeOptions there. */
  skipBarcode?: boolean
}

interface DownloadedImage {
  image: ClusterImage
  buffer: Buffer
  mime: string
}

async function downloadAll(images: ClusterImage[]): Promise<Array<DownloadedImage | { image: ClusterImage; err: string }>> {
  const db = getSupabaseAdminClient()
  const out: Array<DownloadedImage | { image: ClusterImage; err: string }> = new Array(images.length)
  let next = 0
  const slots = Array.from(
    { length: Math.min(DOWNLOAD_CONCURRENCY, images.length) },
    async () => {
      while (true) {
        const idx = next++
        if (idx >= images.length) return
        const image = images[idx]
        try {
          const { data: blob, error } = await db.storage
            .from('images')
            .download(image.storage_path)
          if (error || !blob) {
            out[idx] = {
              image,
              err: `download failed for ${image.storage_path}: ${error?.message ?? 'no blob returned'}`,
            }
            continue
          }
          const ab = await blob.arrayBuffer()
          out[idx] = { image, buffer: Buffer.from(ab), mime: blob.type || 'image/jpeg' }
        } catch (err) {
          out[idx] = { image, err: err instanceof Error ? err.message : String(err) }
        }
      }
    },
  )
  await Promise.all(slots)
  return out
}

async function runOcrOnImages(
  pool: TesseractPool,
  images: ClusterImage[],
  batchId: string,
  sessionId: string,
  userId: string,
  options: RunOcrOptions = {},
): Promise<OcrRow[]> {
  if (images.length === 0) return []

  const log = withContext({
    scope: 'session.process.ocr',
    user_id: userId,
    session_id: sessionId,
    batch_id: batchId,
  })
  const db = getSupabaseAdminClient()

  interface PendingInsert {
    image_id: string
    raw_response: Json
    extracted_text: string
    extracted_code: string | null
    all_candidates: Json
    confidence: number | null
    provider: string
    auto_approved: false
  }
  const pending: PendingInsert[] = []

  // Phase A: prefetch every blob in parallel. By the time the OCR pool starts
  // map'ing, most/all buffers are already in memory — workers consume them
  // back-to-back instead of stalling on Supabase HTTP for each image.
  const tDl = Date.now()
  const fetched = await downloadAll(images)
  log.info('downloads complete', {
    count: images.length,
    dur_ms: Date.now() - tDl,
  })

  // Phase B: OCR via the pool. Each item already has its buffer in hand.
  await pool.map(fetched, async (worker, item) => {
    const tImg = Date.now()
    if ('err' in item) {
      log.error('image download failed — enqueuing retry', {
        image_id: item.image.id,
        filename: item.image.filename,
        err: item.err,
      })
      await db
        .from('images')
        .update({ status: 'failed', error_message: item.err })
        .eq('id', item.image.id)
      try {
        await enqueueRetry('image', item.image.id, item.err)
      } catch (e) {
        log.warn('enqueueRetry failed', { image_id: item.image.id, err: e })
      }
      return
    }

    const { image, buffer, mime } = item
    try {
      const ocrResult = await recognizeWithFallback(worker, buffer, mime, {
        skipBarcode: options.skipBarcode,
      })

      pending.push({
        image_id: image.id,
        raw_response: ocrResult.rawResponse as unknown as Json,
        extracted_text: ocrResult.extractedText,
        extracted_code: ocrResult.topCandidate?.text ?? null,
        all_candidates: ocrResult.candidates as unknown as Json,
        confidence: ocrResult.topCandidate?.confidence ?? null,
        provider: ocrResult.provider,
        auto_approved: false,
      })

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
          mime,
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
    }
  })

  if (pending.length === 0) return []

  const { data: insertedRows, error: bulkErr } = await db
    .from('ocr_results')
    .insert(pending)
    .select('id, image_id, extracted_code, confidence, all_candidates')

  if (bulkErr || !insertedRows) {
    log.error('bulk ocr_results insert failed', {
      pending_count: pending.length,
      err: bulkErr,
    })
    return []
  }

  return insertedRows.map((r) => ({
    id: r.id,
    image_id: r.image_id,
    extracted_code: r.extracted_code,
    confidence: r.confidence,
    all_candidates: (r.all_candidates as unknown as OcrCandidate[]) ?? [],
  }))
}
