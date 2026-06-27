'use client'

/**
 * Browser auth client. Backed by Cognito via our own `/api/auth/*` route
 * handlers (which perform the Cognito calls server-side and set httpOnly
 * session cookies). The returned object preserves the supabase-js
 * `auth.signInWithPassword / signUp / signOut` surface and `{ error }` shape.
 */

interface AuthError {
  message: string
}

async function postAuth(path: string, body?: unknown): Promise<{ error: AuthError | null }> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      return { error: { message: j.error ?? `Request failed (${res.status})` } }
    }
    return { error: null }
  } catch (err) {
    return { error: { message: (err as Error).message } }
  }
}

interface BrowserAuthClient {
  auth: {
    signInWithPassword(creds: { email: string; password: string }): Promise<{ error: AuthError | null }>
    signUp(args: {
      email: string
      password: string
      options?: { data?: { full_name?: string } }
    }): Promise<{ error: AuthError | null }>
    signOut(): Promise<{ error: AuthError | null }>
  }
}

let client: BrowserAuthClient | null = null

export function getSupabaseBrowserClient(): BrowserAuthClient {
  if (!client) {
    client = {
      auth: {
        signInWithPassword: ({ email, password }) =>
          postAuth('/api/auth/login', { email, password }),
        signUp: ({ email, password, options }) =>
          postAuth('/api/auth/signup', {
            email,
            password,
            full_name: options?.data?.full_name,
          }),
        signOut: () => postAuth('/api/auth/logout'),
      },
    }
  }
  return client
}
