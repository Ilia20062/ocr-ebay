import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'

export const GET = withAuth(async (_req, userId) => {
  const db = getSupabaseAdminClient()
  const { data } = await db
    .from('ebay_connections')
    .select('ebay_user_id, marketplace_id, token_expires_at')
    .eq('user_id', userId)
    .single()

  return NextResponse.json({
    connected: !!data,
    ebay_user_id: data?.ebay_user_id ?? null,
    marketplace_id: data?.marketplace_id ?? null,
    token_expires_at: data?.token_expires_at ?? null,
  })
})
