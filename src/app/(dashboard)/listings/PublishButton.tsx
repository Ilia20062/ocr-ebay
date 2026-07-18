'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'

interface Props {
  listingId: string
  label: string
  variant: 'primary' | 'danger'
}

export default function PublishButton({ listingId, label, variant }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function go() {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch(`/api/listings/${listingId}/publish`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.ok === false) {
        setErr(body.error ?? `Publish failed (${res.status})`)
      }
      // Refresh on failure too. publishListing moves the row draft → submitting
      // → failed and persists error_message, so skipping the refresh here left
      // the badge reading "draft" next to a publish error — making it look like
      // the draft had been lost when it was only the stale server render.
      router.refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  const base =
    'inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50'
  const tone =
    variant === 'primary'
      ? 'bg-blue-600 text-white hover:bg-blue-700'
      : 'bg-red-100 text-red-700 hover:bg-red-200'

  return (
    <div className="flex flex-col items-end gap-1">
      <button onClick={go} disabled={busy} className={`${base} ${tone}`}>
        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        {busy ? 'Publishing…' : label}
      </button>
      {err && <span className="text-xs text-red-600 max-w-xs text-right">{err}</span>}
    </div>
  )
}
