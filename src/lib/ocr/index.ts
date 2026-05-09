import { runTesseractOcr } from './tesseract'
import type { OcrProviderResult } from '@/types/ocr'

const OCR_TOTAL_TIMEOUT_MS = 60_000

export async function runOcr(base64Content: string, mimeType = 'image/jpeg'): Promise<OcrProviderResult> {
  return Promise.race([
    runTesseractOcr(base64Content, mimeType),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('OCR timed out after 60s')), OCR_TOTAL_TIMEOUT_MS)
    ),
  ])
}
