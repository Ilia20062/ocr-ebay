import type { OcrCandidate } from '@/types/ocr'

export interface GroupResolverInput {
  ocrResults: Array<{
    id: string
    image_id: string
    extracted_code: string | null
    confidence: number | null
    all_candidates: OcrCandidate[]
  }>
}

export interface GroupResolverAlternative {
  code: string
  ocrResultId: string
  imageId: string
  confidence: number
}

export interface GroupResolverOutput {
  winningOcrResultId: string | null
  winningImageId: string | null
  winningCode: string | null
  winningConfidence: number | null
  hadConsensus: boolean
  alternatives: GroupResolverAlternative[]
}

interface CandidateBucket {
  text: string
  appearances: Array<{ ocrResultId: string; imageId: string; confidence: number }>
  bestConfidence: number
  sumConfidence: number
  imagesSeen: Set<string>
}

const DUPLICATE_SENTINEL = '__DUPLICATE__'

function bucketCandidates(input: GroupResolverInput): Map<string, CandidateBucket> {
  const buckets = new Map<string, CandidateBucket>()
  for (const r of input.ocrResults) {
    const seen = new Set<string>()
    for (const c of r.all_candidates ?? []) {
      if (!c?.text || c.text === DUPLICATE_SENTINEL) continue
      // dedupe within a single image's candidates
      if (seen.has(c.text)) continue
      seen.add(c.text)

      let b = buckets.get(c.text)
      if (!b) {
        b = { text: c.text, appearances: [], bestConfidence: 0, sumConfidence: 0, imagesSeen: new Set() }
        buckets.set(c.text, b)
      }
      b.appearances.push({ ocrResultId: r.id, imageId: r.image_id, confidence: c.confidence ?? 0 })
      b.bestConfidence = Math.max(b.bestConfidence, c.confidence ?? 0)
      b.sumConfidence += c.confidence ?? 0
      b.imagesSeen.add(r.image_id)
    }
  }
  return buckets
}

export function resolveGroupCode(input: GroupResolverInput): GroupResolverOutput {
  const buckets = bucketCandidates(input)
  if (buckets.size === 0) {
    return {
      winningOcrResultId: null,
      winningImageId: null,
      winningCode: null,
      winningConfidence: null,
      hadConsensus: false,
      alternatives: [],
    }
  }

  const all = [...buckets.values()]
  const consensusBuckets = all.filter((b) => b.imagesSeen.size >= 2)

  let winner: CandidateBucket
  let hadConsensus: boolean

  if (consensusBuckets.length > 0) {
    consensusBuckets.sort(
      (a, b) => b.sumConfidence - a.sumConfidence || b.bestConfidence - a.bestConfidence,
    )
    winner = consensusBuckets[0]
    hadConsensus = true
  } else {
    all.sort(
      (a, b) => b.bestConfidence - a.bestConfidence || b.sumConfidence - a.sumConfidence,
    )
    winner = all[0]
    hadConsensus = false
  }

  const winningAppearance = [...winner.appearances].sort((a, b) => b.confidence - a.confidence)[0]

  const alternatives: GroupResolverAlternative[] = all
    .filter((b) => b.text !== winner.text)
    .map((b) => {
      const top = [...b.appearances].sort((x, y) => y.confidence - x.confidence)[0]
      return {
        code: b.text,
        ocrResultId: top.ocrResultId,
        imageId: top.imageId,
        confidence: top.confidence,
      }
    })
    .sort((a, b) => b.confidence - a.confidence)

  return {
    winningOcrResultId: winningAppearance.ocrResultId,
    winningImageId: winningAppearance.imageId,
    winningCode: winner.text,
    winningConfidence: winner.bestConfidence,
    hadConsensus,
    alternatives,
  }
}
