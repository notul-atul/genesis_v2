import { logger } from 'firebase-functions'
import { APP_SECRET, HL_API_BASE, HL_CLIENT_ID, HL_CLIENT_SECRET, HL_REDIRECT_URI } from '../config.js'
import { decrypt, encrypt } from '../lib/crypto.js'
import { HttpError } from '../lib/errors.js'
import { db, FieldValue } from '../lib/firebase.js'

/** Stored at hlTokens/{uid}. Server-only collection; token values are encrypted at rest. */
interface StoredTokens {
  accessTokenEnc: string
  refreshTokenEnc: string
  expiresAt: number
  locationId: string
  companyId?: string
  userType?: string
  scope?: string
  updatedAt: FirebaseFirestore.FieldValue | FirebaseFirestore.Timestamp
}

export interface HlTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  scope?: string
  userType?: string
  locationId?: string
  companyId?: string
}

export interface HlAccess {
  accessToken: string
  locationId: string
}

/** Refresh this long before the real expiry to absorb clock skew and slow requests. */
const EXPIRY_SKEW_MS = 5 * 60_000

const tokensRef = (uid: string) => db.collection('hlTokens').doc(uid)

export async function exchangeToken(params: Record<string, string>): Promise<HlTokenResponse> {
  const body = new URLSearchParams({
    client_id: HL_CLIENT_ID.value(),
    client_secret: HL_CLIENT_SECRET.value(),
    user_type: 'Location',
    redirect_uri: HL_REDIRECT_URI.value(),
    ...params,
  })
  const res = await fetch(`${HL_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(15_000),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    logger.warn('HighLevel token exchange failed', { status: res.status, error: json.error, grant: params.grant_type })
    throw new HttpError(
      res.status === 400 || res.status === 401 ? 401 : 502,
      'HL_TOKEN_EXCHANGE_FAILED',
      String(json.error_description ?? json.message ?? json.error ?? 'HighLevel rejected the token request'),
    )
  }
  return json as unknown as HlTokenResponse
}

export async function saveTokens(uid: string, t: HlTokenResponse) {
  if (!t.locationId) {
    throw new HttpError(400, 'HL_NO_LOCATION', 'Please install the app on a sub-account (location), not an agency.')
  }
  const secret = APP_SECRET.value()
  const doc: StoredTokens = {
    accessTokenEnc: encrypt(t.access_token, secret),
    refreshTokenEnc: encrypt(t.refresh_token, secret),
    expiresAt: Date.now() + t.expires_in * 1000,
    locationId: t.locationId,
    companyId: t.companyId,
    userType: t.userType,
    scope: t.scope,
    updatedAt: FieldValue.serverTimestamp(),
  }
  await tokensRef(uid).set(doc)
}

const inflightRefresh = new Map<string, Promise<HlAccess>>()

/**
 * Returns a usable access token for the user's linked location, refreshing it when
 * it is about to expire. HighLevel rotates refresh tokens on every use, so refreshes
 * are de-duplicated in-process and committed with a compare-and-swap so two instances
 * racing each other cannot overwrite a newer token with an older one.
 */
export async function getValidAccess(uid: string, opts: { forceRefresh?: boolean } = {}): Promise<HlAccess> {
  const snap = await tokensRef(uid).get()
  if (!snap.exists) {
    throw new HttpError(412, 'HL_NOT_CONNECTED', 'Connect your HighLevel account first.')
  }
  const stored = snap.data() as StoredTokens
  const secret = APP_SECRET.value()
  if (!opts.forceRefresh && stored.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return { accessToken: decrypt(stored.accessTokenEnc, secret), locationId: stored.locationId }
  }

  let pending = inflightRefresh.get(uid)
  if (!pending) {
    pending = refresh(uid, stored).finally(() => inflightRefresh.delete(uid))
    inflightRefresh.set(uid, pending)
  }
  return pending
}

async function refresh(uid: string, stored: StoredTokens): Promise<HlAccess> {
  const secret = APP_SECRET.value()
  let fresh: HlTokenResponse
  try {
    fresh = await exchangeToken({ grant_type: 'refresh_token', refresh_token: decrypt(stored.refreshTokenEnc, secret) })
  } catch (err) {
    // Another instance may have rotated the refresh token under us; use its result.
    const latest = (await tokensRef(uid).get()).data() as StoredTokens | undefined
    if (latest && latest.refreshTokenEnc !== stored.refreshTokenEnc && latest.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
      return { accessToken: decrypt(latest.accessTokenEnc, secret), locationId: latest.locationId }
    }
    if (err instanceof HttpError && err.status === 401) {
      await db.collection('users').doc(uid).set({ hl: { status: 'expired' } }, { merge: true })
      throw new HttpError(401, 'HL_RECONNECT_REQUIRED', 'Your HighLevel connection expired. Please reconnect.')
    }
    throw err
  }

  await db.runTransaction(async (tx) => {
    const current = (await tx.get(tokensRef(uid))).data() as StoredTokens | undefined
    if (current && current.refreshTokenEnc !== stored.refreshTokenEnc) return // someone else won
    tx.set(tokensRef(uid), {
      ...stored,
      accessTokenEnc: encrypt(fresh.access_token, secret),
      refreshTokenEnc: encrypt(fresh.refresh_token, secret),
      expiresAt: Date.now() + fresh.expires_in * 1000,
      scope: fresh.scope ?? stored.scope,
      updatedAt: FieldValue.serverTimestamp(),
    })
  })
  logger.info('Refreshed HighLevel token', { uid })
  return { accessToken: fresh.access_token, locationId: stored.locationId }
}

export async function deleteTokens(uid: string) {
  await tokensRef(uid).delete()
}
