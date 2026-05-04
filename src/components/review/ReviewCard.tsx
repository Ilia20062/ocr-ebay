'use client'

import { useState } from 'react'
import Image from 'next/image'
import type { OcrResult } from '@/types/database'

interface AutoListStep {
  step: string
  status: 'ok' | 'fail'
  detail: string
  timestamp: string
}

interface ReviewResponse {
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
  result: OcrResult & { signed_url?: string; final_code?: string | null }
  onSubmit: (id: string, action: 'approve' | 'override' | 'discard', override?: string) => Promise<ReviewResponse>
}

export default function ReviewCard({ result, onSubmit }: Props) {
  const [action, setAction] = useState<'approve' | 'override' | 'discard'>('approve')
  const [manualCode, setManualCode] = useState(result.extracted_code ?? '')
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState<ReviewResponse | null>(null)
  const [showDebug, setShowDebug] = useState(false)

  const confidence = result.confidence ? Math.round(result.confidence * 100) : 0
  const isDuplicate = (result.all_candidates as { text: string }[] | null)?.some(
    (c) => c.text === '__DUPLICATE__'
  )

  async function handleSubmit() {
    setLoading(true)
    try {
      const res = await onSubmit(result.id, action, action === 'override' ? manualCode : undefined)
      setResponse(res)
    } catch (err) {
      setResponse({
        success: false,
        debugLog: [`Client-side error: ${err instanceof Error ? err.message : String(err)}`],
      })
    }
    setLoading(false)
  }

  if (response) {
    const isDiscarded = response.discarded
    const isListed = response.listingResult?.success
    const listingFailed = response.listingResult && !response.listingResult.success
    const noMatch = response.searchResult === 'not_found'
    const searchError = response.searchResult === 'search_error'
    const noCode = response.searchResult === 'no_code'

    // Determine overall status
    let bgColor = 'bg-green-50 border-green-200'
    let textColor = 'text-green-700'
    let icon = '✅'
    let message = 'Reviewed successfully'

    if (isDiscarded) {
      bgColor = 'bg-yellow-50 border-yellow-200'
      textColor = 'text-yellow-700'
      icon = '⚠️'
      message = 'Image discarded'
    } else if (isListed) {
      message = 'Listed on eBay!'
    } else if (listingFailed) {
      bgColor = 'bg-red-50 border-red-200'
      textColor = 'text-red-700'
      icon = '❌'
      message = `Listing failed: ${response.listingResult!.error}`
    } else if (noMatch) {
      bgColor = 'bg-red-50 border-red-200'
      textColor = 'text-red-700'
      icon = '❌'
      message = `No matching product found on eBay for this code`
    } else if (searchError) {
      bgColor = 'bg-red-50 border-red-200'
      textColor = 'text-red-700'
      icon = '❌'
      message = 'Search/listing error — see debug log'
    } else if (noCode) {
      bgColor = 'bg-yellow-50 border-yellow-200'
      textColor = 'text-yellow-700'
      icon = '⚠️'
      message = 'No code extracted — no listing created'
    }

    return (
      <div className={`rounded-xl border ${bgColor} overflow-hidden`}>
        {/* Status header */}
        <div className="p-5">
          <p className={`font-semibold text-base ${textColor}`}>{icon} {message}</p>

          {/* eBay link */}
          {response.listingResult?.listingUrl && (
            <a
              href={response.listingResult.listingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block text-sm text-blue-600 hover:underline font-medium"
            >
              View on eBay ↗
            </a>
          )}

          {/* Search stats */}
          {response.searchDebug && (
            <div className="mt-3 text-xs text-gray-600 space-y-1">
              <p>🔍 eBay search returned <strong>{response.searchDebug.itemCount ?? 0}</strong> items</p>
              {response.searchDebug.bestMatchTitle && (
                <p>🏷️ Best match: &quot;{response.searchDebug.bestMatchTitle}&quot;</p>
              )}
            </div>
          )}

          {/* Auto-list step-by-step */}
          {response.listingResult?.steps && response.listingResult.steps.length > 0 && (
            <div className="mt-3 space-y-1">
              <p className="text-xs font-semibold text-gray-700 mb-1">Listing Pipeline:</p>
              {response.listingResult.steps.map((step, i) => (
                <div key={i} className={`text-xs px-2 py-1 rounded ${step.status === 'ok' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                  <span className="font-medium">{step.status === 'ok' ? '✓' : '✗'} {step.step}:</span>{' '}
                  <span className="break-all">{step.detail}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Debug log toggle */}
        {response.debugLog && response.debugLog.length > 0 && (
          <div className="border-t border-gray-200">
            <button
              onClick={() => setShowDebug(!showDebug)}
              className="w-full px-5 py-2 text-left text-xs font-medium text-gray-500 hover:bg-gray-50 transition-colors"
            >
              {showDebug ? '▼' : '▶'} Debug Log ({response.debugLog.length} entries)
            </button>
            {showDebug && (
              <div className="px-5 pb-4 max-h-64 overflow-y-auto">
                <pre className="text-[10px] leading-4 text-gray-600 font-mono whitespace-pre-wrap break-all bg-white rounded p-2 border border-gray-200">
                  {response.debugLog.join('\n')}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="grid grid-cols-2">
        {/* Image */}
        <div className="bg-gray-50 border-r border-gray-200 flex items-center justify-center p-4 min-h-48">
          {result.signed_url ? (
            <Image src={result.signed_url} alt="Upload" width={200} height={192} className="max-h-48 object-contain rounded" unoptimized />
          ) : (
            <span className="text-gray-400 text-sm">No preview</span>
          )}
        </div>

        {/* OCR data */}
        <div className="p-5 space-y-3">
          <div className="flex items-center gap-2">
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${confidence >= 90 ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
              {confidence}% confidence
            </span>
            {isDuplicate && (
              <span className="px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-700">
                Duplicate detected
              </span>
            )}
          </div>

          <div>
            <p className="text-xs text-gray-500 mb-0.5">Extracted code</p>
            <p className="font-mono text-sm font-semibold text-gray-900 bg-gray-50 px-2 py-1 rounded">
              {result.extracted_code ?? <span className="text-gray-400 italic">No code found</span>}
            </p>
          </div>

          {result.extracted_text && (
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Full text</p>
              <p className="text-xs text-gray-600 bg-gray-50 px-2 py-1 rounded max-h-16 overflow-y-auto">
                {result.extracted_text}
              </p>
            </div>
          )}

          {/* Action */}
          <div className="space-y-2 pt-1">
            <div className="flex gap-2">
              {(['approve', 'override', 'discard'] as const).map((a) => (
                <button
                  key={a}
                  onClick={() => setAction(a)}
                  className={`px-3 py-1 text-xs rounded-lg font-medium transition-colors ${
                    action === a
                      ? a === 'discard' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {a === 'approve' ? 'Accept' : a === 'override' ? 'Correct' : 'Discard'}
                </button>
              ))}
            </div>

            {action === 'override' && (
              <input
                type="text"
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value.toUpperCase())}
                placeholder="Enter correct code"
                className="w-full px-2 py-1.5 border border-gray-300 rounded font-mono text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            )}

            <button
              onClick={handleSubmit}
              disabled={loading || (action === 'override' && !manualCode)}
              className="w-full py-1.5 bg-blue-600 text-white text-sm rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Processing... (searching eBay & listing)' : 'Confirm'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
