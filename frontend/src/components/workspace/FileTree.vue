<script setup lang="ts">
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { ChevronRightIcon, FilePlusIcon, FolderIcon, Loader2Icon, Trash2Icon } from '@lucide/vue'
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
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useWorkspace } from '@/composables/useWorkspace'
import FileIcon from './FileIcon.vue'

const ws = useWorkspace()
const collapsed = ref(new Set<string>())

interface Row {
  kind: 'dir' | 'file'
  path: string
  name: string
  depth: number
}

/** Flattened tree (folders first) so we can render it without recursion. */
const rows = computed<Row[]>(() => {
  const paths = new Set(ws.files.value.map((f) => f.path))
  for (const p of ws.streaming.keys()) paths.add(p) // files being created right now
  type Dir = { dirs: Map<string, Dir>; files: string[] }
  const root: Dir = { dirs: new Map(), files: [] }
  for (const p of paths) {
    const parts = p.split('/')
    let d = root
    for (const part of parts.slice(0, -1)) {
      if (!d.dirs.has(part)) d.dirs.set(part, { dirs: new Map(), files: [] })
      d = d.dirs.get(part)!
    }
    d.files.push(p)
  }
  const out: Row[] = []
  const walk = (d: Dir, prefix: string, depth: number) => {
    for (const [name, sub] of [...d.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      const path = prefix + name
      out.push({ kind: 'dir', path, name, depth })
      if (!collapsed.value.has(path)) walk(sub, `${path}/`, depth + 1)
    }
    for (const p of d.files.sort()) out.push({ kind: 'file', path: p, name: p.split('/').pop()!, depth })
  }
  walk(root, '', 0)
  return out
})

function toggle(path: string) {
  const next = new Set(collapsed.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  collapsed.value = next
}

const newOpen = ref(false)
const newPath = ref('')
const busy = ref(false)
async function createFile() {
  busy.value = true
  try {
    await ws.createFile(newPath.value.trim())
    newOpen.value = false
    newPath.value = ''
  } catch (err) {
    toast.error('Could not create file', { description: (err as Error).message })
  } finally {
    busy.value = false
  }
}

const deleteTarget = ref<string | null>(null)
async function confirmDelete() {
  const path = deleteTarget.value
  deleteTarget.value = null
  if (!path) return
  try {
    await ws.deleteFile(path)
  } catch (err) {
    toast.error('Could not delete file', { description: (err as Error).message })
  }
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex h-9 items-center justify-between border-b px-2">
      <span class="text-muted-foreground text-[11px] font-medium tracking-wider uppercase">Files</span>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon-xs" :disabled="ws.generation.state.running" aria-label="New file" @click="newOpen = true">
            <FilePlusIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>New file</TooltipContent>
      </Tooltip>
    </div>
    <ScrollArea class="min-h-0 flex-1">
      <ul class="py-1 text-[13px]">
        <li v-for="row in rows" :key="row.kind + row.path">
          <button
            v-if="row.kind === 'dir'"
            class="hover:bg-muted flex w-full items-center gap-1 px-2 py-1 text-left"
            :style="{ paddingLeft: `${8 + row.depth * 12}px` }"
            @click="toggle(row.path)"
          >
            <ChevronRightIcon class="size-3.5 transition-transform" :class="{ 'rotate-90': !collapsed.has(row.path) }" />
            <FolderIcon class="text-muted-foreground size-3.5" />
            <span class="truncate">{{ row.name }}</span>
          </button>
          <div
            v-else
            role="button"
            class="group hover:bg-muted flex w-full cursor-pointer items-center gap-1.5 py-1 pr-1 text-left"
            :class="{ 'bg-muted font-medium': ws.activeTab.value === row.path }"
            :style="{ paddingLeft: `${22 + row.depth * 12}px` }"
            @click="ws.openFile(row.path)"
          >
            <FileIcon :path="row.path" />
            <span class="truncate">{{ row.name }}</span>
            <Loader2Icon v-if="ws.streaming.has(row.path)" class="ml-auto size-3 animate-spin text-indigo-500" />
            <span v-else-if="ws.isDirty(row.path)" class="ml-auto size-1.5 rounded-full bg-amber-500" title="Unsaved changes" />
            <button
              v-else-if="row.path !== 'index.html' && !ws.generation.state.running"
              class="text-muted-foreground hover:text-destructive ml-auto hidden p-0.5 group-hover:block"
              :aria-label="`Delete ${row.path}`"
              @click.stop="deleteTarget = row.path"
            >
              <Trash2Icon class="size-3" />
            </button>
          </div>
        </li>
      </ul>
    </ScrollArea>

    <Dialog v-model:open="newOpen">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New file</DialogTitle>
          <DialogDescription>Relative path, e.g. js/components/badge.js</DialogDescription>
        </DialogHeader>
        <form id="new-file" @submit.prevent="createFile">
          <Input v-model="newPath" placeholder="js/utils.js" autofocus />
        </form>
        <DialogFooter>
          <Button variant="outline" @click="newOpen = false">Cancel</Button>
          <Button type="submit" form="new-file" :disabled="busy || !newPath.trim()">Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog :open="!!deleteTarget" @update:open="(o: boolean) => !o && (deleteTarget = null)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {{ deleteTarget }}?</AlertDialogTitle>
          <AlertDialogDescription>You can get it back by restoring an earlier snapshot.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction class="bg-destructive hover:bg-destructive/90 text-white" @click="confirmDelete">Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
