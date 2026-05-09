// Time + label-anchor clustering.
//
// In the target workflow each product cycle is: [PNG burst of label scans] → [bare .jpg
// close-up of the molded code]. Inter-product gaps can be as short as 6s, so gap-only
// clustering over-merges. The bare .jpg ending each cycle is a reliable cluster
// terminator.
//
// Rule:
//   - Gap > gapMs starts a new cluster.
//   - Otherwise, if the previous file was a bare .jpg AND the gap to the next file
//     exceeds jpgRetakeMs, also start a new cluster (handles in-cycle JPG-JPG retakes).
//   - Files without a parseable timestamp are returned as one trailing "orphan" cluster
//     for manual triage.

export interface ClusterableImage {
  id: string
  filename: string
  capturedAt: Date | null
}

export interface ClusterByTimeOptions {
  gapMs?: number          // default 15000 — well above in-burst max (~8s) and below inter-product min (~17s)
  jpgRetakeMs?: number    // default 4000 — 15.25.03.jpg → 15.25.06.jpg = same product
}

const DEFAULT_GAP_MS = 15_000
const DEFAULT_JPG_RETAKE_MS = 4_000

function isBareJpg(filename: string): boolean {
  return /\.jpe?g$/i.test(filename)
}

export function clusterByTime<T extends ClusterableImage>(
  images: T[],
  opts: ClusterByTimeOptions = {},
): T[][] {
  const gapMs = opts.gapMs ?? DEFAULT_GAP_MS
  const jpgRetakeMs = opts.jpgRetakeMs ?? DEFAULT_JPG_RETAKE_MS

  const sorted = images
    .filter((i) => i.capturedAt)
    .slice()
    .sort((a, b) => a.capturedAt!.getTime() - b.capturedAt!.getTime())

  const clusters: T[][] = []
  let current: T[] | null = null

  for (let i = 0; i < sorted.length; i++) {
    const img = sorted[i]
    const prev = i > 0 ? sorted[i - 1] : null
    const gap = prev ? img.capturedAt!.getTime() - prev.capturedAt!.getTime() : Infinity

    let startNew = !current || gap > gapMs
    if (!startNew && prev && isBareJpg(prev.filename) && gap > jpgRetakeMs) {
      startNew = true
    }

    if (startNew) {
      current = []
      clusters.push(current)
    }
    current!.push(img)
  }

  const orphans = images.filter((i) => !i.capturedAt)
  if (orphans.length) clusters.push(orphans)

  return clusters
}
