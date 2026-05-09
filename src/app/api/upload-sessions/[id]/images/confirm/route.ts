import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { sessionConfirmSchema } from '@/lib/validators/upload'
import { withContext } from '@/lib/log'

export const POST = withAuth(async (req, userId, params) => {
  const sessionId = params!.id
  const log = withContext({ scope: 'session.confirm', user_id: userId, session_id: sessionId })

  let body: unknown
  try {
    body = await req.json()
  } catch (err) {
    log.warn('invalid json', { err })
    return apiError('Invalid JSON body', 400)
  }

  const parsed = sessionConfirmSchema.safeParse(body)
  if (!parsed.success) {
    log.warn('schema validation failed', { err: parsed.error.message })
    return apiError(parsed.error.message, 422)
  }

  const { image_id } = parsed.data
  const db = getSupabaseAdminClient()

  const { data: image, error: imgErr } = await db
    .from('images')
    .select('id, user_id, upload_session_id')
    .eq('id', image_id)
    .single()

  if (imgErr || !image) {
    log.warn('image not found', { image_id, err: imgErr })
    return apiError('Image not found in this session', 404)
  }
  if (image.user_id !== userId || image.upload_session_id !== sessionId) {
    log.warn('image session/owner mismatch', {
      image_id,
      image_owner: image.user_id,
      image_session: image.upload_session_id,
    })
    return apiError('Image not found in this session', 404)
  }

  return NextResponse.json({ confirmed: true })
})
