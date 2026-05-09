// Pick the "label image" for a cluster — the one most likely to show the product
// code. The existing resolveGroupCode still owns the OCR-based winner, but the
// label hint drives the ✨ thumbnail badge in the review UI when no code has been
// detected yet (or when confidence is uniformly low).
//
// Preference order:
//   1. Latest bare .jpg in the cluster (the molded-code close-up).
//   2. Image with the highest top-candidate OCR confidence.
//   3. Latest by timestamp.

export interface LabelCandidateImage {
  id: string
  filename: string
  capturedAt: Date | null
  topConfidence?: number | null
}

export function pickLabelCandidate<T extends LabelCandidateImage>(cluster: T[]): T | null {
  if (cluster.length === 0) return null

  const jpgs = cluster.filter((i) => /\.jpe?g$/i.test(i.filename))
  if (jpgs.length) {
    return jpgs.slice().sort((a, b) => (b.capturedAt?.getTime() ?? 0) - (a.capturedAt?.getTime() ?? 0))[0]
  }

  const withCode = cluster.filter((i) => typeof i.topConfidence === 'number' && i.topConfidence! > 0)
  if (withCode.length) {
    return withCode.slice().sort((a, b) => (b.topConfidence ?? 0) - (a.topConfidence ?? 0))[0]
  }

  return cluster.slice().sort((a, b) => (b.capturedAt?.getTime() ?? 0) - (a.capturedAt?.getTime() ?? 0))[0]
}

/**
 * Two-phase-OCR helper: pick every image that LIKELY contains a printed code.
 *
 * In the target workflow, the user shoots wide product PNGs (white background,
 * no readable code) followed by a bare-.jpg close-up of the molded code. So the
 * .jpg files in a cluster are the high-probability label images.
 *
 * If a cluster has any bare .jpg, return all of them (in case the user took
 * multiple close-ups). If not, return empty so the caller knows to OCR the
 * whole cluster.
 *
 * Used by session/process to skip OCR'ing every PNG (which both wastes Tesseract
 * cycles AND introduces watermark false positives like "90 DAYS").
 */
export function pickLabelCandidates<T extends LabelCandidateImage>(cluster: T[]): T[] {
  if (cluster.length === 0) return []
  return cluster.filter((i) => /\.jpe?g$/i.test(i.filename))
}
