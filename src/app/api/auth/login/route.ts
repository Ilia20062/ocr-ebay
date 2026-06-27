import { NextRequest, NextResponse } from 'next/server'
import { signInWithPassword } from '@/lib/aws/cognito'
import { setSessionCookies } from '@/lib/aws/auth-cookies'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  let body: { email?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  if (!body.email || !body.password) {
    return NextResponse.json({ error: 'Email and password are required' }, { status: 422 })
  }

  try {
    const { tokens, user } = await signInWithPassword(body.email, body.password)
    await setSessionCookies(tokens)
    return NextResponse.json({ user: { id: user.sub, email: user.email } })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 401 })
  }
}
