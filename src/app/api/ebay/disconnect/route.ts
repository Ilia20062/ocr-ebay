import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/middleware'
import { deleteConnection } from '@/lib/ebay/token-manager'

export const DELETE = withAuth(async (_req, userId) => {
  await deleteConnection(userId)
  return new NextResponse(null, { status: 204 })
})
