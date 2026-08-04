import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { withAuth } from '@/lib/middleware'
import { recategorizeActiveListing } from '@/lib/ebay/auto-list'

/**
 * POST /api/listings/[id]/recategorize
 *
 * Re-detects the eBay category from the listing's title and pushes the
 * change to the LIVE offer. Only valid for status='active' listings — drafts
 * already auto-detect their category at creation time and use the manual
 * override box instead.
 */
export const POST = withAuth(async (_req, userId, params) => {
  const listingId = params!.id
  const result = await recategorizeActiveListing(userId, listingId)

  revalidatePath('/listings')

  if (!result.success) {
    return NextResponse.json({ ok: false, ...result }, { status: 422 })
  }
  return NextResponse.json({ ok: true, ...result })
})
