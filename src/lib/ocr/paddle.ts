/**
 * PaddleOCR client — talks to a sidecar microservice running PaddleOCR.
 *
 * Why a sidecar? PaddleOCR is a Python library on top of native deps; pulling
 * it into the Next.js Node runtime is impractical. The sidecar exposes a tiny
 * `POST /ocr` endpoint that accepts an image buffer and returns parsed text
 * with per-word confidences — the same shape Tesseract gives us, so the rest
 * of the pipeline doesn't care which engine ran.
 *
 * Enabled by setting `PADDLE_OCR_URL` (e.g. `https://paddle.up.railway.app`).
 * When unset, `recognizeWithFallback` keeps using Tesseract.
 *
 * Deploy: see `paddle-ocr/README.md` — a single `railway up` from that folder.
 */

import { extractCandidates, selectTopCandidate } from './code-extractor'
import { log } from '@/lib/log'
import type { OcrProviderResult } from '@/types/ocr'

const PADDLE_TIMEOUT_MS = 30_000

interface PaddleWord {
  text: string
  confidence: number
}

interface PaddleResponse {
  text: string
  words: PaddleWord[]
}

export function isPaddleEnabled(): boolean {
  return !!process.env.PADDLE_OCR_URL
}

function getBaseUrl(): string {
  const u = process.env.PADDLE_OCR_URL
  if (!u) throw new Error('PADDLE_OCR_URL is not set')
  return u.replace(/\/$/, '')
}

/**
 * POST the image bytes to the sidecar. The sidecar handles decoding,
 * preprocessing, and OCR — we just pass the raw buffer.
 */
export async function runPaddleOcr(
  buffer: Buffer,
  mimeType = 'image/jpeg',
): Promise<OcrProviderResult> {
  const t0 = Date.now()
  const url = `${getBaseUrl()}/ocr`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PADDLE_TIMEOUT_MS)

  let res: Response
  try {
    // Copy into a fresh ArrayBuffer — undici fetch BodyInit accepts
    // ArrayBuffer/Blob/string. Node's Buffer is technically a Uint8Array<ArrayBufferLike>
    // which TS strict mode rejects for BodyInit.
    const ab = new ArrayBuffer(buffer.length)
    new Uint8Array(ab).set(buffer)
    const body: BodyInit = ab
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': mimeType,
        // Lightweight shared-secret auth — sidecar rejects requests without it
        // when PADDLE_OCR_TOKEN is set on its side.
        ...(process.env.PADDLE_OCR_TOKEN
          ? { Authorization: `Bearer ${process.env.PADDLE_OCR_TOKEN}` }
          : {}),
      },
      body,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`PaddleOCR sidecar returned ${res.status}: ${text.slice(0, 200)}`)
  }

  const data = (await res.json()) as PaddleResponse
  const fullText = data.text ?? ''

  // Build word-confidence map for selectTopCandidate.
  const wordConfidences = new Map<string, number>()
  for (const w of data.words ?? []) {
    const key = w.text.toUpperCase().trim()
    if (!key) continue
    const existing = wordConfidences.get(key)
    if (!existing || w.confidence > existing) wordConfidences.set(key, w.confidence)
  }

  const candidates = extractCandidates(fullText)
  const topCandidate = selectTopCandidate(candidates, wordConfidences)

  log.debug('paddle ocr done', {
    scope: 'ocr.paddle',
    text_len: fullText.length,
    words: data.words?.length ?? 0,
    candidates: candidates.length,
    top_code: topCandidate?.text ?? null,
    dur_ms: Date.now() - t0,
  })

  return {
    rawResponse: data,
    extractedText: fullText,
    candidates,
    topCandidate,
    provider: 'paddle',
  }
}
