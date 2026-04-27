import Link from 'next/link'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { getSupabaseServerClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

async function getStats(userId: string) {
  const db = getSupabaseAdminClient()
  const [batches, pending, active, failed] = await Promise.all([
    db.from('upload_batches').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    db.from('images').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'needs_review'),
    db.from('listings').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'active'),
    db.from('listings').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'failed'),
  ])
  return {
    batches: batches.count ?? 0,
    pending: pending.count ?? 0,
    active: active.count ?? 0,
    failed: failed.count ?? 0,
  }
}

const statCards = [
  { key: 'batches', label: 'Total Batches', color: 'bg-blue-50 text-blue-700', href: '/upload' },
  { key: 'pending', label: 'Pending Review', color: 'bg-yellow-50 text-yellow-700', href: '/review' },
  { key: 'active', label: 'Active Listings', color: 'bg-green-50 text-green-700', href: '/listings?status=active' },
  { key: 'failed', label: 'Failed Listings', color: 'bg-red-50 text-red-700', href: '/listings?status=failed' },
]

export default async function DashboardPage() {
  const supabase = await getSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  const stats = await getStats(user!.id)

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-6">Dashboard</h2>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 mb-8">
        {statCards.map(({ key, label, color, href }) => (
          <Link key={key} href={href}>
            <div className={`rounded-xl p-5 ${color} hover:opacity-90 transition-opacity`}>
              <p className="text-3xl font-bold">{stats[key as keyof typeof stats]}</p>
              <p className="text-sm font-medium mt-1 opacity-80">{label}</p>
            </div>
          </Link>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h3 className="font-semibold text-gray-900 mb-4">Quick Actions</h3>
        <div className="flex gap-3">
          <Link
            href="/upload"
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            Upload Images
          </Link>
          <Link
            href="/review"
            className="px-4 py-2 bg-yellow-500 text-white rounded-lg text-sm font-medium hover:bg-yellow-600 transition-colors"
          >
            Review Queue ({stats.pending})
          </Link>
        </div>
      </div>
    </div>
  )
}
