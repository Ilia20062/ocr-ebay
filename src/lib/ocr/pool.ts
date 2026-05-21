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
 * Module-level singleton pool. Survives across upload sessions so the
 * ~5-10s worker init + langdata download is paid exactly once per Node
 * process, not once per upload. Lazy-init on first use; concurrent first
 * callers share a single in-flight init promise.
 */
let sharedPool: TesseractPool | null = null
let sharedPoolInit: Promise<TesseractPool> | null = null

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
  if (sharedPool) return sharedPool
  if (sharedPoolInit) return sharedPoolInit
  const size = readPoolSize()
  sharedPoolInit = (async () => {
    const p = new TesseractPool(size)
    try {
      await p.init()
    } catch (err) {
      sharedPoolInit = null
      throw err
    }
    sharedPool = p
    sharedPoolInit = null
    return p
  })()
  return sharedPoolInit
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

  // Single sharp pipeline: produce JPEG (for OCR) + optional RGBA (for zxing)
  // from one decode. Previously preprocessForOcr + scanBarcode each ran their
  // own sharp pipeline against the original buffer — doubling per-image decode
  // cost. Skipping RGBA when barcode is disabled avoids the extra encode too.
  const processed = await preprocessForOcr(buffer, wantBarcode)
  const processedJpeg = processed.jpeg
  const processedMime = processed.fallback ? mimeType : 'image/jpeg'

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
  if (primaryResult?.topCandidate && primaryResult.topCandidate.confidence >= 0.55) {
    return primaryResult
  }

  // 2) Vision fallback — covers primary returning empty, no candidates, or
  //    weak candidates the user is unlikely to be happy with.
  if (visionEnabled) {
    const visionStart = Date.now()
    try {
      const visionResult = await runGoogleVisionOcr(processedJpeg.toString('base64'), processedMime)
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

      // Prefer Vision when it produced ANY candidate or substantially more text.
      const primCands = primaryResult?.candidates.length ?? 0
      const primTextLen = primaryResult?.extractedText.length ?? 0
      if (
        visionResult.candidates.length > primCands ||
        (visionResult.candidates.length === primCands && visionResult.extractedText.length > primTextLen)
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
