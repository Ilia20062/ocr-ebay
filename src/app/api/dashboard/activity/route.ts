import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'

export const GET = withAuth(async (_req, userId) => {
  const db = getSupabaseAdminClient()
  const { data } = await db
    .from('audit_logs')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50)

  return NextResponse.json(data ?? [])
})
