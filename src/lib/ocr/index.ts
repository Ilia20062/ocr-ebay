import { runGoogleVisionOcr } from './google-vision'
import { runTesseractOcr } from './tesseract'
import { selectTopCandidate } from './code-extractor'
import type { OcrProviderResult, OcrCandidate } from '@/types/ocr'

const OCR_TOTAL_TIMEOUT_MS = 60_000

export async function runOcr(base64Content: string, mimeType = 'image/jpeg'): Promise<OcrProviderResult> {
  return Promise.race([
    _runOcr(base64Content, mimeType),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('OCR timed out after 60s')), OCR_TOTAL_TIMEOUT_MS)
    ),
  ])
}

async function _runOcr(base64Content: string, mimeType: string): Promise<OcrProviderResult> {
  const hasGoogleVision = !!process.env.GOOGLE_VISION_API_KEY

  // Always run Tesseract (free, local)
  const tesseractPromise = runTesseractOcr(base64Content, mimeType).catch(() => null)

  // Run Google Vision in parallel if configured
  const visionPromise = hasGoogleVision
    ? runGoogleVisionOcr(base64Content, mimeType).catch(() => null)
    : Promise.resolve(null)

  const [tesseractResult, visionResult] = await Promise.all([tesseractPromise, visionPromise])

  // If only one succeeded, return it
  if (!tesseractResult && !visionResult) {
    throw new Error('All OCR providers failed')
  }
  if (!visionResult) return tesseractResult!
  if (!tesseractResult) return visionResult

  // Merge candidates from both providers — union by text, keep highest confidence
  const merged = new Map<string, OcrCandidate>()
  for (const c of [...tesseractResult.candidates, ...visionResult.candidates]) {
    const existing = merged.get(c.text)
    if (!existing || c.confidence > existing.confidence) merged.set(c.text, c)
  }
  const allCandidates = [...merged.values()].sort((a, b) => b.confidence - a.confidence)

  // Build combined word confidence map (Vision wins on ties — higher quality)
  const wordConfidences = new Map<string, number>()
  const addConf = (result: OcrProviderResult, weight: number) => {
    for (const c of result.candidates) {
      const scaled = c.confidence * weight
      const existing = wordConfidences.get(c.text)
      if (!existing || scaled > existing) wordConfidences.set(c.text, scaled)
    }
  }
  addConf(tesseractResult, 0.6)
  addConf(visionResult, 1.0)

  const topCandidate = selectTopCandidate(allCandidates, wordConfidences)

  // Combine raw text — longer usually means better
  const extractedText = visionResult.extractedText.length >= tesseractResult.extractedText.length
    ? visionResult.extractedText
    : tesseractResult.extractedText

  return {
    rawResponse: { vision: visionResult.rawResponse, tesseract: tesseractResult.rawResponse },
    extractedText,
    candidates: allCandidates,
    topCandidate,
    provider: 'google_vision',
  }
}
