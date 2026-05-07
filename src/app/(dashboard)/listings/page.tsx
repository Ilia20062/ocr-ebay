import Link from 'next/link'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import { PackageOpen } from 'lucide-react'

export const dynamic = 'force-dynamic'

const statusColors: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600',
  submitting: 'bg-blue-100 text-blue-600',
  active: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  ended: 'bg-gray-100 text-gray-400',
}

export default async function ListingsPage({ searchParams }: { searchParams?: Promise<{ status?: string }> }) {
  const params = await searchParams
  const statusFilter = params?.status
  const supabase = await getSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  const db = getSupabaseAdminClient()
  let query = db
    .from('listings')
    .select('*')
    .eq('user_id', user!.id)
    .order('created_at', { ascending: false })
    .limit(100)

  if (statusFilter) query = query.eq('status', statusFilter)

  const { data: listings } = await query

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Listings</h2>
        <div className="flex gap-2 text-sm">
          {['', 'active', 'failed', 'draft'].map((s) => (
            <Link
              key={s}
              href={s ? `/listings?status=${s}` : '/listings'}
              className={`px-3 py-1 rounded-lg font-medium transition-colors ${
                (statusFilter ?? '') === s
                  ? 'bg-blue-100 text-blue-700'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {s || 'All'}
            </Link>
          ))}
        </div>
      </div>

      {!listings || listings.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
          <PackageOpen className="w-16 h-16 mb-4 text-gray-300" strokeWidth={1.5} />
          <p className="font-medium text-gray-600">No listings yet</p>
        </div>
      ) : (
        <div className="space-y-3">
          {listings.map((listing) => (
            <div key={listing.id} className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900 truncate">{listing.title}</p>
                  <p className="text-sm text-gray-500 mt-0.5">
                    {listing.price ? `$${listing.price}` : 'No price'} · Qty {listing.quantity}
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColors[listing.status]}`}>
                    {listing.status}
                  </span>
                  {listing.ebay_listing_url && (
                    <a
                      href={listing.ebay_listing_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-600 hover:underline"
                    >
                      View on eBay ↗
                    </a>
                  )}
                  {listing.status === 'failed' && (
                    <form action={`/api/listings/${listing.id}/retry`} method="POST">
                      <button
                        type="submit"
                        className="text-xs text-red-600 hover:underline"
                      >
                        Retry
                      </button>
                    </form>
                  )}
                </div>
              </div>
              {listing.error_message && (
                <p className="mt-2 text-xs text-red-600 bg-red-50 rounded p-2">{listing.error_message}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
