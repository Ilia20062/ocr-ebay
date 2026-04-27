import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import ReviewQueue from './ReviewQueue'
import type { OcrResult } from '@/types/database'

export const dynamic = 'force-dynamic'

type OcrWithImage = OcrResult & {
  images: { id: string; user_id: string; original_filename: string | null; storage_path: string; status: string }
  signed_url?: string | null
}

export default async function ReviewPage() {
  const supabase = await getSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  const db = getSupabaseAdminClient()
  const { data: rawResults } = await db
    .from('ocr_results')
    .select('*, images!inner(id, user_id, original_filename, storage_path, status)')
    .eq('images.user_id', user!.id)
    .eq('images.status', 'needs_review')
    .order('created_at', { ascending: true })
    .limit(50)

  const results = (rawResults ?? []) as unknown as OcrWithImage[]

  const withUrls = await Promise.all(
    results.map(async (r) => {
      const { data } = await db.storage.from('images').createSignedUrl(r.images.storage_path, 3600)
      return { ...r, signed_url: data?.signedUrl ?? null }
    })
  )

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Review Queue</h2>
          <p className="text-sm text-gray-500 mt-0.5">{withUrls.length} image{withUrls.length !== 1 ? 's' : ''} need manual review</p>
        </div>
      </div>
      <ReviewQueue initialResults={withUrls} />
    </div>
  )
}
