import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { withAuth, apiError } from '@/lib/middleware'
import { publishListing } from '@/lib/ebay/auto-list'

/**
 * POST /api/listings/[id]/publish
 *
 * Pushes a draft (or previously-failed) listing onto eBay. Idempotent in the
 * sense that publishListing skips already-active rows. This is what the
 * "Publish to eBay" button on /listings hits; /retry is an alias.
 */
export const POST = withAuth(async (_req, userId, params) => {
  const listingId = params!.id
  const result = await publishListing(userId, listingId)

  revalidatePath('/listings')
  revalidatePath('/dashboard')

  if (!result.success) {
    return NextResponse.json({ ok: false, ...result }, { status: 502 })
  }
  return NextResponse.json({ ok: true, ...result })
})
