import { createHash } from 'node:crypto'
import { LIMITS } from '../config.js'
import { HttpError, notFound } from '../lib/errors.js'
import { db, FieldValue } from '../lib/firebase.js'

/**
 * Storage model
 * - projects/{pid}                 { ownerId, name, description, hlLocationId, files: FileEntry[], currentSnapshotId, ... }
 * - projects/{pid}/blobs/{sha256}  { content, size }   content-addressed, immutable, shared by all snapshots
 * - projects/{pid}/snapshots/{id}  { files: FileEntry[], source, label, parentSnapshotId, ... }
 *
 * A snapshot is only a manifest (path -> hash), so taking one per generation is
 * cheap, unchanged files are stored once, and restore is a manifest swap.
 */
export interface FileEntry {
  path: string
  hash: string
  size: number
}

export type SnapshotSource = 'initial' | 'generation' | 'restore' | 'manual' | 'backup'

export interface ProjectDoc {
  ownerId: string
  name: string
  description: string
  hlLocationId: string | null
  files: FileEntry[]
  currentSnapshotId: string | null
  generation?: { status: 'idle' | 'running'; generationId?: string; startedAt?: number }
  deletedAt: FirebaseFirestore.Timestamp | null
  createdAt: FirebaseFirestore.Timestamp
  updatedAt: FirebaseFirestore.Timestamp
}

export const projectsCol = () => db.collection('projects')
export const projectRef = (pid: string) => projectsCol().doc(pid)
const blobRef = (pid: string, hash: string) => projectRef(pid).collection('blobs').doc(hash)

export const sha256 = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex')
export const byteLength = (content: string) => Buffer.byteLength(content, 'utf8')

export async function loadOwnedProject(uid: string, pid: string) {
  const snap = await projectRef(pid).get()
  const data = snap.data() as ProjectDoc | undefined
  if (!data || data.ownerId !== uid || data.deletedAt) throw notFound('Project')
  return data
}

export function isGenerationRunning(project: ProjectDoc, now = Date.now()) {
  const g = project.generation
  return g?.status === 'running' && (g.startedAt ?? 0) > now - LIMITS.generationLockMs
}

export function assertNotGenerating(project: ProjectDoc) {
  if (isGenerationRunning(project)) {
    throw new HttpError(409, 'GENERATION_IN_PROGRESS', 'Wait for the current generation to finish (or cancel it).')
  }
}

/** Reads file contents for a manifest. Missing blobs are reported, never silently dropped. */
export async function readContents(pid: string, files: FileEntry[]): Promise<Map<string, string>> {
  const unique = [...new Set(files.map((f) => f.hash))]
  const out = new Map<string, string>()
  if (!unique.length) return out
  const snaps = await db.getAll(...unique.map((h) => blobRef(pid, h)))
  const byHash = new Map(snaps.map((s) => [s.id, s.get('content') as string | undefined]))
  for (const f of files) {
    const content = byHash.get(f.hash)
    if (content === undefined) throw new HttpError(500, 'BLOB_MISSING', `Stored content for ${f.path} is missing`)
    out.set(f.path, content)
  }
  return out
}

/**
 * Persists blob documents for new content and returns the manifest entries.
 * Blobs are written before any manifest references them, in size-bounded batches
 * (a Firestore commit is capped at 10 MiB).
 */
export async function writeBlobs(pid: string, files: { path: string; content: string }[]): Promise<FileEntry[]> {
  const entries: FileEntry[] = []
  let batch = db.batch()
  let batchBytes = 0
  let pending = 0
  const seen = new Set<string>()
  for (const f of files) {
    const hash = sha256(f.content)
    const size = byteLength(f.content)
    entries.push({ path: f.path, hash, size })
    if (seen.has(hash)) continue
    seen.add(hash)
    if (batchBytes + size > 8_000_000 || pending >= 400) {
      await batch.commit()
      batch = db.batch()
      batchBytes = 0
      pending = 0
    }
    batch.set(blobRef(pid, hash), { content: f.content, size })
    batchBytes += size
    pending++
  }
  if (pending) await batch.commit()
  return entries
}

export function assertWithinLimits(files: FileEntry[]) {
  if (files.length > LIMITS.maxFiles) {
    throw new HttpError(413, 'TOO_MANY_FILES', `Projects are limited to ${LIMITS.maxFiles} files`)
  }
  const total = files.reduce((n, f) => n + f.size, 0)
  if (total > LIMITS.maxProjectBytes) {
    throw new HttpError(413, 'PROJECT_TOO_LARGE', `Projects are limited to ${LIMITS.maxProjectBytes / 1_000_000} MB`)
  }
}

export const sortFiles = (files: FileEntry[]) => [...files].sort((a, b) => a.path.localeCompare(b.path))

export function sameManifest(a: FileEntry[], b: FileEntry[]) {
  if (a.length !== b.length) return false
  const map = new Map(a.map((f) => [f.path, f.hash]))
  return b.every((f) => map.get(f.path) === f.hash)
}

/**
 * Creates a snapshot of `files` and points the project at it, in one batch so the
 * project's manifest and its history can never disagree.
 */
export function addSnapshotToBatch(
  batch: FirebaseFirestore.WriteBatch,
  pid: string,
  project: Pick<ProjectDoc, 'currentSnapshotId'>,
  files: FileEntry[],
  meta: { source: SnapshotSource; label: string; generationId?: string; restoredFrom?: string; parentSnapshotId?: string | null },
) {
  const ref = projectRef(pid).collection('snapshots').doc()
  batch.set(ref, {
    files: sortFiles(files),
    fileCount: files.length,
    totalBytes: files.reduce((n, f) => n + f.size, 0),
    source: meta.source,
    label: meta.label.slice(0, 140),
    generationId: meta.generationId ?? null,
    restoredFrom: meta.restoredFrom ?? null,
    parentSnapshotId: meta.parentSnapshotId !== undefined ? meta.parentSnapshotId : project.currentSnapshotId,
    createdAt: FieldValue.serverTimestamp(),
  })
  return ref.id
}
