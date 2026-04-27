import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseServerClient } from '@/lib/supabase/server'
import { exchangeCodeForTokens } from '@/lib/ebay/auth'
import { saveConnection } from '@/lib/ebay/token-manager'
import { cookies } from 'next/headers'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  const appUrl = process.env.NEXT_PUBLIC_APP_URL!
  const cookieStore = await cookies()
  const savedState = cookieStore.get('ebay_oauth_state')?.value

  if (error || !code || !state || state !== savedState) {
    return NextResponse.redirect(`${appUrl}/settings/ebay?error=oauth_failed`)
  }

  cookieStore.delete('ebay_oauth_state')

  const supabase = await getSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(`${appUrl}/login`)

  try {
    const tokens = await exchangeCodeForTokens(code)
    await saveConnection(user.id, tokens.access_token, tokens.refresh_token, tokens.expires_in)
    return NextResponse.redirect(`${appUrl}/settings/ebay?connected=true`)
  } catch {
    return NextResponse.redirect(`${appUrl}/settings/ebay?error=token_exchange_failed`)
  }
}
