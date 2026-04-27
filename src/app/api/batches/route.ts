import { NextRequest, NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'

export const POST = withAuth(async (_req, userId) => {
  const db = getSupabaseAdminClient()
  const { data, error } = await db
    .from('upload_batches')
    .insert({ user_id: userId, status: 'pending' })
    .select()
    .single()

  if (error) return apiError('Failed to create batch', 500)
  return NextResponse.json(data, { status: 201 })
})

export const GET = withAuth(async (req, userId) => {
  const db = getSupabaseAdminClient()
  const url = new URL(req.url)
  const page = parseInt(url.searchParams.get('page') ?? '1')
  const limit = 20
  const offset = (page - 1) * limit

  const { data, error, count } = await db
    .from('upload_batches')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) return apiError('Failed to fetch batches', 500)
  return NextResponse.json({ data, total: count, page })
})
