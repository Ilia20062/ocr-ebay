import { NextRequest, NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { runOcr, shouldAutoApprove } from '@/lib/ocr'
import type { Json, Database } from '@/types/supabase'

export const POST = withAuth(async (_req, userId, params) => {
  const db = getSupabaseAdminClient()

  const { data: rawOcr } = await db
    .from('ocr_results')
    .select('id, image_id, images!inner(user_id, storage_path)')
    .eq('id', params!.id)
    .single()

  const ocrResult = rawOcr as unknown as { id: string; image_id: string; images: { user_id: string; storage_path: string } } | null
  if (!ocrResult || ocrResult.images.user_id !== userId) return apiError('Not found', 404)

  const { data: signedUrlData } = await db.storage
    .from('images')
    .createSignedUrl(ocrResult.images.storage_path, 300)

  if (!signedUrlData?.signedUrl) return apiError('Could not generate signed URL', 500)

  try {
    const result = await runOcr(signedUrlData.signedUrl)
    const autoApproved = shouldAutoApprove(result)

    const ocrUpdate: Database['public']['Tables']['ocr_results']['Update'] = {
      raw_response: result.rawResponse as unknown as Json,
      extracted_text: result.extractedText,
      extracted_code: result.topCandidate?.text ?? null,
      all_candidates: result.candidates as unknown as Json,
      confidence: result.topCandidate?.confidence ?? null,
      auto_approved: autoApproved,
      manual_override: null,
    }
    await db.from('ocr_results').update(ocrUpdate).eq('id', params!.id)

    await db.from('images').update({
      status: autoApproved ? 'approved' : 'needs_review',
    }).eq('id', ocrResult.image_id)

    return NextResponse.json({ success: true, auto_approved: autoApproved })
  } catch (err) {
    return apiError(`OCR retry failed: ${err}`, 500)
  }
})
