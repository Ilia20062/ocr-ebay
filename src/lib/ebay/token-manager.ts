import { encrypt, decrypt } from '@/lib/encryption'
import { getSupabaseAdminClient } from '@/lib/supabase/admin'
import { refreshAccessToken } from './auth'
import type { EbayConnection } from '@/types/database'

export async function getDecryptedConnection(userId: string): Promise<EbayConnection | null> {
  const db = getSupabaseAdminClient()
  const { data, error } = await db
    .from('ebay_connections')
    .select('*')
    .eq('user_id', userId)
    .single()

  if (error || !data) return null

  return {
    ...data,
    access_token: decrypt(data.access_token),
    refresh_token: decrypt(data.refresh_token),
  }
}

export async function saveConnection(
  userId: string,
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  ebayUserId?: string
) {
  const db = getSupabaseAdminClient()
  const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()

  await db.from('ebay_connections').upsert({
    user_id: userId,
    access_token: encrypt(accessToken),
    refresh_token: encrypt(refreshToken),
    token_expires_at: tokenExpiresAt,
    ebay_user_id: ebayUserId ?? null,
    marketplace_id: process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US',
  }, { onConflict: 'user_id' })
}

export async function getFreshAccessToken(userId: string): Promise<string> {
  const connection = await getDecryptedConnection(userId)
  if (!connection) throw new Error('EBAY_NOT_CONNECTED')

  const expiresAt = new Date(connection.token_expires_at).getTime()
  const bufferMs = 5 * 60 * 1000 // refresh if expiring within 5 minutes

  if (Date.now() + bufferMs < expiresAt) {
    return connection.access_token
  }

  // Token is expiring, refresh it
  const tokens = await refreshAccessToken(connection.refresh_token)
  await saveConnection(userId, tokens.access_token, tokens.refresh_token, tokens.expires_in)
  return tokens.access_token
}

export async function deleteConnection(userId: string) {
  const db = getSupabaseAdminClient()
  await db.from('ebay_connections').delete().eq('user_id', userId)
}
