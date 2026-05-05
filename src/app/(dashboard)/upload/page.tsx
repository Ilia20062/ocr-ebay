'use client'

import { useState } from 'react'
import DropZone from '@/components/upload/DropZone'
import BatchProgress from '@/components/upload/BatchProgress'

type UploadStatus = 'idle' | 'uploading' | 'processing' | 'done' | 'error'

export default function UploadPage() {
  const [status, setStatus] = useState<UploadStatus>('idle')
  const [uploaded, setUploaded] = useState(0)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState('')

  async function handleFiles(files: File[]) {
    setStatus('uploading')
    setTotal(files.length)
    setUploaded(0)
    setError('')

    try {
      // Create batch
      const batchRes = await fetch('/api/batches', { method: 'POST' })
      if (!batchRes.ok) throw new Error('Failed to create batch')
      const batch = await batchRes.json() as { id: string }

      // Upload each file
      for (const file of files) {
        const presignRes = await fetch('/api/images/presign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            batch_id: batch.id,
            filename: file.name,
            mime_type: file.type,
            file_size_bytes: file.size,
          }),
        })

        if (!presignRes.ok) throw new Error(`Failed to get upload URL for ${file.name}`)
        const { upload_url, image_id } = await presignRes.json() as { upload_url: string; image_id: string }

        // Direct upload to Supabase Storage
        const uploadRes = await fetch(upload_url, {
          method: 'PUT',
          body: file,
          headers: { 'Content-Type': file.type },
        })

        if (!uploadRes.ok) throw new Error(`Upload failed for ${file.name}`)

        await fetch('/api/images/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_id }),
        })

        setUploaded((prev) => prev + 1)
      }

      // Trigger OCR processing
      setStatus('processing')
      await fetch(`/api/batches/${batch.id}/process`, { method: 'POST' })
      setStatus('done')
    } catch (err) {
      setError(String(err))
      setStatus('error')
    }
  }

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-2">Upload Images</h2>
      <p className="text-sm text-gray-500 mb-6">
        Upload all photos of a single item. We&apos;ll find the serial number across the group and
        create one listing with every photo attached.
      </p>

      <div className="max-w-2xl">
        <DropZone onFiles={handleFiles} disabled={status === 'uploading' || status === 'processing'} />

        {status !== 'idle' && (
          <BatchProgress
            total={total}
            uploaded={uploaded}
            status={status === 'uploading' ? 'uploading' : status === 'processing' ? 'processing' : status === 'done' ? 'done' : 'error'}
          />
        )}

        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        {status === 'done' && (
          <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-xl">
            <p className="text-sm font-medium text-green-800">
              {total} image{total !== 1 ? 's' : ''} uploaded successfully!
            </p>
            <p className="text-sm text-green-700 mt-1">
              OCR is running in the background. Check the{' '}
              <a href="/review" className="underline font-medium">Review Queue</a> for images
              that need manual verification.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
