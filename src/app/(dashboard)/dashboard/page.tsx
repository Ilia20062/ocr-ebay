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

import { ArrowRight, LayoutDashboard as LayoutDashboardIcon, CheckCircle2, AlertCircle, Clock, UploadCloud, ListChecks } from 'lucide-react'

const statCards = [
  { key: 'batches', label: 'Total Batches', color: 'bg-blue-50 text-blue-700 border-blue-100', icon: LayoutDashboardIcon, href: '/upload' },
  { key: 'pending', label: 'Pending Review', color: 'bg-yellow-50 text-yellow-700 border-yellow-100', icon: Clock, href: '/review' },
  { key: 'active', label: 'Active Listings', color: 'bg-emerald-50 text-emerald-700 border-emerald-100', icon: CheckCircle2, href: '/listings?status=active' },
  { key: 'failed', label: 'Failed Listings', color: 'bg-red-50 text-red-700 border-red-100', icon: AlertCircle, href: '/listings?status=failed' },
]

export default async function DashboardPage() {
  const supabase = await getSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  const stats = await getStats(user!.id)

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-6">Dashboard</h2>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 mb-8">
        {statCards.map(({ key, label, color, icon: Icon, href }) => (
          <Link key={key} href={href}>
            <div className={`rounded-2xl p-6 ${color} border hover:shadow-md transition-all group flex flex-col justify-between h-full`}>
              <div className="flex items-start justify-between mb-4">
                <div className={`p-3 rounded-xl bg-white/60 shadow-sm group-hover:scale-110 transition-transform`}>
                  <Icon className="w-6 h-6" strokeWidth={2.5} />
                </div>
                <ArrowRight className="w-5 h-5 opacity-0 -translate-x-4 group-hover:opacity-50 group-hover:translate-x-0 transition-all" />
              </div>
              <div>
                <p className="text-4xl font-extrabold">{stats[key as keyof typeof stats]}</p>
                <p className="text-sm font-semibold mt-1 opacity-80 uppercase tracking-wider">{label}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h3 className="font-semibold text-gray-900 mb-4">Quick Actions</h3>
        <div className="flex gap-4 mt-2">
          <Link
            href="/upload"
            className="px-5 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 transition-colors shadow-sm flex items-center gap-2 hover:-translate-y-0.5"
          >
            <UploadCloud className="w-4 h-4" />
            Upload Images
          </Link>
          <Link
            href="/review"
            className="px-5 py-2.5 bg-yellow-500 text-white rounded-xl text-sm font-semibold hover:bg-yellow-600 transition-colors shadow-sm flex items-center gap-2 hover:-translate-y-0.5"
          >
            <ListChecks className="w-4 h-4" />
            Review Queue ({stats.pending})
          </Link>
        </div>
      </div>
    </div>
  )
}
