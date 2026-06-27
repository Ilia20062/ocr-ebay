import { createAdminClient, type DbClient } from '@/lib/aws/client'

/**
 * Backed by AWS (RDS Postgres + S3) instead of Supabase. The exported function
 * name is unchanged so existing call sites keep working; the returned object
 * exposes the same `.from()/.storage` surface.
 */
export function getSupabaseAdminClient(): DbClient {
  return createAdminClient()
}
