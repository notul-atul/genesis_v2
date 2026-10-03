import { signToken, verifyToken } from '../lib/crypto.js'

/**
 * Credential handed to the sandboxed preview iframe. It is scoped to one
 * user + project + location, expires quickly and can only reach the HL proxy;
 * the real OAuth token never leaves the server.
 */
export interface PreviewClaims {
  typ: 'preview'
  uid: string
  pid: string
  loc: string
  exp: number
}

export const PREVIEW_TOKEN_TTL_MS = 60 * 60_000

export function issuePreviewToken(claims: Omit<PreviewClaims, 'typ' | 'exp'>, secret: string, now = Date.now()) {
  const exp = now + PREVIEW_TOKEN_TTL_MS
  return { token: signToken({ typ: 'preview', ...claims, exp }, secret), expiresAt: exp }
}

export function readPreviewToken(token: string, secret: string, now = Date.now()): PreviewClaims | null {
  const claims = verifyToken<PreviewClaims>(token, secret)
  if (!claims || claims.typ !== 'preview' || claims.exp < now) return null
  return claims
}
