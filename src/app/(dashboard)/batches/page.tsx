import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { getSupabaseServerClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const statusColors: Record<string, string> = {
  uploaded: 'bg-gray-100 text-gray-600',
  ocr_processing: 'bg-blue-100 text-blue-600',
  ocr_done: 'bg-blue-100 text-blue-600',
  needs_review: 'bg-yellow-100 text-yellow-700',
  approved: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  discarded: 'bg-gray-100 text-gray-400',
}

const batchStatusColors: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-600',
  processing: 'bg-blue-100 text-blue-600',
  awaiting_review: 'bg-yellow-100 text-yellow-700',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
}

export default async function BatchesPage() {
  const supabase = await getSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  const db = getSupabaseAdminClient()

  const { data: batches } = await db
    .from('upload_batches')
    .select('*')
    .eq('user_id', user!.id)
    .order('created_at', { ascending: false })
    .limit(20)

  const batchIds = (batches ?? []).map((b) => b.id)

  type ImageRow = {
    id: string
    batch_id: string
    original_filename: string | null
    status: string
    error_message: string | null
    created_at: string
    ocr_results: { extracted_code: string | null; confidence: number | null; auto_approved: boolean }[] | null
  }

  let images: ImageRow[] = []
  if (batchIds.length > 0) {
    const { data } = await db
      .from('images')
      .select('id, batch_id, original_filename, status, error_message, created_at, ocr_results(extracted_code, confidence, auto_approved)')
      .in('batch_id', batchIds)
      .order('created_at', { ascending: true })
    images = (data ?? []) as unknown as ImageRow[]
  }

  const imagesByBatch = new Map<string, ImageRow[]>()
  for (const img of images) {
    const list = imagesByBatch.get(img.batch_id) ?? []
    list.push(img)
    imagesByBatch.set(img.batch_id, list)
  }

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-6">Upload History</h2>

      {!batches || batches.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-4xl mb-3">📂</p>
          <p className="font-medium text-gray-600">No uploads yet</p>
        </div>
      ) : (
        <div className="space-y-4">
          {batches.map((batch) => {
            const imgs = imagesByBatch.get(batch.id) ?? []
            return (
              <div key={batch.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                  <div>
                    <p className="text-sm font-medium text-gray-900">
                      Batch · {new Date(batch.created_at).toLocaleString()}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {batch.processed} / {batch.total_images} processed
                    </p>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${batchStatusColors[batch.status] ?? 'bg-gray-100 text-gray-600'}`}>
                    {batch.status}
                  </span>
                </div>

                {imgs.length === 0 ? (
                  <p className="px-5 py-4 text-sm text-gray-400">No images found</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                      <tr>
                        <th className="px-5 py-2 text-left font-medium">Filename</th>
                        <th className="px-5 py-2 text-left font-medium">Status</th>
                        <th className="px-5 py-2 text-left font-medium">Extracted Code</th>
                        <th className="px-5 py-2 text-left font-medium">Confidence</th>
                        <th className="px-5 py-2 text-left font-medium">Auto-approved</th>
                        <th className="px-5 py-2 text-left font-medium">Error</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {imgs.map((img) => {
                        const ocr = Array.isArray(img.ocr_results) ? img.ocr_results[0] : img.ocr_results
                        const errorMsg = img.error_message
                        return (
                          <tr key={img.id} className="hover:bg-gray-50">
                            <td className="px-5 py-3 text-gray-800 font-mono text-xs">{img.original_filename ?? '—'}</td>
                            <td className="px-5 py-3">
                              <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColors[img.status] ?? 'bg-gray-100 text-gray-600'}`}>
                                {img.status}
                              </span>
                            </td>
                            <td className="px-5 py-3 font-mono text-xs text-gray-700">{ocr?.extracted_code ?? '—'}</td>
                            <td className="px-5 py-3 text-gray-500 text-xs">
                              {ocr?.confidence != null ? `${(Number(ocr.confidence) * 100).toFixed(0)}%` : '—'}
                            </td>
                            <td className="px-5 py-3 text-xs">
                              {ocr == null ? '—' : ocr.auto_approved ? '✓' : '✗'}
                            </td>
                            <td className="px-5 py-3 text-xs text-red-600 max-w-xs truncate" title={errorMsg ?? undefined}>
                              {errorMsg ?? '—'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
