import Link from 'next/link'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import { PackageOpen } from 'lucide-react'
import PublishButton from './PublishButton'
import DeleteButton from './DeleteButton'
import CategoryOverride from './CategoryOverride'

export const dynamic = 'force-dynamic'

const statusColors: Record<string, string> = {
  draft: 'bg-amber-100 text-amber-700',
  submitting: 'bg-blue-100 text-blue-600',
  active: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  ended: 'bg-gray-100 text-gray-400',
}

const FILTER_TABS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'Drafts' },
  { value: 'active', label: 'Active' },
  { value: 'failed', label: 'Failed' },
]

export default async function ListingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ status?: string }>
}) {
  const params = await searchParams
  const statusFilter = params?.status
  const supabase = await getSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

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
          {FILTER_TABS.map((t) => (
            <Link
              key={t.value}
              href={t.value ? `/listings?status=${t.value}` : '/listings'}
              className={`px-3 py-1 rounded-lg font-medium transition-colors ${
                (statusFilter ?? '') === t.value
                  ? 'bg-blue-100 text-blue-700'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {t.label}
            </Link>
          ))}
        </div>
      </div>

      {!listings || listings.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
          <PackageOpen className="w-16 h-16 mb-4 text-gray-300" strokeWidth={1.5} />
          <p className="font-medium text-gray-600">
            {statusFilter === 'draft'
              ? 'No drafts — confirm a batch in the review queue to create one.'
              : 'No listings yet'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {listings.map((listing) => (
            <div
              key={listing.id}
              className="bg-white rounded-xl border border-gray-200 p-5 space-y-3"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900">{listing.title}</p>
                  <p className="text-sm text-gray-500 mt-0.5">
                    {listing.price ? `$${listing.price}` : 'No price'} {listing.currency} · Qty {listing.quantity}
                    {listing.condition ? ` · ${listing.condition}` : ''}
                    {listing.category_id ? ` · cat ${listing.category_id}` : ''}
                  </p>
                  {listing.sku && (
                    <p className="text-xs text-gray-400 mt-0.5 font-mono">SKU: {listing.sku}</p>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      statusColors[listing.status] ?? 'bg-gray-100 text-gray-600'
                    }`}
                  >
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
                  {(listing.status === 'draft' || listing.status === 'failed') && (
                    <PublishButton
                      listingId={listing.id}
                      variant={listing.status === 'draft' ? 'primary' : 'danger'}
                      label={listing.status === 'draft' ? 'Publish to eBay' : 'Retry'}
                    />
                  )}
                  <DeleteButton listingId={listing.id} />
                </div>
              </div>

              {listing.description && (
                <details className="group" {...(listing.status === 'draft' ? { open: true } : {})}>
                  <summary className="cursor-pointer text-xs text-gray-600 hover:text-gray-900 select-none">
                    AI description ({listing.description.length.toLocaleString()} chars)
                  </summary>
                  {/* Description is HTML (the same markup sent to eBay). Render
                      it so the seller previews the formatted listing. It's the
                      seller's own AI-generated content. */}
                  <div
                    className="ai-desc mt-2 text-xs text-gray-700 bg-gray-50 rounded p-3 border border-gray-100 max-h-96 overflow-auto [&_ul]:list-disc [&_ul]:pl-5 [&_p]:my-1.5 [&_strong]:text-gray-900"
                    dangerouslySetInnerHTML={{ __html: listing.description }}
                  />
                </details>
              )}

              {listing.error_message && (
                <p className="text-xs text-red-600 bg-red-50 rounded p-2 whitespace-pre-wrap break-words">
                  {listing.error_message}
                </p>
              )}

              {(listing.status === 'draft' || listing.status === 'failed') && (
                <CategoryOverride
                  listingId={listing.id}
                  currentCategoryId={listing.category_id}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
