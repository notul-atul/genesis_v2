import { HL_API_BASE } from '../config.js'
import { HttpError } from '../lib/errors.js'
import { getValidAccess } from './tokens.js'

/**
 * Value for HighLevel's required `Version` header. Verified against the live API:
 * every v2 endpoint we use (contacts, conversations, calendars, locations) accepts
 * only 2021-04-15 and answers 401 "version header is invalid" for 2021-07-22.
 */
export const HL_API_VERSION = '2021-04-15'

/**
 * A 401 from HighLevel only means the access token is bad when the message says so.
 * Version-header and scope problems also come back as 401 and must not trigger a
 * token refresh (refresh tokens rotate on every use).
 */
export function isTokenRejection(status: number, body: unknown): boolean {
  if (status !== 401) return false
  const raw = (body as { message?: unknown } | null)?.message
  const msg = (Array.isArray(raw) ? raw.join(' ') : String(raw ?? '')).toLowerCase()
  return !/version header|scope|not authorized for this/.test(msg)
}

export interface HlFetchOptions {
  method?: string
  query?: Record<string, string | number | undefined>
  body?: unknown
  timeoutMs?: number
}

/** Server-side HighLevel call on behalf of a user, with one forced refresh if the token is rejected. */
export async function hlFetch<T>(uid: string, path: string, opts: HlFetchOptions = {}): Promise<T> {
  const url = new URL(HL_API_BASE + path)
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v))

  for (let attempt = 0; attempt < 2; attempt++) {
    const { accessToken } = await getValidAccess(uid, { forceRefresh: attempt > 0 })
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Version: HL_API_VERSION,
        Accept: 'application/json',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    })
    const json = await res.json().catch(() => null)
    if (attempt === 0 && isTokenRejection(res.status, json)) continue
    if (!res.ok) {
      const msg = (json as { message?: unknown } | null)?.message
      throw new HttpError(res.status >= 500 ? 502 : res.status, 'HL_API_ERROR', `HighLevel ${res.status}: ${Array.isArray(msg) ? msg.join(', ') : (msg ?? res.statusText)}`)
    }
    return json as T
  }
  throw new HttpError(401, 'HL_UNAUTHORIZED', 'HighLevel rejected the access token')
}
