import type { OcrCandidate } from '@/types/ocr'

// Part number pattern: uppercase letters, digits, hyphens, slashes, dots, plus — 4 to 25 chars
// \b breaks on + so we use a lookahead/lookbehind for non-alphanumeric boundaries instead
const PART_NUMBER_REGEX = /(?<![A-Z0-9])([A-Z0-9][A-Z0-9\-\/\.\+]{2,23}[A-Z0-9])(?![A-Z0-9])/g

export function extractCandidates(text: string): OcrCandidate[] {
  if (!text) return []

  // Strip non-ASCII symbols (e.g. ◄ ► ™ ® around embossed codes) then normalize whitespace
  const normalized = text.toUpperCase().replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ')
  const matches = [...normalized.matchAll(PART_NUMBER_REGEX)]

  const seen = new Set<string>()
  const candidates: OcrCandidate[] = []

  for (const match of matches) {
    const code = match[1]
    if (seen.has(code)) continue
    seen.add(code)

    // Score heuristic: longer alphanumeric codes with mixed digits are more likely part numbers
    const score = scoreCandidate(code)
    if (score > 0) {
      candidates.push({ text: code, confidence: score })
    }
  }

  return candidates.sort((a, b) => b.confidence - a.confidence)
}

function scoreCandidate(code: string): number {
  const hasDigit = /\d/.test(code)
  const hasLetter = /[A-Z]/.test(code)
  const length = code.length

  // Pure alphabetic short strings are likely words, not codes
  if (!hasDigit && length < 6) return 0

  // Base: 0.4 — heuristic score intentionally stays below auto-approve threshold (0.90)
  // so OCR provider word-level confidence is required to push it over
  let score = 0.4

  if (hasDigit && hasLetter) score += 0.2
  if (length >= 6 && length <= 20) score += 0.1
  if (/[-\/]/.test(code)) score += 0.05
  if (/\+/.test(code)) score += 0.05

  return Math.min(score, 0.75)
}

export function selectTopCandidate(
  candidates: OcrCandidate[],
  wordConfidences: Map<string, number>
): OcrCandidate | null {
  if (candidates.length === 0) return null

  // Apply Vision API word-level confidence to each candidate
  const scored = candidates.map((c) => {
    const wordConf = wordConfidences.get(c.text) ?? c.confidence
    return { ...c, confidence: (c.confidence + wordConf) / 2 }
  })

  scored.sort((a, b) => b.confidence - a.confidence)
  return scored[0]
}
