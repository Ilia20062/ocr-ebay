import { isWatermark } from './code-extractor'
import { log } from '@/lib/log'
import type { OcrProviderResult } from '@/types/ocr'

/**
 * AI vision-based part-number extraction via OpenRouter.
 *
 * Unlike OCR+regex, a vision LLM *understands* the photo: it tells the real
 * manufacturer/OEM part number apart from the seller's "PartsOut" branding,
 * "Warranty / 90 Days" text, and manufacturing dates — which is exactly the
 * failure mode on these listings. Used as the PRIMARY extractor when
 * OPENROUTER_API_KEY is set; OCR (Tesseract/Vision) remains the fallback.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

const PROMPT = `You are extracting the manufacturer / OEM part number (MPN) from a photo of a used automotive part or its label. The number is stamped, molded, etched, or printed on the part or a sticker.

Rules:
- Return ONLY the part number, exactly as it appears (letters, digits, dashes, slashes, dots).
- NEVER return any of these — they are NOT part numbers: the seller brand "PartsOut", warranty text like "Warranty" / "90 Days", manufacturing dates like "30.03.11", country/quantity/price, or generic words.
- Only output a part number if you can read it CLEARLY and are confident. If it is faint, blurry, partially hidden, or you are guessing, output NONE — do not invent or guess digits.

Respond with the part number, or NONE — nothing else.`

export function isAiExtractorEnabled(): boolean {
  return !!process.env.OPENROUTER_API_KEY
}

function model(): string {
  return process.env.OCR_AI_MODEL || 'openai/gpt-4o'
}

function sanitize(raw: string): string | null {
  // Keep only code-ish characters; drop surrounding words/quotes the model may add.
  const cleaned = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .toUpperCase()
  if (!cleaned || cleaned === 'NONE') return null
  // Collapse internal whitespace, keep alnum + - / . +
  const code = cleaned.replace(/\s+/g, '').replace(/[^A-Z0-9\-/.+]/g, '')
  if (code.length < 3) return null
  // A real part number always has at least one digit and isn't seller boilerplate.
  if (!/\d/.test(code)) return null
  if (isWatermark(code)) return null
  return code
}

/**
 * Ask the vision model for the part number in one or more images of the same
 * part. Returns an OcrProviderResult (provider 'ai') or null if unavailable /
 * no readable part number.
 */
export async function extractCodeWithAI(
  images: Array<{ buffer: Buffer; mime: string }>,
): Promise<OcrProviderResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey || images.length === 0) return null

  const content: Array<Record<string, unknown>> = [{ type: 'text', text: PROMPT }]
  for (const im of images.slice(0, 6)) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${im.mime};base64,${im.buffer.toString('base64')}` },
    })
  }

  const t0 = Date.now()
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'https://localhost',
        'X-Title': 'OCR CRM part-number extraction',
      },
      body: JSON.stringify({
        model: model(),
        max_tokens: 30,
        temperature: 0,
        messages: [{ role: 'user', content }],
      }),
    })
    if (!res.ok) {
      log.warn('AI extractor HTTP error', { scope: 'ocr.ai', status: res.status })
      return null
    }
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; error?: unknown }
    if (j.error) {
      log.warn('AI extractor API error', { scope: 'ocr.ai', err: JSON.stringify(j.error).slice(0, 200) })
      return null
    }
    const raw = j.choices?.[0]?.message?.content ?? ''
    const code = sanitize(raw)
    log.info('AI extractor result', {
      scope: 'ocr.ai',
      model: model(),
      images: images.length,
      raw: raw.slice(0, 40),
      code,
      dur_ms: Date.now() - t0,
    })
    if (!code) return null
    return {
      rawResponse: { ai: raw },
      extractedText: code,
      candidates: [{ text: code, confidence: 0.9 }],
      topCandidate: { text: code, confidence: 0.9 },
      provider: 'ai',
    }
  } catch (err) {
    log.warn('AI extractor threw', { scope: 'ocr.ai', err, dur_ms: Date.now() - t0 })
    return null
  }
}
