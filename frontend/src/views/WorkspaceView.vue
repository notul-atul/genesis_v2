<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { ArrowLeftIcon, Loader2Icon, MapPinIcon } from '@lucide/vue'
import AppLogo from '@/components/AppLogo.vue'
import UserMenu from '@/components/UserMenu.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import ChatPanel from '@/components/workspace/ChatPanel.vue'
import DiffDialog from '@/components/workspace/DiffDialog.vue'
import EditorPanel from '@/components/workspace/EditorPanel.vue'
import PreviewPanel from '@/components/workspace/PreviewPanel.vue'
import SnapshotSheet from '@/components/workspace/SnapshotSheet.vue'
import { useHlConnection } from '@/composables/useHlConnection'
import { createWorkspace, provideWorkspace } from '@/composables/useWorkspace'

const props = defineProps<{ id: string }>()
const ws = createWorkspace(props.id)
provideWorkspace(ws)
const { connection } = useHlConnection()

// Open the entry file once the project loads.
const stop = watch(
  () => ws.files.value.length,
  (n) => {
    if (!n) return
    const main = ws.files.value.find((f) => f.path === 'js/main.js') ?? ws.files.value[0]
    ws.openFile(main.path)
    stop()
  },
)

function warnUnsaved(e: BeforeUnloadEvent) {
  if (ws.dirtyPaths.value.length || ws.generation.state.running) e.preventDefault()
}
onMounted(() => window.addEventListener('beforeunload', warnUnsaved))
onBeforeUnmount(() => window.removeEventListener('beforeunload', warnUnsaved))
onBeforeRouteLeave(() => {
  if (ws.dirtyPaths.value.length) return window.confirm('You have unsaved edits. Leave anyway?')
})
</script>

<template>
  <div class="flex h-svh flex-col">
    <header class="flex h-12 shrink-0 items-center gap-3 border-b px-3">
      <Button variant="ghost" size="icon-sm" as-child aria-label="Back to dashboard">
        <RouterLink to="/dashboard"><ArrowLeftIcon /></RouterLink>
      </Button>
      <AppLogo class="hidden md:flex" />
      <span class="text-muted-foreground hidden md:inline">/</span>
      <h1 class="truncate text-sm font-semibold">{{ ws.project.value?.name ?? '…' }}</h1>
      <Badge v-if="ws.generation.state.running" variant="secondary" class="gap-1">
        <Loader2Icon class="animate-spin" /> Generating
      </Badge>
      <div class="ml-auto flex items-center gap-2">
        <Badge v-if="connection" variant="outline" class="hidden gap-1 sm:inline-flex" :title="connection.locationId">
          <MapPinIcon />
          {{ connection.locationName }}
        </Badge>
        <Badge v-else variant="outline" class="text-muted-foreground hidden sm:inline-flex">HighLevel not connected</Badge>
        <SnapshotSheet />
        <UserMenu />
      </div>
    </header>

    <div v-if="ws.missing.value" class="flex flex-1 flex-col items-center justify-center gap-3">
      <p class="font-medium">Project not found</p>
      <p class="text-muted-foreground text-sm">It may have been deleted, or it belongs to another account.</p>
      <Button as-child variant="outline"><RouterLink to="/dashboard">Back to dashboard</RouterLink></Button>
    </div>
    <div v-else-if="!ws.project.value" class="text-muted-foreground flex flex-1 items-center justify-center gap-2 text-sm">
      <Loader2Icon class="size-4 animate-spin" /> Loading project…
    </div>
    <ResizablePanelGroup v-else direction="horizontal" auto-save-id="genesis-workspace" class="min-h-0 flex-1">
      <ResizablePanel :default-size="26" :min-size="18">
        <ChatPanel />
      </ResizablePanel>
      <ResizableHandle with-handle />
      <ResizablePanel :default-size="42" :min-size="25">
        <EditorPanel />
      </ResizablePanel>
      <ResizableHandle with-handle />
      <ResizablePanel :default-size="32" :min-size="20">
        <PreviewPanel />
      </ResizablePanel>
    </ResizablePanelGroup>

    <DiffDialog />
  </div>
</template>
