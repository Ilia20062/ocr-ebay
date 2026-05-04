import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { ocrReviewSchema } from '@/lib/validators/ocr'
import { searchEbayProducts, selectBestMatch } from '@/lib/ebay/search'
import { autoCreateListing } from '@/lib/ebay/auto-list'
import { enqueueRetry } from '@/lib/retry'
import type { OcrResult } from '@/types/database'
import type { Json, Database } from '@/types/supabase'

type OcrWithImage = OcrResult & { images: { id: string; user_id: string; storage_path: string; original_filename: string | null } }

export const GET = withAuth(async (_req, userId, params) => {
  const db = getSupabaseAdminClient()
  const { data, error } = await db
    .from('ocr_results')
    .select('*, images!inner(id, user_id, storage_path, original_filename)')
    .eq('id', params!.id)
    .single()

  if (error || !data) return apiError('OCR result not found', 404)
  const result = data as unknown as OcrWithImage
  if (result.images.user_id !== userId) return apiError('Not found', 404)

  const { data: signedUrl } = await db.storage
    .from('images')
    .createSignedUrl(result.images.storage_path, 3600)

  const finalCode = result.manual_override ?? (result.auto_approved ? result.extracted_code : null)
  return NextResponse.json({ ...result, final_code: finalCode, signed_url: signedUrl?.signedUrl })
})

export const PATCH = withAuth(async (req, userId, params) => {
  const body = await req.json()
  const parsed = ocrReviewSchema.safeParse(body)
  if (!parsed.success) return apiError(parsed.error.message, 422)

  const { action, manual_override } = parsed.data
  const db = getSupabaseAdminClient()

  const { data: rawOcr } = await db
    .from('ocr_results')
    .select('id, image_id, extracted_code, images!inner(user_id)')
    .eq('id', params!.id)
    .single()

  const ocrResult = rawOcr as unknown as (OcrResult & { images: { user_id: string } }) | null
  if (!ocrResult || ocrResult.images.user_id !== userId) return apiError('Not found', 404)

  if (action === 'discard') {
    await db.from('images').update({ status: 'discarded' }).eq('id', ocrResult.image_id)
    return NextResponse.json({ discarded: true })
  }

  type OcrUpdate = Database['public']['Tables']['ocr_results']['Update']
  const updates: OcrUpdate = {
    reviewed_by: userId,
    reviewed_at: new Date().toISOString(),
    ...(action === 'approve' ? { auto_approved: true } : {}),
    ...(action === 'override' ? { manual_override } : {}),
  }

  await db.from('ocr_results').update(updates).eq('id', params!.id)
  await db.from('images').update({ status: 'approved' }).eq('id', ocrResult.image_id)

  const finalCode = action === 'override' ? manual_override! : ocrResult.extracted_code

  let searchResult: 'found' | 'not_found' | 'error' = 'not_found'
  let listingResult: { success: boolean; listingUrl?: string; error?: string } | undefined

  if (finalCode) {
    try {
      const { data: search } = await db.from('product_searches').insert({
        ocr_result_id: params!.id,
        search_query: finalCode,
        status: 'pending',
      }).select().single()

      if (search) {
        const items = await searchEbayProducts(userId, finalCode)
        const best = selectBestMatch(items, finalCode)
        await db.from('product_searches').update({
          status: items.length > 0 ? 'success' : 'no_results',
          result_count: items.length,
          results_raw: items as unknown as Json,
          selected_item_id: best?.itemId ?? null,
        }).eq('id', search.id)

        // Auto-create eBay listing if a matching product was found
        if (best) {
          searchResult = 'found'
          // Wait for listing creation to provide immediate feedback to the UI
          listingResult = await autoCreateListing({ userId, searchId: search.id, bestMatch: best })
        } else {
          searchResult = 'not_found'
        }
      }
    } catch (err) {
      searchResult = 'error'
      await enqueueRetry('product_search', params!.id, String(err))
    }
  }

  return NextResponse.json({ success: true, searchResult, listingResult })
})
