import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  SignUpCommand,
  AdminConfirmSignUpCommand,
  AdminUpdateUserAttributesCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

/**
 * Amazon Cognito auth backend, replacing Supabase Auth (GoTrue).
 *
 * - signup/login/refresh use the User Pool app client (USER_PASSWORD_AUTH,
 *   no client secret).
 * - ID-token verification uses the pool's JWKS endpoint.
 */

function region(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
}
function userPoolId(): string {
  const v = process.env.COGNITO_USER_POOL_ID
  if (!v) throw new Error('COGNITO_USER_POOL_ID is not set')
  return v
}
function clientId(): string {
  const v = process.env.COGNITO_CLIENT_ID
  if (!v) throw new Error('COGNITO_CLIENT_ID is not set')
  return v
}

let idp: CognitoIdentityProviderClient | null = null
function idpClient(): CognitoIdentityProviderClient {
  if (!idp) idp = new CognitoIdentityProviderClient({ region: region() })
  return idp
}

export interface AuthTokens {
  idToken: string
  accessToken: string
  refreshToken?: string
  expiresIn: number
}

export interface AuthUser {
  sub: string
  email: string
}

export interface AuthResult {
  tokens: AuthTokens
  user: AuthUser
}

// ---- JWKS / verification ----
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null
function getJwks() {
  if (!jwks) {
    const url = new URL(
      `https://cognito-idp.${region()}.amazonaws.com/${userPoolId()}/.well-known/jwks.json`
    )
    jwks = createRemoteJWKSet(url)
  }
  return jwks
}

export async function verifyIdToken(token: string): Promise<AuthUser> {
  const issuer = `https://cognito-idp.${region()}.amazonaws.com/${userPoolId()}`
  const { payload } = await jwtVerify(token, getJwks(), { issuer })
  const p = payload as JWTPayload & { token_use?: string; email?: string; aud?: string }
  if (p.token_use !== 'id') throw new Error('Not an ID token')
  if (p.aud !== clientId()) throw new Error('Token audience mismatch')
  if (!p.sub) throw new Error('Token missing sub')
  return { sub: p.sub, email: p.email ?? '' }
}

function tokensFromAuthResult(
  res: { AccessToken?: string; IdToken?: string; RefreshToken?: string; ExpiresIn?: number }
): AuthTokens {
  if (!res.IdToken || !res.AccessToken) throw new Error('Cognito returned no tokens')
  return {
    idToken: res.IdToken,
    accessToken: res.AccessToken,
    refreshToken: res.RefreshToken,
    expiresIn: res.ExpiresIn ?? 3600,
  }
}

function friendlyError(err: unknown): Error {
  const name = (err as { name?: string }).name
  switch (name) {
    case 'NotAuthorizedException':
      return new Error('Invalid login credentials')
    case 'UserNotFoundException':
      return new Error('Invalid login credentials')
    case 'UsernameExistsException':
      return new Error('An account with this email already exists')
    case 'InvalidPasswordException':
      return new Error('Password does not meet requirements')
    case 'UserNotConfirmedException':
      return new Error('Account not confirmed')
    default:
      return new Error((err as Error).message || 'Authentication failed')
  }
}

export async function signInWithPassword(email: string, password: string): Promise<AuthResult> {
  try {
    const res = await idpClient().send(
      new InitiateAuthCommand({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: clientId(),
        AuthParameters: { USERNAME: email, PASSWORD: password },
      })
    )
    const tokens = tokensFromAuthResult(res.AuthenticationResult ?? {})
    const user = await verifyIdToken(tokens.idToken)
    return { tokens, user }
  } catch (err) {
    throw friendlyError(err)
  }
}

export async function refreshIdToken(refreshToken: string): Promise<AuthTokens> {
  const res = await idpClient().send(
    new InitiateAuthCommand({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: clientId(),
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    })
  )
  // Refresh responses omit the refresh token; the caller keeps the existing one.
  return tokensFromAuthResult(res.AuthenticationResult ?? {})
}

/**
 * Self-service signup: create the user, auto-confirm it (no email verification
 * is wired up), mark the email verified, then sign in to mint a session.
 * The caller is responsible for inserting the matching `profiles` row.
 */
export async function signUp(
  email: string,
  password: string,
  fullName?: string
): Promise<AuthResult & { fullName?: string }> {
  try {
    await idpClient().send(
      new SignUpCommand({
        ClientId: clientId(),
        Username: email,
        Password: password,
        UserAttributes: [
          { Name: 'email', Value: email },
          ...(fullName ? [{ Name: 'name', Value: fullName }] : []),
        ],
      })
    )
    await idpClient().send(
      new AdminConfirmSignUpCommand({ UserPoolId: userPoolId(), Username: email })
    )
    await idpClient().send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: userPoolId(),
        Username: email,
        UserAttributes: [{ Name: 'email_verified', Value: 'true' }],
      })
    )
    const result = await signInWithPassword(email, password)
    return { ...result, fullName }
  } catch (err) {
    throw friendlyError(err)
  }
}
