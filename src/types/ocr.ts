export interface OcrCandidate {
  text: string
  confidence: number
}

export interface OcrProviderResult {
  rawResponse: unknown
  extractedText: string
  candidates: OcrCandidate[]
  topCandidate: OcrCandidate | null
  provider: 'google_vision' | 'tesseract'
}
