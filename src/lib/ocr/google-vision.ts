import type { OcrProviderResult } from '@/types/ocr'
import { extractCandidates, selectTopCandidate } from './code-extractor'

interface VisionAnnotation {
  description: string
  confidence?: number
  boundingPoly?: unknown
}

interface VisionWord {
  property?: { detectedLanguages?: unknown[] }
  boundingBox?: unknown
  symbols?: Array<{ text: string; confidence?: number }>
  confidence?: number
}

interface VisionBlock {
  paragraphs?: Array<{ words?: VisionWord[] }>
}

interface VisionPage {
  blocks?: VisionBlock[]
}

interface VisionFullAnnotation {
  text?: string
  pages?: VisionPage[]
}

interface VisionResponse {
  textAnnotations?: VisionAnnotation[]
  fullTextAnnotation?: VisionFullAnnotation
  error?: { code: number; message: string }
}

export async function runGoogleVisionOcr(base64Content: string, _mimeType = 'image/jpeg'): Promise<OcrProviderResult> {
  const apiKey = process.env.GOOGLE_VISION_API_KEY

  if (!apiKey) {
    throw new Error('Google Vision credentials not configured: missing GOOGLE_VISION_API_KEY')
  }

  const endpoint = `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`

  const body = {
    requests: [{
      image: { content: base64Content },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
    }],
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    throw new Error(`Google Vision API error: ${res.status} ${res.statusText}`)
  }

  const data = await res.json() as { responses?: VisionResponse[] }
  const response = data.responses?.[0]

  if (response?.error) {
    throw new Error(`Vision API: ${response.error.message}`)
  }

  const fullText = response?.fullTextAnnotation?.text ?? response?.textAnnotations?.[0]?.description ?? ''

  // Build word-level confidence map from fullTextAnnotation
  const wordConfidences = new Map<string, number>()
  for (const page of response?.fullTextAnnotation?.pages ?? []) {
    for (const block of page.blocks ?? []) {
      for (const para of block.paragraphs ?? []) {
        for (const word of para.words ?? []) {
          const wordText = (word.symbols ?? []).map((s) => s.text).join('').toUpperCase()
          const conf = word.confidence ?? 0
          const existing = wordConfidences.get(wordText)
          if (!existing || conf > existing) {
            wordConfidences.set(wordText, conf)
          }
        }
      }
    }
  }

  const candidates = extractCandidates(fullText)
  const topCandidate = selectTopCandidate(candidates, wordConfidences)

  return {
    rawResponse: response ?? null,
    extractedText: fullText,
    candidates,
    topCandidate,
    provider: 'google_vision',
  }
}
