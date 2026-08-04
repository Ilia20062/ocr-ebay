'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Tag } from 'lucide-react'

interface Props {
  listingId: string
}

/**
 * Re-detects category from the title for a LIVE listing and pushes the
 * change to eBay. eBay only allows this while the listing has zero sales
 * and doesn't end within 12 hours — a rejection past that point is expected
 * and surfaced as a plain message, not a bug.
 */
export default function RecategorizeButton({ listingId }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  async function go() {
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch(`/api/listings/${listingId}/recategorize`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.ok === false) {
        setMsg({ tone: 'error', text: body.error ?? `Recategorize failed (${res.status})` })
      } else if (body.unchanged) {
        setMsg({ tone: 'ok', text: `Already in the best-matching category (${body.newCategoryId}).` })
      } else {
        setMsg({ tone: 'ok', text: `Moved to "${body.newCategoryName}" (${body.newCategoryId}).` })
        router.refresh()
      }
    } catch (e) {
      setMsg({ tone: 'error', text: e instanceof Error ? e.message : String(e) })
    }
    setBusy(false)
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={go}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50 bg-gray-100 text-gray-700 hover:bg-gray-200"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Tag className="w-3.5 h-3.5" />}
        {busy ? 'Detecting…' : 'Re-detect category'}
      </button>
      {msg && (
        <span className={`text-xs max-w-xs text-right ${msg.tone === 'error' ? 'text-red-600' : 'text-green-700'}`}>
          {msg.text}
        </span>
      )}
    </div>
  )
}
