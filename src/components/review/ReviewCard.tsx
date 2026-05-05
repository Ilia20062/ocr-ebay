'use client'

import { useMemo, useState } from 'react'
import Image from 'next/image'
import type { GroupForReview, ReviewResponse } from '@/app/(dashboard)/review/ReviewQueue'

interface Props {
  group: GroupForReview
  onSubmit: (
    batchId: string,
    action: 'approve' | 'override' | 'discard',
    override?: string,
  ) => Promise<ReviewResponse>
}

export default function ReviewCard({ group, onSubmit }: Props) {
  const noCode = !group.finalCode
  const [action, setAction] = useState<'approve' | 'override' | 'discard'>(noCode ? 'override' : 'approve')
  const [manualCode, setManualCode] = useState(group.finalCode ?? '')
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState<ReviewResponse | null>(null)
  const [showDebug, setShowDebug] = useState(false)

  const winningOcr = useMemo(
    () => group.ocrResults.find((r) => r.id === group.winningOcrResultId) ?? null,
    [group.ocrResults, group.winningOcrResultId],
  )
  const winningImageId = winningOcr?.image_id ?? null
  const confidence = winningOcr?.confidence ? Math.round(winningOcr.confidence * 100) : 0

  const alternatives = useMemo(() => {
    const map = new Map<string, { code: string; confidence: number; imageId: string }>()
    for (const r of group.ocrResults) {
      for (const c of r.all_candidates ?? []) {
        if (!c?.text || c.text === '__DUPLICATE__') continue
        if (c.text === group.finalCode) continue
        const existing = map.get(c.text)
        if (!existing || c.confidence > existing.confidence) {
          map.set(c.text, { code: c.text, confidence: c.confidence ?? 0, imageId: r.image_id })
        }
      }
    }
    return [...map.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 6)
  }, [group.ocrResults, group.finalCode])

  async function handleSubmit() {
    setLoading(true)
    try {
      const res = await onSubmit(group.batchId, action, action === 'override' ? manualCode : undefined)
      setResponse(res)
    } catch (err) {
      setResponse({
        success: false,
        debugLog: [`Client error: ${err instanceof Error ? err.message : String(err)}`],
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

    let bgColor = 'bg-green-50 border-green-200'
    let textColor = 'text-green-700'
    let icon = '✅'
    let message = 'Group reviewed successfully'

    if (isDiscarded) {
      bgColor = 'bg-yellow-50 border-yellow-200'; textColor = 'text-yellow-700'; icon = '⚠️'; message = 'Group discarded'
    } else if (isListed) {
      message = `Listed on eBay with ${group.totalImages} photo${group.totalImages !== 1 ? 's' : ''}!`
    } else if (listingFailed) {
      bgColor = 'bg-red-50 border-red-200'; textColor = 'text-red-700'; icon = '❌'
      message = `Listing failed: ${response.listingResult!.error}`
    } else if (noMatch) {
      bgColor = 'bg-red-50 border-red-200'; textColor = 'text-red-700'; icon = '❌'
      message = 'No matching product found on eBay for this code'
    } else if (searchError) {
      bgColor = 'bg-red-50 border-red-200'; textColor = 'text-red-700'; icon = '❌'
      message = 'Search/listing error — see debug log'
    }

    return (
      <div className={`rounded-xl border ${bgColor} overflow-hidden`}>
        <div className="p-5">
          <p className={`font-semibold text-base ${textColor}`}>{icon} {message}</p>
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
          {response.searchDebug && (
            <div className="mt-3 text-xs text-gray-600 space-y-1">
              <p>🔍 eBay returned <strong>{response.searchDebug.itemCount ?? 0}</strong> items</p>
              {response.searchDebug.bestMatchTitle && (
                <p>🏷️ Best match: &quot;{response.searchDebug.bestMatchTitle}&quot;</p>
              )}
            </div>
          )}
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
      <div className="p-4 border-b border-gray-100 flex items-center justify-between">
        <p className="text-sm font-semibold text-gray-700">
          Group · {group.images.length} photo{group.images.length !== 1 ? 's' : ''}
        </p>
        {noCode ? (
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">No code detected</span>
        ) : (
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${confidence >= 90 ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
            {confidence}% confidence
          </span>
        )}
      </div>

      <div className="p-4 bg-gray-50 border-b border-gray-100">
        <div className="flex gap-2 overflow-x-auto">
          {group.images.map((img) => {
            const isSource = img.id === winningImageId
            return (
              <div key={img.id} className="relative shrink-0">
                {img.signed_url ? (
                  <Image
                    src={img.signed_url}
                    alt={img.original_filename ?? 'photo'}
                    width={120}
                    height={120}
                    className={`h-28 w-28 object-cover rounded-lg ${isSource ? 'ring-4 ring-blue-500' : 'ring-1 ring-gray-200'}`}
                    unoptimized
                  />
                ) : (
                  <div className="h-28 w-28 bg-gray-200 rounded-lg flex items-center justify-center text-xs text-gray-400">no preview</div>
                )}
                {isSource && (
                  <span className="absolute bottom-1 left-1 bg-blue-600 text-white text-[10px] px-1.5 py-0.5 rounded">
                    📄 source
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="p-5 space-y-3">
        <div>
          <p className="text-xs text-gray-500 mb-0.5">Detected code</p>
          <p className="font-mono text-sm font-semibold text-gray-900 bg-gray-50 px-2 py-1 rounded">
            {group.finalCode ?? <span className="text-gray-400 italic">No code found — please override</span>}
          </p>
        </div>

        {alternatives.length > 0 && (
          <details className="text-xs text-gray-600">
            <summary className="cursor-pointer font-medium">{alternatives.length} other candidate{alternatives.length !== 1 ? 's' : ''}</summary>
            <ul className="mt-2 space-y-1 pl-2">
              {alternatives.map((a) => (
                <li key={a.code} className="font-mono">
                  <span className="text-gray-900">{a.code}</span>{' '}
                  <span className="text-gray-400">— {Math.round(a.confidence * 100)}%</span>
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="space-y-2 pt-1">
          <div className="flex gap-2">
            {(['approve', 'override', 'discard'] as const).map((a) => {
              const disabled = a === 'approve' && noCode
              return (
                <button
                  key={a}
                  onClick={() => !disabled && setAction(a)}
                  disabled={disabled}
                  className={`px-3 py-1 text-xs rounded-lg font-medium transition-colors ${
                    action === a
                      ? a === 'discard' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed'
                  }`}
                >
                  {a === 'approve' ? 'Accept' : a === 'override' ? 'Correct' : 'Discard'}
                </button>
              )
            })}
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
            {loading ? 'Processing… (searching eBay & listing)' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}
