import { defineSecret, defineString } from 'firebase-functions/params'

export const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY')
export const HL_CLIENT_SECRET = defineSecret('HL_CLIENT_SECRET')
/** Root key for preview-token signing and OAuth token encryption at rest. */
export const APP_SECRET = defineSecret('APP_SECRET')

export const HL_CLIENT_ID = defineString('HL_CLIENT_ID')
export const HL_APP_VERSION_ID = defineString('HL_APP_VERSION_ID', { default: '' })
export const HL_REDIRECT_URI = defineString('HL_REDIRECT_URI', {
  default: 'https://genesis-v2-b77b9.web.app/api/oauth/callback',
})
export const APP_URL = defineString('APP_URL', { default: 'https://genesis-v2-b77b9.web.app' })
export const ALLOWED_ORIGINS = defineString('ALLOWED_ORIGINS', { default: '' })
export const LLM_MODEL = defineString('LLM_MODEL', { default: 'gpt-5.5' })
export const LLM_EFFORT = defineString('LLM_EFFORT', { default: 'low' })

export const HL_API_BASE = 'https://services.leadconnectorhq.com'
export const HL_AUTHORIZE_URL = 'https://marketplace.gohighlevel.com/oauth/chooselocation'

export const HL_SCOPES = [
  'contacts.readonly',
  'contacts.write',
  'conversations.readonly',
  'conversations.write',
  'conversations/message.readonly',
  'conversations/message.write',
  'calendars.readonly',
  'calendars/events.readonly',
  'calendars/events.write',
  'locations.readonly',
]

/** Hard limits that keep generation bounded and Firestore documents small. */
export const LIMITS = {
  maxFiles: 60,
  maxFileBytes: 300_000,
  maxProjectBytes: 2_000_000,
  maxPromptChars: 8_000,
  contextFileChars: 120_000,
  contextHistoryMessages: 8,
  contextHistoryCharsEach: 1_500,
  maxOutputTokens: 32_000,
  generationLockMs: 15 * 60_000,
  generationsPerHour: 30,
}
