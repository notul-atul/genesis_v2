<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { VueMonacoEditor } from '@guolao/vue-monaco-editor'
import { Code2Icon, Loader2Icon, LockIcon, SaveIcon, XIcon } from '@lucide/vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useWorkspace } from '@/composables/useWorkspace'
import { languageFor } from '@/lib/format'
import FileIcon from './FileIcon.vue'
import FileTree from './FileTree.vue'

// Minimal structural types so we don't need monaco-editor as a dependency.
interface Monaco {
  KeyMod: { CtrlCmd: number }
  KeyCode: { KeyS: number }
}
interface CodeEditor {
  getModel(): { getLineCount(): number } | null
  revealLine(line: number): void
  addCommand(keybinding: number, handler: () => void): void
}

const ws = useWorkspace()
const editor = shallowRef<CodeEditor | null>(null)
const saving = ref(false)

const active = computed(() => ws.activeTab.value)
const isStreaming = computed(() => !!active.value && ws.streaming.has(active.value))
const readOnly = computed(() => ws.generation.state.running)
const value = computed(() => (active.value ? ws.contentOf(active.value) : undefined))
const loading = computed(() => !!active.value && value.value === undefined)

const options = computed(() => ({
  readOnly: readOnly.value,
  readOnlyMessage: { value: 'Read-only while Genesis is generating' },
  minimap: { enabled: false },
  fontSize: 13,
  lineHeight: 20,
  tabSize: 2,
  automaticLayout: true,
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  renderLineHighlight: 'none' as const,
  padding: { top: 12 },
}))

function onMount(ed: CodeEditor, monaco: Monaco) {
  editor.value = ed
  // eslint-disable-next-line no-bitwise
  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save())
}

function onChange(v: string | undefined) {
  if (active.value && v !== undefined && !readOnly.value) ws.setDraft(active.value, v)
}

// Follow the cursor of the model while it writes.
watch(value, async () => {
  if (!isStreaming.value) return
  await nextTick()
  const lines = editor.value?.getModel()?.getLineCount()
  if (lines) editor.value?.revealLine(lines)
})

async function save() {
  const path = active.value
  if (!path || !ws.isDirty(path) || saving.value) return
  saving.value = true
  try {
    await ws.saveFile(path)
    toast.success(`Saved ${path}`)
  } catch (err) {
    toast.error(`Could not save ${path}`, { description: (err as Error).message })
  } finally {
    saving.value = false
  }
}

const tabName = (p: string) => p.split('/').pop()
</script>

<template>
  <ResizablePanelGroup direction="horizontal" auto-save-id="genesis-editor">
    <ResizablePanel :default-size="24" :min-size="14" :max-size="45">
      <FileTree />
    </ResizablePanel>
    <ResizableHandle />
    <ResizablePanel :default-size="76">
      <div class="flex h-full flex-col">
        <div class="flex h-9 items-stretch border-b">
          <div class="flex min-w-0 flex-1 items-stretch overflow-x-auto">
            <div
              v-for="path in ws.openTabs.value"
              :key="path"
              role="tab"
              :aria-selected="path === active"
              :title="path"
              class="group flex shrink-0 cursor-pointer items-center gap-1.5 border-r px-3 text-[13px]"
              :class="path === active ? 'bg-background text-foreground' : 'bg-muted/40 text-muted-foreground hover:text-foreground'"
              @click="ws.activeTab.value = path"
              @auxclick.middle="ws.closeTab(path)"
            >
              <FileIcon :path="path" />
              <span>{{ tabName(path) }}</span>
              <Loader2Icon v-if="ws.streaming.has(path)" class="size-3 animate-spin text-indigo-500" />
              <span v-else-if="ws.isDirty(path)" class="size-1.5 rounded-full bg-amber-500 group-hover:hidden" />
              <button
                class="hover:bg-muted rounded p-0.5 opacity-60 hover:opacity-100"
                :class="{ 'hidden group-hover:block': ws.isDirty(path) }"
                :aria-label="`Close ${path}`"
                @click.stop="ws.closeTab(path)"
              >
                <XIcon class="size-3" />
              </button>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-2 px-2">
            <Badge v-if="readOnly" variant="secondary" class="gap-1">
              <LockIcon />
              {{ isStreaming ? 'Streaming' : 'Read-only' }}
            </Badge>
            <Button
              v-else-if="active"
              size="xs"
              variant="outline"
              :disabled="!ws.isDirty(active) || saving"
              title="Save (⌘S / Ctrl+S)"
              @click="save"
            >
              <Loader2Icon v-if="saving" class="animate-spin" />
              <SaveIcon v-else />
              Save
            </Button>
          </div>
        </div>

        <div class="relative min-h-0 flex-1">
          <div v-if="!active" class="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-sm">
            <Code2Icon class="size-6" />
            Select a file to view or edit it.
          </div>
          <div v-else-if="loading" class="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
            <Loader2Icon class="size-4 animate-spin" /> Loading {{ active }}…
          </div>
          <VueMonacoEditor
            v-else
            :value="value"
            :path="active"
            :language="languageFor(active)"
            :options="options"
            theme="vs"
            class="h-full"
            @mount="onMount"
            @change="onChange"
          >
            <template #default>
              <div class="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
                <Loader2Icon class="size-4 animate-spin" /> Loading editor…
              </div>
            </template>
          </VueMonacoEditor>
        </div>
      </div>
    </ResizablePanel>
  </ResizablePanelGroup>
</template>
