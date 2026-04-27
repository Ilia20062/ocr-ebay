interface Props {
  total: number
  uploaded: number
  status: 'uploading' | 'processing' | 'done' | 'error'
}

export default function BatchProgress({ total, uploaded, status }: Props) {
  const pct = total > 0 ? Math.round((uploaded / total) * 100) : 0

  const statusLabel: Record<Props['status'], string> = {
    uploading: `Uploading ${uploaded} / ${total}...`,
    processing: 'OCR processing started...',
    done: 'All images uploaded and processing!',
    error: 'Upload failed. Check errors above.',
  }

  const barColor: Record<Props['status'], string> = {
    uploading: 'bg-blue-500',
    processing: 'bg-yellow-500',
    done: 'bg-green-500',
    error: 'bg-red-500',
  }

  return (
    <div className="mt-4 p-4 bg-white rounded-xl border border-gray-200">
      <div className="flex justify-between text-sm text-gray-700 mb-2">
        <span>{statusLabel[status]}</span>
        <span className="font-medium">{pct}%</span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-2">
        <div
          className={`h-2 rounded-full transition-all duration-300 ${barColor[status]}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
