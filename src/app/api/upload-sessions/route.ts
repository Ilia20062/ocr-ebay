import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { createSessionSchema } from '@/lib/validators/upload'
import { withContext } from '@/lib/log'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export const POST = withAuth(async (req, userId) => {
  const log = withContext({ scope: 'session.create', user_id: userId })

  let body: unknown = {}
  try {
    body = await req.json()
  } catch {
    // empty body is fine
  }
  const parsed = createSessionSchema.safeParse(body)
  if (!parsed.success) {
    log.warn('schema validation failed', { err: parsed.error.message })
    return apiError(parsed.error.message, 422)
  }

  const db = getSupabaseAdminClient()
  const { data, error } = await db
    .from('upload_sessions')
    .insert({ user_id: userId, lot_label: parsed.data.lot_label ?? null })
    .select()
    .single()

  if (error || !data) {
    log.error('insert failed', { err: error })
    return apiError('Failed to create upload session', 500)
  }

  log.info('session created', { session_id: data.id, lot_label: parsed.data.lot_label ?? null })
  return NextResponse.json(data, { status: 201 })
})
