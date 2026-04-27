import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/middleware'
import { buildAuthorizationUrl } from '@/lib/ebay/auth'
import { randomBytes } from 'crypto'
import { cookies } from 'next/headers'

export const GET = withAuth(async (_req, _userId) => {
  const state = randomBytes(16).toString('hex')
  const cookieStore = await cookies()
  cookieStore.set('ebay_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 600, // 10 minutes
    sameSite: 'lax',
  })
  const url = buildAuthorizationUrl(state)
  return NextResponse.redirect(url)
})
