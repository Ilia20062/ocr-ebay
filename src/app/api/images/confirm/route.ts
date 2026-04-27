import { NextRequest, NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'

export const POST = withAuth(async (req, userId) => {
  const body = await req.json() as { image_id: string }
  if (!body.image_id) return apiError('image_id required', 422)

  const db = getSupabaseAdminClient()
  const { data, error } = await db
    .from('images')
    .select('id')
    .eq('id', body.image_id)
    .eq('user_id', userId)
    .single()

  if (error || !data) return apiError('Image not found', 404)
  return NextResponse.json({ confirmed: true })
})
