import { setGlobalOptions } from 'firebase-functions'
import { onRequest } from 'firebase-functions/https'
import { OPENAI_API_KEY, APP_SECRET, HL_CLIENT_SECRET } from './config.js'
import { createApp } from './app.js'

setGlobalOptions({ region: 'us-central1', maxInstances: 10 })

/**
 * Single HTTP function hosting the REST API, the SSE generation endpoint, the
 * HighLevel OAuth callback and the preview proxy. One function keeps cold starts,
 * secrets and CORS in one place; SSE needs a long timeout and a concurrency > 1.
 */
export const api = onRequest(
  {
    secrets: [OPENAI_API_KEY, HL_CLIENT_SECRET, APP_SECRET],
    timeoutSeconds: 1800,
    memory: '1GiB',
    concurrency: 40,
    cors: false,
    invoker: 'public',
  },
  createApp(),
)
