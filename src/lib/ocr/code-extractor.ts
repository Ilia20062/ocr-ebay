import type { OcrCandidate } from '@/types/ocr'

// Part number pattern: uppercase letters, digits, hyphens, slashes, dots, plus — 4 to 25 chars
// \b breaks on + so we use a lookahead/lookbehind for non-alphanumeric boundaries instead
const PART_NUMBER_REGEX = /(?<![A-Z0-9])([A-Z0-9][A-Z0-9\-\/\.\+]{2,23}[A-Z0-9])(?![A-Z0-9])/g

// Boilerplate text that survives the digit-required guard and otherwise leaks
// into the cluster's "dominant code". Anything matching is rejected outright.
//
// Patterns first, then a literal set for one-off strings that wouldn't be
// caught by a clean pattern.
const WATERMARK_PATTERNS: RegExp[] = [
  /^O?\d{1,3}\s*DAYS?$/,         // "90DAYS", "O90DAYS", "30 DAYS", "70DAYS"
  /^\d{1,3}\s*YEARS?$/,          // "1YEAR", "2YEARS"
  /^\d{1,2}\s*MONTHS?$/,         // "12MONTH", "6MONTHS"
  /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/, // dates: "11/06/15", "11.06.2015"
  /^\d{1,2}:\d{2}(?::\d{2})?$/,  // times: "21:20", "21:20:01"
  /^V?\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/, // version-y: "V1.0", "1.2.3"
]

// Exact-match watermark / boilerplate words that pass the digit guard.
// Add aggressively — false negatives (missed watermarks) hurt more than
// false positives (a real code that happens to match boilerplate is rare).
const WATERMARK_LITERALS = new Set<string>([
  'PE-94',     // recurring watermark in this dataset; not a real OEM PN format
  'OFI2',
  '90DAY',
  '90DAYS',
  'O90DAYS',
  '70DAYS',
  '60DAYS',
  '30DAYS',
  'MADEIN',
  'MADE-IN',
  'ISO9001',
  'ISO-9001',
  'CE2024',
  'CE2025',
  'CE2026',
])

export function isWatermark(code: string): boolean {
  if (!code) return false
  const c = code.toUpperCase().trim()
  if (WATERMARK_LITERALS.has(c)) return true
  for (const re of WATERMARK_PATTERNS) {
    if (re.test(c)) return true
  }
  return false
}

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

  // Pure-alphabetic strings are words ("WARRANTY", "GENUINE", "PATENT"), not codes.
  // A real serial / part number on a label always contains at least one digit.
  if (!hasDigit) return 0

  // Reject known watermark / boilerplate text (warranty stamps, dates, times,
  // version strings). These pass the digit guard but are never real part numbers.
  if (isWatermark(code)) return 0

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
