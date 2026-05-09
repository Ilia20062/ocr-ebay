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
    .select(
      'id, status, final_code, winning_ocr_result_id, total_images, upload_session_id, auto_grouped, created_at',
    )
    .eq('user_id', user!.id)
    .eq('status', 'awaiting_review')
    .order('created_at', { ascending: true })
    .limit(100)

  if (sessionId) query = query.eq('upload_session_id', sessionId)

  const { data: batches } = await query
  const batchList = batches ?? []
  const batchIds = batchList.map((b) => b.id)

  // Bulk-fetch every image and ocr_result for all visible batches in TWO queries
  // total — was N+1+1 per batch. With 36 session batches × ~7 images each, this
  // collapses 73 round trips into 2.
  const [imagesRes, sessionLotLabel] = await Promise.all([
    batchIds.length > 0
      ? db
          .from('images')
          .select('id, batch_id, storage_path, original_filename, is_label_candidate, captured_at')
          .in('batch_id', batchIds)
          .order('captured_at', { ascending: true, nullsFirst: false })
      : Promise.resolve({ data: [] as Array<{
          id: string
          batch_id: string | null
          storage_path: string
          original_filename: string | null
          is_label_candidate: boolean | null
          captured_at: string | null
        }> }),
    sessionId
      ? db
          .from('upload_sessions')
          .select('lot_label')
          .eq('id', sessionId)
          .eq('user_id', user!.id)
          .single()
          .then((r) => r.data?.lot_label ?? null)
      : Promise.resolve<string | null>(null),
  ])

  const imagesByBatch = new Map<
    string,
    Array<{
      id: string
      storage_path: string
      original_filename: string | null
      is_label_candidate: boolean | null
      captured_at: string | null
    }>
  >()
  for (const img of imagesRes.data ?? []) {
    if (!img.batch_id) continue
    const list = imagesByBatch.get(img.batch_id) ?? []
    list.push({
      id: img.id,
      storage_path: img.storage_path,
      original_filename: img.original_filename,
      is_label_candidate: img.is_label_candidate,
      captured_at: img.captured_at,
    })
    imagesByBatch.set(img.batch_id, list)
  }

  const allImageIds = (imagesRes.data ?? []).map((i) => i.id)
  const ocrByImage = new Map<string, Array<{
    id: string
    image_id: string
    extracted_code: string | null
    confidence: number | null
    all_candidates: OcrCandidate[]
  }>>()
  if (allImageIds.length > 0) {
    const { data: ocrRows } = await db
      .from('ocr_results')
      .select('id, image_id, extracted_code, confidence, all_candidates')
      .in('image_id', allImageIds)
    for (const r of ocrRows ?? []) {
      const list = ocrByImage.get(r.image_id) ?? []
      list.push({
        id: r.id,
        image_id: r.image_id,
        extracted_code: r.extracted_code,
        confidence: r.confidence,
        all_candidates: (r.all_candidates as unknown as OcrCandidate[]) ?? [],
      })
      ocrByImage.set(r.image_id, list)
    }
  }

  // Sign every storage path in parallel — Supabase JS handles this concurrently.
  const allPaths = (imagesRes.data ?? []).map((i) => ({ id: i.id, path: i.storage_path }))
  const signedByImage = new Map<string, string | null>()
  await Promise.all(
    allPaths.map(async ({ id, path }) => {
      const { data } = await db.storage.from('images').createSignedUrl(path, SIGNED_TTL)
      signedByImage.set(id, data?.signedUrl ?? null)
    }),
  )

  const groups: GroupForReview[] = batchList.map((b) => {
    const imgs = imagesByBatch.get(b.id) ?? []
    return {
      batchId: b.id,
      sessionId: b.upload_session_id,
      autoGrouped: b.auto_grouped ?? false,
      finalCode: b.final_code,
      winningOcrResultId: b.winning_ocr_result_id,
      totalImages: b.total_images,
      images: imgs.map((img) => ({
        id: img.id,
        signed_url: signedByImage.get(img.id) ?? null,
        original_filename: img.original_filename,
        is_label_candidate: img.is_label_candidate ?? false,
      })),
      ocrResults: imgs.flatMap((img) => ocrByImage.get(img.id) ?? []),
    }
  })

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
