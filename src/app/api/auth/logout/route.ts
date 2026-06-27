import { NextResponse } from 'next/server'
import { clearSessionCookies } from '@/lib/aws/auth-cookies'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  await clearSessionCookies()
  return NextResponse.json({ success: true })
}
