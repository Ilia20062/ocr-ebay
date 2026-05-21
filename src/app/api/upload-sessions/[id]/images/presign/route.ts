import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { sessionPresignSchema } from '@/lib/validators/upload'
import { parseCapturedAt } from '@/lib/grouping/timestamp'
import { withContext } from '@/lib/log'

// Disable static-path generation. Next 16 / Turbopack otherwise tries to
// pre-render dynamic `[id]` segments and the compilation workers crash with
// "Jest worker encountered child process exceptions" → upload POSTs 500.
// This route is per-request (auth + DB writes + signed-URL mint), never
// static.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export const POST = withAuth(async (req, userId, params) => {
  const sessionId = params!.id
  const log = withContext({ scope: 'session.presign', user_id: userId, session_id: sessionId })

  let body: unknown
  try {
    body = await req.json()
  } catch (err) {
    log.warn('invalid json', { err })
    return apiError('Invalid JSON body', 400)
  }

  const parsed = sessionPresignSchema.safeParse(body)
  if (!parsed.success) {
    log.warn('schema validation failed', { err: parsed.error.message })
    return apiError(parsed.error.message, 422)
  }

  const { filename, mime_type, file_size_bytes } = parsed.data
  const db = getSupabaseAdminClient()

  // Verify session ownership and that it still accepts uploads.
  const { data: session, error: sessionErr } = await db
    .from('upload_sessions')
    .select('id, status')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .single()

  if (sessionErr || !session) {
    log.warn('session not found', { filename, err: sessionErr })
    return apiError('Upload session not found', 404)
  }
  if (session.status !== 'uploading') {
    log.warn('presign on non-uploading session', { current_status: session.status })
    return apiError(`Session is not accepting uploads (status: ${session.status})`, 409)
  }

  // (image-count cap removed — uploads have no per-session limit)

  const safeName = filename.replace(/[^a-zA-Z0-9.\-_]/g, '_')
  const storagePath = `${userId}/session-${sessionId}/${crypto.randomUUID()}-${safeName}`
  const captured = parseCapturedAt(filename)

  const { data: image, error: insertErr } = await db
    .from('images')
    .insert({
      batch_id: null,
      upload_session_id: sessionId,
      user_id: userId,
      storage_path: storagePath,
      original_filename: filename,
      file_size_bytes,
      mime_type,
      status: 'uploaded',
      captured_at: captured?.toISOString() ?? null,
    })
    .select()
    .single()

  if (insertErr || !image) {
    log.error('image insert failed', { filename, storage_path: storagePath, err: insertErr })
    return apiError('Failed to create image record', 500)
  }

  const { data: signedUrl, error: urlError } = await db.storage
    .from('images')
    .createSignedUploadUrl(storagePath)

  if (urlError || !signedUrl) {
    log.error('createSignedUploadUrl failed', { filename, storage_path: storagePath, err: urlError })
    return apiError('Failed to generate upload URL', 500)
  }

  return NextResponse.json(
    {
      image_id: image.id,
      storage_path: storagePath,
      upload_url: signedUrl.signedUrl,
      token: signedUrl.token,
    },
    { status: 201 },
  )
})
