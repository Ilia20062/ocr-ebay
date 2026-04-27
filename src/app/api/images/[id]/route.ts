import { NextRequest, NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import type { Image } from '@/types/database'

export const GET = withAuth(async (_req, userId, params) => {
  const db = getSupabaseAdminClient()
  const { data, error } = await db
    .from('images')
    .select('*, ocr_results(*)')
    .eq('id', params!.id)
    .eq('user_id', userId)
    .single()

  if (error || !data) return apiError('Image not found', 404)
  const image = data as unknown as Image & { ocr_results: unknown }

  const { data: signedUrlData } = await db.storage
    .from('images')
    .createSignedUrl(image.storage_path, 3600)

  return NextResponse.json({ ...image, signed_url: signedUrlData?.signedUrl ?? null })
})

export const DELETE = withAuth(async (_req, userId, params) => {
  const db = getSupabaseAdminClient()
  const { data } = await db
    .from('images')
    .select('storage_path, status')
    .eq('id', params!.id)
    .eq('user_id', userId)
    .single()

  if (!data) return apiError('Image not found', 404)
  if (['ocr_processing', 'approved'].includes(data.status)) {
    return apiError('Cannot delete image in current state', 409)
  }

  await db.storage.from('images').remove([data.storage_path])
  await db.from('images').delete().eq('id', params!.id)
  return new NextResponse(null, { status: 204 })
})
