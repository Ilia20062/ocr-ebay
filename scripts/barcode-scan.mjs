#!/usr/bin/env node
// Smoke-scan a folder of images and report which contained a barcode.
// Mirrors src/lib/ocr/barcode.ts so you can validate the integration
// without going through the upload UI.

import * as fs from 'node:fs'
import * as path from 'node:path'
import sharp from 'sharp'
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library'

const ROOT = process.argv[2]
if (!ROOT) {
  console.error('Usage: node scripts/barcode-scan.mjs <folder>')
  process.exit(1)
}

const IMG_EXT = /\.(jpe?g|png|webp|tiff?)$/i
const TARGET_WIDTH = 1600

const FORMATS = [
  BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93,
  BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E, BarcodeFormat.ITF, BarcodeFormat.QR_CODE,
  BarcodeFormat.DATA_MATRIX, BarcodeFormat.AZTEC, BarcodeFormat.PDF_417,
]

function walk(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(full))
    else if (e.isFile() && IMG_EXT.test(e.name)) out.push(full)
  }
  return out
}

function rgbaToArgb(rgba) {
  const out = new Uint8ClampedArray(rgba.length)
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = rgba[i + 3]
    out[i + 1] = rgba[i]
    out[i + 2] = rgba[i + 1]
    out[i + 3] = rgba[i + 2]
  }
  return out
}

function makeReader() {
  const reader = new MultiFormatReader()
  const hints = new Map()
  hints.set(DecodeHintType.POSSIBLE_FORMATS, FORMATS)
  hints.set(DecodeHintType.TRY_HARDER, true)
  reader.setHints(hints)
  return reader
}

async function scan(file) {
  try {
    const { data, info } = await sharp(file)
      .rotate()
      .resize({ width: TARGET_WIDTH, withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const luminance = new RGBLuminanceSource(rgbaToArgb(data), info.width, info.height)
    const binary = new BinaryBitmap(new HybridBinarizer(luminance))
    const reader = makeReader()
    const result = reader.decode(binary)
    return { code: result.getText(), format: BarcodeFormat[result.getBarcodeFormat()] }
  } catch {
    return null
  }
}

const files = walk(ROOT)
console.log(`Scanning ${files.length} images in ${ROOT} ...`)
let hits = 0
const hitDetails = []
for (let i = 0; i < files.length; i++) {
  const f = files[i]
  const r = await scan(f)
  if (r) {
    hits++
    hitDetails.push({ file: path.basename(f), ...r })
  }
  if ((i + 1) % 50 === 0 || i === files.length - 1) {
    process.stdout.write(`\r  ${i + 1}/${files.length} scanned, ${hits} hits`)
  }
}
console.log('')
console.log('')
console.log(`=== ${hits} barcodes found ===`)
for (const h of hitDetails.slice(0, 80)) {
  console.log(`  [${h.format.padEnd(12)}] ${h.code}   <-- ${h.file}`)
}
if (hitDetails.length > 80) console.log(`  ... +${hitDetails.length - 80} more`)
