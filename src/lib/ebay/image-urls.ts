import type { getSupabaseAdminClient } from '@/lib/supabase/admin'

type Db = ReturnType<typeof getSupabaseAdminClient>

const SIGNED_URL_TTL_SECONDS = 60 * 60
const EBAY_MAX_IMAGES = 24

export async function generateListingImageUrls(
  db: Db,
  images: Array<{ id: string; storage_path: string }>,
): Promise<string[]> {
  const limited = images.slice(0, EBAY_MAX_IMAGES)
  const urls: string[] = []

  for (const img of limited) {
    const { data, error } = await db.storage
      .from('images')
      .createSignedUrl(img.storage_path, SIGNED_URL_TTL_SECONDS)
    if (error || !data?.signedUrl) {
      console.warn(`[image-urls] could not sign ${img.storage_path}: ${error?.message ?? 'no url'}`)
      continue
    }
    urls.push(data.signedUrl)
  }

  return urls
}
