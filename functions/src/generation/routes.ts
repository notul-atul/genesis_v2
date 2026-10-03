import { Router } from 'express'
import { logger } from 'firebase-functions'
import { z } from 'zod'
import { LIMITS, LLM_MODEL } from '../config.js'
import { requireAuth, type AuthedRequest } from '../lib/auth.js'
import { HttpError, notFound } from '../lib/errors.js'
import { db, FieldValue } from '../lib/firebase.js'
import { enforceRateLimit } from '../lib/rateLimit.js'
import {
  addSnapshotToBatch,
  assertWithinLimits,
  isGenerationRunning,
  loadOwnedProject,
  projectRef,
  readContents,
  sortFiles,
  writeBlobs,
  type ProjectDoc,
} from '../projects/store.js'
import { buildUserMessage } from './context.js'
import { describeLlmError, streamCompletion } from './llm.js'
import { OutputParser } from './parser.js'
import { SseWriter } from './sse.js'
import { applyOperations, validateOutput, type FileOperation } from './validate.js'

export const generationRouter = Router()

type GenerationStatus = 'streaming' | 'completed' | 'partial' | 'cancelled' | 'failed'

const LLM_IDLE_TIMEOUT_MS = 180_000

const GenerateBody = z.object({ prompt: z.string().trim().min(1).max(LIMITS.maxPromptChars) })

generationRouter.post('/projects/:pid/generate', requireAuth, async (req, res) => {
  const { uid } = req as AuthedRequest
  const pid = String(req.params.pid)
  const { prompt } = GenerateBody.parse(req.body)
  await loadOwnedProject(uid, pid)
  await enforceRateLimit(`gen_${uid}`, LIMITS.generationsPerHour, 3600)

  const pRef = projectRef(pid)
  const genRef = pRef.collection('generations').doc()
  const gid = genRef.id

  // Acquire the per-project lock and record the prompt atomically.
  const project = await db.runTransaction(async (tx) => {
    const p = (await tx.get(pRef)).data() as ProjectDoc | undefined
    if (!p || p.ownerId !== uid || p.deletedAt) throw notFound('Project')
    if (isGenerationRunning(p)) {
      throw new HttpError(409, 'GENERATION_IN_PROGRESS', 'A generation is already running for this project.')
    }
    tx.update(pRef, { generation: { status: 'running', generationId: gid, startedAt: Date.now() } })
    tx.set(genRef, {
      prompt,
      status: 'streaming' satisfies GenerationStatus,
      model: LLM_MODEL.value(),
      parentSnapshotId: p.currentSnapshotId,
      cancelRequested: false,
      startedAt: FieldValue.serverTimestamp(),
    })
    tx.set(pRef.collection('messages').doc(), {
      role: 'user',
      content: prompt,
      generationId: gid,
      createdAt: FieldValue.serverTimestamp(),
    })
    return p
  })

  const sse = new SseWriter(res)
  try {
    await runGeneration({ uid, pid, gid, prompt, project, sse })
  } finally {
    await releaseLock(pid, gid).catch((err) => logger.error('Failed to release generation lock', { pid, gid, err }))
    sse.end()
  }
})

/** Cancellation is a flag on the generation doc so it works whichever instance runs the stream. */
generationRouter.post('/projects/:pid/generations/:gid/cancel', requireAuth, async (req, res) => {
  const { uid } = req as AuthedRequest
  const pid = String(req.params.pid)
  await loadOwnedProject(uid, pid)
  const ref = projectRef(pid).collection('generations').doc(String(req.params.gid))
  const snap = await ref.get()
  if (!snap.exists) throw notFound('Generation')
  if (snap.get('status') === 'streaming') await ref.update({ cancelRequested: true })
  res.json({ ok: true })
})

async function releaseLock(pid: string, gid: string) {
  const ref = projectRef(pid)
  await db.runTransaction(async (tx) => {
    const p = (await tx.get(ref)).data() as ProjectDoc | undefined
    if (p?.generation?.generationId === gid) tx.update(ref, { generation: { status: 'idle' } })
  })
}

interface RunContext {
  uid: string
  pid: string
  gid: string
  prompt: string
  project: ProjectDoc
  sse: SseWriter
}

async function runGeneration({ uid, pid, gid, prompt, project, sse }: RunContext) {
  const pRef = projectRef(pid)
  const genRef = pRef.collection('generations').doc(gid)
  sse.send('meta', { generationId: gid, model: LLM_MODEL.value() })
  sse.send('status', { phase: 'context' })

  const existingPaths = new Set(project.files.map((f) => f.path))
  const abort = new AbortController()
  let cancelled = false
  // A reasoning model can go quiet; if the provider sends nothing for this long, give up
  // with a clear error instead of hanging until the function times out.
  let stalled = false
  let idleTimer: NodeJS.Timeout | undefined
  const armIdleTimer = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      stalled = true
      abort.abort()
    }, LLM_IDLE_TIMEOUT_MS)
  }
  // The client may disconnect (closed tab, flaky network). We deliberately keep going so
  // the result is persisted; the client re-syncs from Firestore. Only an explicit cancel aborts.
  const unsubscribe = genRef.onSnapshot(
    (snap) => {
      if (snap.get('cancelRequested') && !cancelled) {
        cancelled = true
        abort.abort()
      }
    },
    (err) => logger.warn('Cancel listener failed', { err }),
  )

  let raw = ''
  let lastProgressWrite = 0
  const filesDone: string[] = []
  let currentFile: string | null = null
  const writeProgress = (force = false) => {
    if (!force && Date.now() - lastProgressWrite < 2000) return
    lastProgressWrite = Date.now()
    genRef.update({ progress: { chars: raw.length, currentFile, filesDone } }).catch(() => {})
  }

  const parser = new OutputParser((e) => {
    switch (e.type) {
      case 'text':
        sse.send('text', { delta: e.delta })
        break
      case 'file_start':
        currentFile = e.path
        sse.send('file_start', { path: e.path, action: existingPaths.has(e.path) ? 'update' : 'create' })
        break
      case 'file_delta':
        sse.send('token', { path: e.path, delta: e.delta })
        break
      case 'file_end':
        currentFile = null
        filesDone.push(e.path)
        sse.send('file_end', { path: e.path, bytes: Buffer.byteLength(e.content) })
        writeProgress(true)
        break
      case 'delete':
        sse.send('file_delete', { path: e.path })
        break
    }
  })

  let status: GenerationStatus = 'completed'
  let error: { code: string; message: string; retryable: boolean } | null = null
  let stopReason: string | null = null
  let usage: Record<string, number | null | undefined> | null = null
  const warnings: string[] = []

  try {
    const contents = await readContents(pid, project.files)
    const userDoc = await db.collection('users').doc(uid).get()
    const { text: userMessage, notes } = await buildUserMessage({
      uid,
      pid,
      project,
      contents,
      prompt,
      hl: userDoc.get('hl'),
    })
    warnings.push(...notes)

    sse.send('status', { phase: 'thinking' })
    let generatingAnnounced = false
    let finishReason: string | null = null
    armIdleTimer()
    const stream = await streamCompletion(userMessage, abort.signal)
    for await (const chunk of stream) {
      armIdleTimer()
      const choice = chunk.choices[0]
      const delta = choice?.delta?.content
      if (delta) {
        if (!generatingAnnounced) {
          generatingAnnounced = true
          sse.send('status', { phase: 'generating' })
        }
        raw += delta
        parser.push(delta)
        writeProgress()
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason
      if (chunk.usage) {
        usage = {
          input_tokens: chunk.usage.prompt_tokens,
          output_tokens: chunk.usage.completion_tokens,
          cached_input_tokens: chunk.usage.prompt_tokens_details?.cached_tokens,
          reasoning_tokens: chunk.usage.completion_tokens_details?.reasoning_tokens,
        }
      }
    }
    stopReason = finishReason
    if (stopReason === 'content_filter') {
      status = 'failed'
      error = { code: 'REFUSED', message: 'The AI declined this request. Try rephrasing it.', retryable: false }
    } else if (stopReason === 'length') {
      status = 'partial'
      warnings.push('The response hit the output length limit; the last file was cut off. Ask Genesis to continue or simplify.')
    }
  } catch (err) {
    if (cancelled) {
      status = 'cancelled'
    } else if (stalled) {
      error = { code: 'LLM_STALLED', message: 'The AI stopped responding. Complete files were kept; try again.', retryable: true }
      status = 'failed' // upgraded to 'partial' below if complete files were received
    } else {
      error = err instanceof HttpError ? { code: err.code, message: err.message, retryable: err.status >= 500 } : describeLlmError(err)
      status = 'failed' // may be upgraded to 'partial' below if complete files were received
      logger.error('Generation stream failed', { pid, gid, err: String(err) })
    }
  } finally {
    clearTimeout(idleTimer)
    unsubscribe()
  }

  // ---- Validate and persist whatever complete work we have ----------------------
  sse.send('status', { phase: 'validating' })
  const parsed = parser.finish()
  const rejected: { path: string; reason: string }[] = []
  if (parsed.incomplete) rejected.push({ path: parsed.incomplete.path, reason: 'incomplete (stream ended mid-file)' })

  let ops: FileOperation[] = []
  let snapshotId: string | null = null
  const keepWork = !(error?.code === 'REFUSED')
  if (keepWork) {
    const v = validateOutput(parsed, existingPaths)
    ops = v.operations
    warnings.push(...v.warnings)
    rejected.push(...v.rejected)
  }
  if (status === 'failed' && ops.length && error?.code !== 'REFUSED') status = 'partial'
  if (status === 'completed' && !ops.length && !parsed.text) {
    status = 'failed'
    error = { code: 'EMPTY_RESPONSE', message: 'The AI returned no usable output. Try again or rephrase.', retryable: true }
  }

  try {
    sse.send('status', { phase: 'saving' })
    snapshotId = await persist({ pid, gid, prompt, ops, status })
  } catch (err) {
    logger.error('Persisting generation failed', { pid, gid, err })
    error = err instanceof HttpError ? { code: err.code, message: err.message, retryable: false } : { code: 'SAVE_FAILED', message: 'Could not save generated files.', retryable: true }
    status = 'failed'
    ops = []
  }

  const opSummary = ops.map((o) => ({ path: o.path, action: o.action }))
  const assistantText =
    parsed.text ||
    (ops.length ? `Updated ${ops.length} file${ops.length === 1 ? '' : 's'}.` : status === 'cancelled' ? 'Generation cancelled.' : '')

  const batch = db.batch()
  batch.update(genRef, {
    status,
    stopReason,
    usage,
    error,
    warnings,
    rejected,
    operations: opSummary,
    snapshotId,
    finishedAt: FieldValue.serverTimestamp(),
    // Keep the raw output for anything that didn't fully succeed, for debugging / recovery.
    rawOutput: status === 'completed' ? null : raw.slice(0, 200_000),
    progress: FieldValue.delete(),
  })
  batch.set(pRef.collection('messages').doc(), {
    role: 'assistant',
    content: assistantText,
    generationId: gid,
    status,
    operations: opSummary,
    warnings,
    error: error ? { code: error.code, message: error.message } : null,
    snapshotId,
    createdAt: FieldValue.serverTimestamp(),
  })
  await batch.commit().catch((err) => logger.error('Failed to record generation result', { err }))

  if (status === 'failed' || (status === 'partial' && error)) {
    sse.send('error', { ...(error ?? { code: 'UNKNOWN', message: 'Generation failed', retryable: true }), partial: { applied: opSummary.length, snapshotId } })
  }
  if (status !== 'failed') {
    sse.send('done', { generationId: gid, status, snapshotId, operations: opSummary, warnings, rejected, usage })
  }
}

/**
 * Applies validated operations: writes new blobs, swaps the project manifest and
 * records a snapshot in one batch. Returns the snapshot id (null if nothing changed).
 */
async function persist(opts: { pid: string; gid: string; prompt: string; ops: FileOperation[]; status: GenerationStatus }) {
  if (!opts.ops.length) return null
  const pRef = projectRef(opts.pid)
  const project = (await pRef.get()).data() as ProjectDoc
  const current = await readContents(opts.pid, project.files)
  const next = applyOperations(current, opts.ops)
  if (!next.has('index.html')) throw new HttpError(422, 'MISSING_ENTRY', 'The result has no index.html, so it was not applied.')

  const changed = opts.ops.filter((o) => o.action !== 'delete') as { path: string; content: string }[]
  const newEntries = await writeBlobs(opts.pid, changed)
  const byPath = new Map(project.files.map((f) => [f.path, f]))
  for (const op of opts.ops) if (op.action === 'delete') byPath.delete(op.path)
  for (const e of newEntries) byPath.set(e.path, e)
  const files = sortFiles([...byPath.values()])
  assertWithinLimits(files)

  const batch = db.batch()
  const label = opts.status === 'completed' ? opts.prompt : `[${opts.status}] ${opts.prompt}`
  const snapshotId = addSnapshotToBatch(batch, opts.pid, project, files, { source: 'generation', label, generationId: opts.gid })
  batch.update(pRef, { files, currentSnapshotId: snapshotId, updatedAt: FieldValue.serverTimestamp() })
  await batch.commit()
  return snapshotId
}
