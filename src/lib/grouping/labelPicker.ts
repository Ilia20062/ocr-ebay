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
