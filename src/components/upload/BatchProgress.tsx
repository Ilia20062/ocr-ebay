interface Props {
  total: number
  uploaded: number
  status: 'uploading' | 'grouping' | 'processing' | 'done' | 'error'
  groupCount?: number
}

export default function BatchProgress({ total, uploaded, status, groupCount }: Props) {
  const pct = total > 0 ? Math.round((uploaded / total) * 100) : 0

  const statusLabel: Record<Props['status'], string> = {
    uploading: `Uploading ${uploaded} / ${total}...`,
    grouping: 'Grouping photos by product...',
    processing: groupCount
      ? `Reading product codes across ${groupCount} group${groupCount === 1 ? '' : 's'}...`
      : 'Reading product codes...',
    done: 'All groups ready for review.',
    error: 'Upload failed. Check errors above.',
  }

  const barColor: Record<Props['status'], string> = {
    uploading: 'bg-blue-500',
    grouping: 'bg-indigo-500',
    processing: 'bg-yellow-500',
    done: 'bg-green-500',
    error: 'bg-red-500',
  }

  // Show indeterminate-ish bar for grouping/processing (no per-image progress).
  const displayPct = status === 'uploading' ? pct : status === 'done' ? 100 : 100

  return (
    <div className="mt-4 p-4 bg-white rounded-xl border border-gray-200">
      <div className="flex justify-between text-sm text-gray-700 mb-2">
        <span>{statusLabel[status]}</span>
        {status === 'uploading' && <span className="font-medium">{pct}%</span>}
      </div>
      <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
        <div
          className={`h-2 rounded-full transition-all duration-300 ${barColor[status]} ${
            status === 'grouping' || status === 'processing' ? 'animate-pulse' : ''
          }`}
          style={{ width: `${displayPct}%` }}
        />
      </div>
    </div>
  )
}
