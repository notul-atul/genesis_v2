/**
 * HighLevel API v2 client.
 *
 * Runtime config is read from window.__HL_CONFIG__ = { baseUrl, token, locationId }:
 *  - In the Genesis preview, baseUrl is an authenticated proxy and token is a short-lived preview token.
 *  - In production (marketplace custom page) your backend provides a location access token,
 *    and baseUrl defaults to https://services.leadconnectorhq.com.
 * App code always calls the real HighLevel paths, e.g. hl.get('/contacts/', { locationId: LOCATION_ID }).
 */
const config = window.__HL_CONFIG__ || {}

export const HL_BASE_URL = (config.baseUrl || 'https://services.leadconnectorhq.com').replace(/\/$/, '')
export const LOCATION_ID = config.locationId || ''

// HighLevel's v2 API requires this Version header on every request.
const API_VERSION = '2021-04-15'

export class HLApiError extends Error {
  constructor(message, { status = 0, path = '', body = null } = {}) {
    super(message)
    this.name = 'HLApiError'
    this.status = status
    this.path = path
    this.body = body
  }

  get isAuthError() {
    return this.status === 401 || this.status === 403
  }

  get isRateLimited() {
    return this.status === 429
  }
}

function buildUrl(path, query) {
  const url = new URL(HL_BASE_URL + (path.startsWith('/') ? path : `/${path}`))
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, String(v)))
    else url.searchParams.set(key, String(value))
  }
  return url
}

function errorMessage(body, status) {
  const m = body && (body.message || body.error || body.msg)
  if (Array.isArray(m)) return m.join(', ')
  if (typeof m === 'string' && m) return m
  if (status === 401) return 'Not authorized with HighLevel. Reconnect your account.'
  if (status === 403) return 'This app is missing a required HighLevel permission (scope).'
  if (status === 429) return 'HighLevel rate limit reached. Please wait a moment and retry.'
  return `HighLevel request failed (${status})`
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Low-level request. Sets HighLevel's required `Version` header, retries 429/5xx
 * with backoff (honouring Retry-After, max 2 retries) and throws HLApiError on failure.
 */
export async function hlRequest(path, { method = 'GET', query, body, version, signal } = {}) {
  const url = buildUrl(path, query)
  for (let attempt = 0; ; attempt++) {
    let res
    try {
      res = await fetch(url, {
        method,
        signal,
        headers: {
          Accept: 'application/json',
          Version: version || API_VERSION,
          ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      if (err && err.name === 'AbortError') throw err
      throw new HLApiError('Network error while contacting HighLevel', { path })
    }

    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    if (res.ok) return data

    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      const retryAfter = Number(res.headers.get('retry-after'))
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 600 * 2 ** attempt)
      continue
    }
    throw new HLApiError(errorMessage(data, res.status), { status: res.status, path, body: data })
  }
}

export const hl = {
  get: (path, query, opts) => hlRequest(path, { ...opts, query }),
  post: (path, body, opts) => hlRequest(path, { ...opts, method: 'POST', body }),
  put: (path, body, opts) => hlRequest(path, { ...opts, method: 'PUT', body }),
}

/**
 * Cursor pagination helper. `fetchPage(cursor)` resolves to { items, nextCursor };
 * iteration stops when nextCursor is falsy or a limit is reached.
 */
export async function collectPages(fetchPage, { maxPages = 10, maxItems = Infinity } = {}) {
  const all = []
  let cursor
  for (let page = 0; page < maxPages; page++) {
    const { items, nextCursor } = await fetchPage(cursor)
    all.push(...items)
    if (!nextCursor || all.length >= maxItems) break
    cursor = nextCursor
  }
  return all.slice(0, maxItems)
}
