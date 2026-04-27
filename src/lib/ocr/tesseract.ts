import type { OcrProviderResult } from '@/types/ocr'
import { extractCandidates, selectTopCandidate } from './code-extractor'

const TESSERACT_TIMEOUT_MS = 30_000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ])
}

export async function runTesseractOcr(base64Content: string, mimeType = 'image/jpeg'): Promise<OcrProviderResult> {
  const { createWorker } = await import('tesseract.js')

  const worker = await createWorker('eng', 1, {
    logger: () => {},
    // Use CDN for lang data — explicit to avoid resolution issues in Next.js
    langPath: 'https://tessdata.projectnaptha.com/4.0.0',
    workerPath: undefined,
    corePath: undefined,
  })

  try {
    const dataUrl = `data:${mimeType};base64,${base64Content}`
    const { data } = await withTimeout(
      worker.recognize(dataUrl),
      TESSERACT_TIMEOUT_MS,
      'Tesseract'
    )
    const fullText = data.text ?? ''

    const wordConfidences = new Map<string, number>()
    for (const word of data.words ?? []) {
      const w = word.text.toUpperCase().trim()
      if (!w) continue
      const conf = (word.confidence ?? 0) / 100
      const existing = wordConfidences.get(w)
      if (!existing || conf > existing) wordConfidences.set(w, conf)
    }

    const candidates = extractCandidates(fullText)
    const topCandidate = selectTopCandidate(candidates, wordConfidences)

    return {
      rawResponse: { text: fullText, words: data.words },
      extractedText: fullText,
      candidates,
      topCandidate,
      provider: 'tesseract',
    }
  } finally {
    await worker.terminate().catch(() => {})
  }
}
