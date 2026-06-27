import { cookies } from 'next/headers'
import { verifyIdToken, refreshIdToken } from './cognito'
import { ID_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, setIdTokenCookie } from './auth-cookies'

export interface SessionUser {
  id: string
  email: string
}

export interface GetUserResult {
  data: { user: SessionUser | null }
  error: { message: string } | null
}

/**
 * Server-side equivalent of `supabase.auth.getUser()`.
 * Verifies the ID-token cookie; if it has expired, transparently refreshes it
 * using the refresh-token cookie (persisting the new ID token when the calling
 * context permits cookie writes).
 */
export async function getUser(): Promise<GetUserResult> {
  const store = await cookies()
  const idToken = store.get(ID_TOKEN_COOKIE)?.value

  if (idToken) {
    try {
      const u = await verifyIdToken(idToken)
      return { data: { user: { id: u.sub, email: u.email } }, error: null }
    } catch {
      // expired/invalid — try refresh below
    }
  }

  const refresh = store.get(REFRESH_TOKEN_COOKIE)?.value
  if (refresh) {
    try {
      const t = await refreshIdToken(refresh)
      const u = await verifyIdToken(t.idToken)
      try {
        await setIdTokenCookie(t.idToken)
      } catch {
        // Server Component context — write ignored; next route handler refreshes.
      }
      return { data: { user: { id: u.sub, email: u.email } }, error: null }
    } catch {
      // refresh failed — treat as unauthenticated
    }
  }

  return { data: { user: null }, error: { message: 'Not authenticated' } }
}
