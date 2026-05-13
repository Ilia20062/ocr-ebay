import { NextRequest, NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { presignSchema } from '@/lib/validators/upload'

export const POST = withAuth(async (req, userId) => {
  const body = await req.json()
  const parsed = presignSchema.safeParse(body)
  if (!parsed.success) return apiError(parsed.error.message, 422)

  const { batch_id, filename, mime_type, file_size_bytes } = parsed.data
  const db = getSupabaseAdminClient()

  // Verify batch ownership
  const { data: batch } = await db
    .from('upload_batches')
    .select('id')
    .eq('id', batch_id)
    .eq('user_id', userId)
    .single()

  if (!batch) return apiError('Batch not found', 404)

  // (image-count cap removed — uploads have no per-batch limit)

  // Create image record
  const safeName = filename.replace(/[^a-zA-Z0-9.\-_]/g, '_')
  const storagePath = `${userId}/${batch_id}/${crypto.randomUUID()}-${safeName}`
  const { data: image, error } = await db.from('images').insert({
    batch_id,
    user_id: userId,
    storage_path: storagePath,
    original_filename: filename,
    file_size_bytes,
    mime_type,
    status: 'uploaded',
  }).select().single()

  if (error) {
    console.error('[presign] DB insert error:', error)
    return apiError('Failed to create image record', 500)
  }

  // Ensure storage bucket exists (no-op if already created)
  await db.storage.createBucket('images', { public: false })

  // Generate presigned upload URL (15-minute validity)
  const { data: signedUrl, error: urlError } = await db.storage
    .from('images')
    .createSignedUploadUrl(storagePath)

  if (urlError || !signedUrl) {
    console.error('[presign] createSignedUploadUrl error:', urlError)
    return apiError('Failed to generate upload URL', 500)
  }

  return NextResponse.json({
    image_id: image.id,
    storage_path: storagePath,
    upload_url: signedUrl.signedUrl,
    token: signedUrl.token,
  }, { status: 201 })
})
