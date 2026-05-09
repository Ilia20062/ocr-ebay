#!/usr/bin/env node
/**
 * Dry-run of the auto-grouping pipeline against a folder of images.
 *
 *   node scripts/grouping-dryrun.mjs "D:\OCR Project\ocr-crm\3694 09.04.2026 IRA"
 *
 * Flags:
 *   --no-ocr          Skip Tesseract calls (timestamp-only clustering — free, fast).
 *   --concurrency=N   OCR worker count (default 4).
 *   --gap-ms=N        Time-cluster gap threshold in ms (default 15000).
 *   --jpg-retake-ms=N Bare-JPG quick-retake window (default 4000).
 *   --merge-by-code   Enable cross-cluster merging when dominant codes match (default OFF — buggy on noisy OCR).
 *   --out=PATH        Where to write the JSON report (default ./grouping-report.json).
 *
 * The script prints a per-cluster summary to stdout and writes a full JSON report.
 * No external API calls — Tesseract runs locally via tesseract.js (already a project dep).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

// ── arg parsing ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const flags = Object.fromEntries(
  args.filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  })
)
const positional = args.filter(a => !a.startsWith('--'))
const ROOT = positional[0]
if (!ROOT) {
  console.error('Usage: node scripts/grouping-dryrun.mjs <folder> [--no-ocr] [--concurrency=4] [--gap-ms=15000] [--jpg-retake-ms=4000] [--merge-by-code] [--out=path]')
  process.exit(1)
}
const SKIP_OCR = !!flags['no-ocr']
const CONCURRENCY = parseInt(flags['concurrency'] ?? '4', 10)
const GAP_MS = parseInt(flags['gap-ms'] ?? '15000', 10)
const JPG_RETAKE_MS = parseInt(flags['jpg-retake-ms'] ?? '4000', 10)
const MERGE_BY_CODE = !!flags['merge-by-code']
const OUT = flags['out'] ?? path.join(process.cwd(), 'grouping-report.json')

// ── walk folder ──────────────────────────────────────────────────────────────
const IMG_EXT = /\.(jpe?g|png|webp|tiff?)$/i

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile() && IMG_EXT.test(entry.name)) out.push(full)
  }
  return out
}

// ── timestamp parsing ────────────────────────────────────────────────────────
const TS_RE = /(\d{4})-(\d{2})-(\d{2})[ _](\d{2})\.(\d{2})\.(\d{2})(?:_(\d+))?/

function parseCapturedAt(filename) {
  const m = TS_RE.exec(filename)
  if (!m) return null
  const [, y, mo, d, hh, mm, ss, suffix] = m
  const ms = suffix ? parseInt(suffix, 10) * 500 : 0
  return new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss, ms))
}

// ── time + label-anchor clustering ───────────────────────────────────────────
// Each product cycle ends with a bare .jpg (label shot). Gap-only clustering
// fails because PNG-burst → next-product-PNG gaps can be as short as 6s.
// Rule: new cluster on (gap > gapMs) OR (previous file was bare .jpg AND gap > jpgRetakeMs).
function clusterByTime(images, gapMs, jpgRetakeMs) {
  const sorted = [...images]
    .filter(i => i.capturedAt)
    .sort((a, b) => a.capturedAt - b.capturedAt)
  const clusters = []
  let current = null
  for (let i = 0; i < sorted.length; i++) {
    const img = sorted[i]
    const prev = i > 0 ? sorted[i - 1] : null
    const gap = prev ? img.capturedAt - prev.capturedAt : Infinity
    let startNew = !current || gap > gapMs
    if (!startNew && prev && prev.isJpg && gap > jpgRetakeMs) startNew = true
    if (startNew) {
      current = []
      clusters.push(current)
    }
    current.push(img)
  }
  const orphans = images.filter(i => !i.capturedAt)
  if (orphans.length) clusters.push(orphans)
  return clusters
}

// ── code extraction (mirrors src/lib/ocr/code-extractor.ts) ──────────────────
const PART_RE = /(?<![A-Z0-9])([A-Z0-9][A-Z0-9\-/.+]{2,23}[A-Z0-9])(?![A-Z0-9])/g

function extractCandidates(text) {
  if (!text) return []
  const norm = text.toUpperCase().replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ')
  const seen = new Set()
  const out = []
  for (const m of norm.matchAll(PART_RE)) {
    const code = m[1]
    if (seen.has(code)) continue
    seen.add(code)
    if (!/\d/.test(code)) continue
    let score = 0.4
    if (/[A-Z]/.test(code)) score += 0.2
    if (code.length >= 6 && code.length <= 20) score += 0.1
    if (/[-/]/.test(code)) score += 0.05
    if (/\+/.test(code)) score += 0.05
    out.push({ text: code, confidence: Math.min(score, 0.75) })
  }
  return out.sort((a, b) => b.confidence - a.confidence)
}

function selectTop(candidates, wordConf) {
  if (!candidates.length) return null
  const scored = candidates.map(c => {
    const w = wordConf.get(c.text) ?? c.confidence
    return { text: c.text, confidence: (c.confidence + w) / 2 }
  }).sort((a, b) => b.confidence - a.confidence)
  return scored[0]
}

// ── Tesseract worker pool ────────────────────────────────────────────────────
async function makeWorkerPool(size) {
  const { createWorker } = await import('tesseract.js')
  const workers = []
  for (let i = 0; i < size; i++) {
    const w = await createWorker('eng', 1, {
      logger: () => {},
      // Allow Tesseract to fetch its core/lang data on first use; cached after.
    })
    workers.push(w)
  }
  return workers
}

async function ocrImage(worker, buffer) {
  const { data } = await worker.recognize(buffer)
  const fullText = data.text ?? ''
  const wordConf = new Map()
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const word of line.words ?? []) {
          const w = (word.text ?? '').toUpperCase().trim()
          if (!w) continue
          const c = (word.confidence ?? 0) / 100
          const existing = wordConf.get(w)
          if (!existing || c > existing) wordConf.set(w, c)
        }
      }
    }
  }
  const candidates = extractCandidates(fullText)
  return {
    fullText,
    candidates,
    topCandidate: selectTop(candidates, wordConf),
  }
}

// ── concurrency-limited runner with worker affinity ──────────────────────────
async function pMapPool(items, workers, mapper) {
  const out = new Array(items.length)
  let nextIdx = 0
  await Promise.all(workers.map(async w => {
    while (true) {
      const idx = nextIdx++
      if (idx >= items.length) return
      try {
        out[idx] = { ok: await mapper(w, items[idx], idx) }
      } catch (err) {
        out[idx] = { err: String(err?.message ?? err) }
      }
    }
  }))
  return out
}

// ── OCR-code refinement (DISABLED by default — see --merge-by-code) ──────────
function dominantCodeOf(cluster) {
  const stats = new Map()
  for (const img of cluster) {
    const seen = new Set()
    for (const c of img.candidates ?? []) {
      if (c.confidence < 0.4) continue
      if (seen.has(c.text)) continue
      seen.add(c.text)
      const s = stats.get(c.text) ?? { text: c.text, images: new Set(), sumConf: 0, bestConf: 0 }
      s.images.add(img.filename)
      s.sumConf += c.confidence
      s.bestConf = Math.max(s.bestConf, c.confidence)
      stats.set(c.text, s)
    }
  }
  const arr = [...stats.values()]
  if (!arr.length) return null
  arr.sort((a, b) => b.images.size - a.images.size || b.sumConf - a.sumConf)
  const top = arr[0]
  return { text: top.text, imageCount: top.images.size, sumConf: top.sumConf, bestConf: top.bestConf }
}

function mergeClustersByCode(clusters) {
  // Disabled by default: produces false merges when two unrelated products both
  // contain a noisy substring like "64469T" or "023AA85883". Time + JPG-anchor
  // clustering is precise enough on its own for this workflow.
  const codeToCluster = new Map()
  const merged = []
  for (const c of clusters) {
    const dom = dominantCodeOf(c)
    if (!dom || dom.imageCount < 3) {  // require ≥3 images sharing the code
      merged.push(c)
      continue
    }
    const key = dom.text.toUpperCase().replace(/\s+/g, '')
    if (codeToCluster.has(key)) {
      const idx = codeToCluster.get(key)
      merged[idx] = [...merged[idx], ...c]
    } else {
      codeToCluster.set(key, merged.length)
      merged.push(c)
    }
  }
  return merged
}

// ── label picker ─────────────────────────────────────────────────────────────
function pickLabel(cluster) {
  const jpgs = cluster.filter(i => /\.jpe?g$/i.test(i.filename))
  if (jpgs.length) return jpgs.sort((a, b) => (b.capturedAt ?? 0) - (a.capturedAt ?? 0))[0]
  const withCode = cluster.filter(i => i.topCandidate)
  if (withCode.length) return withCode.sort((a, b) => b.topCandidate.confidence - a.topCandidate.confidence)[0]
  return [...cluster].sort((a, b) => (b.capturedAt ?? 0) - (a.capturedAt ?? 0))[0]
}

// ── main ─────────────────────────────────────────────────────────────────────
function fmtTime(d) {
  if (!d) return '?'
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

async function main() {
  console.log(`Scanning ${ROOT} ...`)
  const files = walk(ROOT)
  console.log(`Found ${files.length} image files.`)

  const images = files.map(filepath => {
    const filename = path.basename(filepath)
    const rel = path.relative(ROOT, filepath)
    return {
      filepath,
      filename,
      rel,
      capturedAt: parseCapturedAt(filename),
      bytes: fs.statSync(filepath).size,
      isJpg: /\.jpe?g$/i.test(filename),
      candidates: null,
      topCandidate: null,
      ocrText: null,
      error: null,
    }
  })

  const noTs = images.filter(i => !i.capturedAt).length
  console.log(`Parsed timestamps: ${images.length - noTs}/${images.length}` + (noTs ? ` (${noTs} without)` : ''))

  // Stage B: time-cluster (label-anchor aware)
  let clusters = clusterByTime(images, GAP_MS, JPG_RETAKE_MS)
  console.log(`Time-clusters (gap ${GAP_MS}ms, jpg-retake ${JPG_RETAKE_MS}ms): ${clusters.length}`)

  // Stage C: Tesseract OCR
  if (!SKIP_OCR) {
    console.log(`Initializing ${CONCURRENCY} Tesseract workers ...`)
    const t0 = Date.now()
    const workers = await makeWorkerPool(CONCURRENCY)
    console.log(`Workers ready in ${Math.round((Date.now() - t0) / 1000)}s. Running OCR on ${images.length} images ...`)
    let done = 0
    const t1 = Date.now()
    await pMapPool(images, workers, async (worker, img) => {
      try {
        const buf = fs.readFileSync(img.filepath)
        const r = await ocrImage(worker, buf)
        img.candidates = r.candidates
        img.topCandidate = r.topCandidate
        img.ocrText = r.fullText
      } catch (err) {
        img.error = String(err?.message ?? err)
      }
      done++
      if (done % 10 === 0 || done === images.length) {
        process.stdout.write(`\r  ${done}/${images.length}  (${Math.round((Date.now() - t1) / 1000)}s)`)
      }
    })
    console.log('')
    await Promise.all(workers.map(w => w.terminate().catch(() => {})))
    const errs = images.filter(i => i.error).length
    if (errs) console.log(`  OCR errors: ${errs}`)
  }

  // Stage E: optional code-based merge (off by default; was found to over-merge on noisy OCR)
  if (MERGE_BY_CODE) {
    const beforeMerge = clusters.length
    clusters = mergeClustersByCode(clusters)
    if (clusters.length !== beforeMerge) {
      console.log(`OCR-code merge: ${beforeMerge} → ${clusters.length} clusters`)
    }
  }

  // Stage F: label picker
  for (const c of clusters) {
    const label = pickLabel(c)
    for (const img of c) img.isLabel = (img === label)
  }

  // Build report
  const report = {
    root: ROOT,
    totalImages: images.length,
    clusterCount: clusters.length,
    ocrRan: !SKIP_OCR,
    gapMs: GAP_MS,
    jpgRetakeMs: JPG_RETAKE_MS,
    mergeByCode: MERGE_BY_CODE,
    clusters: clusters.map((c, idx) => {
      const dom = dominantCodeOf(c)
      const sorted = [...c].sort((a, b) => (a.capturedAt ?? 0) - (b.capturedAt ?? 0))
      const first = sorted[0]?.capturedAt
      const last = sorted[sorted.length - 1]?.capturedAt
      const label = c.find(i => i.isLabel)
      return {
        id: idx,
        imageCount: c.length,
        timeRange: [fmtTime(first), fmtTime(last)],
        durationSec: first && last ? Math.round((last - first) / 1000) : null,
        dominantCode: dom?.text ?? null,
        dominantCodeImageCount: dom?.imageCount ?? 0,
        dominantCodeBestConf: dom?.bestConf ? Number(dom.bestConf.toFixed(3)) : null,
        labelCandidate: label?.rel ?? null,
        files: sorted.map(i => ({
          rel: i.rel,
          ts: fmtTime(i.capturedAt),
          jpg: i.isJpg,
          isLabel: !!i.isLabel,
          topCode: i.topCandidate?.text ?? null,
          topConf: i.topCandidate ? Number(i.topCandidate.confidence.toFixed(3)) : null,
          error: i.error ?? null,
        })),
      }
    }),
  }

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
  console.log(`Wrote report → ${OUT}`)

  // Console summary
  console.log('')
  console.log('=== CLUSTER SUMMARY ===')
  let nzClusters = 0, codedClusters = 0, labelIsJpg = 0, labelIsPng = 0
  for (const c of report.clusters) {
    const flag = c.dominantCode ? `[${c.dominantCode}]` : '[NO CODE]'
    if (!c.dominantCode) nzClusters++
    else codedClusters++
    if (c.labelCandidate) {
      if (/\.jpe?g$/i.test(c.labelCandidate)) labelIsJpg++
      else labelIsPng++
    }
    console.log(
      `  #${String(c.id).padStart(2)}  ${c.timeRange[0]}-${c.timeRange[1]}  ` +
      `${String(c.imageCount).padStart(2)} imgs  ${flag.padEnd(20)}  label=${c.labelCandidate ?? '-'}`
    )
  }

  console.log('')
  console.log('=== HEALTH CHECKS ===')
  console.log(`  Total clusters:        ${report.clusterCount}`)
  console.log(`  With dominant code:    ${codedClusters}`)
  console.log(`  Without code (NZ-ish): ${nzClusters}`)
  console.log(`  Label = .jpg:          ${labelIsJpg}`)
  console.log(`  Label = .png:          ${labelIsPng}`)
  if (report.totalImages === 257 || report.totalImages === 256) {
    const ok = (cond, msg) => console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`)
    ok(report.clusterCount >= 35 && report.clusterCount <= 45, `Cluster count in [35,45] (got ${report.clusterCount})`)
    ok(labelIsJpg / Math.max(1, labelIsJpg + labelIsPng) >= 0.7, `≥70% labels are .jpg (got ${Math.round(100 * labelIsJpg / Math.max(1, labelIsJpg + labelIsPng))}%)`)
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
