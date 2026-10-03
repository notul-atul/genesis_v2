import express, { type NextFunction, type Request, type Response } from 'express'
import { ALLOWED_ORIGINS, APP_URL } from './config.js'
import { errorHandler } from './lib/errors.js'
import { generationRouter } from './generation/routes.js'
import { oauthRouter } from './hl/oauthRoutes.js'
import { hlProxy } from './hl/proxy.js'
import { projectsRouter } from './projects/routes.js'

function cors(req: Request, res: Response, next: NextFunction) {
  const origin = req.header('origin')
  const allowed = [APP_URL.value(), ...ALLOWED_ORIGINS.value().split(',')].map((o) => o.trim()).filter(Boolean)
  // Firebase Hosting also serves the app on the *.firebaseapp.com domain.
  const firebaseAlias = APP_URL.value().replace('.web.app', '.firebaseapp.com')
  if (origin && (allowed.includes(origin) || origin === firebaseAlias)) {
    res.set('Access-Control-Allow-Origin', origin)
    res.set('Vary', 'Origin')
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.set('Access-Control-Max-Age', '600')
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }
  next()
}

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', true)

  const api = express.Router()
  // The proxy has its own permissive CORS (sandboxed iframe origin is "null").
  api.use('/hl-proxy', express.json({ limit: '1mb' }), hlProxy)
  api.use(cors)
  api.use(express.json({ limit: '2mb' }))
  api.get('/health', (_req, res) => {
    res.json({ ok: true })
  })
  api.use(oauthRouter)
  api.use(projectsRouter)
  api.use(generationRouter)

  // Reachable both directly (cloudfunctions.net/api/...) and via the Hosting rewrite (/api/...).
  app.use('/api', api)
  app.use(api)
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } })
  })
  app.use(errorHandler)
  return app
}
