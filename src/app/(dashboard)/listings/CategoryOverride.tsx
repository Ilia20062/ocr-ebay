'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'

interface Props {
  listingId: string
  currentCategoryId: string | null
}

/**
 * Inline category override. Lets the seller force a specific eBay categoryId
 * before retrying publish — necessary when every Taxonomy suggestion lands in
 * eBay Motors but the account isn't enrolled, or for any other category
 * permission edge case the auto-resolver can't bypass.
 */
export default function CategoryOverride({ listingId, currentCategoryId }: Props) {
  const router = useRouter()
  const [value, setValue] = useState(currentCategoryId ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function save() {
    const trimmed = value.trim()
    if (!/^\d+$/.test(trimmed)) {
      setErr('Category ID must be a number (e.g. 33705).')
      return
    }
    setBusy(true)
    setErr(null)
    setSaved(false)
    try {
      const res = await fetch(`/api/listings/${listingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category_id: trimmed }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.success === false) {
        setErr(body.error ?? `Save failed (${res.status})`)
      } else {
        setSaved(true)
        router.refresh()
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <label className="text-gray-500" htmlFor={`cat-${listingId}`}>
        Override cat:
      </label>
      <input
        id={`cat-${listingId}`}
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          setSaved(false)
        }}
        placeholder="e.g. 99"
        className="w-24 px-2 py-1 rounded border border-gray-300 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <button
        onClick={save}
        disabled={busy || value.trim() === (currentCategoryId ?? '')}
        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold disabled:opacity-50"
      >
        {busy && <Loader2 className="w-3 h-3 animate-spin" />}
        Save
      </button>
      {saved && <span className="text-green-600">saved</span>}
      {err && <span className="text-red-600 truncate max-w-[18ch]" title={err}>{err}</span>}
    </div>
  )
}
