import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import { logger } from 'firebase-functions'
import { APP_URL, HL_APP_VERSION_ID, HL_AUTHORIZE_URL, HL_CLIENT_ID, HL_REDIRECT_URI, HL_SCOPES } from '../config.js'
import { requireAuth, type AuthedRequest } from '../lib/auth.js'
import { HttpError } from '../lib/errors.js'
import { db, FieldValue } from '../lib/firebase.js'
import { enforceRateLimit } from '../lib/rateLimit.js'
import { hlFetch } from './client.js'
import { deleteTokens, exchangeToken, saveTokens } from './tokens.js'

export const oauthRouter = Router()

const STATE_TTL_MS = 10 * 60_000

/** Step 1: create a single-use `state` bound to the Firebase user and return the consent URL. */
oauthRouter.post('/oauth/start', requireAuth, async (req, res) => {
  const { uid } = req as AuthedRequest
  await enforceRateLimit(`oauth_${uid}`, 20, 600)
  const state = randomBytes(24).toString('base64url')
  await db.collection('oauthStates').doc(state).set({
    uid,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  })
  const url = new URL(HL_AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', HL_CLIENT_ID.value())
  url.searchParams.set('redirect_uri', HL_REDIRECT_URI.value())
  url.searchParams.set('scope', HL_SCOPES.join(' '))
  url.searchParams.set('state', state)
  // HighLevel's marketplace rejects installs without an app version ("No AppVersion Id found").
  // Client IDs are "<appId>-<suffix>"; an app's first version id equals its app id.
  const versionId = HL_APP_VERSION_ID.value() || HL_CLIENT_ID.value().split('-')[0]
  url.searchParams.set('version_id', versionId)
  res.json({ url: url.toString() })
})

/** Step 2: HighLevel redirects here (registered redirect URI). Browser navigation, so we answer with redirects. */
oauthRouter.get('/oauth/callback', async (req, res) => {
  const back = (params: Record<string, string>) =>
    res.redirect(302, `${APP_URL.value()}/dashboard?${new URLSearchParams(params).toString()}`)

  const code = typeof req.query.code === 'string' ? req.query.code : ''
  const state = typeof req.query.state === 'string' ? req.query.state : ''
  if (req.query.error) return back({ hl_error: String(req.query.error_description ?? req.query.error) })
  if (!code) return back({ hl_error: 'Missing authorization code' })

  // HighLevel's "install from marketplace" flow may omit our state. We only accept
  // callbacks we initiated, otherwise the tokens could not be attributed to a user.
  const stateRef = db.collection('oauthStates').doc(state || '_')
  const uid = await db.runTransaction(async (tx) => {
    const snap = await tx.get(stateRef)
    if (!snap.exists) return null
    tx.delete(stateRef) // single use
    const expiresAt = (snap.get('expiresAt') as FirebaseFirestore.Timestamp).toMillis()
    return expiresAt > Date.now() ? (snap.get('uid') as string) : null
  })
  if (!uid) return back({ hl_error: 'This connection link expired. Start again from the dashboard.' })

  try {
    const tokens = await exchangeToken({ grant_type: 'authorization_code', code })
    await saveTokens(uid, tokens)

    let locationName = tokens.locationId!
    let timezone: string | undefined
    try {
      const { location } = await hlFetch<{ location: { name?: string; timezone?: string } }>(
        uid,
        `/locations/${tokens.locationId}`,
      )
      locationName = location.name || locationName
      timezone = location.timezone
    } catch (err) {
      logger.warn('Could not load HighLevel location details', { err })
    }

    await db.collection('users').doc(uid).set(
      {
        hl: {
          status: 'connected',
          locationId: tokens.locationId,
          locationName,
          timezone: timezone ?? null,
          companyId: tokens.companyId ?? null,
          scopes: tokens.scope?.split(' ') ?? [],
          connectedAt: FieldValue.serverTimestamp(),
        },
      },
      { merge: true },
    )
    return back({ hl: 'connected' })
  } catch (err) {
    logger.error('OAuth callback failed', { err })
    return back({ hl_error: err instanceof HttpError ? err.message : 'Could not connect HighLevel' })
  }
})

oauthRouter.post('/oauth/disconnect', requireAuth, async (req, res) => {
  const { uid } = req as AuthedRequest
  await deleteTokens(uid)
  await db.collection('users').doc(uid).set({ hl: FieldValue.delete() }, { merge: true })
  res.json({ ok: true })
})
