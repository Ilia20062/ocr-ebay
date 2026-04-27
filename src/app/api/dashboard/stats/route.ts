import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'

export const GET = withAuth(async (_req, userId) => {
  const db = getSupabaseAdminClient()

  const [batches, pendingReview, activeListings, failedListings] = await Promise.all([
    db.from('upload_batches').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    db.from('images').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'needs_review'),
    db.from('listings').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'active'),
    db.from('listings').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'failed'),
  ])

  return NextResponse.json({
    total_batches: batches.count ?? 0,
    pending_review: pendingReview.count ?? 0,
    active_listings: activeListings.count ?? 0,
    failed_listings: failedListings.count ?? 0,
  })
})
