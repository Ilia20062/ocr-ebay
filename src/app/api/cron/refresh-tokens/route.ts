import { NextRequest, NextResponse } from 'next/server'
import { withCron } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { refreshAccessToken } from '@/lib/ebay/auth'
import { decrypt, encrypt } from '@/lib/encryption'

export const POST = withCron(async (_req) => {
  const db = getSupabaseAdminClient()

  // Find connections expiring within 24 hours
  const expiryThreshold = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const { data: connections } = await db
    .from('ebay_connections')
    .select('id, user_id, refresh_token, token_expires_at')
    .lte('token_expires_at', expiryThreshold)

  if (!connections || connections.length === 0) return NextResponse.json({ refreshed: 0 })

  let refreshed = 0
  let failed = 0

  for (const conn of connections) {
    try {
      const decryptedRefreshToken = decrypt(conn.refresh_token)
      const tokens = await refreshAccessToken(decryptedRefreshToken)
      const newExpiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

      await db.from('ebay_connections').update({
        access_token: encrypt(tokens.access_token),
        refresh_token: encrypt(tokens.refresh_token),
        token_expires_at: newExpiry,
      }).eq('id', conn.id)

      refreshed++
    } catch {
      failed++
    }
  }

  return NextResponse.json({ refreshed, failed })
})
