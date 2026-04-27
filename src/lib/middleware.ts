import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseServerClient } from './supabase/server'

export type AuthenticatedHandler = (
  req: NextRequest,
  userId: string,
  params?: Record<string, string>
) => Promise<NextResponse>

export function withAuth(handler: AuthenticatedHandler) {
  return async (req: NextRequest, context?: { params?: Promise<Record<string, string>> }) => {
    const supabase = await getSupabaseServerClient()
    const { data: { user }, error } = await supabase.auth.getUser()

    if (error || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const params = context?.params ? await context.params : undefined
    return handler(req, user.id, params)
  }
}

export function withCron(handler: (req: NextRequest) => Promise<NextResponse>) {
  return async (req: NextRequest) => {
    const cronSecret = req.headers.get('authorization')
    if (cronSecret !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    return handler(req)
  }
}

export function apiError(message: string, status = 400, code?: string) {
  return NextResponse.json({ error: message, ...(code && { code }) }, { status })
}
