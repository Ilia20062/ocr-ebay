'use client'

import { useState } from 'react'
import type { OcrResult } from '@/types/database'

interface Props {
  result: OcrResult & { signed_url?: string; final_code?: string | null }
  onSubmit: (id: string, action: 'approve' | 'override' | 'discard', override?: string) => Promise<void>
}

export default function ReviewCard({ result, onSubmit }: Props) {
  const [action, setAction] = useState<'approve' | 'override' | 'discard'>('approve')
  const [manualCode, setManualCode] = useState(result.extracted_code ?? '')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  const confidence = result.confidence ? Math.round(result.confidence * 100) : 0
  const isDuplicate = (result.all_candidates as { text: string }[] | null)?.some(
    (c) => c.text === '__DUPLICATE__'
  )

  async function handleSubmit() {
    setLoading(true)
    await onSubmit(result.id, action, action === 'override' ? manualCode : undefined)
    setDone(true)
    setLoading(false)
  }

  if (done) {
    return (
      <div className="bg-white rounded-xl border border-green-200 p-5 opacity-60">
        <p className="text-sm text-green-700 font-medium">Reviewed ✓</p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="grid grid-cols-2">
        {/* Image */}
        <div className="bg-gray-50 border-r border-gray-200 flex items-center justify-center p-4 min-h-48">
          {result.signed_url ? (
            <img src={result.signed_url} alt="Upload" className="max-h-48 object-contain rounded" />
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
              {loading ? 'Saving...' : 'Confirm'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
