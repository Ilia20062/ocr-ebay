'use client'

import { useState } from 'react'
import ReviewCard from '@/components/review/ReviewCard'
import type { OcrResult } from '@/types/database'

interface Props {
  initialResults: (OcrResult & { signed_url?: string | null })[]
}

export default function ReviewQueue({ initialResults }: Props) {
  const [results, setResults] = useState(initialResults)

  async function handleReview(id: string, action: 'approve' | 'override' | 'discard', override?: string) {
    await fetch(`/api/ocr-results/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, manual_override: override }),
    })
    // Card marks itself done; no state removal needed until refresh
  }

  if (results.length === 0) {
    return (
      <div className="text-center py-16 text-gray-400">
        <p className="text-4xl mb-3">✓</p>
        <p className="font-medium text-gray-600">All caught up!</p>
        <p className="text-sm mt-1">No images need review right now.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4 max-w-3xl">
      {results.map((r) => (
        <ReviewCard
          key={r.id}
          result={r as OcrResult & { signed_url?: string }}
          onSubmit={handleReview}
        />
      ))}
    </div>
  )
}
