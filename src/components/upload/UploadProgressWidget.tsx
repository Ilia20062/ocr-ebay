'use client'

import Link from 'next/link'
import { useUploadSession } from './UploadSessionProvider'
import { Loader2, CheckCircle2, AlertTriangle, X, ExternalLink } from 'lucide-react'

/**
 * Floating progress widget. Mounted at the dashboard layout level so it
 * persists across page navigation. Hidden when no upload is in flight.
 */
export default function UploadProgressWidget() {
  const { sessionId, status, total, uploaded, groupCount, error, dismiss } = useUploadSession()

  if (status === 'idle' || !sessionId) return null

  const pct = total > 0 ? Math.round((uploaded / total) * 100) : 0
  const isWorking = status === 'uploading' || status === 'grouping' || status === 'processing'

  const headline =
    status === 'uploading'
      ? `Uploading ${uploaded} / ${total}`
      : status === 'grouping'
      ? 'Auto-grouping photos by product…'
      : status === 'processing'
      ? groupCount
        ? `Reading codes across ${groupCount} group${groupCount === 1 ? '' : 's'}…`
        : 'Reading product codes…'
      : status === 'done'
      ? `${groupCount || 0} group${groupCount === 1 ? '' : 's'} ready for review`
      : 'Upload failed'

  const accent =
    status === 'error'
      ? 'border-red-200 bg-red-50'
      : status === 'done'
      ? 'border-emerald-200 bg-emerald-50'
      : 'border-blue-200 bg-white'

  const icon =
    status === 'error' ? (
      <AlertTriangle className="w-5 h-5 text-red-600" />
    ) : status === 'done' ? (
      <CheckCircle2 className="w-5 h-5 text-emerald-600" />
    ) : (
      <Loader2 className="w-5 h-5 text-blue-600 animate-spin" />
    )

  return (
    <div className={`fixed bottom-4 right-4 z-50 w-80 rounded-2xl border shadow-lg ${accent}`}>
      <div className="px-4 py-3 flex items-center gap-3">
        <div className="shrink-0">{icon}</div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-gray-900 truncate">{headline}</p>
          {status === 'error' && error && (
            <p className="text-xs text-red-700 mt-0.5 truncate" title={error}>{error}</p>
          )}
          {status === 'uploading' && (
            <div className="mt-2 w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
              <div className="h-1.5 bg-blue-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
            </div>
          )}
          {(status === 'grouping' || status === 'processing') && (
            <div className="mt-2 w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
              <div className="h-1.5 bg-blue-500 rounded-full animate-pulse" style={{ width: '100%' }} />
            </div>
          )}
        </div>
        <button
          onClick={dismiss}
          className="shrink-0 p-1 text-gray-400 hover:text-gray-600 hover:bg-black/5 rounded-md"
          title={isWorking ? 'Hide (upload continues in background until you reload)' : 'Dismiss'}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      {(status === 'done' || (isWorking && total > 0)) && (
        <div className="px-4 pb-3 -mt-1">
          <Link
            href={`/review?session=${sessionId}`}
            className="text-xs font-bold text-blue-700 hover:text-blue-800 inline-flex items-center gap-1"
          >
            {status === 'done' ? 'Open review queue' : 'Open review when ready'}
            <ExternalLink className="w-3 h-3" />
          </Link>
        </div>
      )}
    </div>
  )
}
