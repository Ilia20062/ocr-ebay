import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import ReviewQueue, { type GroupForReview } from './ReviewQueue'
import type { OcrCandidate } from '@/types/ocr'

export const dynamic = 'force-dynamic'

const SIGNED_TTL = 3600

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>
}) {
  const { session: sessionId } = await searchParams
  const supabase = await getSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  const db = getSupabaseAdminClient()
  let query = db
    .from('upload_batches')
    .select('id, status, final_code, winning_ocr_result_id, total_images, upload_session_id, auto_grouped, created_at')
    .eq('user_id', user!.id)
    .eq('status', 'awaiting_review')
    .order('created_at', { ascending: true })
    .limit(100)

  if (sessionId) query = query.eq('upload_session_id', sessionId)

  const { data: batches } = await query

  const groups: GroupForReview[] = []
  for (const b of batches ?? []) {
    const { data: imgs } = await db
      .from('images')
      .select('id, storage_path, original_filename, is_label_candidate, captured_at')
      .eq('batch_id', b.id)
      .order('captured_at', { ascending: true, nullsFirst: false })

    const signedImages = await Promise.all(
      (imgs ?? []).map(async (img) => {
        const { data } = await db.storage.from('images').createSignedUrl(img.storage_path, SIGNED_TTL)
        return {
          id: img.id,
          signed_url: data?.signedUrl ?? null,
          original_filename: img.original_filename,
          is_label_candidate: img.is_label_candidate ?? false,
        }
      }),
    )

    const { data: ocrRows } = await db
      .from('ocr_results')
      .select('id, image_id, extracted_code, confidence, all_candidates')
      .in('image_id', (imgs ?? []).map((i) => i.id))

    groups.push({
      batchId: b.id,
      sessionId: b.upload_session_id,
      autoGrouped: b.auto_grouped ?? false,
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

  // Header copy varies depending on whether we're filtered to a session.
  let sessionLotLabel: string | null = null
  if (sessionId) {
    const { data: session } = await db
      .from('upload_sessions')
      .select('lot_label')
      .eq('id', sessionId)
      .eq('user_id', user!.id)
      .single()
    sessionLotLabel = session?.lot_label ?? null
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">
            {sessionId ? 'Review Job Lot' : 'Review Queue'}
            {sessionLotLabel ? <span className="ml-2 text-gray-400 font-mono">#{sessionLotLabel}</span> : null}
          </h2>
          <p className="text-sm text-gray-500 mt-0.5">
            {groups.length} group{groups.length !== 1 ? 's' : ''} waiting for review
            {sessionId ? ' — confirm or fix grouping below' : ''}
          </p>
        </div>
      </div>
      <ReviewQueue initialGroups={groups} sessionId={sessionId ?? null} />
    </div>
  )
}
