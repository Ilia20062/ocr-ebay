import { existsSync, mkdirSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { log } from '@/lib/log'
import type { OcrProviderResult } from '@/types/ocr'
import { extractCandidates, selectTopCandidate } from './code-extractor'

const TESSERACT_TIMEOUT_MS = 30_000

/**
 * Where to cache `eng.traineddata` (~10 MB) so we download it from the CDN
 * only once per machine instead of once per worker init. Tesseract.js reads
 * from cachePath on subsequent inits when the file is present. Prefer an
 * Electron-aware dir if set, otherwise a per-user temp dir.
 */
function resolveTessCachePath(): string {
  const root = process.env.OCR_TESSERACT_CACHE
    || (process.env.OCR_TESSERACT_ROOT ? path.join(process.env.OCR_TESSERACT_ROOT, '.tesseract-cache') : null)
    || path.join(os.tmpdir(), 'ocr-crm-tesseract-cache')
  try {
    mkdirSync(root, { recursive: true })
  } catch {
    // mkdir is best-effort — tesseract.js will fall back to its default behaviour.
  }
  return root
}

const TESS_CACHE_PATH = resolveTessCachePath()

// Resolve tesseract.js worker + core paths from disk at module load.
//
// Why not require.resolve / createRequire? Because under Next.js 16 + Turbopack,
// when `tesseract.js` is in `serverExternalPackages`, every require resolution
// returns a Turbopack-virtual path like
//   [externals]/tesseract.js/src/worker-script/node/index.js
// Tesseract.js then hands that string to node:worker_threads' new Worker(file),
// which rejects anything that isn't absolute or starts with './'. So we go
// straight to the filesystem.
//
// Search roots in order:
//   1. OCR_TESSERACT_ROOT  — set by the Electron main process to the unpacked
//      asar location (app.asar.unpacked/node_modules) where native + worker
//      assets live in the packaged .exe.
//   2. process.cwd()       — works for `next dev`, `next start`, and the
//      standalone server (which chdirs into .next/standalone).
//
// If a path isn't there at runtime (e.g. an unfamiliar deployment layout) we
// leave it undefined and let tesseract.js try its own resolution. We never set
// the option to a virtual or otherwise invalid string — that's what was crashing.
function resolveOnDisk(...segments: string[]): string | undefined {
  const roots: string[] = []
  if (process.env.OCR_TESSERACT_ROOT) roots.push(process.env.OCR_TESSERACT_ROOT)
  roots.push(path.join(process.cwd(), 'node_modules'))
  for (const root of roots) {
    const candidate = path.join(root, ...segments)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const RESOLVED_WORKER_PATH = resolveOnDisk('tesseract.js', 'src', 'worker-script', 'node', 'index.js')
const RESOLVED_CORE_PATH = resolveOnDisk('tesseract.js-core', 'tesseract-core.wasm.js')

if (!RESOLVED_WORKER_PATH || !RESOLVED_CORE_PATH) {
  log.warn('Tesseract paths not found on disk — falling back to library defaults', {
    scope: 'ocr.tesseract',
    cwd: process.cwd(),
    worker_path_resolved: RESOLVED_WORKER_PATH ?? null,
    core_path_resolved: RESOLVED_CORE_PATH ?? null,
  })
}

// tesseract.js Worker type — kept loose so we don't pin to internals.
// Has a .recognize() method and a .terminate() method.
export interface TesseractWorker {
  recognize: (input: string | Buffer) => Promise<{ data: TesseractRecognizeData }>
  terminate: () => Promise<unknown>
}

interface TesseractWord {
  text: string
  confidence: number
}
interface TesseractRecognizeData {
  text?: string
  blocks?: Array<{
    paragraphs: Array<{
      lines: Array<{ words: TesseractWord[] }>
    }>
  }>
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ])
}

/**
 * Create a Tesseract worker. Tesseract.js v7 in Node will hit
 *   path.resolve(undefined)
 * → "filename argument must be of type string or URL" if its internal __dirname
 * lookup gets bundled. We pin workerPath + corePath ourselves via require.resolve
 * (anchored to this module's import.meta.url, see top of file). Only set the
 * keys when resolution succeeded — passing `undefined` triggers the same crash.
 */
export async function createTesseractWorker(): Promise<TesseractWorker> {
  const t0 = Date.now()
  try {
    const { createWorker } = await import('tesseract.js')
    const opts: Record<string, unknown> = {
      logger: () => {},
      langPath: 'https://tessdata.projectnaptha.com/4.0.0',
      // Persist the downloaded eng.traineddata so subsequent worker inits
      // (including across upload sessions and across process restarts) skip
      // the ~10 MB CDN fetch. `readWrite` writes on first download, reads
      // thereafter. Tesseract.js silently falls back to network if the dir
      // is unwritable.
      cachePath: TESS_CACHE_PATH,
      cacheMethod: 'readWrite',
    }
    if (RESOLVED_WORKER_PATH) opts.workerPath = RESOLVED_WORKER_PATH
    if (RESOLVED_CORE_PATH) opts.corePath = RESOLVED_CORE_PATH
    const worker = (await createWorker('eng', 1, opts)) as unknown as TesseractWorker
    log.debug('Tesseract worker created', {
      scope: 'ocr.tesseract',
      dur_ms: Date.now() - t0,
      worker_path_set: !!RESOLVED_WORKER_PATH,
      core_path_set: !!RESOLVED_CORE_PATH,
    })
    return worker
  } catch (err) {
    log.error('Tesseract worker creation failed', {
      scope: 'ocr.tesseract',
      dur_ms: Date.now() - t0,
      worker_path: RESOLVED_WORKER_PATH ?? null,
      core_path: RESOLVED_CORE_PATH ?? null,
      err,
    })
    throw err
  }
}

/**
 * Run OCR on one image using an already-created worker. Cheaper than
 * runTesseractOcr when processing many images in a row.
 */
export async function recognizeWithWorker(
  worker: TesseractWorker,
  base64Content: string,
  mimeType = 'image/jpeg',
): Promise<OcrProviderResult> {
  // Decode base64 once and feed Tesseract a Buffer. Tesseract.js v7 in Node prefers
  // Buffer input — multi-MB data URLs trigger memory copies and have produced empty
  // OCR results in production runs.
  const buffer = Buffer.from(base64Content, 'base64')
  return recognizeBuffer(worker, buffer, mimeType)
}

/**
 * Run OCR on one image from a raw Buffer. Avoids the base64 round-trip when the
 * caller already has the bytes in memory (e.g. straight from Supabase Storage).
 */
export async function recognizeBuffer(
  worker: TesseractWorker,
  buffer: Buffer,
  // Reserved for future use — Tesseract.js v7 ignores mime hints for Buffer input.
  // Kept on the signature so call sites can pass through what they downloaded.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _mimeType?: string,
): Promise<OcrProviderResult> {
  const { data } = await withTimeout(
    worker.recognize(buffer),
    TESSERACT_TIMEOUT_MS,
    'Tesseract',
  )
  return buildResult(data)
}

/**
 * One-shot: create worker, recognize, terminate. Use for single-image callers.
 * For multi-image batches use createTesseractWorker + recognizeWithWorker so the
 * setup cost amortises.
 */
export async function runTesseractOcr(
  base64Content: string,
  mimeType = 'image/jpeg',
): Promise<OcrProviderResult> {
  const worker = await createTesseractWorker()
  try {
    return await recognizeWithWorker(worker, base64Content, mimeType)
  } finally {
    await worker.terminate().catch(() => {})
  }
}

function buildResult(data: TesseractRecognizeData): OcrProviderResult {
  const fullText = data.text ?? ''

  // Page.words doesn't exist in v7 — traverse blocks > paragraphs > lines > words
  const wordConfidences = new Map<string, number>()
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        for (const word of line.words) {
          const w = word.text.toUpperCase().trim()
          if (!w) continue
          const conf = word.confidence / 100
          const existing = wordConfidences.get(w)
          if (!existing || conf > existing) wordConfidences.set(w, conf)
        }
      }
    }
  }

  const candidates = extractCandidates(fullText)
  const topCandidate = selectTopCandidate(candidates, wordConfidences)

  return {
    rawResponse: { text: fullText },
    extractedText: fullText,
    candidates,
    topCandidate,
    provider: 'tesseract',
  }
}
