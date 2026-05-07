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
  const [manualCode, setManualCode] = useState(group.finalCode ?? '')
  const [loading, setLoading] = useState(false)
  const [loadingAction, setLoadingAction] = useState<'list' | 'discard' | null>(null)
  const [response, setResponse] = useState<ReviewResponse | null>(null)
  const [showDebug, setShowDebug] = useState(false)

  const winningOcr = useMemo(
    () => group.ocrResults.find((r) => r.id === group.winningOcrResultId) ?? null,
    [group.ocrResults, group.winningOcrResultId],
  )
  
  const winningImageId = winningOcr?.image_id ?? group.images[0]?.id ?? null
  const [activeImageId, setActiveImageId] = useState<string | null>(winningImageId)

  const confidence = winningOcr?.confidence ? Math.round(winningOcr.confidence * 100) : 0

  const activeImage = useMemo(
    () => group.images.find(img => img.id === activeImageId) ?? group.images[0],
    [group.images, activeImageId]
  )

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
    return [...map.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 5)
  }, [group.ocrResults, group.finalCode])

  async function handleAction(type: 'list' | 'discard') {
    setLoading(true)
    setLoadingAction(type)
    try {
      if (type === 'discard') {
        const res = await onSubmit(group.batchId, 'discard')
        setResponse(res)
      } else {
        const isOverride = manualCode !== group.finalCode || noCode
        const res = await onSubmit(
          group.batchId, 
          isOverride ? 'override' : 'approve', 
          isOverride ? manualCode : undefined
        )
        setResponse(res)
      }
    } catch (err) {
      setResponse({
        success: false,
        debugLog: [`Client error: ${err instanceof Error ? err.message : String(err)}`],
      })
    }
    setLoading(false)
    setLoadingAction(null)
  }

  if (response) {
    const isDiscarded = response.discarded
    const isListed = response.listingResult?.success
    const listingFailed = response.listingResult && !response.listingResult.success
    const noMatch = response.searchResult === 'not_found'
    const searchError = response.searchResult === 'search_error'

    let bgColor = 'bg-emerald-50 border-emerald-200'
    let textColor = 'text-emerald-800'
    let icon = (
      <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600 mb-3">
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
      </div>
    )
    let title = 'Review Successful'
    let message = 'Group reviewed successfully'

    if (isDiscarded) {
      bgColor = 'bg-amber-50 border-amber-200'; textColor = 'text-amber-800'; 
      icon = (
        <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center text-amber-600 mb-3">
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
        </div>
      )
      title = 'Item Discarded'
      message = 'This group was discarded and removed from the queue.'
    } else if (isListed) {
      title = 'Successfully Listed!'
      message = `Listed on eBay with ${group.totalImages} photo${group.totalImages !== 1 ? 's' : ''}.`
    } else if (listingFailed) {
      bgColor = 'bg-red-50 border-red-200'; textColor = 'text-red-800'; 
      icon = (
         <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center text-red-600 mb-3">
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        </div>
      )
      title = 'Listing Failed'
      message = response.listingResult!.error ?? 'Unknown error'
    } else if (noMatch) {
      bgColor = 'bg-amber-50 border-amber-200'; textColor = 'text-amber-800'; 
      icon = (
         <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center text-amber-600 mb-3">
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
        </div>
      )
      title = 'No Product Found'
      message = 'No matching product found on eBay for this code.'
    } else if (searchError) {
      bgColor = 'bg-red-50 border-red-200'; textColor = 'text-red-800'; 
      icon = (
         <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center text-red-600 mb-3">
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
        </div>
      )
      title = 'Search Error'
      message = 'There was an error searching eBay. See debug log.'
    }

    return (
      <div className={`rounded-2xl border ${bgColor} overflow-hidden transition-all duration-500 ease-in-out`}>
        <div className="p-8 flex flex-col items-center text-center">
          {icon}
          <h3 className={`font-bold text-lg mb-1 ${textColor}`}>{title}</h3>
          <p className={`text-sm opacity-90 ${textColor}`}>{message}</p>
          
          {response.listingResult?.listingUrl && (
            <a
              href={response.listingResult.listingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 px-6 py-2.5 bg-white text-blue-600 border border-blue-200 rounded-full text-sm font-semibold hover:bg-blue-50 transition-colors shadow-sm flex items-center gap-2"
            >
              View Listing on eBay
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
            </a>
          )}
          
          {response.searchDebug && (
            <div className={`mt-6 text-sm text-left w-full max-w-md p-4 rounded-xl bg-white/50 border border-white/20 shadow-sm ${textColor}`}>
              <div className="flex items-center gap-2 mb-2 font-medium opacity-80">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                eBay Search Results
              </div>
              <p className="mb-1">Returned <strong>{response.searchDebug.itemCount ?? 0}</strong> items</p>
              {response.searchDebug.bestMatchTitle && (
                <p className="truncate" title={response.searchDebug.bestMatchTitle}>
                  Best match: &quot;{response.searchDebug.bestMatchTitle}&quot;
                </p>
              )}
            </div>
          )}

          {response.listingResult?.steps && response.listingResult.steps.length > 0 && (
            <div className="mt-4 w-full max-w-md text-left space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wider opacity-70 mb-2">Listing Pipeline</p>
              {response.listingResult.steps.map((step, i) => (
                <div key={i} className={`text-xs px-3 py-2 rounded-lg flex items-start gap-2 ${step.status === 'ok' ? 'bg-white/60' : 'bg-red-100/50'}`}>
                  <span className={`mt-0.5 ${step.status === 'ok' ? 'text-emerald-500' : 'text-red-500'}`}>
                    {step.status === 'ok' ? (
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                    ) : (
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    )}
                  </span>
                  <div>
                    <span className="font-semibold">{step.step}</span>
                    <p className="opacity-80 mt-0.5 break-all">{step.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {response.debugLog && response.debugLog.length > 0 && (
          <div className="border-t border-black/5">
            <button
              onClick={() => setShowDebug(!showDebug)}
              className="w-full px-6 py-3 text-center text-xs font-medium opacity-60 hover:opacity-100 transition-opacity flex items-center justify-center gap-2"
            >
              {showDebug ? 'Hide' : 'Show'} Debug Log
              <svg className={`w-3 h-3 transition-transform ${showDebug ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
            {showDebug && (
              <div className="px-6 pb-6">
                <pre className="text-[10px] leading-relaxed font-mono whitespace-pre-wrap break-all bg-black/5 rounded-xl p-4 max-h-64 overflow-y-auto">
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
    <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden transition-all hover:shadow-md">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
        <div className="flex items-center gap-3">
          <h3 className="text-base font-semibold text-gray-900">Review Item</h3>
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600 border border-gray-200">
            {group.images.length} Photo{group.images.length !== 1 ? 's' : ''}
          </span>
        </div>
        {noCode ? (
          <span className="px-3 py-1 rounded-full text-xs font-medium bg-red-50 text-red-700 border border-red-100 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500"></span> No Code Detected
          </span>
        ) : (
          <span className={`px-3 py-1 rounded-full text-xs font-medium flex items-center gap-1.5 ${
            confidence >= 90 ? 'bg-green-50 text-green-700 border border-green-100' : 'bg-amber-50 text-amber-700 border border-amber-100'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${confidence >= 90 ? 'bg-green-500' : 'bg-amber-500'}`}></span>
            {confidence}% Confidence
          </span>
        )}
      </div>

      <div className="flex flex-col md:flex-row">
        {/* Left: Images Area */}
        <div className="md:w-1/2 p-6 border-b md:border-b-0 md:border-r border-gray-100 bg-gray-50/30">
           {/* Active Image */}
           <div className="relative aspect-square w-full mb-4 rounded-xl overflow-hidden bg-white border border-gray-200 shadow-inner">
             {activeImage?.signed_url ? (
               <Image
                 src={activeImage.signed_url}
                 alt={activeImage.original_filename ?? 'Product photo'}
                 fill
                 className="object-contain"
                 unoptimized
               />
             ) : (
               <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400">
                 No preview available
               </div>
             )}
           </div>

           {/* Thumbnails */}
           {group.images.length > 1 && (
             <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-gray-300 scrollbar-track-transparent">
               {group.images.map(img => (
                 <button
                   key={img.id}
                   onClick={() => setActiveImageId(img.id)}
                   className={`relative h-16 w-16 shrink-0 rounded-lg overflow-hidden border-2 transition-all ${
                     activeImageId === img.id ? 'border-blue-500 shadow-sm' : 'border-transparent hover:border-gray-300 opacity-70 hover:opacity-100'
                   }`}
                 >
                   {img.signed_url ? (
                     <Image
                       src={img.signed_url}
                       alt="thumbnail"
                       fill
                       className="object-cover"
                       unoptimized
                     />
                   ) : (
                     <div className="absolute inset-0 bg-gray-200" />
                   )}
                   {img.id === winningImageId && (
                     <div className="absolute bottom-0 right-0 bg-blue-500 p-0.5 rounded-tl">
                       <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                         <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                       </svg>
                     </div>
                   )}
                 </button>
               ))}
             </div>
           )}
        </div>

        {/* Right: Form Area */}
        <div className="md:w-1/2 p-6 flex flex-col justify-between bg-white">
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">
                Product Code
              </label>
              <input
                type="text"
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value.toUpperCase())}
                placeholder="Enter product code..."
                className="w-full px-4 py-3 text-lg font-mono tracking-wider border border-gray-300 rounded-xl bg-gray-50 focus:bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
              />
              <p className="mt-2 text-xs text-gray-500">
                Verify the detected code or manually override it before listing.
              </p>
            </div>

            {alternatives.length > 0 && (
              <div>
                <p className="text-xs font-medium text-gray-500 mb-2 uppercase tracking-wider">Alternative Suggestions</p>
                <div className="flex flex-wrap gap-2">
                  {alternatives.map(a => (
                    <button
                      key={a.code}
                      onClick={() => setManualCode(a.code)}
                      className="px-3 py-1.5 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-lg text-sm font-mono text-gray-700 transition-colors flex items-center gap-2 group"
                    >
                      {a.code}
                      <span className="text-[10px] text-gray-400 group-hover:text-gray-500">{Math.round(a.confidence * 100)}%</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="mt-8 space-y-3">
            <button
              onClick={() => handleAction('list')}
              disabled={loading || !manualCode.trim()}
              className="w-full py-3 px-4 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-xl font-semibold shadow-sm hover:from-blue-700 hover:to-indigo-700 disabled:from-gray-300 disabled:to-gray-400 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
            >
              {loading && loadingAction === 'list' ? (
                <>
                  <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Processing Listing...
                </>
              ) : (
                'Confirm & List to eBay'
              )}
            </button>
            
            <button
              onClick={() => handleAction('discard')}
              disabled={loading}
              className="w-full py-2.5 px-4 bg-white text-red-600 border border-red-200 rounded-xl font-medium hover:bg-red-50 disabled:opacity-50 transition-colors"
            >
               {loading && loadingAction === 'discard' ? 'Discarding...' : 'Discard Item'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

