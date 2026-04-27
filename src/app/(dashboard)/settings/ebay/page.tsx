import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import EbaySettings from './EbaySettings'

export const dynamic = 'force-dynamic'

export default async function EbaySettingsPage({ searchParams }: { searchParams?: Promise<{ connected?: string; error?: string }> }) {
  const params = await searchParams
  const supabase = await getSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  const db = getSupabaseAdminClient()
  const { data: conn } = await db
    .from('ebay_connections')
    .select('ebay_user_id, marketplace_id, token_expires_at')
    .eq('user_id', user!.id)
    .single()

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-6">eBay Settings</h2>
      {params?.connected && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
          eBay store connected successfully!
        </div>
      )}
      {params?.error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          Connection failed: {params.error.replace(/_/g, ' ')}. Please try again.
        </div>
      )}
      <EbaySettings connection={conn ?? null} />
    </div>
  )
}
