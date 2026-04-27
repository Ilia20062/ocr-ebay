import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'

// Required by eBay policy: handle marketplace account deletion notifications
export async function POST(req: NextRequest) {
  const body = await req.json() as {
    metadata?: { topic: string }
    notification?: { data?: { userId?: string } }
  }

  if (body.metadata?.topic === 'MARKETPLACE_ACCOUNT_DELETION') {
    const ebayUserId = body.notification?.data?.userId
    if (ebayUserId) {
      const db = getSupabaseAdminClient()
      await db.from('ebay_connections').delete().eq('ebay_user_id', ebayUserId)
    }
  }

  return NextResponse.json({ acknowledged: true })
}
