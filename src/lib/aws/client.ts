import { QueryBuilder } from './query-builder'
import { storage } from './storage'
import { getUser } from './server-auth'

/**
 * Assembles the AWS-backed clients that stand in for the Supabase clients.
 * The `.from()/.storage/.auth` surface matches what the app already calls.
 */

export interface DbClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from<T = any>(table: string): QueryBuilder<T>
  storage: typeof storage
}

export interface ServerClient extends DbClient {
  auth: {
    getUser: typeof getUser
  }
}

/** Admin client: full DB + storage access (no row-level scoping; ownership is
 *  enforced in application code, as it was with the Supabase service role). */
export function createAdminClient(): DbClient {
  return {
    from: <T>(table: string) => new QueryBuilder<T>(table),
    storage,
  }
}

/** Server client: same DB/storage plus Cognito-backed auth. */
export function createServerClient(): ServerClient {
  return {
    from: <T>(table: string) => new QueryBuilder<T>(table),
    storage,
    auth: { getUser },
  }
}
