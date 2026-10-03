<script setup lang="ts">
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { BookmarkPlusIcon, GitCompareIcon, HistoryIcon, Loader2Icon, RotateCcwIcon } from '@lucide/vue'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { useWorkspace } from '@/composables/useWorkspace'
import { absoluteTime, formatBytes, relativeTime } from '@/lib/format'
import type { Snapshot, SnapshotSource } from '@/lib/types'

const ws = useWorkspace()
const restoring = ref<Snapshot | null>(null)
const busy = ref<string | null>(null)

const SOURCE: Record<SnapshotSource, { label: string; cls: string }> = {
  initial: { label: 'Starter', cls: 'bg-zinc-100 text-zinc-700' },
  generation: { label: 'AI', cls: 'bg-indigo-100 text-indigo-800' },
  restore: { label: 'Restore', cls: 'bg-sky-100 text-sky-800' },
  manual: { label: 'Checkpoint', cls: 'bg-emerald-100 text-emerald-800' },
  backup: { label: 'Backup', cls: 'bg-amber-100 text-amber-900' },
}

const currentId = computed(() => ws.project.value?.currentSnapshotId)
const hasUnsnapshottedEdits = computed(() => {
  const current = ws.snapshots.value.find((s) => s.id === currentId.value)
  if (!current) return false
  const map = new Map(current.files.map((f) => [f.path, f.hash]))
  return current.files.length !== ws.files.value.length || ws.files.value.some((f) => map.get(f.path) !== f.hash)
})

async function restore() {
  const s = restoring.value
  restoring.value = null
  if (!s) return
  busy.value = s.id
  try {
    const res = await ws.restoreSnapshot(s.id)
    toast.success('Snapshot restored', {
      description: res.backupSnapshotId ? 'Your unsaved edits were saved as a backup snapshot first.' : s.label,
    })
  } catch (err) {
    toast.error('Restore failed', { description: (err as Error).message })
  } finally {
    busy.value = null
  }
}

async function checkpoint() {
  busy.value = 'checkpoint'
  try {
    await ws.createCheckpoint('Manual checkpoint')
    toast.success('Checkpoint saved')
  } catch (err) {
    toast.error('Could not save checkpoint', { description: (err as Error).message })
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <Sheet v-model:open="ws.ui.historyOpen">
    <SheetTrigger as-child>
      <Button variant="outline" size="sm">
        <HistoryIcon />
        History
        <Badge variant="secondary" class="ml-0.5">{{ ws.snapshots.value.length }}</Badge>
      </Button>
    </SheetTrigger>
    <SheetContent class="flex w-full flex-col gap-0 p-0 sm:max-w-md">
      <SheetHeader class="border-b p-4">
        <SheetTitle>Version history</SheetTitle>
        <SheetDescription>Every generation saves a snapshot of all files. Restoring is non-destructive: it adds a new snapshot.</SheetDescription>
        <div class="flex items-center gap-2 pt-2">
          <Button size="sm" variant="outline" :disabled="!!busy || ws.generation.state.running" @click="checkpoint">
            <Loader2Icon v-if="busy === 'checkpoint'" class="animate-spin" />
            <BookmarkPlusIcon v-else />
            Save checkpoint
          </Button>
          <span v-if="hasUnsnapshottedEdits" class="text-xs text-amber-700">You have saved edits not in any snapshot yet.</span>
        </div>
      </SheetHeader>
      <ScrollArea class="min-h-0 flex-1">
        <ol class="divide-y">
          <li v-for="s in ws.snapshots.value" :key="s.id" class="space-y-2 p-4" :class="{ 'bg-muted/50': s.id === currentId }">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 space-y-1">
                <div class="flex items-center gap-1.5">
                  <span class="rounded px-1.5 py-0.5 text-[10px] font-medium" :class="SOURCE[s.source]?.cls">{{ SOURCE[s.source]?.label ?? s.source }}</span>
                  <Badge v-if="s.id === currentId" variant="outline" class="text-[10px]">Current</Badge>
                </div>
                <p class="line-clamp-2 text-sm font-medium" :title="s.label">{{ s.label }}</p>
                <p class="text-muted-foreground text-xs" :title="absoluteTime(s.createdAt)">
                  {{ absoluteTime(s.createdAt) }} · {{ relativeTime(s.createdAt) }} · {{ s.fileCount }} files · {{ formatBytes(s.totalBytes) }}
                </p>
              </div>
            </div>
            <div class="flex gap-1">
              <Button variant="ghost" size="xs" @click="ws.ui.diffSnapshotId = s.id"><GitCompareIcon />Changes</Button>
              <Button
                v-if="s.id !== currentId"
                variant="ghost"
                size="xs"
                :disabled="!!busy || ws.generation.state.running"
                @click="restoring = s"
              >
                <Loader2Icon v-if="busy === s.id" class="animate-spin" />
                <RotateCcwIcon v-else />
                Restore
              </Button>
            </div>
          </li>
        </ol>
      </ScrollArea>
    </SheetContent>
  </Sheet>

  <AlertDialog :open="!!restoring" @update:open="(o: boolean) => !o && (restoring = null)">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Restore this snapshot?</AlertDialogTitle>
        <AlertDialogDescription>
          All files will revert to “{{ restoring?.label }}” ({{ absoluteTime(restoring?.createdAt) }}). Unsaved editor changes are discarded;
          saved edits that aren't in a snapshot are backed up automatically.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction @click="restore">Restore</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
