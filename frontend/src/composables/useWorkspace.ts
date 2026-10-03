import { computed, inject, onScopeDispose, provide, reactive, ref, watch, type InjectionKey } from 'vue'
import { collection, doc, getDoc, limit, onSnapshot, orderBy, query } from 'firebase/firestore'
import { api } from '@/lib/api'
import { db } from '@/lib/firebase'
import type { ChatMessage, FileEntry, Project, Snapshot } from '@/lib/types'
import { toMessage, toProject, toSnapshot } from './converters'
import { useGeneration } from './useGeneration'

/**
 * State for one open project, shared by the chat, editor, preview and history panels.
 *
 * File content is resolved in priority order:
 *   streaming buffer (LLM writing it right now) > unsaved draft > saved blob (by hash)
 */
export function createWorkspace(projectId: string) {
  const project = ref<Project | null>(null)
  const missing = ref(false)
  const messages = ref<ChatMessage[]>([])
  const snapshots = ref<Snapshot[]>([])

  /** Immutable blob cache keyed by content hash, shared across snapshots. */
  const blobs = reactive(new Map<string, string>())
  const drafts = reactive(new Map<string, string>())
  const streaming = reactive(new Map<string, string>())
  const blobErrors = ref<string[]>([])

  const openTabs = ref<string[]>([])
  const activeTab = ref<string | null>(null)
  /** Cross-panel UI state (e.g. the chat asks the history panel to show a diff). */
  const ui = reactive({ diffSnapshotId: null as string | null, historyOpen: false })

  const unsubs = [
    onSnapshot(
      doc(db, 'projects', projectId),
      (snap) => {
        if (!snap.exists() || snap.get('deletedAt')) {
          missing.value = true
          return
        }
        project.value = toProject(snap.id, snap.data())
      },
      () => (missing.value = true),
    ),
    onSnapshot(query(collection(db, 'projects', projectId, 'messages'), orderBy('createdAt', 'asc'), limit(200)), (snap) => {
      messages.value = snap.docs.map((d) => toMessage(d.id, d.data()))
    }),
    onSnapshot(query(collection(db, 'projects', projectId, 'snapshots'), orderBy('createdAt', 'desc'), limit(100)), (snap) => {
      snapshots.value = snap.docs.map((d) => toSnapshot(d.id, d.data()))
    }),
  ]
  onScopeDispose(() => unsubs.forEach((u) => u()))

  const files = computed<FileEntry[]>(() => project.value?.files ?? [])
  const entryFor = (path: string) => files.value.find((f) => f.path === path)

  const inflight = new Map<string, Promise<void>>()
  async function ensureBlobs(entries: FileEntry[]) {
    await Promise.all(
      entries
        .filter((e) => !blobs.has(e.hash))
        .map((e) => {
          let p = inflight.get(e.hash)
          if (!p) {
            p = getDoc(doc(db, 'projects', projectId, 'blobs', e.hash))
              .then((snap) => {
                if (snap.exists()) blobs.set(e.hash, snap.get('content') as string)
                else blobErrors.value.push(`Content for ${e.path} is missing`)
              })
              .finally(() => inflight.delete(e.hash))
            inflight.set(e.hash, p)
          }
          return p
        }),
    )
  }

  // Keep every current file's content loaded (projects are small; the preview needs all of them).
  watch(files, (f) => void ensureBlobs(f), { immediate: true })

  const allLoaded = computed(() => files.value.every((f) => blobs.has(f.hash)))
  const savedContent = (path: string) => {
    const e = entryFor(path)
    return e ? blobs.get(e.hash) : undefined
  }
  const contentOf = (path: string) => streaming.get(path) ?? drafts.get(path) ?? savedContent(path)
  const isDirty = (path: string) => drafts.has(path) && drafts.get(path) !== savedContent(path)
  const dirtyPaths = computed(() => [...drafts.keys()].filter(isDirty))

  /** Saved files only: what the preview renders. */
  const savedFiles = computed(() => {
    const out = new Map<string, string>()
    for (const f of files.value) {
      const c = blobs.get(f.hash)
      if (c !== undefined) out.set(f.path, c)
    }
    return out
  })

  // Drop tabs/drafts for files that disappeared (restore, generation deleted them).
  watch(files, (list) => {
    const paths = new Set(list.map((f) => f.path))
    openTabs.value = openTabs.value.filter((p) => paths.has(p) || streaming.has(p) || drafts.has(p))
    if (activeTab.value && !openTabs.value.includes(activeTab.value)) activeTab.value = openTabs.value.at(-1) ?? null
  })

  function openFile(path: string) {
    if (!openTabs.value.includes(path)) openTabs.value.push(path)
    activeTab.value = path
  }

  function closeTab(path: string) {
    const i = openTabs.value.indexOf(path)
    if (i === -1) return
    openTabs.value.splice(i, 1)
    if (activeTab.value === path) activeTab.value = openTabs.value[Math.min(i, openTabs.value.length - 1)] ?? null
  }

  function setDraft(path: string, value: string) {
    if (streaming.has(path)) return
    if (value === savedContent(path)) drafts.delete(path)
    else drafts.set(path, value)
  }

  async function saveFile(path: string) {
    const content = drafts.get(path)
    if (content === undefined) return
    const res = await api<{ file: FileEntry }>('PUT', `/projects/${projectId}/files`, {
      path,
      content,
      baseHash: entryFor(path)?.hash ?? null,
    })
    blobs.set(res.file.hash, content) // no need to re-download what we just wrote
    drafts.delete(path)
  }

  async function createFile(path: string, content = '') {
    const res = await api<{ file: FileEntry }>('PUT', `/projects/${projectId}/files`, { path, content, baseHash: null })
    blobs.set(res.file.hash, content)
    openFile(res.file.path)
  }

  async function deleteFile(path: string) {
    await api('DELETE', `/projects/${projectId}/files?path=${encodeURIComponent(path)}`)
    drafts.delete(path)
    closeTab(path)
  }

  async function restoreSnapshot(snapshotId: string) {
    drafts.clear()
    return api<{ snapshotId: string; backupSnapshotId: string | null }>('POST', `/projects/${projectId}/snapshots/${snapshotId}/restore`)
  }

  const createCheckpoint = (label?: string) => api('POST', `/projects/${projectId}/snapshots`, { label })

  const ws = {
    projectId,
    project,
    missing,
    messages,
    snapshots,
    files,
    blobs,
    drafts,
    streaming,
    blobErrors,
    openTabs,
    activeTab,
    ui,
    allLoaded,
    savedFiles,
    dirtyPaths,
    entryFor,
    ensureBlobs,
    contentOf,
    savedContent,
    isDirty,
    openFile,
    closeTab,
    setDraft,
    saveFile,
    createFile,
    deleteFile,
    restoreSnapshot,
    createCheckpoint,
  }
  const generation = useGeneration(ws)
  return { ...ws, generation }
}

export type WorkspaceCore = Omit<ReturnType<typeof createWorkspace>, 'generation'>
export type Workspace = ReturnType<typeof createWorkspace>

const KEY: InjectionKey<Workspace> = Symbol('workspace')
export const provideWorkspace = (ws: Workspace) => provide(KEY, ws)
export function useWorkspace() {
  const ws = inject(KEY)
  if (!ws) throw new Error('useWorkspace() called outside a workspace')
  return ws
}
