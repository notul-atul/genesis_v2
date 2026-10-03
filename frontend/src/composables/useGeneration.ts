import { onScopeDispose, reactive, watch, type Ref } from 'vue'
import { doc, onSnapshot, type Unsubscribe } from 'firebase/firestore'
import { toast } from 'vue-sonner'
import { api, ApiError, openGenerationStream } from '@/lib/api'
import { db } from '@/lib/firebase'
import { sha256 } from '@/lib/format'
import { readSse } from '@/lib/sse'
import type { FileOpSummary, GenerationEvent, GenerationStatus, Project } from '@/lib/types'

/** The slice of the workspace the generation client needs. */
interface GenerationHost {
  projectId: string
  project: Ref<Project | null>
  streaming: Map<string, string>
  blobs: Map<string, string>
  openFile(path: string): void
}

export type Phase = 'idle' | 'starting' | 'context' | 'thinking' | 'generating' | 'validating' | 'saving' | 'reconnecting'

export interface LiveFile {
  path: string
  action: 'create' | 'update' | 'delete'
  done: boolean
}

export function useGeneration(ws: GenerationHost) {
  const state = reactive({
    running: false,
    phase: 'idle' as Phase,
    generationId: null as string | null,
    prompt: '',
    text: '',
    files: [] as LiveFile[],
    error: null as { code: string; message: string } | null,
    /** True while we lost the SSE connection and follow the result through Firestore instead. */
    detached: false,
    progress: null as { chars: number; currentFile: string | null; filesDone: string[] } | null,
    cancelling: false,
  })

  let controller: AbortController | null = null
  let watcher: Unsubscribe | null = null
  onScopeDispose(() => {
    controller?.abort()
    watcher?.()
  })

  // Pending token deltas are flushed once per animation frame so a fast stream
  // doesn't trigger a Monaco re-render per token.
  const pending = new Map<string, string>()
  let frame = 0
  const flush = () => {
    frame = 0
    for (const [path, delta] of pending) ws.streaming.set(path, (ws.streaming.get(path) ?? '') + delta)
    pending.clear()
  }
  const queueDelta = (path: string, delta: string) => {
    pending.set(path, (pending.get(path) ?? '') + delta)
    if (!frame) frame = requestAnimationFrame(flush)
  }

  function reset(prompt: string) {
    Object.assign(state, {
      running: true,
      phase: 'starting',
      generationId: null,
      prompt,
      text: '',
      files: [],
      error: null,
      detached: false,
      progress: null,
      cancelling: false,
    })
    ws.streaming.clear()
  }

  /** Waits until Firestore reflects the result so the editor never flashes stale content. */
  function settle(snapshotId: string | null) {
    const clear = () => {
      flush()
      ws.streaming.clear()
      state.running = false
      state.phase = 'idle'
    }
    if (!snapshotId || ws.project.value?.currentSnapshotId === snapshotId) return clear()
    const stop = watch(
      () => ws.project.value?.currentSnapshotId,
      (id) => {
        if (id === snapshotId) {
          stop()
          clear()
        }
      },
    )
    setTimeout(() => {
      stop()
      clear()
    }, 5000)
  }

  function announce(status: GenerationStatus, ops: FileOpSummary[], warnings: string[]) {
    const n = ops.length
    const files = `${n} file${n === 1 ? '' : 's'}`
    if (status === 'completed') toast.success(n ? `Generated ${files}` : 'Done', { description: warnings[0] })
    else if (status === 'partial') toast.warning(`Partial result saved (${files})`, { description: warnings[0] ?? 'Some output could not be used.' })
    else if (status === 'cancelled') toast.info(n ? `Cancelled. Kept ${files} that were complete.` : 'Generation cancelled')
  }

  function handle(e: GenerationEvent) {
    switch (e.event) {
      case 'meta':
        state.generationId = e.data.generationId
        break
      case 'status':
        state.phase = e.data.phase
        break
      case 'text':
        state.text += e.data.delta
        break
      case 'file_start':
        state.files.push({ path: e.data.path, action: e.data.action, done: false })
        ws.streaming.set(e.data.path, '')
        ws.openFile(e.data.path)
        break
      case 'token':
        queueDelta(e.data.path, e.data.delta)
        break
      case 'file_end': {
        flush()
        const f = [...state.files].reverse().find((x) => x.path === e.data.path)
        if (f) f.done = true
        // Pre-seed the blob cache so the saved file appears instantly once the manifest updates.
        const content = ws.streaming.get(e.data.path)
        if (content !== undefined) void sha256(content).then((h) => ws.blobs.set(h, content))
        break
      }
      case 'file_delete':
        state.files.push({ path: e.data.path, action: 'delete', done: true })
        break
      case 'error':
        state.error = { code: e.data.code, message: e.data.message }
        if (!e.data.partial?.applied) toast.error('Generation failed', { description: e.data.message })
        break
      case 'done':
        announce(e.data.status, e.data.operations, e.data.warnings)
        settle(e.data.snapshotId)
        break
    }
  }

  async function start(prompt: string) {
    if (state.running) return
    reset(prompt)
    controller = new AbortController()
    // 'done' = result saved (possibly partial); 'failed' = fatal error event; null = stream cut off.
    let terminal: 'done' | 'failed' | null = null
    try {
      const res = await openGenerationStream(ws.projectId, prompt, controller.signal)
      for await (const msg of readSse(res.body!)) {
        let parsed: GenerationEvent
        try {
          parsed = { event: msg.event, data: JSON.parse(msg.data) } as GenerationEvent
        } catch {
          continue // ignore a malformed frame rather than killing the stream
        }
        handle(parsed)
        if (parsed.event === 'done') terminal = 'done'
        else if (parsed.event === 'error' && !parsed.data.partial?.applied) terminal = 'failed'
      }
    } catch (err) {
      if (err instanceof ApiError) {
        // Rejected before streaming started (409 already running, 429 rate limit, ...).
        state.error = { code: err.code, message: err.message }
        toast.error(err.status === 409 ? 'Already generating' : 'Could not start generation', { description: err.message })
        settle(null)
        return
      }
      // Otherwise a network error mid-stream: handled below like an early end.
    } finally {
      controller = null
    }

    if (terminal === 'failed') return settle(null)
    if (terminal === 'done') return
    if (state.cancelling && !state.generationId) {
      toast.info('Generation cancelled')
      return settle(null)
    }
    // Network drop / server restart: the server keeps going and persists the result,
    // so follow the generation document instead of failing.
    if (state.generationId) {
      toast.info('Connection interrupted', { description: 'Still generating on the server. Following progress…' })
      follow(state.generationId)
    } else {
      state.error = { code: 'NETWORK', message: 'Lost connection before the generation started.' }
      toast.error('Connection lost', { description: 'Check your network and try again.' })
      settle(null)
    }
  }

  /** Tracks a generation through Firestore (after a disconnect, or one started in another tab). */
  function follow(generationId: string) {
    watcher?.()
    state.running = true
    state.detached = true
    state.generationId = generationId
    state.phase = 'reconnecting'
    watcher = onSnapshot(doc(db, 'projects', ws.projectId, 'generations', generationId), (snap) => {
      const status = snap.get('status') as GenerationStatus | undefined
      state.progress = snap.get('progress') ?? null
      if (!state.prompt) state.prompt = snap.get('prompt') ?? ''
      if (!status || status === 'streaming') return
      watcher?.()
      watcher = null
      state.detached = false
      const error = snap.get('error') as { code: string; message: string } | null
      if (status === 'failed') {
        state.error = error
        toast.error('Generation failed', { description: error?.message })
      } else announce(status, snap.get('operations') ?? [], snap.get('warnings') ?? [])
      settle(snap.get('snapshotId') ?? null)
    })
  }

  async function cancel() {
    if (!state.running || state.cancelling) return
    state.cancelling = true
    if (!state.generationId) {
      controller?.abort()
      return
    }
    try {
      await api('POST', `/projects/${ws.projectId}/generations/${state.generationId}/cancel`)
    } catch (err) {
      toast.error('Could not cancel', { description: (err as Error).message })
      state.cancelling = false
    }
    // The server stops the model, saves complete files and closes the stream with `done`.
  }

  // Page reloaded mid-generation (or another tab started one): attach to it.
  const stopAttach = watch(
    () => ws.project.value?.generation,
    (g) => {
      if (g?.status === 'running' && g.generationId && !state.running && Date.now() - (g.startedAt ?? 0) < 15 * 60_000) {
        follow(g.generationId)
      }
    },
    { immediate: true },
  )
  onScopeDispose(stopAttach)

  return { state, start, cancel }
}
