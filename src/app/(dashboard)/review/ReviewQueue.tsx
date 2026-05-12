'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import ReviewCard from '@/components/review/ReviewCard'
import type { OcrCandidate } from '@/types/ocr'
import { CheckCircle2, GitMerge, Loader2, X } from 'lucide-react'

export interface GroupForReview {
  batchId: string
  sessionId: string | null
  autoGrouped: boolean
  finalCode: string | null
  winningOcrResultId: string | null
  totalImages: number
  images: Array<{
    id: string
    signed_url: string | null
    original_filename: string | null
    is_label_candidate: boolean
  }>
  ocrResults: Array<{
    id: string
    image_id: string
    extracted_code: string | null
    confidence: number | null
    all_candidates: OcrCandidate[]
  }>
}

interface AutoListStep {
  step: string
  status: 'ok' | 'fail'
  detail: string
  timestamp: string
}

export interface ReviewResponse {
  success: boolean
  discarded?: boolean
  searchResult?: string
  searchDebug?: { itemCount?: number; bestMatchTitle?: string; bestMatchId?: string }
  listingResult?: {
    success: boolean
    listingUrl?: string
    error?: string
    steps?: AutoListStep[]
  }
  debugLog?: string[]
}

interface Props {
  initialGroups: GroupForReview[]
  sessionId?: string | null
}

export default function ReviewQueue({ initialGroups, sessionId }: Props) {
  const router = useRouter()
  const [groups, setGroups] = useState(initialGroups)
  const [selectedBatches, setSelectedBatches] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<null | 'merge' | string>(null)
  const [opError, setOpError] = useState<string | null>(null)

  const sessionMode = !!sessionId
  const selectedCount = selectedBatches.size

  const visibleGroups = useMemo(() => groups, [groups])

  function toggleBatchSelection(batchId: string) {
    setSelectedBatches((prev) => {
      const next = new Set(prev)
      if (next.has(batchId)) next.delete(batchId)
      else next.add(batchId)
      return next
    })
  }

  async function handleReview(
    batchId: string,
    action: 'approve' | 'override' | 'discard',
    override?: string,
  ): Promise<ReviewResponse> {
    const res = await fetch(`/api/batches/${batchId}/review`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, manual_override: override }),
    })
    return res.json()
  }

  async function handleMerge() {
    if (selectedBatches.size < 2) return
    setBusy('merge')
    setOpError(null)
    try {
      const res = await fetch('/api/batches/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_ids: [...selectedBatches] }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `Merge failed (${res.status})`)
      }
      setSelectedBatches(new Set())
      router.refresh()
    } catch (err) {
      setOpError(err instanceof Error ? err.message : String(err))
    }
    setBusy(null)
  }

  async function handleSplit(batchId: string, imageIds: string[]) {
    setBusy(batchId)
    setOpError(null)
    try {
      const res = await fetch(`/api/batches/${batchId}/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_ids: imageIds }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `Split failed (${res.status})`)
      }
      router.refresh()
    } catch (err) {
      setOpError(err instanceof Error ? err.message : String(err))
    }
    setBusy(null)
  }

  function handleCardComplete(batchId: string) {
    // After approve / discard, drop the card from the local view.
    setGroups((g) => g.filter((x) => x.batchId !== batchId))
    setSelectedBatches((prev) => {
      const next = new Set(prev)
      next.delete(batchId)
      return next
    })
  }

  if (visibleGroups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="w-20 h-20 bg-green-50 rounded-full flex items-center justify-center mb-6 shadow-sm border border-green-100">
          <CheckCircle2 className="w-10 h-10 text-green-500" strokeWidth={2.5} />
        </div>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">All caught up!</h2>
        <p className="text-gray-500 max-w-sm">
          {sessionMode
            ? 'Every group from this upload has been reviewed.'
            : 'There are no more items waiting for your review.'}
        </p>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto pb-12">
      {sessionMode && (
        <div className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b border-gray-200 -mx-4 px-4 py-3 mb-6 flex items-center gap-3">
          <span className="text-sm text-gray-600">
            {selectedCount > 0 ? `${selectedCount} group${selectedCount === 1 ? '' : 's'} selected` : 'Tap a group to select for merging'}
          </span>
          <div className="ml-auto flex gap-2">
            {selectedCount > 0 && (
              <button
                onClick={() => setSelectedBatches(new Set())}
                className="px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-100 rounded-lg flex items-center gap-1.5"
              >
                <X className="w-3.5 h-3.5" /> Clear
              </button>
            )}
            <button
              onClick={handleMerge}
              disabled={selectedCount < 2 || busy === 'merge'}
              className="px-4 py-1.5 text-xs font-bold rounded-lg flex items-center gap-1.5 transition-all bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 shadow-sm"
            >
              {busy === 'merge' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitMerge className="w-3.5 h-3.5" />}
              Merge selected
            </button>
          </div>
        </div>
      )}

      {opError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {opError}
        </div>
      )}

      <div className="space-y-8">
        {visibleGroups.map((g) => (
          <div
            key={g.batchId}
            className={`relative ${
              sessionMode && selectedBatches.has(g.batchId)
                ? 'ring-2 ring-blue-500 ring-offset-2 rounded-2xl'
                : ''
            }`}
          >
            {sessionMode && (
              <button
                onClick={() => toggleBatchSelection(g.batchId)}
                className={`absolute -top-2 -left-2 z-20 w-7 h-7 rounded-full border-2 shadow-sm transition-all flex items-center justify-center ${
                  selectedBatches.has(g.batchId)
                    ? 'bg-blue-600 border-blue-600 text-white'
                    : 'bg-white border-gray-300 hover:border-blue-400'
                }`}
                title="Select for merge"
              >
                {selectedBatches.has(g.batchId) && <CheckCircle2 className="w-4 h-4" strokeWidth={3} />}
              </button>
            )}
            <ReviewCard
              group={g}
              onSubmit={async (batchId, action, override) => {
                const r = await handleReview(batchId, action, override)
                if (r.success || r.discarded) {
                  handleCardComplete(batchId)
                  // Invalidate the App Router client cache so /listings,
                  // /batches and /dashboard show the new row on next nav.
                  router.refresh()
                }
                return r
              }}
              onSplit={sessionMode ? (imageIds) => handleSplit(g.batchId, imageIds) : undefined}
              splitBusy={busy === g.batchId}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
