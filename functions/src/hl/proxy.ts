import type { Request, Response } from 'express'
import { logger } from 'firebase-functions'
import { APP_SECRET, HL_API_BASE } from '../config.js'
import { HttpError } from '../lib/errors.js'
import { enforceMemoryRateLimit } from '../lib/rateLimit.js'
import { versionFor } from './client.js'
import { readPreviewToken } from './previewToken.js'
import { getValidAccess } from './tokens.js'

/** Only the API areas Genesis apps are allowed to touch. */
const ALLOWED_PATH = /^\/(contacts|conversations|calendars|locations)(\/|$|\?)/
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT'])

/**
 * Transparent HighLevel proxy for previews. Generated code calls the exact HL v2
 * path (e.g. GET {base}/contacts/?locationId=...), so the same code works against
 * services.leadconnectorhq.com when deployed as a real marketplace app.
 */
export async function hlProxy(req: Request, res: Response) {
  // Sandboxed srcdoc iframes have an opaque ("null") origin; auth is the bearer token, not cookies.
  res.set('Access-Control-Allow-Origin', '*')
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Version, Accept')
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
  res.set('Access-Control-Max-Age', '600')
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }

  const token = (req.header('authorization') ?? '').replace(/^Bearer /, '')
  const claims = token ? readPreviewToken(token, APP_SECRET.value()) : null
  if (!claims) throw new HttpError(401, 'PREVIEW_TOKEN_INVALID', 'Preview session expired. Reload the preview.')

  // req.url is relative to the mount point: "/contacts/?locationId=..."
  const target = req.url
  if (!ALLOWED_PATH.test(target) || target.includes('..')) {
    throw new HttpError(403, 'PATH_NOT_ALLOWED', `Genesis previews may only call Contacts, Conversations, Calendars and Locations APIs (got ${req.path})`)
  }
  if (!ALLOWED_METHODS.has(req.method)) {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', `${req.method} is disabled in previews`)
  }
  enforceMemoryRateLimit(`proxy_${claims.uid}`, 240, 60_000)

  const hasBody = req.method !== 'GET' && req.body !== undefined && Object.keys(req.body ?? {}).length > 0
  for (let attempt = 0; attempt < 2; attempt++) {
    const access = await getValidAccess(claims.uid, { forceRefresh: attempt > 0 })
    if (access.locationId !== claims.loc) {
      throw new HttpError(409, 'LOCATION_MISMATCH', 'This project is linked to a different HighLevel location than your current connection.')
    }
    const upstream = await fetch(HL_API_BASE + target, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${access.accessToken}`,
        Version: req.header('version') ?? versionFor(req.path),
        Accept: 'application/json',
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      body: hasBody ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    }).catch((err) => {
      logger.warn('HL proxy network error', { target, err: String(err) })
      throw new HttpError(504, 'HL_UNREACHABLE', 'HighLevel did not respond in time')
    })

    if (upstream.status === 401 && attempt === 0) continue // token revoked/rotated early: refresh once

    const text = await upstream.text()
    res.status(upstream.status)
    res.set('Content-Type', upstream.headers.get('content-type') ?? 'application/json')
    for (const h of ['retry-after', 'x-ratelimit-remaining', 'x-ratelimit-max']) {
      const v = upstream.headers.get(h)
      if (v) res.set(h, v)
    }
    res.send(text)
    return
  }
}
