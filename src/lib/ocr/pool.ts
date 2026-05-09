import {
  createTesseractWorker,
  recognizeWithWorker,
  recognizeBuffer,
  type TesseractWorker,
} from './tesseract'
import { runGoogleVisionOcr } from './google-vision'
import { log } from '@/lib/log'
import type { OcrProviderResult } from '@/types/ocr'

/**
 * Pool of long-lived Tesseract workers. Each worker pays the ~1-3s init cost once
 * and then handles many images. Used by the session-grouping pipeline (which OCRs
 * up to 300 images per session) and any other multi-image batch caller.
 */
export class TesseractPool {
  private workers: TesseractWorker[] = []
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
      }
      throw err
    }
  }

  /**
   * Run an async mapper over `items` with each item assigned to one of the pool's
   * workers. Workers are not thread-safe individually, so each worker handles one
   * item at a time. Returns results in input order.
   */
  async map<T, R>(
    items: T[],
    mapper: (worker: TesseractWorker, item: T, index: number) => Promise<R>,
  ): Promise<Array<{ ok?: R; err?: string }>> {
    if (this.workers.length === 0) await this.init()
    const out: Array<{ ok?: R; err?: string }> = new Array(items.length)
    let next = 0
    await Promise.all(
      this.workers.map(async (w) => {
        while (true) {
          const idx = next++
          if (idx >= items.length) return
          try {
            out[idx] = { ok: await mapper(w, items[idx], idx) }
          } catch (err) {
            out[idx] = { err: err instanceof Error ? err.message : String(err) }
          }
        }
      }),
    )
    return out
  }

  async terminate(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate().catch(() => {})))
    this.workers = []
  }
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
export async function recognizeWithFallback(
  worker: TesseractWorker,
  buffer: Buffer,
  mimeType?: string,
): Promise<OcrProviderResult> {
  const visionEnabled = !!process.env.GOOGLE_VISION_API_KEY

  // 1) Tesseract attempt
  let tessResult: OcrProviderResult | null = null
  let tessErr: unknown = null
  const tessStart = Date.now()
  try {
    tessResult = await recognizeBuffer(worker, buffer, mimeType)
  } catch (err) {
    tessErr = err
    log.warn('Tesseract attempt failed', {
      scope: 'ocr.recognize',
      dur_ms: Date.now() - tessStart,
      err,
    })
  }

  // High-confidence Tesseract hit → return immediately, skip Vision call.
  if (tessResult?.topCandidate && tessResult.topCandidate.confidence >= 0.55) {
    return tessResult
  }

  // 2) Vision fallback — covers Tesseract returning empty, no candidates, or
  //    weak candidates the user is unlikely to be happy with.
  if (visionEnabled) {
    const visionStart = Date.now()
    try {
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

      // Prefer Vision when it produced ANY candidate or substantially more text.
      const tessCands = tessResult?.candidates.length ?? 0
      const tessTextLen = tessResult?.extractedText.length ?? 0
      if (
        visionResult.candidates.length > tessCands ||
        (visionResult.candidates.length === tessCands && visionResult.extractedText.length > tessTextLen)
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

  if (tessResult) return tessResult

  throw new Error(
    `All OCR providers failed: ${tessErr instanceof Error ? tessErr.message : String(tessErr)}`,
  )
}
