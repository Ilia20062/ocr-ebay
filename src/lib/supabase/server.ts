import { createServerClient, type ServerClient } from '@/lib/aws/client'

/**
 * Backed by AWS (RDS Postgres + S3 + Cognito) instead of Supabase. Returns the
 * same `.from()/.storage/.auth.getUser()` surface the app already uses.
 *
 * Kept async to preserve the original call signature
 * (`await getSupabaseServerClient()`).
 */
export async function getSupabaseServerClient(): Promise<ServerClient> {
  return createServerClient()
}
