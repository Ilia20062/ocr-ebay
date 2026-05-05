import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import ReviewQueue, { type GroupForReview } from './ReviewQueue'
import type { OcrCandidate } from '@/types/ocr'

export const dynamic = 'force-dynamic'

const SIGNED_TTL = 3600

export default async function ReviewPage() {
  const supabase = await getSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  const db = getSupabaseAdminClient()
  const { data: batches } = await db
    .from('upload_batches')
    .select('id, status, final_code, winning_ocr_result_id, total_images, created_at')
    .eq('user_id', user!.id)
    .eq('status', 'awaiting_review')
    .order('created_at', { ascending: true })
    .limit(50)

  const groups: GroupForReview[] = []
  for (const b of batches ?? []) {
    const { data: imgs } = await db
      .from('images')
      .select('id, storage_path, original_filename')
      .eq('batch_id', b.id)
      .order('created_at', { ascending: true })

    const signedImages = await Promise.all(
      (imgs ?? []).map(async (img) => {
        const { data } = await db.storage.from('images').createSignedUrl(img.storage_path, SIGNED_TTL)
        return { id: img.id, signed_url: data?.signedUrl ?? null, original_filename: img.original_filename }
      }),
    )

    const { data: ocrRows } = await db
      .from('ocr_results')
      .select('id, image_id, extracted_code, confidence, all_candidates')
      .in('image_id', (imgs ?? []).map((i) => i.id))

    groups.push({
      batchId: b.id,
      finalCode: b.final_code,
      winningOcrResultId: b.winning_ocr_result_id,
      totalImages: b.total_images,
      images: signedImages,
      ocrResults: (ocrRows ?? []).map((r) => ({
        id: r.id,
        image_id: r.image_id,
        extracted_code: r.extracted_code,
        confidence: r.confidence,
        all_candidates: (r.all_candidates as unknown as OcrCandidate[]) ?? [],
      })),
    })
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Review Queue</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            {groups.length} group{groups.length !== 1 ? 's' : ''} waiting for review
          </p>
        </div>
      </div>
      <ReviewQueue initialGroups={groups} />
    </div>
  )
}
