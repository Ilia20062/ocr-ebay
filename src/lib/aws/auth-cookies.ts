import { cookies } from 'next/headers'
import type { AuthTokens } from './cognito'

/**
 * Session cookie management. Mirrors what Supabase-SSR did with its auth
 * cookies, but stores Cognito tokens instead.
 *
 * Cookie writes from a Server Component throw in Next; callers tolerate that
 * (route handlers / server actions perform the durable refresh), matching the
 * original `server.ts` behaviour.
 */

export const ID_TOKEN_COOKIE = 'id_token'
export const REFRESH_TOKEN_COOKIE = 'refresh_token'

const ID_TOKEN_MAX_AGE = 60 * 60 * 24 // 1 day
const REFRESH_TOKEN_MAX_AGE = 60 * 60 * 24 * 30 // 30 days

function baseOpts() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  }
}

export async function setSessionCookies(tokens: AuthTokens): Promise<void> {
  const store = await cookies()
  store.set(ID_TOKEN_COOKIE, tokens.idToken, { ...baseOpts(), maxAge: ID_TOKEN_MAX_AGE })
  if (tokens.refreshToken) {
    store.set(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
      ...baseOpts(),
      maxAge: REFRESH_TOKEN_MAX_AGE,
    })
  }
}

export async function setIdTokenCookie(idToken: string): Promise<void> {
  const store = await cookies()
  store.set(ID_TOKEN_COOKIE, idToken, { ...baseOpts(), maxAge: ID_TOKEN_MAX_AGE })
}

export async function clearSessionCookies(): Promise<void> {
  const store = await cookies()
  store.delete(ID_TOKEN_COOKIE)
  store.delete(REFRESH_TOKEN_COOKIE)
}
