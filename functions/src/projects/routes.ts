import { Router } from 'express'
import { z } from 'zod'
import { APP_SECRET, LIMITS } from '../config.js'
import { requireAuth, type AuthedRequest } from '../lib/auth.js'
import { HttpError, notFound } from '../lib/errors.js'
import { db, FieldValue } from '../lib/firebase.js'
import { enforceRateLimit } from '../lib/rateLimit.js'
import { issuePreviewToken } from '../hl/previewToken.js'
import { getValidAccess } from '../hl/tokens.js'
import { STARTER_FILES } from '../generation/templates.js'
import { normalizePath } from '../generation/validate.js'
import {
  addSnapshotToBatch,
  assertNotGenerating,
  assertWithinLimits,
  byteLength,
  loadOwnedProject,
  projectRef,
  projectsCol,
  sameManifest,
  sortFiles,
  writeBlobs,
  type FileEntry,
} from './store.js'

export const projectsRouter = Router()
projectsRouter.use('/projects', requireAuth)

const uidOf = (req: unknown) => (req as AuthedRequest).uid

const ProjectInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
})

// Reads (list, file tree, file contents, snapshots, messages) happen client-side through
// Firestore listeners guarded by security rules. These endpoints are the write path.

projectsRouter.post('/projects', async (req, res) => {
  const uid = uidOf(req)
  const input = ProjectInput.parse(req.body)
  await enforceRateLimit(`create_${uid}`, 30, 3600)
  const userDoc = await db.collection('users').doc(uid).get()
  const ref = projectsCol().doc()
  const files = sortFiles(await writeBlobs(ref.id, STARTER_FILES))
  const batch = db.batch()
  const snapshotId = addSnapshotToBatch(batch, ref.id, { currentSnapshotId: null }, files, {
    source: 'initial',
    label: 'Starter template',
    parentSnapshotId: null,
  })
  batch.set(ref, {
    ownerId: uid,
    name: input.name,
    description: input.description,
    hlLocationId: (userDoc.get('hl.locationId') as string | undefined) ?? null,
    files,
    currentSnapshotId: snapshotId,
    generation: { status: 'idle' },
    deletedAt: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })
  await batch.commit()
  res.status(201).json({ id: ref.id })
})

projectsRouter.patch('/projects/:pid', async (req, res) => {
  const uid = uidOf(req)
  const pid = String(req.params.pid)
  const input = ProjectInput.partial().extend({ relinkLocation: z.boolean().optional() }).parse(req.body)
  await loadOwnedProject(uid, pid)
  const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }
  if (input.name !== undefined) patch.name = input.name
  if (input.description !== undefined) patch.description = input.description
  if (input.relinkLocation) {
    const userDoc = await db.collection('users').doc(uid).get()
    const loc = userDoc.get('hl.locationId') as string | undefined
    if (!loc) throw new HttpError(412, 'HL_NOT_CONNECTED', 'Connect HighLevel first.')
    patch.hlLocationId = loc
  }
  await projectRef(pid).update(patch)
  res.json({ ok: true })
})

/** Soft delete: hidden from every query and rejected by every endpoint, but recoverable. */
projectsRouter.delete('/projects/:pid', async (req, res) => {
  const uid = uidOf(req)
  const pid = String(req.params.pid)
  const project = await loadOwnedProject(uid, pid)
  assertNotGenerating(project)
  await projectRef(pid).update({ deletedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
  res.json({ ok: true })
})

// ---- Files --------------------------------------------------------------------

const SaveFile = z.object({
  path: z.string().min(1).max(200),
  content: z.string(),
  /** Hash the client's edit was based on; null for a new file. Enables conflict detection. */
  baseHash: z.string().nullable().optional(),
})

projectsRouter.put('/projects/:pid/files', async (req, res) => {
  const uid = uidOf(req)
  const pid = String(req.params.pid)
  const body = SaveFile.parse(req.body)
  const path = normalizePath(body.path)
  if (!path) throw new HttpError(400, 'INVALID_PATH', 'Unsupported file path or extension')
  if (byteLength(body.content) > LIMITS.maxFileBytes) throw new HttpError(413, 'FILE_TOO_LARGE', 'File is too large')

  const project = await loadOwnedProject(uid, pid)
  assertNotGenerating(project)
  const [entry] = await writeBlobs(pid, [{ path, content: body.content }])

  // Transaction: manifest may have changed since the client loaded it.
  const files = await db.runTransaction(async (tx) => {
    const fresh = (await tx.get(projectRef(pid))).data()!
    const current = (fresh.files as FileEntry[]).find((f) => f.path === path)
    if (body.baseHash !== undefined && (current?.hash ?? null) !== body.baseHash) {
      throw new HttpError(409, 'FILE_CONFLICT', `${path} changed since you opened it. Reload the file and re-apply your edit.`)
    }
    const next = sortFiles([...(fresh.files as FileEntry[]).filter((f) => f.path !== path), entry])
    assertWithinLimits(next)
    tx.update(projectRef(pid), { files: next, updatedAt: FieldValue.serverTimestamp() })
    return next
  })
  res.json({ file: entry, fileCount: files.length })
})

projectsRouter.delete('/projects/:pid/files', async (req, res) => {
  const uid = uidOf(req)
  const pid = String(req.params.pid)
  const path = normalizePath(String(req.query.path ?? ''))
  if (!path) throw new HttpError(400, 'INVALID_PATH', 'Invalid path')
  if (path === 'index.html') throw new HttpError(400, 'PROTECTED_FILE', 'index.html is the entry point and cannot be deleted')
  const project = await loadOwnedProject(uid, pid)
  assertNotGenerating(project)
  await db.runTransaction(async (tx) => {
    const fresh = (await tx.get(projectRef(pid))).data()!
    const files = (fresh.files as FileEntry[]).filter((f) => f.path !== path)
    if (files.length === (fresh.files as FileEntry[]).length) throw notFound('File')
    tx.update(projectRef(pid), { files, updatedAt: FieldValue.serverTimestamp() })
  })
  res.json({ ok: true })
})

// ---- Snapshots -------------------------------------------------------------------

/** Manual checkpoint of the current files (e.g. after hand edits). */
projectsRouter.post('/projects/:pid/snapshots', async (req, res) => {
  const uid = uidOf(req)
  const pid = String(req.params.pid)
  const { label } = z.object({ label: z.string().trim().max(140).default('Manual checkpoint') }).parse(req.body ?? {})
  const project = await loadOwnedProject(uid, pid)
  const batch = db.batch()
  const snapshotId = addSnapshotToBatch(batch, pid, project, project.files, { source: 'manual', label })
  batch.update(projectRef(pid), { currentSnapshotId: snapshotId, updatedAt: FieldValue.serverTimestamp() })
  await batch.commit()
  res.status(201).json({ snapshotId })
})

/**
 * Restore = point the manifest at the snapshot's files and record that as a new
 * snapshot, so history stays linear and a restore can itself be undone. If the
 * working files contain edits that no snapshot captured, they are backed up first.
 */
projectsRouter.post('/projects/:pid/snapshots/:sid/restore', async (req, res) => {
  const uid = uidOf(req)
  const pid = String(req.params.pid)
  const sid = String(req.params.sid)
  const project = await loadOwnedProject(uid, pid)
  assertNotGenerating(project)

  const snapsCol = projectRef(pid).collection('snapshots')
  const target = await snapsCol.doc(sid).get()
  if (!target.exists) throw notFound('Snapshot')
  const targetFiles = target.get('files') as FileEntry[]

  const batch = db.batch()
  let parent = project.currentSnapshotId
  let backupSnapshotId: string | null = null
  const currentSnap = parent ? await snapsCol.doc(parent).get() : null
  if (!currentSnap?.exists || !sameManifest(currentSnap.get('files') as FileEntry[], project.files)) {
    backupSnapshotId = addSnapshotToBatch(batch, pid, project, project.files, {
      source: 'backup',
      label: 'Unsaved edits (auto-saved before restore)',
    })
    parent = backupSnapshotId
  }
  const label = `Restored: ${String(target.get('label') ?? sid)}`
  const snapshotId = addSnapshotToBatch(batch, pid, project, targetFiles, {
    source: 'restore',
    label,
    restoredFrom: sid,
    parentSnapshotId: parent,
  })
  batch.update(projectRef(pid), { files: targetFiles, currentSnapshotId: snapshotId, updatedAt: FieldValue.serverTimestamp() })
  await batch.commit()
  res.json({ snapshotId, backupSnapshotId })
})

// ---- Preview -------------------------------------------------------------------

/** Issues the short-lived credential the sandboxed preview uses to reach the HL proxy. */
projectsRouter.post('/projects/:pid/preview-session', async (req, res) => {
  const uid = uidOf(req)
  const pid = String(req.params.pid)
  const project = await loadOwnedProject(uid, pid)
  const access = await getValidAccess(uid) // validates connection + refreshes if needed
  if (!project.hlLocationId) {
    await projectRef(pid).update({ hlLocationId: access.locationId })
  } else if (project.hlLocationId !== access.locationId) {
    throw new HttpError(409, 'LOCATION_MISMATCH', 'This project is linked to a different HighLevel location than the one you are connected to.')
  }
  const { token, expiresAt } = issuePreviewToken({ uid, pid, loc: access.locationId }, APP_SECRET.value())
  res.json({ token, expiresAt, locationId: access.locationId })
})
