// Analyze grouping-report.json: simulate the production two-phase OCR by
// looking only at .jpg label candidates within each cluster, since the
// dry-run script OCRs every image (including PNG product photos which leak
// watermark text like "90 DAYS" into "dominant code").

import * as fs from 'node:fs'
import * as path from 'node:path'

const reportPath = process.argv[2] || path.join(process.cwd(), 'grouping-report.json')
const r = JSON.parse(fs.readFileSync(reportPath, 'utf8'))

const KNOWN_WATERMARKS = new Set([
  '90DAYS', 'O90DAYS', '70DAYS', 'PE-94', 'OFI2',
])

function isWatermark(code) {
  if (!code) return false
  const c = code.toUpperCase()
  if (KNOWN_WATERMARKS.has(c)) return true
  if (/^O?\d{2,3}DAYS$/.test(c)) return true
  return false
}

// For each cluster, look at the .jpg files only — that's what the prod
// two-phase pipeline (pickLabelCandidates) would OCR first.
function bestCodeFromJpgs(cluster) {
  const jpgs = cluster.files.filter((f) => f.jpg)
  if (jpgs.length === 0) return { method: 'no-jpg', code: null }
  // Bucket codes across the cluster's .jpgs
  const buckets = new Map()
  for (const f of jpgs) {
    if (!f.topCode) continue
    const b = buckets.get(f.topCode) ?? { code: f.topCode, hits: 0, sumConf: 0, bestConf: 0 }
    b.hits++
    b.sumConf += f.topConf ?? 0
    b.bestConf = Math.max(b.bestConf, f.topConf ?? 0)
    buckets.set(f.topCode, b)
  }
  if (buckets.size === 0) return { method: 'jpg-no-text', code: null }
  const all = [...buckets.values()].sort(
    (a, b) => b.hits - a.hits || b.sumConf - a.sumConf,
  )
  return { method: 'jpg', code: all[0].code, hits: all[0].hits, bestConf: all[0].bestConf }
}

console.log(`Root: ${r.root}`)
console.log(`Total images: ${r.totalImages}   Clusters: ${r.clusterCount}`)
console.log(`Time params: gapMs=${r.gapMs}, jpgRetakeMs=${r.jpgRetakeMs}`)
console.log('')

// Cluster size distribution
const sizes = r.clusters.map((c) => c.imageCount).sort((a, b) => a - b)
const mean = sizes.reduce((s, n) => s + n, 0) / sizes.length
console.log('=== Cluster size distribution ===')
console.log(
  `min=${sizes[0]} p25=${sizes[Math.floor(sizes.length * 0.25)]} median=${
    sizes[Math.floor(sizes.length / 2)]
  } mean=${mean.toFixed(1)} p75=${sizes[Math.floor(sizes.length * 0.75)]} max=${
    sizes[sizes.length - 1]
  }`,
)
console.log('')

// Compare current vs simulated-prod (jpg-only) code resolution
let dryrunHasCode = 0
let dryrunWatermark = 0
let prodHasCode = 0
let prodWatermark = 0
let prodNoJpg = 0
let prodJpgNoText = 0
const flipped = [] // dryrun said code, prod says none (or vice versa)
const watermarkFixed = [] // dryrun = watermark, prod = real or none

for (const c of r.clusters) {
  if (c.dominantCode) {
    dryrunHasCode++
    if (isWatermark(c.dominantCode)) dryrunWatermark++
  }
  const prod = bestCodeFromJpgs(c)
  if (prod.method === 'no-jpg') prodNoJpg++
  if (prod.method === 'jpg-no-text') prodJpgNoText++
  if (prod.code) {
    prodHasCode++
    if (isWatermark(prod.code)) prodWatermark++
  }

  if (isWatermark(c.dominantCode) && !isWatermark(prod.code)) {
    watermarkFixed.push({ id: c.id, dryrun: c.dominantCode, prod: prod.code, prodMethod: prod.method })
  }
  if (!!c.dominantCode !== !!prod.code) {
    flipped.push({ id: c.id, dryrun: c.dominantCode, prod: prod.code, prodMethod: prod.method, size: c.imageCount })
  }
}

console.log('=== Code resolution: dry-run (all imgs) vs prod (.jpg only) ===')
console.log(`dry-run  has-code=${dryrunHasCode}/${r.clusters.length}  watermark=${dryrunWatermark}`)
console.log(`prod-sim has-code=${prodHasCode}/${r.clusters.length}  watermark=${prodWatermark}`)
console.log(`  prod jpg-no-text: ${prodJpgNoText}   no-jpg-in-cluster: ${prodNoJpg}`)
console.log('')

console.log(`=== Watermark fixes (${watermarkFixed.length}) — prod two-phase avoids these false codes ===`)
watermarkFixed.slice(0, 20).forEach((f) =>
  console.log(`  #${f.id}  dry-run="${f.dryrun}"  -> prod="${f.prod ?? 'NO CODE'}" (${f.prodMethod})`),
)
if (watermarkFixed.length > 20) console.log(`  ... +${watermarkFixed.length - 20} more`)
console.log('')

console.log(`=== Disagreement: presence flipped (${flipped.length}) ===`)
flipped.forEach((f) =>
  console.log(`  #${f.id} size=${f.size}  dry="${f.dryrun ?? 'NO CODE'}" prod="${f.prod ?? 'NO CODE'}" (${f.prodMethod})`),
)
console.log('')

console.log('=== Final prod-simulated cluster summary ===')
console.log(`  total clusters:                ${r.clusters.length}`)
console.log(`  prod would detect a code on:   ${prodHasCode}`)
console.log(`  prod NO CODE (review needed):  ${r.clusters.length - prodHasCode}`)
console.log(`  of which jpg-no-text:          ${prodJpgNoText}`)
console.log(`  of which no-jpg-in-cluster:    ${prodNoJpg}`)
