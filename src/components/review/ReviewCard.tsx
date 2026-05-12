'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import type { GroupForReview, ReviewResponse } from '@/app/(dashboard)/review/ReviewQueue'
import {
  Check, Trash2, X, Search, AlertTriangle,
  ExternalLink, ChevronDown, Loader2, Image as ImageIcon,
  Upload, Sparkles, ShieldCheck, ShieldAlert, AlertCircle, ShoppingCart, Scissors,
  RotateCw
} from 'lucide-react'

interface Props {
  group: GroupForReview
  onSubmit: (
    batchId: string,
    action: 'approve' | 'override' | 'discard',
    override?: string,
  ) => Promise<ReviewResponse>
  onSplit?: (imageIds: string[]) => Promise<void> | void
  splitBusy?: boolean
}

export default function ReviewCard({ group, onSubmit, onSplit, splitBusy }: Props) {
  const router = useRouter()
  const noCode = !group.finalCode
  const [manualCode, setManualCode] = useState(group.finalCode ?? '')
  const [loading, setLoading] = useState(false)
  const [loadingAction, setLoadingAction] = useState<'list' | 'discard' | null>(null)
  const [response, setResponse] = useState<ReviewResponse | null>(null)
  const [showDebug, setShowDebug] = useState(false)
  const [splitMode, setSplitMode] = useState(false)
  const [splitSelection, setSplitSelection] = useState<Set<string>>(new Set())
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
  const [retryDiagnostic, setRetryDiagnostic] = useState<string | null>(null)
  const [retryTextSample, setRetryTextSample] = useState<string | null>(null)

  const winningOcr = useMemo(
    () => group.ocrResults.find((r) => r.id === group.winningOcrResultId) ?? null,
    [group.ocrResults, group.winningOcrResultId],
  )

  // Prefer the OCR-winning image; fall back to is_label_candidate hint; else first image.
  const winningImageId =
    winningOcr?.image_id ??
    group.images.find((i) => i.is_label_candidate)?.id ??
    group.images[0]?.id ??
    null
  const [activeImageId, setActiveImageId] = useState<string | null>(winningImageId)

  function toggleSplitSelection(imageId: string) {
    setSplitSelection((prev) => {
      const next = new Set(prev)
      if (next.has(imageId)) next.delete(imageId)
      else next.add(imageId)
      return next
    })
  }

  async function handleSplitConfirm() {
    if (!onSplit) return
    if (splitSelection.size === 0 || splitSelection.size === group.images.length) return
    await onSplit([...splitSelection])
    setSplitMode(false)
    setSplitSelection(new Set())
  }

  async function handleRetryOcr() {
    setRetrying(true)
    setRetryError(null)
    setRetryDiagnostic(null)
    setRetryTextSample(null)
    try {
      const res = await fetch(`/api/batches/${group.batchId}/retry-ocr`, { method: 'POST' })
      const body = (await res.json().catch(() => ({}))) as {
        error?: string
        final_code?: string | null
        diagnostic?: string | null
        text_sample?: string | null
        images_processed?: number
        images_total?: number
        images_failed?: number
      }
      if (!res.ok) {
        throw new Error(body.error ?? `Retry failed (${res.status})`)
      }
      if (!body.final_code) {
        if (body.diagnostic) setRetryDiagnostic(body.diagnostic)
        if (body.text_sample) setRetryTextSample(body.text_sample)
      }
      // Pull fresh resolver state from the server.
      router.refresh()
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : String(err))
    }
    setRetrying(false)
  }

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
      <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600 mb-4 shadow-sm border border-emerald-200">
        <Check className="w-6 h-6 md:w-7 md:h-7" strokeWidth={2.5} />
      </div>
    )
    let title = 'Review Successful'
    let message = 'Group reviewed successfully'

    if (isDiscarded) {
      bgColor = 'bg-amber-50 border-amber-200'; textColor = 'text-amber-800'; 
      icon = (
        <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center text-amber-600 mb-4 shadow-sm border border-amber-200">
          <Trash2 className="w-6 h-6 md:w-7 md:h-7" strokeWidth={2.5} />
        </div>
      )
      title = 'Item Discarded'
      message = 'This group was discarded and removed from the queue.'
    } else if (isListed) {
      title = 'Draft Ready for Review'
      const photoBit = `${group.totalImages} photo${group.totalImages !== 1 ? 's' : ''}`
      const aiBit =
        response.listingResult?.descriptionSource === 'fallback'
          ? ' AI description failed — placeholder used; you can edit before publishing.'
          : ' AI description generated.'
      message = `Saved a draft listing with ${photoBit}.${aiBit} Open Listings to publish to eBay.`
    } else if (listingFailed) {
      bgColor = 'bg-red-50 border-red-200'; textColor = 'text-red-800';
      icon = (
         <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center text-red-600 mb-4 shadow-sm border border-red-200">
          <X className="w-6 h-6 md:w-7 md:h-7" strokeWidth={2.5} />
        </div>
      )
      title = 'Draft Creation Failed'
      message = response.listingResult!.error ?? 'Unknown error'
    } else if (noMatch) {
      bgColor = 'bg-amber-50 border-amber-200'; textColor = 'text-amber-800'; 
      icon = (
         <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center text-amber-600 mb-4 shadow-sm border border-amber-200">
          <Search className="w-6 h-6 md:w-7 md:h-7" strokeWidth={2.5} />
        </div>
      )
      title = 'No Product Found'
      message = 'No matching product found on eBay for this code.'
    } else if (searchError) {
      bgColor = 'bg-red-50 border-red-200'; textColor = 'text-red-800'; 
      icon = (
         <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center text-red-600 mb-4 shadow-sm border border-red-200">
          <AlertTriangle className="w-6 h-6 md:w-7 md:h-7" strokeWidth={2.5} />
        </div>
      )
      title = 'Search Error'
      message = 'There was an error searching eBay. See debug log.'
    }

    return (
      <div className={`rounded-2xl border ${bgColor} overflow-hidden transition-all duration-500 ease-in-out shadow-sm`}>
        <div className="p-8 flex flex-col items-center text-center">
          {icon}
          <h3 className={`font-bold text-xl mb-2 ${textColor}`}>{title}</h3>
          <p className={`text-sm md:text-base opacity-90 ${textColor}`}>{message}</p>
          
          {response.listingResult?.success && response.listingResult.listingId && (
            <a
              href={`/listings?status=draft`}
              className="mt-6 px-6 py-3 bg-white text-blue-600 border border-blue-200 rounded-full text-sm font-bold hover:bg-blue-50 hover:border-blue-300 transition-all shadow-sm flex items-center gap-2 group"
            >
              Review & Publish Draft
              <ExternalLink className="w-4 h-4 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
            </a>
          )}
          
          {response.searchDebug && (
            <div className={`mt-8 text-sm text-left w-full max-w-md p-5 rounded-xl bg-white/50 border border-white/40 shadow-sm ${textColor}`}>
              <div className="flex items-center gap-2 mb-3 font-semibold opacity-80">
                <Search className="w-4 h-4" />
                eBay Search Results
              </div>
              <p className="mb-1.5 flex items-center justify-between">
                <span>Returned items</span>
                <span className="font-bold bg-white/60 px-2 py-0.5 rounded-md">{response.searchDebug.itemCount ?? 0}</span>
              </p>
              {response.searchDebug.bestMatchTitle && (
                <div className="mt-2 pt-2 border-t border-black/5">
                  <p className="text-xs font-medium opacity-70 mb-1">Best Match</p>
                  <p className="truncate font-medium bg-white/60 px-3 py-2 rounded-lg" title={response.searchDebug.bestMatchTitle}>
                    {response.searchDebug.bestMatchTitle}
                  </p>
                </div>
              )}
            </div>
          )}

          {response.listingResult?.steps && response.listingResult.steps.length > 0 && (
            <div className="mt-6 w-full max-w-md text-left space-y-2">
              <p className="text-xs font-bold uppercase tracking-wider opacity-70 mb-3 flex items-center gap-1.5">
                <ShoppingCart className="w-3.5 h-3.5" /> Listing Pipeline
              </p>
              {response.listingResult.steps.map((step, i) => {
                const tone =
                  step.status === 'ok'
                    ? { box: 'bg-white border-emerald-100', icon: 'text-emerald-500' }
                    : step.status === 'warn'
                      ? { box: 'bg-amber-50 border-amber-100', icon: 'text-amber-500' }
                      : { box: 'bg-red-50 border-red-100', icon: 'text-red-500' }
                return (
                  <div
                    key={i}
                    className={`text-sm px-4 py-3 rounded-xl flex items-start gap-3 shadow-sm border ${tone.box}`}
                  >
                    <span className={`mt-0.5 shrink-0 ${tone.icon}`}>
                      {step.status === 'ok' ? (
                        <Check className="w-4 h-4" strokeWidth={3} />
                      ) : step.status === 'warn' ? (
                        <AlertTriangle className="w-4 h-4" strokeWidth={3} />
                      ) : (
                        <X className="w-4 h-4" strokeWidth={3} />
                      )}
                    </span>
                    <div>
                      <span className="font-bold">{step.step}</span>
                      <p className="opacity-80 mt-1 break-words text-xs md:text-sm">{step.detail}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {response.debugLog && response.debugLog.length > 0 && (
          <div className="border-t border-black/5">
            <button
              onClick={() => setShowDebug(!showDebug)}
              className="w-full px-6 py-4 text-center text-xs font-bold opacity-60 hover:opacity-100 hover:bg-black/5 transition-all flex items-center justify-center gap-2 uppercase tracking-wider"
            >
              {showDebug ? 'Hide' : 'Show'} Debug Log
              <ChevronDown className={`w-4 h-4 transition-transform duration-300 ${showDebug ? 'rotate-180' : ''}`} />
            </button>
            {showDebug && (
              <div className="px-6 pb-6">
                <pre className="text-[10px] md:text-xs leading-relaxed font-mono whitespace-pre-wrap break-all bg-white rounded-xl p-5 max-h-80 overflow-y-auto shadow-inner border border-black/5">
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
      <div className="px-5 py-4 md:px-6 md:py-5 border-b border-gray-100 flex flex-wrap gap-3 items-center justify-between bg-gray-50/50">
        <div className="flex items-center gap-3">
          <h3 className="text-base md:text-lg font-bold text-gray-900 flex items-center gap-2">
            <ImageIcon className="w-5 h-5 text-gray-400" />
            Review Item
          </h3>
          <span className="px-3 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-600 border border-gray-200 shadow-sm">
            {group.images.length} Photo{group.images.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {noCode ? (
            <>
              <span className="px-3 py-1.5 rounded-full text-xs font-bold bg-amber-50 text-amber-800 border border-amber-200 flex items-center gap-1.5 shadow-sm">
                <AlertCircle className="w-4 h-4" /> No code detected — type the product code
              </span>
              <button
                onClick={handleRetryOcr}
                disabled={retrying}
                className="px-3 py-1.5 rounded-full text-xs font-bold bg-white text-blue-700 border border-blue-200 hover:bg-blue-50 hover:border-blue-300 disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-1.5 shadow-sm transition-all"
                title="Re-run OCR on every photo in this group"
              >
                {retrying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCw className="w-3.5 h-3.5" />}
                {retrying ? 'Retrying…' : 'Retry OCR'}
              </button>
            </>
          ) : (
            <span className={`px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-1.5 shadow-sm ${
              confidence >= 90 ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-amber-50 text-amber-700 border border-amber-200'
            }`}>
              {confidence >= 90 ? <ShieldCheck className="w-4 h-4" /> : <ShieldAlert className="w-4 h-4" />}
              {confidence}% Confidence
            </span>
          )}
          {onSplit && !splitMode && group.images.length > 1 && (
            <button
              onClick={() => { setSplitMode(true); setSplitSelection(new Set()) }}
              className="px-2.5 py-1.5 rounded-full text-xs font-semibold bg-white text-gray-600 border border-gray-200 hover:bg-gray-50 hover:border-gray-300 flex items-center gap-1.5 shadow-sm"
              title="Split this group — move selected photos to a new group"
            >
              <Scissors className="w-3.5 h-3.5" /> Split
            </button>
          )}
          {splitMode && (
            <>
              <span className="px-2.5 py-1.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200">
                Pick photos to move
              </span>
              <button
                onClick={handleSplitConfirm}
                disabled={splitSelection.size === 0 || splitSelection.size === group.images.length || splitBusy}
                className="px-2.5 py-1.5 rounded-full text-xs font-bold bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 flex items-center gap-1.5 shadow-sm"
              >
                {splitBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Scissors className="w-3.5 h-3.5" />}
                Move {splitSelection.size}
              </button>
              <button
                onClick={() => { setSplitMode(false); setSplitSelection(new Set()) }}
                className="px-2 py-1.5 rounded-full text-xs font-semibold text-gray-500 hover:bg-gray-100"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-col md:flex-row">
        {/* Left: Images Area */}
        <div className="md:w-[45%] lg:w-1/2 p-5 md:p-6 border-b md:border-b-0 md:border-r border-gray-100 bg-gray-50/30">
           {/* Active Image */}
           <div className="relative aspect-square w-full mb-4 rounded-xl overflow-hidden bg-white border border-gray-200 shadow-inner group">
             {activeImage?.signed_url ? (
               <>
                 <Image
                   src={activeImage.signed_url}
                   alt={activeImage.original_filename ?? 'Product photo'}
                   fill
                   className="object-contain transition-transform duration-500 group-hover:scale-105"
                   unoptimized
                 />
                 <div className="absolute inset-0 ring-1 ring-inset ring-black/5 rounded-xl pointer-events-none" />
               </>
             ) : (
               <div className="absolute inset-0 flex flex-col gap-2 items-center justify-center text-sm text-gray-400 bg-gray-50">
                 <ImageIcon className="w-8 h-8 opacity-20" />
                 No preview available
               </div>
             )}
           </div>

           {/* Thumbnails */}
           {group.images.length > 1 && (
             <div className="flex gap-2.5 overflow-x-auto pb-3 pt-1 scrollbar-thin scrollbar-thumb-gray-300 scrollbar-track-transparent">
               {group.images.map(img => {
                 const selected = splitSelection.has(img.id)
                 const onClickHandler = splitMode
                   ? () => toggleSplitSelection(img.id)
                   : () => setActiveImageId(img.id)
                 return (
                   <button
                     key={img.id}
                     onClick={onClickHandler}
                     className={`relative h-16 w-16 md:h-20 md:w-20 shrink-0 rounded-lg overflow-hidden border-2 transition-all ${
                       splitMode && selected
                         ? 'border-blue-500 ring-2 ring-blue-500/40 shadow-md'
                         : !splitMode && activeImageId === img.id
                         ? 'border-blue-500 shadow-md ring-2 ring-blue-500/20'
                         : 'border-transparent hover:border-gray-300 opacity-80 hover:opacity-100 hover:shadow-sm'
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
                       <div className="absolute inset-0 bg-gray-200 flex items-center justify-center">
                         <ImageIcon className="w-4 h-4 text-gray-400" />
                       </div>
                     )}
                     {(img.id === winningImageId || img.is_label_candidate) && !splitMode && (
                       <div className="absolute bottom-0 right-0 bg-blue-500 p-1 rounded-tl-lg shadow-sm">
                         <Sparkles className="w-3 h-3 md:w-3.5 md:h-3.5 text-white" />
                       </div>
                     )}
                     {splitMode && (
                       <div className={`absolute top-1 left-1 w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                         selected ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white/90 border-gray-300'
                       }`}>
                         {selected && <Check className="w-3 h-3" strokeWidth={3} />}
                       </div>
                     )}
                   </button>
                 )
               })}
             </div>
           )}
        </div>

        {/* Right: Form Area */}
        <div className="md:w-[55%] lg:w-1/2 p-5 md:p-8 flex flex-col justify-between bg-white">
          <div className="space-y-7">
            <div>
              <label className="block text-sm font-bold text-gray-700 mb-2.5 uppercase tracking-wide">
                Product Code
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value.toUpperCase())}
                  placeholder="Enter product code..."
                  className="w-full px-5 py-4 text-xl md:text-2xl font-mono tracking-wider border border-gray-300 rounded-xl bg-gray-50 focus:bg-white shadow-sm focus:outline-none focus:ring-4 focus:ring-blue-500/20 focus:border-blue-500 transition-all font-semibold text-gray-900"
                />
              </div>
              <p className="mt-3 text-sm text-gray-500 flex items-start gap-1.5">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 opacity-60" />
                <span>Verify the detected code or manually override it before listing.</span>
              </p>
              {retryError && (
                <p className="mt-2 text-sm text-red-600 flex items-start gap-1.5">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>OCR retry failed: {retryError}</span>
                </p>
              )}
              {retryDiagnostic && (
                <p className="mt-2 text-sm text-amber-700 flex items-start gap-1.5">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{retryDiagnostic}</span>
                </p>
              )}
              {retryTextSample && (
                <div className="mt-2 p-3 bg-gray-50 border border-gray-200 rounded-lg">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">
                    What OCR read
                  </p>
                  <pre className="text-xs text-gray-700 font-mono whitespace-pre-wrap break-words">
                    {retryTextSample}
                  </pre>
                </div>
              )}
            </div>

            {alternatives.length > 0 && (
              <div className="pt-2 border-t border-gray-100">
                <p className="text-xs font-bold text-gray-500 mb-3 uppercase tracking-wider flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" /> Alternative Suggestions
                </p>
                <div className="flex flex-wrap gap-2.5">
                  {alternatives.map(a => (
                    <button
                      key={a.code}
                      onClick={() => setManualCode(a.code)}
                      className="px-3.5 py-2 bg-gray-50 hover:bg-blue-50 hover:border-blue-200 border border-gray-200 rounded-lg text-sm font-mono font-medium text-gray-700 hover:text-blue-700 transition-all flex items-center gap-2 group shadow-sm"
                    >
                      {a.code}
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-gray-200 group-hover:bg-blue-100 text-gray-500 group-hover:text-blue-600 font-sans font-bold transition-colors">
                        {Math.round(a.confidence * 100)}%
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="mt-10 space-y-3.5">
            <button
              onClick={() => handleAction('list')}
              disabled={loading || !manualCode.trim()}
              className="w-full py-4 px-5 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-xl font-bold text-base shadow-md hover:shadow-lg hover:from-blue-700 hover:to-indigo-700 hover:-translate-y-0.5 disabled:transform-none disabled:shadow-none disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-400 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2.5"
            >
              {loading && loadingAction === 'list' ? (
                <>
                  <Loader2 className="animate-spin w-5 h-5" />
                  Processing Listing...
                </>
              ) : (
                <>
                  <Upload className="w-5 h-5" />
                  Confirm & List to eBay
                </>
              )}
            </button>
            
            <button
              onClick={() => handleAction('discard')}
              disabled={loading}
              className="w-full py-3.5 px-5 bg-white text-red-600 border border-red-200 rounded-xl font-bold hover:bg-red-50 hover:border-red-300 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
            >
               {loading && loadingAction === 'discard' ? (
                 <>
                   <Loader2 className="animate-spin w-4 h-4" /> Discarding...
                 </>
               ) : (
                 <>
                   <Trash2 className="w-4 h-4" /> Discard Item
                 </>
               )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}


