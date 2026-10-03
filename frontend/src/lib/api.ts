import { auth } from './firebase'

export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string).replace(/\/$/, '')

export class ApiError extends Error {
  status: number
  code: string
  details?: unknown

  constructor(message: string, status: number, code: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

async function authHeader() {
  const user = auth.currentUser
  if (!user) throw new ApiError('You are signed out', 401, 'UNAUTHENTICATED')
  return `Bearer ${await user.getIdToken()}`
}

async function toApiError(res: Response): Promise<ApiError> {
  const body = await res.json().catch(() => null)
  const err = body?.error
  return new ApiError(err?.message ?? `Request failed (${res.status})`, res.status, err?.code ?? 'HTTP_ERROR', err?.details)
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: await authHeader(),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError('Network error: could not reach the Genesis API', 0, 'NETWORK')
  }
  if (!res.ok) throw await toApiError(res)
  return (await res.json()) as T
}

/** Opens the SSE generation stream. Resolves once headers arrive; errors before streaming throw ApiError. */
export async function openGenerationStream(projectId: string, prompt: string, signal: AbortSignal) {
  const res = await fetch(`${API_BASE}/projects/${projectId}/generate`, {
    method: 'POST',
    headers: {
      Authorization: await authHeader(),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ prompt }),
    signal,
  })
  if (!res.ok) throw await toApiError(res)
  if (!res.body) throw new ApiError('Streaming is not supported by this browser', 0, 'NO_STREAM')
  return res
}
