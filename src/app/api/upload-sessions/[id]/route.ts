import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export const GET = withAuth(async (_req, userId, params) => {
  const sessionId = params!.id
  const db = getSupabaseAdminClient()

  const { data: session } = await db
    .from('upload_sessions')
    .select('*')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .single()

  if (!session) return apiError('Session not found', 404)

  const { count: imageCount } = await db
    .from('images')
    .select('id', { count: 'exact', head: true })
    .eq('upload_session_id', sessionId)

  const { count: batchCount } = await db
    .from('upload_batches')
    .select('id', { count: 'exact', head: true })
    .eq('upload_session_id', sessionId)

  return NextResponse.json({
    ...session,
    actual_image_count: imageCount ?? 0,
    actual_batch_count: batchCount ?? 0,
  })
})
