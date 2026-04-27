import { NextRequest, NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'

type OcrWithImg = { id: string; images: { storage_path: string }; [key: string]: unknown }

export const GET = withAuth(async (req, userId) => {
  const db = getSupabaseAdminClient()
  const url = new URL(req.url)
  const page = parseInt(url.searchParams.get('page') ?? '1')
  const limit = 20
  const offset = (page - 1) * limit

  const { data: rawData, error, count } = await db
    .from('ocr_results')
    .select('*, images!inner(id, user_id, original_filename, storage_path, status)', { count: 'exact' })
    .eq('images.user_id', userId)
    .eq('images.status', 'needs_review')
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1)

  if (error) return apiError('Failed to fetch OCR results', 500)

  const data = (rawData ?? []) as unknown as OcrWithImg[]

  const resultsWithUrls = await Promise.all(
    data.map(async (result) => {
      const { data: signedUrl } = await db.storage
        .from('images')
        .createSignedUrl(result.images.storage_path, 3600)
      return { ...result, signed_url: signedUrl?.signedUrl ?? null }
    })
  )

  return NextResponse.json({ data: resultsWithUrls, total: count, page })
})
