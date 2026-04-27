import { NextRequest, NextResponse } from 'next/server'
import { withAuth, apiError } from '@/lib/middleware'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { endListing } from '@/lib/ebay/inventory'
import type { Database } from '@/types/supabase'

export const GET = withAuth(async (_req, userId, params) => {
  const db = getSupabaseAdminClient()
  const { data, error } = await db
    .from('listings')
    .select('*')
    .eq('id', params!.id)
    .eq('user_id', userId)
    .single()

  if (error || !data) return apiError('Listing not found', 404)
  return NextResponse.json(data)
})

export const PATCH = withAuth(async (req, userId, params) => {
  const body = await req.json()
  const db = getSupabaseAdminClient()

  const { data } = await db
    .from('listings')
    .select('status')
    .eq('id', params!.id)
    .eq('user_id', userId)
    .single()

  if (!data) return apiError('Listing not found', 404)
  if (data.status === 'active') return apiError('Cannot edit an active listing', 409)

  const allowed = new Set(['title', 'description', 'price', 'quantity', 'condition'])
  const updates = Object.fromEntries(
    Object.entries(body as Record<string, unknown>).filter(([k]) => allowed.has(k))
  ) as Database['public']['Tables']['listings']['Update']

  await db.from('listings').update(updates).eq('id', params!.id)
  return NextResponse.json({ success: true })
})

export const DELETE = withAuth(async (_req, userId, params) => {
  const db = getSupabaseAdminClient()
  const { data } = await db
    .from('listings')
    .select('ebay_item_id, status')
    .eq('id', params!.id)
    .eq('user_id', userId)
    .single()

  if (!data) return apiError('Listing not found', 404)

  if (data.status === 'active' && data.ebay_item_id) {
    try {
      await endListing(userId, data.ebay_item_id)
    } catch {
      // Continue even if eBay end fails — mark locally as ended
    }
  }

  await db.from('listings').update({ status: 'ended' }).eq('id', params!.id)
  return new NextResponse(null, { status: 204 })
})
