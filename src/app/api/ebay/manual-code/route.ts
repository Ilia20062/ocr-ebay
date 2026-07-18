import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import { exchangeCodeForTokens, fetchEbayUserId } from '@/lib/ebay/auth'
import { saveConnection } from '@/lib/ebay/token-manager'

export async function POST(req: NextRequest) {
  try {
    const { code } = await req.json()
    if (!code) {
      return NextResponse.json({ error: 'No code provided' }, { status: 400 })
    }

    // Safely decode the code in case the user copied it from the URL bar (e.g. %5E instead of ^)
    // If it's already decoded, decodeURIComponent is safe as long as there are no stray % signs.
    // To be perfectly safe, we handle potential decode errors gracefully.
    let cleanCode = code.trim()
    try {
      if (cleanCode.includes('%')) {
        cleanCode = decodeURIComponent(cleanCode)
      }
    } catch (e) {
      // Ignore decode errors and try with the raw string
    }

    const supabase = await getSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Exchange the manually submitted code for a real access token
    const tokens = await exchangeCodeForTokens(cleanCode)
    if (!tokens.refresh_token) {
      return NextResponse.json(
        { error: 'eBay did not return a refresh token. Re-authorize the app from scratch.' },
        { status: 502 },
      )
    }

    // Save to database
    const ebayUserId = await fetchEbayUserId(tokens.access_token)
    await saveConnection(
      user.id,
      tokens.access_token,
      tokens.refresh_token,
      tokens.expires_in,
      ebayUserId ?? undefined,
    )

    return NextResponse.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('Manual code exchange failed:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
