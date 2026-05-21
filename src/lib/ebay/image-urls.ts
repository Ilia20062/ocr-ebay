import type { getSupabaseAdminClient } from '@/lib/supabase/admin'

type Db = ReturnType<typeof getSupabaseAdminClient>

const SIGNED_URL_TTL_SECONDS = 60 * 60
const EBAY_MAX_IMAGES = 24
// eBay errorId=25015 caps:
//   - each Picture URL ≤ 500 chars
//   - total length of all Picture URLs ≤ 3975 chars
const EBAY_PER_URL_LIMIT = 500
const EBAY_TOTAL_URL_LIMIT = 3975

/**
 * Generates the image URL list we attach to an eBay inventory item.
 *
 * Preferred path: when `NEXT_PUBLIC_APP_URL` is set, we hand eBay a short
 * stable proxy URL — `${APP_URL}/api/i/<image-id>` — which 302-redirects to a
 * fresh signed URL. This keeps every URL ~60–80 chars so even 24 images fit
 * well inside eBay's 3975-char total budget.
 *
 * Fallback path: if no app URL is configured, sign each path directly. We
 * still enforce the per-URL and total budget caps so we never trigger
 * errorId=25015 — we just may have to drop trailing images.
 */
export async function generateListingImageUrls(
  db: Db,
  images: Array<{ id: string; storage_path: string }>,
): Promise<string[]> {
  const limited = images.slice(0, EBAY_MAX_IMAGES)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '')

  const candidates: string[] = []

  if (appUrl) {
    for (const img of limited) {
      candidates.push(`${appUrl}/api/i/${img.id}`)
    }
  } else {
    for (const img of limited) {
      const { data, error } = await db.storage
        .from('images')
        .createSignedUrl(img.storage_path, SIGNED_URL_TTL_SECONDS)
      if (error || !data?.signedUrl) {
        console.warn(`[image-urls] could not sign ${img.storage_path}: ${error?.message ?? 'no url'}`)
        continue
      }
      candidates.push(data.signedUrl)
    }
  }

  // Enforce eBay's per-URL and total-length caps. Drop trailing entries
  // rather than fail outright — a listing with fewer images still goes live.
  const urls: string[] = []
  let totalLen = 0
  let dropped = 0
  for (const url of candidates) {
    if (url.length > EBAY_PER_URL_LIMIT) {
      dropped++
      continue
    }
    if (totalLen + url.length > EBAY_TOTAL_URL_LIMIT) {
      dropped += candidates.length - urls.length - dropped
      break
    }
    urls.push(url)
    totalLen += url.length
  }

  if (dropped > 0) {
    console.warn(
      `[image-urls] dropped ${dropped}/${candidates.length} image URL(s) to fit eBay caps ` +
        `(per_url=${EBAY_PER_URL_LIMIT}, total=${EBAY_TOTAL_URL_LIMIT})`,
    )
  }

  return urls
}
