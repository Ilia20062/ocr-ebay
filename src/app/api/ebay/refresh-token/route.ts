import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getFreshAccessToken } from '@/lib/ebay/token-manager'

export const POST = withAuth(async (_req, userId) => {
  try {
    const token = await getFreshAccessToken(userId)
    return NextResponse.json({ refreshed: true, expires_soon: false })
  } catch (err) {
    if (String(err).includes('EBAY_NOT_CONNECTED')) {
      return apiError('eBay not connected', 403, 'EBAY_NOT_CONNECTED')
    }
    return apiError('Token refresh failed', 500)
  }
})
