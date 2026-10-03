import type { DocumentData, Timestamp } from 'firebase/firestore'
import type { ChatMessage, Project, Snapshot } from '@/lib/types'

const date = (v: unknown) => ((v as Timestamp | null | undefined)?.toDate?.() ?? null)

export const toProject = (id: string, d: DocumentData): Project => ({
  id,
  ownerId: d.ownerId,
  name: d.name,
  description: d.description ?? '',
  hlLocationId: d.hlLocationId ?? null,
  files: d.files ?? [],
  currentSnapshotId: d.currentSnapshotId ?? null,
  generation: d.generation,
  createdAt: date(d.createdAt),
  updatedAt: date(d.updatedAt),
})

export const toSnapshot = (id: string, d: DocumentData): Snapshot => ({
  id,
  files: d.files ?? [],
  fileCount: d.fileCount ?? 0,
  totalBytes: d.totalBytes ?? 0,
  source: d.source,
  label: d.label ?? '',
  generationId: d.generationId ?? null,
  restoredFrom: d.restoredFrom ?? null,
  parentSnapshotId: d.parentSnapshotId ?? null,
  createdAt: date(d.createdAt),
})

export const toMessage = (id: string, d: DocumentData): ChatMessage => ({
  id,
  role: d.role,
  content: d.content ?? '',
  generationId: d.generationId,
  status: d.status,
  operations: d.operations ?? [],
  warnings: d.warnings ?? [],
  error: d.error ?? null,
  snapshotId: d.snapshotId ?? null,
  createdAt: date(d.createdAt),
})
