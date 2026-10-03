import type { Response } from 'express'

/**
 * Server-Sent Events protocol for /generate (all payloads are JSON):
 *
 *   meta        { generationId, model }
 *   status      { phase: 'context' | 'thinking' | 'generating' | 'validating' | 'saving' }
 *   text        { delta }                         assistant prose (chat panel)
 *   file_start  { path, action }                  a file block opened
 *   token       { path, delta }                   file content tokens (editor)
 *   file_end    { path, bytes }                   a file block closed
 *   file_delete { path }
 *   done        { generationId, status, snapshotId, operations, warnings, rejected, usage }
 *   error       { code, message, retryable, partial }
 *
 * A comment line (": ping") is sent every 15 s so proxies and the browser keep the
 * connection open while the model is thinking.
 */
export class SseWriter {
  private seq = 0
  private heartbeat: NodeJS.Timeout
  closed = false

  constructor(private res: Response) {
    res.status(200)
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders()
    res.on('close', () => {
      this.closed = true
      clearInterval(this.heartbeat)
    })
    this.heartbeat = setInterval(() => this.write(': ping\n\n'), 15_000)
  }

  send(event: string, data: unknown) {
    this.write(`id: ${++this.seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  end() {
    clearInterval(this.heartbeat)
    if (!this.closed) this.res.end()
    this.closed = true
  }

  private write(chunk: string) {
    if (this.closed || this.res.writableEnded) return
    this.res.write(chunk)
  }
}
