/**
 * Benchmark the optimized OCR pipeline against a real folder of images.
 *
 * Drives the SAME `recognizeWithFallback` + `TesseractPool` the upload-session
 * processor uses — no UI/Supabase needed. Splits the input into bare-.jpg
 * (phase-1, skipBarcode=true) and PNG (phase-2, skipBarcode=false) buckets to
 * mirror production behavior.
 *
 *   npx tsx scripts/ocr-bench.ts "3694 09.04.2026 IRA" [--limit=50]
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  getSharedTesseractPool,
  recognizeWithFallback,
} from '../src/lib/ocr/pool'

const args = process.argv.slice(2)
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? 'true']
  }),
)
const positional = args.filter((a) => !a.startsWith('--'))
const ROOT = positional[0]
if (!ROOT) {
  console.error('usage: tsx scripts/ocr-bench.ts <folder> [--limit=N]')
  process.exit(1)
}
const LIMIT = flags.limit ? parseInt(flags.limit, 10) : Infinity

const IMG_RE = /\.(jpe?g|png|webp|tiff?)$/i
function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile() && IMG_RE.test(entry.name)) out.push(full)
  }
  return out
}

async function main() {
  const all = walk(ROOT).slice(0, LIMIT)
  const jpgs = all.filter((p) => /\.jpe?g$/i.test(p))
  const pngs = all.filter((p) => !/\.jpe?g$/i.test(p))
  console.log(`[bench] folder=${ROOT}`)
  console.log(`[bench] total=${all.length}  jpg=${jpgs.length}  png=${pngs.length}`)
  console.log(`[bench] env: PADDLE=${!!process.env.PADDLE_OCR_URL}  VISION=${!!process.env.GOOGLE_VISION_API_KEY}  POOL=${process.env.OCR_CONCURRENCY ?? 'auto'}`)

  const tPoolInit = performance.now()
  const pool = await getSharedTesseractPool()
  console.log(`[bench] pool ready in ${(performance.now() - tPoolInit).toFixed(0)}ms`)

  interface Result {
    file: string
    bytes: number
    ms: number
    topCode: string | null
    topConf: number | null
    provider: string
    candidates: number
    skipBarcode: boolean
  }

  async function runBucket(files: string[], label: string, skipBarcode: boolean): Promise<Result[]> {
    const tStart = performance.now()
    const items = files.map((f) => ({ f, buf: fs.readFileSync(f) }))
    console.log(`[bench] [${label}] disk read complete: ${items.length} files in ${(performance.now() - tStart).toFixed(0)}ms`)

    const tOcr = performance.now()
    const out = await pool.map(items, async (worker, item) => {
      const t = performance.now()
      const r = await recognizeWithFallback(worker, item.buf, 'image/jpeg', { skipBarcode })
      return {
        file: path.basename(item.f),
        bytes: item.buf.length,
        ms: performance.now() - t,
        topCode: r.topCandidate?.text ?? null,
        topConf: r.topCandidate?.confidence ?? null,
        provider: r.provider,
        candidates: r.candidates.length,
        skipBarcode,
      } as Result
    })
    const wall = performance.now() - tOcr
    const successes = out.filter((o) => o.ok).map((o) => o.ok as Result)
    console.log(`[bench] [${label}] OCR done: ${successes.length}/${items.length} in ${(wall / 1000).toFixed(1)}s  (avg ${(wall / items.length).toFixed(0)}ms/img)`)
    return successes
  }

  const t0 = performance.now()
  const jpgResults = jpgs.length ? await runBucket(jpgs, 'phase1.jpg', true) : []
  const pngResults = pngs.length ? await runBucket(pngs, 'phase2.png', false) : []
  const wallTotal = performance.now() - t0
  const all2 = [...jpgResults, ...pngResults]

  const avg = all2.reduce((s, r) => s + r.ms, 0) / Math.max(1, all2.length)
  const codeHits = all2.filter((r) => r.topCode).length
  const byProvider = all2.reduce<Record<string, number>>((acc, r) => {
    acc[r.provider] = (acc[r.provider] ?? 0) + 1
    return acc
  }, {})

  console.log('')
  console.log(`[bench] ─── SUMMARY ───────────────────────────────────────`)
  console.log(`[bench] images:            ${all2.length}`)
  console.log(`[bench] wall time:         ${(wallTotal / 1000).toFixed(1)}s`)
  console.log(`[bench] throughput:        ${(all2.length / (wallTotal / 1000)).toFixed(2)} img/s`)
  console.log(`[bench] mean per-image:    ${avg.toFixed(0)}ms`)
  console.log(`[bench] code hit rate:     ${codeHits}/${all2.length} (${((codeHits / all2.length) * 100).toFixed(0)}%)`)
  console.log(`[bench] provider mix:      ${JSON.stringify(byProvider)}`)
  console.log('')

  // Slowest 5
  const slow = all2.slice().sort((a, b) => b.ms - a.ms).slice(0, 5)
  console.log(`[bench] slowest 5:`)
  for (const r of slow) console.log(`        ${r.ms.toFixed(0)}ms  ${r.file}  → ${r.topCode ?? '(none)'} via ${r.provider}`)

  // Write JSON report
  const out = path.join(process.cwd(), 'ocr-bench-report.json')
  fs.writeFileSync(out, JSON.stringify({ root: ROOT, wallMs: wallTotal, avgMs: avg, codeHits, total: all2.length, byProvider, results: all2 }, null, 2))
  console.log(`[bench] report: ${out}`)

  process.exit(0)
}

main().catch((err) => {
  console.error('[bench] FATAL', err)
  process.exit(1)
})
