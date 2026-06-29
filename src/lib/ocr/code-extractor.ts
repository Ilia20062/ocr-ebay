import type { OcrCandidate } from '@/types/ocr'

/**
 * Extract the seller's case / batch number from the FIRST image of a batch
 * (the case-number sticker, e.g. "3718 Parts Out Warranty 90 Days" → "3718").
 *
 * This is NOT a part number: it's a plain integer the seller writes on each
 * case, used as the listing SKU. We reject warranty durations ("90 DAYS"),
 * years, and date components so only the real case number remains.
 */
export function extractBatchNumber(text: string): string | null {
  if (!text) return null
  const norm = text.toUpperCase().replace(/[^\x20-\x7E]/g, ' ')
  const candidates: string[] = []
  for (const m of norm.matchAll(/(\d{1,6})/g)) {
    const num = m[1]
    const idx = m.index ?? 0
    const before = idx > 0 ? norm[idx - 1] : ''
    const afterChar = norm[idx + num.length] ?? ''
    const afterWord = norm.slice(idx + num.length).trimStart()
    // part of a date / decimal ("30.03.11", "7.47") — skip
    if (before === '.' || before === '/' || afterChar === '.' || afterChar === '/' || afterChar === ':') continue
    // warranty / duration ("90 DAYS", "1 YEAR", "12 MONTHS") — skip
    if (/^(DAYS?|YEARS?|MONTHS?)\b/.test(afterWord)) continue
    // calendar years — skip
    if (/^(19|20)\d\d$/.test(num)) continue
    candidates.push(num)
  }
  if (candidates.length === 0) return null
  // Prefer the longest (most specific) standalone number as the case number.
  candidates.sort((a, b) => b.length - a.length || candidates.indexOf(a) - candidates.indexOf(b))
  return candidates[0]
}

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
  /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}[/.-]\d{1,4}$/, // date + batch/shift suffix: "30.03.11/141"
  /^\d{1,2}:\d{2}(?::\d{2})?$/,  // times: "21:20", "21:20:01"
  /^V?\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/, // version-y: "V1.0", "1.2.3"
]

// Seller photo-template branding / boilerplate that OCR glues onto nearby
// digits ("3718PARTS", "PARTSQUT4", "PARTSOUT3P-", "5Z90DAYS"). A genuine OEM
// part number never contains these words, so reject any candidate that CONTAINS
// one (matched against the uppercased candidate).
const WATERMARK_SUBSTRINGS: string[] = [
  'PARTS', // seller "PartsOut" — covers PARTSOUT/PARTSQUT/PARTSUT/PARTSO/3718PARTS
  'PARTOUT', // OCR misread of "PartsOut" dropping the S
  'WARRANT',
  'DAYS',
  'GENUINE',
  'ORIGINAL',
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

// True if the code embeds a plausible date (DD.MM.YY[.batch]) anywhere — e.g.
// "30.03.11/141", or a date glued to a fragment like "30.03.11/14M23". We
// validate day ≤ 31 and month ≤ 12 so genuine part numbers with three numeric
// groups ("12-34-5678", month 34) are NOT mistaken for dates.
function embedsDate(c: string): boolean {
  const m = c.match(/(\d{1,2})[.\-/](\d{1,2})[.\-/]\d{2,4}/)
  if (!m) return false
  const dd = Number(m[1])
  const mm = Number(m[2])
  return dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12
}

export function isWatermark(code: string): boolean {
  if (!code) return false
  const c = code.toUpperCase().trim()
  if (WATERMARK_LITERALS.has(c)) return true
  for (const sub of WATERMARK_SUBSTRINGS) {
    if (c.includes(sub)) return true
  }
  for (const re of WATERMARK_PATTERNS) {
    if (re.test(c)) return true
  }
  if (embedsDate(c)) return true
  return false
}

// Single token of code-like characters used to reconstruct part numbers that
// OCR split across whitespace ("BR 23156" → join → "BR23156"). Allowed chars
// match the body of PART_NUMBER_REGEX; we DO require ≥1 char here because the
// regex emits empty captures otherwise.
const CODE_TOKEN_REGEX = /[A-Z0-9][A-Z0-9\-\/\.\+]*/g

/**
 * OCR engines often insert spurious spaces inside embossed/stencilled part
 * numbers — e.g. "BR  23156", "10K  PE-94", "B R 23156". The contiguous-only
 * PART_NUMBER_REGEX skips those.
 *
 * This pass collects code-like tokens and emits the joined string for every
 * 2- and 3-token window that contains at least one letter and one digit and
 * lands in the 6-25 char band. Scoring still gets the final word.
 */
function reconstructJoinedCandidates(normalized: string): string[] {
  const tokens = [...normalized.matchAll(CODE_TOKEN_REGEX)].map((m) => m[0])
  if (tokens.length < 2) return []

  const out: string[] = []
  const seen = new Set<string>()

  for (let windowSize = 2; windowSize <= 3; windowSize++) {
    for (let i = 0; i + windowSize <= tokens.length; i++) {
      const window = tokens.slice(i, i + windowSize)
      const joined = window.join('')
      if (joined.length < 6 || joined.length > 25) continue
      // A real PN has both letters and digits; pure-numeric joins are usually
      // dates / lot indexes (the barcode pre-pass already owns true numerics).
      if (!/[A-Z]/.test(joined) || !/\d/.test(joined)) continue
      if (seen.has(joined)) continue
      seen.add(joined)
      out.push(joined)
    }
  }
  return out
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

    const score = scoreCandidate(code)
    if (score > 0) {
      candidates.push({ text: code, confidence: score })
    }
  }

  // Whitespace-recovery pass: reconstruct codes the regex missed because OCR
  // inserted stray spaces. Joined candidates score slightly lower so a clean
  // contiguous read always wins over a reconstructed one.
  for (const joined of reconstructJoinedCandidates(normalized)) {
    if (seen.has(joined)) continue
    seen.add(joined)
    const score = scoreCandidate(joined)
    if (score > 0) {
      candidates.push({ text: joined, confidence: Math.max(0, score - 0.05) })
    }
  }

  return candidates.sort((a, b) => b.confidence - a.confidence)
}

/**
 * True for OCR scraps that pass the digit guard but are never real part
 * numbers: pure short numbers (years, prices, lot counts), repeated-separator
 * artefacts ("5..5", "A--7"), digit-only versions/times that slip past the
 * watermark patterns ("7.47", "21.20"), and standalone single-segment
 * "fractions" with very short parts ("27/4", "5-28", "J-01").
 *
 * Hard reject — these never become candidates.
 */
function isObviousScrap(code: string): boolean {
  const c = code

  // Pure 1-4 digit numbers — years, prices, lot indexes, page numbers.
  if (/^\d{1,4}$/.test(c)) return true

  // Pure digit + dot strings ("7.47", "21.20", "1.2.3") — versions, prices,
  // mis-parsed times. The watermark pattern catches some of these but not all
  // (anything that doesn't match the explicit version regex still leaked).
  if (/^[\d.]+$/.test(c) && /\./.test(c)) return true

  // Pure digit + colon ("21:20"), already caught by isWatermark, defensive here.
  if (/^[\d:]+$/.test(c) && /:/.test(c)) return true

  // Consecutive separators — OCR doubling the same character. Real PNs don't
  // have "..", "--", or "//".
  if (/\.\.|--|\/\//.test(c)) return true

  // Standalone single-segment "fractions" or measurements:
  //   "27/4", "5-28", "J-01", "A-7"
  // Match: ≤6 chars, exactly one dash/slash, at least one numeric-only segment
  // ≤2 chars long. Real PNs either are longer or have multiple separators.
  if (c.length <= 6) {
    const m = c.match(/^([A-Z0-9]+)[\-\/]([A-Z0-9]+)$/)
    if (m) {
      const [, a, b] = m
      const numericOnly = (s: string) => /^\d+$/.test(s)
      // both pure numeric (a fraction) → reject
      if (numericOnly(a) && numericOnly(b)) return true
      // one side ≤2 chars and the other pure-numeric → reject ("J-01", "A-7")
      if ((a.length <= 2 && numericOnly(b)) || (b.length <= 2 && numericOnly(a))) return true
    }
  }

  return false
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

  // Reject obvious OCR scraps that have nothing in common with real OEM PNs.
  if (isObviousScrap(code)) return 0

  // Hard minimum length: real OEM part numbers are 6+ chars in this domain.
  // 4-5 char alphanumerics are overwhelmingly OCR noise (brand letters, partial
  // reads, edge artefacts). A reviewer can still type one manually if a rare
  // 4-5 char real code appears.
  if (length < 6) return 0

  // Base: 0.4 — heuristic score intentionally stays below auto-approve threshold (0.90)
  // so OCR provider word-level confidence is required to push it over
  let score = 0.4

  if (hasDigit && hasLetter) score += 0.2

  // Length bias: real OEM PNs cluster at 7-15 chars.
  if (length >= 8 && length <= 16) score += 0.2       // sweet spot
  else if (length >= 6 && length < 8) score += 0.1    // plausible
  else if (length > 20) score -= 0.1                  // OCR likely glued two strings

  if (/[-\/]/.test(code)) score += 0.05
  if (/\+/.test(code)) score += 0.05

  return Math.max(0, Math.min(score, 0.85))
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
