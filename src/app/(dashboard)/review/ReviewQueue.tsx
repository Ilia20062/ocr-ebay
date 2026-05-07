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
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="w-20 h-20 bg-green-50 rounded-full flex items-center justify-center mb-6 shadow-sm border border-green-100">
          <svg className="w-10 h-10 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">All caught up!</h2>
        <p className="text-gray-500 max-w-sm">There are no more items waiting for your review. Great job keeping the queue clear.</p>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto space-y-8 pb-12">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Review Queue</h1>
        <p className="text-gray-500 mt-1">Review detected product codes and list them to eBay.</p>
      </div>
      
      {groups.map((g) => (
        <ReviewCard key={g.batchId} group={g} onSubmit={handleReview} />
      ))}
    </div>
  )
}
