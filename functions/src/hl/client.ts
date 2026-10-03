import { HL_API_BASE } from '../config.js'
import { HttpError } from '../lib/errors.js'
import { getValidAccess } from './tokens.js'

/** API version header per resource, per the HighLevel v2 docs. */
export function versionFor(path: string): string {
  return /^\/(conversations|calendars)\b/.test(path) ? '2021-04-15' : '2021-07-22'
}

export interface HlFetchOptions {
  method?: string
  query?: Record<string, string | number | undefined>
  body?: unknown
  timeoutMs?: number
}

/** Server-side HighLevel call on behalf of a user, with one forced refresh on 401. */
export async function hlFetch<T>(uid: string, path: string, opts: HlFetchOptions = {}): Promise<T> {
  const url = new URL(HL_API_BASE + path)
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v))

  for (let attempt = 0; attempt < 2; attempt++) {
    const { accessToken } = await getValidAccess(uid, { forceRefresh: attempt > 0 })
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Version: versionFor(path),
        Accept: 'application/json',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    })
    if (res.status === 401 && attempt === 0) continue
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      const msg = (json as { message?: unknown } | null)?.message
      throw new HttpError(res.status >= 500 ? 502 : res.status, 'HL_API_ERROR', `HighLevel ${res.status}: ${Array.isArray(msg) ? msg.join(', ') : (msg ?? res.statusText)}`)
    }
    return json as T
  }
  throw new HttpError(401, 'HL_UNAUTHORIZED', 'HighLevel rejected the access token')
}
