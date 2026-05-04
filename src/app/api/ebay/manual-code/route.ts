import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import { exchangeCodeForTokens } from '@/lib/ebay/auth'
import { saveConnection } from '@/lib/ebay/token-manager'

export async function POST(req: NextRequest) {
  try {
    const { code } = await req.json()
    if (!code) {
      return NextResponse.json({ error: 'No code provided' }, { status: 400 })
    }

    const supabase = await getSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Exchange the manually submitted code for a real access token
    const tokens = await exchangeCodeForTokens(code)
    
    // Save to database
    await saveConnection(user.id, tokens.access_token, tokens.refresh_token, tokens.expires_in)

    return NextResponse.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('Manual code exchange failed:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
