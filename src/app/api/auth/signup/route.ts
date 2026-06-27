import { NextRequest, NextResponse } from 'next/server'
import { signUp } from '@/lib/aws/cognito'
import { setSessionCookies } from '@/lib/aws/auth-cookies'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  let body: { email?: string; password?: string; full_name?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  if (!body.email || !body.password) {
    return NextResponse.json({ error: 'Email and password are required' }, { status: 422 })
  }

  try {
    const { tokens, user, fullName } = await signUp(body.email, body.password, body.full_name)

    // Replaces the Supabase `handle_new_user` trigger: create the profile row.
    const db = getSupabaseAdminClient()
    const { error: profileErr } = await db
      .from('profiles')
      .upsert({ id: user.sub, email: user.email, full_name: fullName ?? null }, { onConflict: 'id' })
    if (profileErr) {
      return NextResponse.json({ error: 'Failed to create profile' }, { status: 500 })
    }

    await setSessionCookies(tokens)
    return NextResponse.json({ user: { id: user.sub, email: user.email } })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}
