import os from 'node:os'
import sharp from 'sharp'
import {
  createTesseractWorker,
  recognizeWithWorker,
  recognizeBuffer,
  type TesseractWorker,
} from './tesseract'
import { runGoogleVisionOcr } from './google-vision'
import { scanBarcodeFromRgba } from './barcode'
import { runPaddleOcr, isPaddleEnabled } from './paddle'
import { maskOverlays } from './overlay-mask'
import { extractCodeWithAI, isAiExtractorEnabled } from './ai-extractor'
import { log } from '@/lib/log'
import type { OcrProviderResult } from '@/types/ocr'

/**
 * Modern phone cameras produce 4000+ pixel-wide images. Tesseract.js cost
 * scales ~linearly with pixel count; 1200 px width keeps molded codes legible
 * while cutting per-image OCR time substantially. The barcode scanner shares
 * the same width because we feed it from the same sharp pipeline.
 */
const OCR_MAX_WIDTH = 1200

interface PreprocessOutput {
  /** JPEG-encoded, EXIF-rotated, resized buffer for OCR engines. */
  jpeg: Buffer
  /** Raw RGBA pixels at the same dimensions for zxing — null if not requested. */
  rgba: Buffer | null
  width: number
  height: number
  /** True when sharp failed to decode and we fell back to the original buffer. */
  fallback: boolean
}

/**
 * Single sharp decode that produces BOTH the JPEG buffer the OCR engines need
 * AND the raw RGBA buffer the barcode scanner needs. Previously the pipeline
 * re-decoded the same JPEG twice (once in preprocessForOcr, once in scanBarcode),
 * which doubled per-image sharp cost on every image. `clone()` shares the
 * decoded source between the two output pipelines.
 */
async function preprocessForOcr(buffer: Buffer, wantRgba: boolean): Promise<PreprocessOutput> {
  try {
    const base = sharp(buffer)
      .rotate()
      .resize({ width: OCR_MAX_WIDTH, withoutEnlargement: true })

    if (wantRgba) {
      const [jpeg, rgba] = await Promise.all([
        base.clone().jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true }),
        base.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
      ])
      return {
        jpeg: jpeg.data,
        rgba: rgba.data,
        width: rgba.info.width,
        height: rgba.info.height,
        fallback: false,
      }
    }

    const jpeg = await base.jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true })
    return {
      jpeg: jpeg.data,
      rgba: null,
      width: jpeg.info.width,
      height: jpeg.info.height,
      fallback: false,
    }
  } catch (err) {
    log.warn('OCR preprocess failed — using original buffer', { scope: 'ocr.preprocess', err })
    return { jpeg: buffer, rgba: null, width: 0, height: 0, fallback: true }
  }
}

/**
 * Pool of long-lived Tesseract workers. Each worker pays the ~1-3s init cost once
 * and then handles many images. Used by the session-grouping pipeline (which OCRs
 * up to 300 images per session) and any other multi-image batch caller.
 *
 * Design: an idle-worker queue + waiter list. Each item that wants to run
 * `acquire()`s a worker, executes, then `release()`s it back. This lets several
 * callers (e.g. multiple clusters processed in parallel) share the same pool
 * safely — a worker is only ever driving one recognize() at a time, but the
 * pool as a whole has N workers running concurrently. The previous "one async
 * loop per worker" design forced map() to be called sequentially.
 */
export class TesseractPool {
  private workers: TesseractWorker[] = []
  private idleQueue: TesseractWorker[] = []
  private waiters: Array<(w: TesseractWorker) => void> = []
  private size: number

  constructor(size: number) {
    this.size = Math.max(1, size)
  }

  async init(): Promise<void> {
    if (this.workers.length > 0) return
    const t0 = Date.now()
    try {
      this.workers = await Promise.all(
        Array.from({ length: this.size }, () => createTesseractWorker()),
      )
      this.idleQueue = [...this.workers]
      log.info('TesseractPool init', { scope: 'ocr.pool', workers: this.size, dur_ms: Date.now() - t0 })
    } catch (err) {
      log.error('TesseractPool init failed', {
        scope: 'ocr.pool',
        workers: this.size,
        dur_ms: Date.now() - t0,
        err,
      })
      // Make sure any partially-created workers are torn down before we rethrow.
      try {
        await Promise.all(this.workers.map((w) => w.terminate().catch(() => {})))
      } finally {
        this.workers = []
        this.idleQueue = []
      }
      throw err
    }
  }

  private acquire(): Promise<TesseractWorker> {
    const idle = this.idleQueue.shift()
    if (idle) return Promise.resolve(idle)
    return new Promise<TesseractWorker>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  private release(w: TesseractWorker): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(w)
    else this.idleQueue.push(w)
  }

  /**
   * Run an async mapper over `items`. Each item independently acquires a free
   * worker, runs, releases. Safe to call concurrently from multiple callers —
   * a single worker is never driving more than one recognize() at once.
   * Returns results in input order.
   */
  async map<T, R>(
    items: T[],
    mapper: (worker: TesseractWorker, item: T, index: number) => Promise<R>,
  ): Promise<Array<{ ok?: R; err?: string }>> {
    if (this.workers.length === 0) await this.init()
    const out: Array<{ ok?: R; err?: string }> = new Array(items.length)
    await Promise.all(
      items.map(async (item, idx) => {
        const w = await this.acquire()
        try {
          out[idx] = { ok: await mapper(w, item, idx) }
        } catch (err) {
          out[idx] = { err: err instanceof Error ? err.message : String(err) }
        } finally {
          this.release(w)
        }
      }),
    )
    return out
  }

  async terminate(): Promise<void> {
    const ws = this.workers
    this.workers = []
    this.idleQueue = []
    // acquire() should not be called after terminate(); session-process
    // always awaits its map() calls before entering the finally block.
    this.waiters = []
    await Promise.all(ws.map((w) => w.terminate().catch(() => {})))
  }
}

/**
 * Singleton pool stored on `globalThis`, NOT module scope.
 *
 * Why globalThis: Next.js dev mode hot-reloads modules — every edit nulls
 * module-scope `let` bindings while the previously-created Tesseract worker
 * processes keep running. Over a few HMR cycles you accumulate dozens of
 * orphaned workers piping to stdout/stderr, which exhausts SyncWriteStream
 * listeners (`MaxListenersExceededWarning: 11 unpipe listeners added`) and
 * eventually causes Next's compilation workers to crash with
 * `Jest worker encountered child process exceptions`. Storing the pool on
 * `globalThis` survives HMR so we re-use exactly one pool per Node process.
 */
const POOL_GLOBAL_KEY = Symbol.for('ocr-crm.tesseract-pool')
const INIT_GLOBAL_KEY = Symbol.for('ocr-crm.tesseract-pool-init')

type PoolGlobal = typeof globalThis & {
  [POOL_GLOBAL_KEY]?: TesseractPool | null
  [INIT_GLOBAL_KEY]?: Promise<TesseractPool> | null
}

const globalForPool = globalThis as PoolGlobal

function readPoolSize(): number {
  const raw = process.env.OCR_CONCURRENCY
  const parsed = raw ? parseInt(raw, 10) : NaN
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 16) return parsed
  // Auto-size: one worker per CPU minus the main thread, clamped [4, 8]. Below
  // 4 the pool stalls behind serial sharp+download cost; above 8 we just churn
  // L3 with no Tesseract-side speedup on a typical desktop.
  const cpuCount = os.cpus()?.length ?? 4
  return Math.max(4, Math.min(8, cpuCount - 1))
}

export async function getSharedTesseractPool(): Promise<TesseractPool> {
  const existing = globalForPool[POOL_GLOBAL_KEY]
  if (existing) return existing
  const inflight = globalForPool[INIT_GLOBAL_KEY]
  if (inflight) return inflight

  const size = readPoolSize()
  // Node's default per-EventEmitter cap is 10. With N Tesseract worker child
  // processes piping to stdout/stderr plus Next's own compile workers, we
  // routinely exceed that during dev and produce noisy warnings. Bump the
  // cap on the relevant streams so they don't false-positive as leaks.
  try {
    process.stdout.setMaxListeners(Math.max(20, size * 4))
    process.stderr.setMaxListeners(Math.max(20, size * 4))
  } catch {
    // setMaxListeners isn't critical — proceed if the stream rejects it.
  }

  const init = (async () => {
    const p = new TesseractPool(size)
    try {
      await p.init()
    } catch (err) {
      globalForPool[INIT_GLOBAL_KEY] = null
      throw err
    }
    globalForPool[POOL_GLOBAL_KEY] = p
    globalForPool[INIT_GLOBAL_KEY] = null
    return p
  })()
  globalForPool[INIT_GLOBAL_KEY] = init
  return init
}

/**
 * Convenience wrapper: run OCR on one image using a pool worker, base64 input.
 */
export function recognizeFromBase64(
  worker: TesseractWorker,
  base64: string,
  mimeType?: string,
): Promise<OcrProviderResult> {
  return recognizeWithWorker(worker, base64, mimeType)
}

/**
 * Convenience wrapper: run OCR on one image using a pool worker, raw Buffer input.
 * Preferred over base64 — avoids a round-trip and works around Tesseract.js v7
 * issues with large data URLs in Node.
 */
export function recognizeFromBuffer(
  worker: TesseractWorker,
  buffer: Buffer,
  mimeType?: string,
): Promise<OcrProviderResult> {
  return recognizeBuffer(worker, buffer, mimeType)
}

/**
 * Recognize an image with multi-provider fallback.
 *
 * Strategy:
 *   1. Tesseract.js (in-process, free, ~1-3s/image) — always tried first.
 *   2. Google Vision API (network, free quota 1000/month, much higher accuracy
 *      on molded/embossed text) — used as fallback when Tesseract returned
 *      empty text, no candidates, or only weak candidates.
 *
 * The two providers' outputs aren't merged — we pick whichever found something
 * usable. Vision is generally better on the test data (28/36 vs 17/36 codes in
 * dry-run benchmarks), so when both return candidates we prefer Vision.
 *
 * Vision is silently skipped if GOOGLE_VISION_API_KEY isn't set.
 */
export interface RecognizeOptions {
  /**
   * Skip the zxing barcode pre-pass. Use when the input is known not to contain
   * printed barcodes (molded-plastic close-ups in phase-1 of session/process).
   * Avoids the raw-RGBA encode + zxing TRY_HARDER decode cost (~200-400ms/img).
   */
  skipBarcode?: boolean
  /** Skip the AI vision extractor (e.g. for bulk/low-value images). */
  skipAI?: boolean
}

export async function recognizeWithFallback(
  worker: TesseractWorker,
  buffer: Buffer,
  mimeType?: string,
  options: RecognizeOptions = {},
): Promise<OcrProviderResult> {
  const visionEnabled = !!process.env.GOOGLE_VISION_API_KEY
  const paddleEnabled = isPaddleEnabled()
  const wantBarcode = !options.skipBarcode

  // Paint out the seller's fixed-position photo-template overlays (logo +
  // warranty badge) BEFORE any OCR so neither engine can misread "PartsOut" /
  // "WARRANTY" / "90 DAYS" as a part number. No-op if disabled or on failure.
  const { buffer: ocrBuffer, mime: ocrMime } = await maskOverlays(buffer)

  // Single sharp pipeline: produce JPEG (for OCR) + optional RGBA (for zxing)
  // from one decode. Previously preprocessForOcr + scanBarcode each ran their
  // own sharp pipeline against the original buffer — doubling per-image decode
  // cost. Skipping RGBA when barcode is disabled avoids the extra encode too.
  const processed = await preprocessForOcr(ocrBuffer, wantBarcode)
  const processedJpeg = processed.jpeg
  const processedMime = processed.fallback ? ocrMime : 'image/jpeg'

  // 0) Barcode pre-pass (when requested + we have RGBA pixels in hand).
  //    Pure-1D and QR codes return their exact payload with effectively 100%
  //    confidence, beating any OCR engine.
  if (wantBarcode && processed.rgba) {
    try {
      const hit = scanBarcodeFromRgba(processed.rgba, processed.width, processed.height)
      if (hit) {
        return {
          rawResponse: { format: hit.format, code: hit.code },
          extractedText: hit.code,
          candidates: [{ text: hit.code, confidence: 1 }],
          topCandidate: { text: hit.code, confidence: 1 },
          provider: 'barcode',
        }
      }
    } catch (err) {
      log.debug('barcode pre-pass threw', { scope: 'ocr.recognize', err })
    }
  }

  // 0.5) AI vision extraction (PRIMARY when OPENROUTER_API_KEY is set).
  //      A vision LLM understands which text is the real OEM part number vs the
  //      seller's "PartsOut" logo, "Warranty / 90 Days" badge, and the
  //      manufacturing date — the exact noise that wrecks OCR+regex here. Fed
  //      the ORIGINAL full-res buffer (best for faint engravings). Falls
  //      through to OCR on null / unavailable / no readable code.
  if (isAiExtractorEnabled() && !options.skipAI) {
    try {
      const aiResult = await extractCodeWithAI([{ buffer, mime: mimeType ?? 'image/jpeg' }])
      if (aiResult?.topCandidate) return aiResult
    } catch (err) {
      log.warn('AI extractor failed — falling back to OCR', { scope: 'ocr.recognize', err })
    }
  }

  // 1) Primary OCR.
  let primaryResult: OcrProviderResult | null = null
  let primaryErr: unknown = null
  const primaryStart = Date.now()
  const primaryName = paddleEnabled ? 'paddle' : 'tesseract'

  try {
    if (paddleEnabled) {
      primaryResult = await runPaddleOcr(processedJpeg, processedMime)
    } else {
      primaryResult = await recognizeBuffer(worker, processedJpeg, processedMime)
    }
  } catch (err) {
    primaryErr = err
    log.warn(`${primaryName} attempt failed`, {
      scope: 'ocr.recognize',
      provider: primaryName,
      dur_ms: Date.now() - primaryStart,
      err,
    })
    if (paddleEnabled) {
      try {
        primaryResult = await recognizeBuffer(worker, processedJpeg, processedMime)
      } catch (tessErr) {
        log.warn('Tesseract failed after Paddle failure', {
          scope: 'ocr.recognize',
          err: tessErr,
        })
      }
    }
  }

  // High-confidence primary hit → return immediately, skip Vision call.
  //
  // 0.85 is the cap of scoreCandidate's heuristic alone — so anything ≥0.85
  // must have been boosted by a real OCR word-confidence read (the average of
  // heuristic + wordConf in selectTopCandidate). That's the only condition
  // under which we trust primary enough to skip Vision. The previous threshold
  // (0.55) let pure-heuristic scores on garbage like "SER3SAAS" pre-empt
  // Vision, which is exactly what made molded-code OCR regress.
  if (primaryResult?.topCandidate && primaryResult.topCandidate.confidence >= 0.85) {
    return primaryResult
  }

  // 2) Vision fallback — covers primary returning empty, no candidates, or
  //    weak candidates the user is unlikely to be happy with.
  //
  // Vision is fed the ORIGINAL buffer (not the 1200px downscale). Phone-photo
  // molded codes need every available pixel to resolve the engraving, and
  // Vision charges per call (not per pixel) with its own internal scaling.
  // Feeding it the downscaled image was the second half of the OCR regression.
  if (visionEnabled) {
    const visionStart = Date.now()
    try {
      // Vision gets the ORIGINAL full-res buffer (not masked, not downscaled):
      // it reads faint engraved digits best at full fidelity, and the extractor
      // already rejects the seller overlays from its token stream. Masking is
      // only applied to the Tesseract path (which merges adjacent text).
      const visionResult = await runGoogleVisionOcr(buffer.toString('base64'), mimeType)
      log.info('Vision fallback ran', {
        scope: 'ocr.recognize',
        text_len: visionResult.extractedText.length,
        candidates: visionResult.candidates.length,
        top_code: visionResult.topCandidate?.text ?? null,
        top_conf: visionResult.topCandidate
          ? Number(visionResult.topCandidate.confidence.toFixed(2))
          : null,
        dur_ms: Date.now() - visionStart,
      })

      // Prefer Vision by candidate QUALITY, not count. Tesseract on noisy molded
      // codes emits many junk candidates that used to out-number — and wrongly
      // suppress — Vision's single clean read. Use Vision when its best candidate
      // is at least as strong as primary's, or when primary found none at all.
      const primTop = primaryResult?.topCandidate?.confidence ?? 0
      const visTop = visionResult.topCandidate?.confidence ?? 0
      if (visionResult.topCandidate && visTop >= primTop) {
        return visionResult
      }
      if (
        !primaryResult?.topCandidate &&
        visionResult.extractedText.length > (primaryResult?.extractedText.length ?? 0)
      ) {
        return visionResult
      }
    } catch (err) {
      log.warn('Vision fallback failed', {
        scope: 'ocr.recognize',
        dur_ms: Date.now() - visionStart,
        err,
      })
    }
  }

  if (primaryResult) return primaryResult

  throw new Error(
    `All OCR providers failed: ${primaryErr instanceof Error ? primaryErr.message : String(primaryErr)}`,
  )
}
