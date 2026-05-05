'use client'

import { useState } from 'react'
import ReviewCard from '@/components/review/ReviewCard'
import type { OcrCandidate } from '@/types/ocr'

export interface GroupForReview {
  batchId: string
  finalCode: string | null
  winningOcrResultId: string | null
  totalImages: number
  images: Array<{ id: string; signed_url: string | null; original_filename: string | null }>
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
}

export default function ReviewQueue({ initialGroups }: Props) {
  const [groups] = useState(initialGroups)

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

  if (groups.length === 0) {
    return (
      <div className="text-center py-16 text-gray-400">
        <p className="text-4xl mb-3">✓</p>
        <p className="font-medium text-gray-600">All caught up!</p>
        <p className="text-sm mt-1">No groups need review right now.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4 max-w-4xl">
      {groups.map((g) => (
        <ReviewCard key={g.batchId} group={g} onSubmit={handleReview} />
      ))}
    </div>
  )
}
