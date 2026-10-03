import OpenAI from 'openai'
import { LIMITS, LLM_EFFORT, LLM_MODEL, OPENAI_API_KEY } from '../config.js'
import { SYSTEM_PROMPT } from './templates.js'

let client: OpenAI | null = null
const getClient = () => (client ??= new OpenAI({ apiKey: OPENAI_API_KEY.value(), maxRetries: 2 }))

type Effort = 'low' | 'medium' | 'high'

/**
 * Streams a completion. The static system prompt (rules + HighLevel API reference)
 * comes first and never changes, so OpenAI's automatic prompt caching applies;
 * per-request context goes in the user turn.
 */
export function streamCompletion(userMessage: string, signal: AbortSignal) {
  const effort = (['low', 'medium', 'high'].includes(LLM_EFFORT.value()) ? LLM_EFFORT.value() : 'medium') as Effort
  return getClient().chat.completions.create(
    {
      model: LLM_MODEL.value(),
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: LIMITS.maxOutputTokens,
      reasoning_effort: effort,
      prompt_cache_key: 'genesis-system-v1',
      messages: [
        { role: 'developer', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    },
    { signal },
  )
}

export function describeLlmError(err: unknown): { code: string; message: string; retryable: boolean } {
  if (err instanceof OpenAI.APIUserAbortError) return { code: 'CANCELLED', message: 'Generation cancelled', retryable: true }
  if (err instanceof OpenAI.RateLimitError) return { code: 'LLM_RATE_LIMITED', message: 'The AI provider is rate limiting requests (or the account is out of credits). Try again in a minute.', retryable: true }
  if (err instanceof OpenAI.AuthenticationError) return { code: 'LLM_AUTH', message: 'The AI provider rejected the server API key.', retryable: false }
  if (err instanceof OpenAI.BadRequestError) return { code: 'LLM_BAD_REQUEST', message: `The AI provider rejected the request: ${err.message}`, retryable: false }
  if (err instanceof OpenAI.InternalServerError) return { code: 'LLM_UNAVAILABLE', message: 'The AI provider is overloaded or unavailable. Try again shortly.', retryable: true }
  if (err instanceof OpenAI.APIConnectionError) return { code: 'LLM_CONNECTION', message: 'Lost connection to the AI provider mid-stream.', retryable: true }
  if (err instanceof OpenAI.APIError) return { code: 'LLM_ERROR', message: err.message, retryable: (err.status ?? 500) >= 500 }
  return { code: 'INTERNAL', message: err instanceof Error ? err.message : 'Unexpected error', retryable: true }
}
