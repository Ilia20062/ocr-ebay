import { NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'

type SearchWithOwner = { id: string; upload_batches: { user_id: string } }

export const GET = withAuth(async (_req, userId, params) => {
  const db = getSupabaseAdminClient()
  const { data, error } = await db
    .from('product_searches')
    .select('*, upload_batches!inner(user_id)')
    .eq('id', params!.id)
    .single()

  const result = data as unknown as SearchWithOwner | null
  if (error || !result || result.upload_batches.user_id !== userId) return apiError('Search not found', 404)
  return NextResponse.json(data)
})

export const PATCH = withAuth(async (req, userId, params) => {
  const body = await req.json() as { selected_item_id: string }
  if (!body.selected_item_id) return apiError('selected_item_id required', 422)

  const db = getSupabaseAdminClient()
  const { data, error } = await db
    .from('product_searches')
    .select('id, upload_batches!inner(user_id)')
    .eq('id', params!.id)
    .single()

  const result = data as unknown as SearchWithOwner | null
  if (error || !result || result.upload_batches.user_id !== userId) return apiError('Search not found', 404)

  await db.from('product_searches').update({ selected_item_id: body.selected_item_id }).eq('id', params!.id)
  return NextResponse.json({ success: true })
})
