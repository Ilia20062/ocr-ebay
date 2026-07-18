'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Trash2 } from 'lucide-react'

interface Props {
  listingId: string
}

export default function DeleteButton({ listingId }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  async function handleDelete() {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch(`/api/listings/${listingId}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setErr(body.error ?? `Delete failed (${res.status})`)
      }
      router.refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
    setConfirming(false)
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-1.5">
        <button
          onClick={handleDelete}
          disabled={busy}
          className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50 bg-red-600 text-white hover:bg-red-700"
        >
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {busy ? 'Deleting…' : 'Confirm'}
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={busy}
          className="px-2 py-1 text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors"
        >
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={() => setConfirming(true)}
        className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-lg transition-colors bg-gray-100 text-gray-600 hover:bg-red-50 hover:text-red-600"
      >
        <Trash2 className="w-3.5 h-3.5" />
        Delete
      </button>
      {err && <span className="text-xs text-red-600 max-w-xs text-right">{err}</span>}
    </div>
  )
}
