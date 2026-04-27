import { NextRequest, NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { runOcr, shouldAutoApprove } from '@/lib/ocr'
import { searchEbayProducts, selectBestMatch } from '@/lib/ebay/search'
import { enqueueRetry } from '@/lib/retry'
import type { Json } from '@/types/supabase'

export const POST = withAuth(async (_req, userId, params) => {
  const db = getSupabaseAdminClient()
  const batchId = params!.id

  // Verify batch ownership
  const { data: batch } = await db
    .from('upload_batches')
    .select('*')
    .eq('id', batchId)
    .eq('user_id', userId)
    .single()

  if (!batch) return apiError('Batch not found', 404)
  if (batch.status === 'processing') return apiError('Batch already processing', 409)

  // Mark batch as processing
  await db.from('upload_batches').update({ status: 'processing' }).eq('id', batchId)

  // Fetch all uploaded images in the batch
  const { data: images } = await db
    .from('images')
    .select('*')
    .eq('batch_id', batchId)
    .eq('status', 'uploaded')

  if (!images || images.length === 0) {
    await db.from('upload_batches').update({ status: 'completed' }).eq('id', batchId)
    return NextResponse.json({ message: 'No images to process' })
  }

  await db.from('upload_batches').update({ total_images: images.length }).eq('id', batchId)

  // Process each image (async, non-blocking response — runs in Vercel function lifetime)
  processImagesInBackground(images, userId, batchId, db)

  return NextResponse.json({ message: 'Processing started', total: images.length })
})

async function processImagesInBackground(
  images: Array<{ id: string; storage_path: string }>,
  userId: string,
  batchId: string,
  db: ReturnType<typeof getSupabaseAdminClient>
) {
  let processed = 0
  let needsReview = 0

  for (const image of images) {
    try {
      await db.from('images').update({ status: 'ocr_processing' }).eq('id', image.id)

      // Download image bytes for OCR (avoids Google Vision needing to reach Supabase URLs)
      const { data: imageBlob, error: downloadError } = await db.storage
        .from('images')
        .download(image.storage_path)

      if (downloadError || !imageBlob) throw new Error('Could not download image')

      const arrayBuffer = await imageBlob.arrayBuffer()
      const base64 = Buffer.from(arrayBuffer).toString('base64')

      // Run OCR
      const ocrResult = await runOcr(base64, imageBlob.type || 'image/jpeg')
      const autoApproved = shouldAutoApprove(ocrResult)

      // Check for duplicate final_code in this batch
      const finalCode = ocrResult.topCandidate?.text ?? null
      if (finalCode) {
        const { data: existing } = await db
          .from('ocr_results')
          .select('id')
          .eq('extracted_code', finalCode)
          .in('image_id', images.map((i) => i.id))
          .limit(1)

        if (existing && existing.length > 0) {
          // Flag as duplicate in all_candidates
          ocrResult.candidates.push({ text: '__DUPLICATE__', confidence: 0 })
        }
      }

      // Save OCR result (unique constraint on image_id prevents double-processing)
      const { error: insertError } = await db.from('ocr_results').insert({
        image_id: image.id,
        raw_response: ocrResult.rawResponse as unknown as Json,
        extracted_text: ocrResult.extractedText,
        extracted_code: ocrResult.topCandidate?.text ?? null,
        all_candidates: ocrResult.candidates as unknown as Json,
        confidence: ocrResult.topCandidate?.confidence ?? null,
        provider: ocrResult.provider,
        auto_approved: autoApproved,
      })

      if (insertError && insertError.code === '23505') {
        // Unique violation — already processed, skip
        processed++
        continue
      }

      const newImageStatus = autoApproved ? 'approved' : 'needs_review'
      await db.from('images').update({ status: newImageStatus }).eq('id', image.id)

      if (!autoApproved) needsReview++

      // If auto-approved, trigger product search immediately
      if (autoApproved && finalCode) {
        await triggerProductSearch(image.id, finalCode, userId, db)
      }

      processed++
      await db.from('upload_batches').update({ processed }).eq('id', batchId)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`OCR failed for image ${image.id}:`, errMsg)
      await db.from('images').update({ status: 'failed', error_message: errMsg }).eq('id', image.id)
      await enqueueRetry('image', image.id, errMsg)
      processed++
      await db.from('upload_batches').update({ processed }).eq('id', batchId)
    }
  }

  const finalStatus = needsReview > 0 ? 'awaiting_review' : 'completed'
  await db.from('upload_batches').update({ status: finalStatus, processed }).eq('id', batchId)
}

async function triggerProductSearch(
  imageId: string,
  finalCode: string,
  userId: string,
  db: ReturnType<typeof getSupabaseAdminClient>
) {
  const { data: ocrResult } = await db
    .from('ocr_results')
    .select('id')
    .eq('image_id', imageId)
    .single()

  if (!ocrResult) return

  const { data: search } = await db.from('product_searches').insert({
    ocr_result_id: ocrResult.id,
    search_query: finalCode,
    status: 'pending',
  }).select().single()

  if (!search) return

  try {
    const items = await searchEbayProducts(userId, finalCode)
    const best = selectBestMatch(items, finalCode)

    await db.from('product_searches').update({
      status: items.length > 0 ? 'success' : 'no_results',
      result_count: items.length,
      results_raw: items as unknown as Json,
      selected_item_id: best?.itemId ?? null,
    }).eq('id', search.id)
  } catch (err) {
    await db.from('product_searches').update({
      status: 'failed',
      error_message: String(err),
    }).eq('id', search.id)
    await enqueueRetry('product_search', search.id, String(err))
  }
}
