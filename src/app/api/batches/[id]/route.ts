import { NextRequest, NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'

export const GET = withAuth(async (_req, userId, params) => {
  const db = getSupabaseAdminClient()
  const { data, error } = await db
    .from('upload_batches')
    .select('*, images(id, status, original_filename)')
    .eq('id', params!.id)
    .eq('user_id', userId)
    .single()

  if (error || !data) return apiError('Batch not found', 404)
  return NextResponse.json(data)
})

export const DELETE = withAuth(async (_req, userId, params) => {
  const db = getSupabaseAdminClient()
  const { data } = await db
    .from('upload_batches')
    .select('status')
    .eq('id', params!.id)
    .eq('user_id', userId)
    .single()

  if (!data) return apiError('Batch not found', 404)
  if (data.status !== 'pending') return apiError('Only pending batches can be deleted', 409)

  await db.from('upload_batches').delete().eq('id', params!.id)
  return new NextResponse(null, { status: 204 })
})
