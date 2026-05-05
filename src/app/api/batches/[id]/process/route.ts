import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { runOcr } from '@/lib/ocr'
import { resolveGroupCode } from '@/lib/ocr/group-resolver'
import { enqueueRetry } from '@/lib/retry'
import type { Json } from '@/types/supabase'
import type { OcrCandidate } from '@/types/ocr'

const OCR_CONCURRENCY = 5

export const POST = withAuth(async (_req, userId, params) => {
  const db = getSupabaseAdminClient()
  const batchId = params!.id

  const { data: batch } = await db
    .from('upload_batches')
    .select('*')
    .eq('id', batchId)
    .eq('user_id', userId)
    .single()

  if (!batch) return apiError('Batch not found', 404)
  if (batch.status === 'processing') return apiError('Batch already processing', 409)

  await db.from('upload_batches').update({ status: 'processing' }).eq('id', batchId)

  const { data: images } = await db
    .from('images')
    .select('id, storage_path')
    .eq('batch_id', batchId)
    .eq('status', 'uploaded')

  if (!images || images.length === 0) {
    await db.from('upload_batches').update({ status: 'failed' }).eq('id', batchId)
    return apiError('No images to process', 422)
  }

  await db.from('upload_batches').update({ total_images: images.length }).eq('id', batchId)

  // Run OCR in background; return immediately
  void processGroupInBackground(images, batchId, db)

  return NextResponse.json({ message: 'Processing started', total: images.length })
})

async function processGroupInBackground(
  images: Array<{ id: string; storage_path: string }>,
  batchId: string,
  db: ReturnType<typeof getSupabaseAdminClient>,
) {
  const queue = [...images]
  const ocrRows: Array<{
    id: string
    image_id: string
    extracted_code: string | null
    confidence: number | null
    all_candidates: OcrCandidate[]
  }> = []
  let processed = 0

  async function worker() {
    while (queue.length > 0) {
      const image = queue.shift()
      if (!image) return
      try {
        await db.from('images').update({ status: 'ocr_processing' }).eq('id', image.id)

        const { data: blob, error: dlError } = await db.storage.from('images').download(image.storage_path)
        if (dlError || !blob) throw new Error('Could not download image')

        const ab = await blob.arrayBuffer()
        const base64 = Buffer.from(ab).toString('base64')
        const ocrResult = await runOcr(base64, blob.type || 'image/jpeg')

        const { data: inserted } = await db
          .from('ocr_results')
          .insert({
            image_id: image.id,
            raw_response: ocrResult.rawResponse as unknown as Json,
            extracted_text: ocrResult.extractedText,
            extracted_code: ocrResult.topCandidate?.text ?? null,
            all_candidates: ocrResult.candidates as unknown as Json,
            confidence: ocrResult.topCandidate?.confidence ?? null,
            provider: ocrResult.provider,
            auto_approved: false,
          })
          .select('id, image_id, extracted_code, confidence, all_candidates')
          .single()

        if (inserted) {
          ocrRows.push({
            id: inserted.id,
            image_id: inserted.image_id,
            extracted_code: inserted.extracted_code,
            confidence: inserted.confidence,
            all_candidates: (inserted.all_candidates as unknown as OcrCandidate[]) ?? [],
          })
        }

        await db.from('images').update({ status: 'ocr_done' }).eq('id', image.id)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[process] OCR failed for image ${image.id}:`, errMsg)
        await db.from('images').update({ status: 'failed', error_message: errMsg }).eq('id', image.id)
        await enqueueRetry('image', image.id, errMsg)
      } finally {
        processed++
        await db.from('upload_batches').update({ processed }).eq('id', batchId)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(OCR_CONCURRENCY, images.length) }, worker))

  const resolved = resolveGroupCode({ ocrResults: ocrRows })

  await db
    .from('upload_batches')
    .update({
      status: 'awaiting_review',
      winning_ocr_result_id: resolved.winningOcrResultId,
      final_code: resolved.winningCode,
      processed,
    })
    .eq('id', batchId)
}
