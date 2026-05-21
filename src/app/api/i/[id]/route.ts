import { NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { withContext } from '@/lib/log'

/**
 * Public image proxy used in eBay listings.
 *
 * Why this exists: Supabase signed URLs run ~400–500 characters each
 * (project host + path + JWT). eBay caps every Picture URL at 500 chars and
 * the *sum* of all URLs at 3975 chars (errorId=25015). Even 8–10 images blow
 * past the total budget.
 *
 * This endpoint serves a short, stable URL — `${APP_URL}/api/i/<image-id>` —
 * that 302-redirects to a fresh signed URL. eBay fetches once, caches the
 * bytes, and the underlying signed URL expiring afterwards is harmless.
 *
 * No auth on purpose: eBay (and its image-scraping CDN) must be able to GET
 * this without credentials. Image IDs are UUIDs (unguessable) and only paths
 * that exist in the `images` table resolve.
 */

const SIGNED_TTL_SECONDS = 60 * 10

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const log = withContext({ scope: 'api.image-proxy', image_id: id })

  if (!id || !/^[0-9a-f-]{8,}$/i.test(id)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 })
  }

  const db = getSupabaseAdminClient()
  const { data: image, error } = await db
    .from('images')
    .select('storage_path')
    .eq('id', id)
    .maybeSingle()

  if (error || !image) {
    log.warn('Image not found', { err: error?.message })
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const { data: signed, error: signErr } = await db.storage
    .from('images')
    .createSignedUrl(image.storage_path, SIGNED_TTL_SECONDS)

  if (signErr || !signed?.signedUrl) {
    log.error('Failed to sign storage URL', { err: signErr?.message, path: image.storage_path })
    return NextResponse.json({ error: 'storage error' }, { status: 502 })
  }

  // 302 (temporary) so eBay's scraper re-resolves later if it wants the URL
  // again — but in practice eBay caches the bytes, not the URL.
  return NextResponse.redirect(signed.signedUrl, {
    status: 302,
    headers: { 'Cache-Control': 'public, max-age=600' },
  })
}
