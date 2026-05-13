/**
 * Barcode / QR scanner for label images.
 *
 * Run BEFORE OCR. When a part has a printed barcode (EAN, UPC, Code128/39,
 * QR, Data Matrix), zxing returns the encoded value with effectively 100%
 * confidence — far better than OCR'ing molded plastic.
 *
 * Pipeline:
 *   1. `sharp` decodes the input buffer to raw RGBA pixels (resized to a
 *      consistent width to keep zxing fast and robust to phone-camera
 *      resolution drift).
 *   2. zxing tries to read every common 1D/2D format from the pixel buffer.
 *   3. We accept any non-empty result that passes a sanity filter (the
 *      "WhatsApp/SMS share" QR overlay on some screenshots is rejected).
 *
 * Designed to never throw — a failure to decode is just "no barcode here".
 */

import sharp from 'sharp'
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library'
import { log } from '@/lib/log'

export interface BarcodeHit {
  /** The decoded text — e.g. "0123456789012", "PART-A2128200102", or a URL. */
  code: string
  /** zxing format name — "EAN_13", "CODE_128", "QR_CODE", … */
  format: string
}

/** Target width for zxing input. Phones produce 4000-pixel-wide labels; downscaling speeds decoding without hurting accuracy on barcodes that are >50px tall in the resized image. */
const TARGET_WIDTH = 1600

/**
 * Formats we care about. CODE_128 / CODE_39 / EAN_13 / UPC cover almost every
 * printed parts label. QR / DATA_MATRIX cover modern OEM stickers.
 */
const FORMATS: BarcodeFormat[] = [
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.CODE_93,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.ITF,
  BarcodeFormat.QR_CODE,
  BarcodeFormat.DATA_MATRIX,
  BarcodeFormat.AZTEC,
  BarcodeFormat.PDF_417,
]

function makeReader(): MultiFormatReader {
  const reader = new MultiFormatReader()
  const hints = new Map()
  hints.set(DecodeHintType.POSSIBLE_FORMATS, FORMATS)
  hints.set(DecodeHintType.TRY_HARDER, true)
  reader.setHints(hints)
  return reader
}

/**
 * Convert a sharp RGBA buffer into the ARGB-packed Uint8ClampedArray that
 * RGBLuminanceSource expects. Each output pixel is 4 bytes: A, R, G, B (zxing
 * ignores alpha; it only reads RGB to compute luminance).
 */
function rgbaToArgb(rgba: Buffer): Uint8ClampedArray {
  // sharp emits RGBA in this byte order: [R,G,B,A,R,G,B,A,…]. zxing's
  // RGBLuminanceSource accepts the same length array but reads bytes as
  // [_,R,G,B,_,R,G,B,…] when given a length-4×N buffer where alpha is the
  // first byte. Repacking is required.
  const out = new Uint8ClampedArray(rgba.length)
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = rgba[i + 3] // A
    out[i + 1] = rgba[i] // R
    out[i + 2] = rgba[i + 1] // G
    out[i + 3] = rgba[i + 2] // B
  }
  return out
}

/**
 * Reject decoded strings that aren't useful as part numbers:
 *   - URLs ("https://…", "www.…")
 *   - Phone numbers / "Call us at …"
 *   - Pure marketing slogans
 *   - Anything < 4 chars
 *
 * Real part numbers are alphanumeric with optional dashes/dots/slashes.
 */
function isUsableBarcodeValue(value: string): boolean {
  const v = value.trim()
  if (v.length < 4) return false
  if (/^https?:\/\//i.test(v)) return false
  if (/^www\./i.test(v)) return false
  if (/^tel:/i.test(v)) return false
  // Allow letters, digits, dashes, dots, slashes, spaces, plus, hash
  if (!/^[A-Za-z0-9\-\.\/\s\+#:_]+$/.test(v)) return false
  // Require at least one digit (matches the OCR extractor's invariant — part
  // numbers always have a digit, but words like "SCAN ME" don't)
  if (!/\d/.test(v)) return false
  return true
}

/**
 * Try to read a barcode out of an image buffer.
 *
 * Returns `null` on any of:
 *   - No barcode detected.
 *   - Decoded text fails the usability filter (URL, phone, etc.).
 *   - Decoder throws (NotFoundException from zxing is the normal case).
 *
 * Never throws.
 */
export async function scanBarcode(buffer: Buffer): Promise<BarcodeHit | null> {
  const t0 = Date.now()
  try {
    // Step 1: decode + resize to RGBA via sharp.
    const { data, info } = await sharp(buffer)
      .rotate() // honor EXIF orientation
      .resize({ width: TARGET_WIDTH, withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })

    // Step 2: pack into zxing's expected ARGB layout and wrap in a binary bitmap.
    const packed = rgbaToArgb(data)
    const luminance = new RGBLuminanceSource(packed, info.width, info.height)
    const binary = new BinaryBitmap(new HybridBinarizer(luminance))

    // Step 3: decode.
    const reader = makeReader()
    const result = reader.decode(binary)
    const text = result.getText()
    const formatName = BarcodeFormat[result.getBarcodeFormat()] ?? 'UNKNOWN'

    if (!isUsableBarcodeValue(text)) {
      log.info('barcode rejected by filter', {
        scope: 'ocr.barcode',
        raw: text.slice(0, 60),
        format: formatName,
        dur_ms: Date.now() - t0,
      })
      return null
    }

    log.info('barcode hit', {
      scope: 'ocr.barcode',
      code: text,
      format: formatName,
      dur_ms: Date.now() - t0,
    })
    return { code: text.trim(), format: formatName }
  } catch (err) {
    // zxing throws NotFoundException when there's no barcode — the common
    // case for product photos. Don't log every miss.
    const msg = err instanceof Error ? err.message : String(err)
    if (!/notfound/i.test(msg)) {
      log.debug('barcode decode threw (non-NotFound)', {
        scope: 'ocr.barcode',
        err: msg,
        dur_ms: Date.now() - t0,
      })
    }
    return null
  }
}
