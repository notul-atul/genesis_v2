export interface FileEntry {
  path: string
  hash: string
  size: number
}

export interface Project {
  id: string
  ownerId: string
  name: string
  description: string
  hlLocationId: string | null
  files: FileEntry[]
  currentSnapshotId: string | null
  generation?: { status: 'idle' | 'running'; generationId?: string; startedAt?: number }
  createdAt: Date | null
  updatedAt: Date | null
}

export type SnapshotSource = 'initial' | 'generation' | 'restore' | 'manual' | 'backup'

export interface Snapshot {
  id: string
  files: FileEntry[]
  fileCount: number
  totalBytes: number
  source: SnapshotSource
  label: string
  generationId: string | null
  restoredFrom: string | null
  parentSnapshotId: string | null
  createdAt: Date | null
}

export type GenerationStatus = 'streaming' | 'completed' | 'partial' | 'cancelled' | 'failed'

export interface FileOpSummary {
  path: string
  action: 'create' | 'update' | 'delete'
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  generationId?: string
  status?: GenerationStatus
  operations?: FileOpSummary[]
  warnings?: string[]
  error?: { code: string; message: string } | null
  snapshotId?: string | null
  createdAt: Date | null
}

export interface HlConnection {
  status: 'connected' | 'expired'
  locationId: string
  locationName: string
  timezone: string | null
  connectedAt: Date | null
}

/** Server-Sent Events emitted by POST /projects/:pid/generate (see functions/src/generation/sse.ts). */
export type GenerationEvent =
  | { event: 'meta'; data: { generationId: string; model: string } }
  | { event: 'status'; data: { phase: 'context' | 'thinking' | 'generating' | 'validating' | 'saving' } }
  | { event: 'text'; data: { delta: string } }
  | { event: 'file_start'; data: { path: string; action: 'create' | 'update' } }
  | { event: 'token'; data: { path: string; delta: string } }
  | { event: 'file_end'; data: { path: string; bytes: number } }
  | { event: 'file_delete'; data: { path: string } }
  | {
      event: 'done'
      data: {
        generationId: string
        status: GenerationStatus
        snapshotId: string | null
        operations: FileOpSummary[]
        warnings: string[]
        rejected: { path: string; reason: string }[]
      }
    }
  | {
      event: 'error'
      data: { code: string; message: string; retryable: boolean; partial?: { applied: number; snapshotId: string | null } }
    }
