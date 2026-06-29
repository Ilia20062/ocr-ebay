import sharp from 'sharp'
import { log } from '@/lib/log'

/**
 * Seller photo-template overlays (logo + warranty badge) are baked into every
 * product image at fixed corners. They wreck OCR: the engines read "PartsOut",
 * "WARRANTY", "90 DAYS" and the extractor turns those into fake part numbers.
 *
 * Because the overlays sit in fixed, known regions, the most reliable fix is to
 * paint them out (white) BEFORE OCR. Masking the corners leaves the engraved
 * part number (always near the centre) untouched.
 *
 * Regions are fractions of width/height. Defaults match the "PartsOut" template
 * (logo top-right, warranty shield bottom-left) and can be overridden with
 * OCR_MASK_REGIONS (JSON array of {x,y,w,h} fractions). Disable with
 * OCR_MASK_OVERLAYS=0.
 */
export interface MaskRegion {
  x: number
  y: number
  w: number
  h: number
}

const DEFAULT_REGIONS: MaskRegion[] = [
  { x: 0.6, y: 0.0, w: 0.4, h: 0.2 }, // top-right logo
  { x: 0.0, y: 0.74, w: 0.46, h: 0.26 }, // bottom-left warranty badge
]

export function maskingEnabled(): boolean {
  return process.env.OCR_MASK_OVERLAYS !== '0'
}

function regions(): MaskRegion[] {
  const raw = process.env.OCR_MASK_REGIONS
  if (!raw) return DEFAULT_REGIONS
  try {
    const parsed = JSON.parse(raw) as MaskRegion[]
    if (Array.isArray(parsed) && parsed.length) return parsed
  } catch {
    log.warn('OCR_MASK_REGIONS is not valid JSON — using defaults', { scope: 'ocr.mask' })
  }
  return DEFAULT_REGIONS
}

/**
 * Returns a JPEG buffer with the overlay corners painted white. On any failure
 * (decode error, etc.) returns the original buffer unchanged — masking must
 * never break the OCR path.
 */
export async function maskOverlays(buffer: Buffer): Promise<{ buffer: Buffer; mime: string; masked: boolean }> {
  if (!maskingEnabled()) return { buffer, mime: 'image/jpeg', masked: false }
  try {
    const meta = await sharp(buffer).metadata()
    const W = meta.width ?? 0
    const H = meta.height ?? 0
    if (!W || !H) return { buffer, mime: 'image/jpeg', masked: false }

    const rects = regions()
      .map((r) => {
        const x = Math.max(0, Math.round(r.x * W))
        const y = Math.max(0, Math.round(r.y * H))
        const w = Math.min(W - x, Math.round(r.w * W))
        const h = Math.min(H - y, Math.round(r.h * H))
        return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="white"/>`
      })
      .join('')

    const svg = Buffer.from(`<svg width="${W}" height="${H}">${rects}</svg>`)
    const out = await sharp(buffer)
      .composite([{ input: svg, top: 0, left: 0 }])
      .jpeg({ quality: 95 })
      .toBuffer()
    return { buffer: out, mime: 'image/jpeg', masked: true }
  } catch (err) {
    log.warn('overlay masking failed — using original buffer', { scope: 'ocr.mask', err })
    return { buffer, mime: 'image/jpeg', masked: false }
  }
}
