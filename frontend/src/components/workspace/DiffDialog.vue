<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { doc, getDoc } from 'firebase/firestore'
import { VueMonacoDiffEditor } from '@guolao/vue-monaco-editor'
import { Loader2Icon, MinusIcon, PencilIcon, PlusIcon } from '@lucide/vue'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { toSnapshot } from '@/composables/converters'
import { useWorkspace } from '@/composables/useWorkspace'
import { db } from '@/lib/firebase'
import { absoluteTime, languageFor } from '@/lib/format'
import type { FileEntry, Snapshot } from '@/lib/types'

const ws = useWorkspace()

const open = computed({
  get: () => !!ws.ui.diffSnapshotId,
  set: (v) => {
    if (!v) ws.ui.diffSnapshotId = null
  },
})

const snapshot = ref<Snapshot | null>(null)
const parent = ref<Snapshot | null>(null)
const selected = ref<string | null>(null)
const loading = ref(false)

async function loadSnapshot(id: string) {
  const known = ws.snapshots.value.find((s) => s.id === id)
  if (known) return known
  const snap = await getDoc(doc(db, 'projects', ws.projectId, 'snapshots', id))
  return snap.exists() ? toSnapshot(snap.id, snap.data()) : null
}

interface Change {
  path: string
  kind: 'added' | 'modified' | 'deleted'
  before?: FileEntry
  after?: FileEntry
}

const changes = computed<Change[]>(() => {
  if (!snapshot.value) return []
  const before = new Map((parent.value?.files ?? []).map((f) => [f.path, f]))
  const after = new Map(snapshot.value.files.map((f) => [f.path, f]))
  const out: Change[] = []
  for (const [path, a] of after) {
    const b = before.get(path)
    if (!b) out.push({ path, kind: 'added', after: a })
    else if (b.hash !== a.hash) out.push({ path, kind: 'modified', before: b, after: a })
  }
  for (const [path, b] of before) if (!after.has(path)) out.push({ path, kind: 'deleted', before: b })
  return out.sort((x, y) => x.path.localeCompare(y.path))
})

watch(
  () => ws.ui.diffSnapshotId,
  async (id) => {
    snapshot.value = parent.value = null
    selected.value = null
    if (!id) return
    loading.value = true
    try {
      snapshot.value = await loadSnapshot(id)
      if (snapshot.value?.parentSnapshotId) parent.value = await loadSnapshot(snapshot.value.parentSnapshotId)
      const entries = changes.value.flatMap((c) => [c.before, c.after].filter(Boolean) as FileEntry[])
      await ws.ensureBlobs(entries)
      selected.value = changes.value[0]?.path ?? null
    } finally {
      loading.value = false
    }
  },
)

const current = computed(() => changes.value.find((c) => c.path === selected.value))
const original = computed(() => (current.value?.before ? (ws.blobs.get(current.value.before.hash) ?? '') : ''))
const modified = computed(() => (current.value?.after ? (ws.blobs.get(current.value.after.hash) ?? '') : ''))
const kindIcon = { added: PlusIcon, modified: PencilIcon, deleted: MinusIcon }
const kindClass = { added: 'text-emerald-600', modified: 'text-amber-600', deleted: 'text-destructive' }
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex h-[85vh] flex-col gap-3 sm:max-w-6xl">
      <DialogHeader>
        <DialogTitle>Changes</DialogTitle>
        <DialogDescription>
          <template v-if="snapshot">
            {{ snapshot.label }} · {{ absoluteTime(snapshot.createdAt) }}
            <template v-if="!parent"> · compared with an empty project</template>
          </template>
        </DialogDescription>
      </DialogHeader>
      <div v-if="loading" class="text-muted-foreground flex flex-1 items-center justify-center gap-2 text-sm">
        <Loader2Icon class="size-4 animate-spin" /> Loading diff…
      </div>
      <div v-else-if="!changes.length" class="text-muted-foreground flex flex-1 items-center justify-center text-sm">
        No file changes in this snapshot.
      </div>
      <div v-else class="flex min-h-0 flex-1 overflow-hidden rounded-lg border">
        <ScrollArea class="w-56 shrink-0 border-r">
          <ul class="py-1 text-[12px]">
            <li v-for="c in changes" :key="c.path">
              <button
                class="hover:bg-muted flex w-full items-center gap-1.5 px-2 py-1.5 text-left font-mono"
                :class="{ 'bg-muted': c.path === selected }"
                @click="selected = c.path"
              >
                <component :is="kindIcon[c.kind]" class="size-3 shrink-0" :class="kindClass[c.kind]" />
                <span class="truncate">{{ c.path }}</span>
              </button>
            </li>
          </ul>
        </ScrollArea>
        <div class="min-w-0 flex-1">
          <VueMonacoDiffEditor
            v-if="current"
            :key="current.path"
            :original="original"
            :modified="modified"
            :language="languageFor(current.path)"
            :options="{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 12, automaticLayout: true }"
            class="h-full"
          />
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
