'use client'

import { useState } from 'react'
import DropZone from '@/components/upload/DropZone'
import BatchProgress from '@/components/upload/BatchProgress'
import { useUploadSession } from '@/components/upload/UploadSessionProvider'

export default function UploadPage() {
  const { status, total, uploaded, groupCount, error, startUpload, sessionId } = useUploadSession()
  const [lotLabel, setLotLabel] = useState('')

  const inFlight =
    status === 'uploading' || status === 'grouping' || status === 'processing'

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-2">Upload Job Lot</h2>
      <p className="text-sm text-gray-500 mb-6">
        Drop every photo from your job lot. We&apos;ll auto-group them by product, find the
        label image with the code, and send each group to the review queue. You can
        switch tabs while it runs — progress is shown in the bottom-right.
      </p>

      <div className="max-w-2xl">
        <div className="mb-4">
          <label className="block text-xs font-bold uppercase tracking-wider text-gray-600 mb-2">
            Lot Label (optional)
          </label>
          <input
            type="text"
            value={lotLabel}
            onChange={(e) => setLotLabel(e.target.value)}
            placeholder="e.g. 3694"
            disabled={inFlight}
            className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 disabled:bg-gray-50"
          />
        </div>

        <DropZone
          onFiles={(files) => startUpload(files, lotLabel)}
          disabled={inFlight}
        />

        {status !== 'idle' && (
          <BatchProgress
            total={total}
            uploaded={uploaded}
            groupCount={groupCount}
            status={
              status === 'uploading'
                ? 'uploading'
                : status === 'grouping'
                ? 'grouping'
                : status === 'processing'
                ? 'processing'
                : status === 'done'
                ? 'done'
                : 'error'
            }
          />
        )}

        {status === 'done' && sessionId && (
          <div className="mt-4 p-4 bg-emerald-50 border border-emerald-200 rounded-xl">
            <p className="text-sm font-medium text-emerald-800">
              {groupCount} group{groupCount === 1 ? '' : 's'} ready for review.
            </p>
            <a
              href={`/review?session=${sessionId}`}
              className="mt-2 inline-block text-sm font-bold text-emerald-700 underline"
            >
              Open the review queue →
            </a>
          </div>
        )}

        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
