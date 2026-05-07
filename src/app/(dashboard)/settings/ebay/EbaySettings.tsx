'use client'

import { useState } from 'react'
import { ShoppingCart } from 'lucide-react'

interface Connection {
  ebay_user_id: string | null
  marketplace_id: string
  token_expires_at: string
}

interface Props {
  connection: Connection | null
}

export default function EbaySettings({ connection }: Props) {
  const [disconnecting, setDisconnecting] = useState(false)
  const [manualCode, setManualCode] = useState('')
  const [submittingCode, setSubmittingCode] = useState(false)
  const [manualError, setManualError] = useState<string | null>(null)

  async function handleDisconnect() {
    if (!confirm('Disconnect your eBay store? Active listings will remain on eBay.')) return
    setDisconnecting(true)
    await fetch('/api/ebay/disconnect', { method: 'DELETE' })
    window.location.reload()
  }

  async function handleManualSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!manualCode.trim()) return
    
    setSubmittingCode(true)
    setManualError(null)
    
    try {
      const res = await fetch('/api/ebay/manual-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: manualCode.trim() })
      })
      
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to exchange code')
      
      window.location.reload()
    } catch (err) {
      setManualError(err instanceof Error ? err.message : String(err))
      setSubmittingCode(false)
    }
  }

  if (!connection) {
    return (
      <div className="max-w-md bg-white rounded-xl border border-gray-200 p-6 space-y-6">
        <div>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2.5 bg-yellow-100 rounded-xl text-yellow-600">
              <ShoppingCart className="w-6 h-6" strokeWidth={2.5} />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900">Connect eBay Store</h3>
              <p className="text-sm text-gray-500">Link your eBay account to enable auto-listing</p>
            </div>
          </div>
          <a
            href="/api/ebay/connect"
            className="inline-block w-full text-center py-2 px-4 bg-yellow-400 hover:bg-yellow-500 text-gray-900 font-semibold rounded-lg text-sm transition-colors"
          >
            Connect with eBay
          </a>
        </div>

        <div className="pt-4 border-t border-gray-100">
          <h4 className="text-sm font-medium text-gray-900 mb-2">Fallback: Manual Code Entry</h4>
          <p className="text-xs text-gray-500 mb-3">
            If eBay did not automatically redirect you back, copy the long code provided by eBay (starts with <code>v^1...</code>) and paste it below:
          </p>
          <form onSubmit={handleManualSubmit} className="space-y-2">
            <input
              type="text"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              placeholder="v^1.1#i^1#r^0..."
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-yellow-400"
              required
            />
            {manualError && <p className="text-xs text-red-600">{manualError}</p>}
            <button
              type="submit"
              disabled={submittingCode || !manualCode.trim()}
              className="w-full py-2 px-4 bg-gray-900 hover:bg-gray-800 text-white font-semibold rounded-lg text-sm transition-colors disabled:opacity-50"
            >
              {submittingCode ? 'Submitting...' : 'Submit Code'}
            </button>
          </form>
        </div>
      </div>
    )
  }

  const expiresAt = new Date(connection.token_expires_at)
  const expiresInDays = Math.ceil((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24))

  return (
    <div className="max-w-md bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center gap-2 mb-4">
        <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
        <span className="text-sm font-medium text-green-700">Connected</span>
      </div>

      <div className="space-y-3 text-sm">
        {connection.ebay_user_id && (
          <div>
            <span className="text-gray-500">eBay User ID:</span>{' '}
            <span className="font-mono text-gray-900">{connection.ebay_user_id}</span>
          </div>
        )}
        <div>
          <span className="text-gray-500">Marketplace:</span>{' '}
          <span className="text-gray-900">{connection.marketplace_id}</span>
        </div>
        <div>
          <span className="text-gray-500">Token expires:</span>{' '}
          <span className={expiresInDays < 7 ? 'text-red-600 font-medium' : 'text-gray-900'}>
            {expiresAt.toLocaleDateString()} ({expiresInDays}d)
          </span>
        </div>
      </div>

      <div className="mt-5 flex gap-3">
        <button
          onClick={handleDisconnect}
          disabled={disconnecting}
          className="px-4 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50"
        >
          {disconnecting ? 'Disconnecting...' : 'Disconnect'}
        </button>
        <a
          href="/api/ebay/connect"
          className="px-4 py-2 text-sm text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
        >
          Reconnect
        </a>
      </div>
    </div>
  )
}
