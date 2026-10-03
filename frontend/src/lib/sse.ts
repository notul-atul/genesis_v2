export interface SseMessage {
  event: string
  data: string
  id?: string
}

/**
 * Minimal spec-compliant SSE reader over a fetch() body. We use fetch rather than
 * EventSource because the request is a POST with an Authorization header.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n')
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const msg = parseBlock(block)
        if (msg) yield msg
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function parseBlock(block: string): SseMessage | null {
  let event = 'message'
  let id: string | undefined
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue // comment / heartbeat
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    else if (field === 'id') id = value
  }
  return data.length ? { event, data: data.join('\n'), id } : null
}
