<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  AlertCircleIcon,
  ArrowUpIcon,
  CheckIcon,
  GitCompareIcon,
  Loader2Icon,
  MinusIcon,
  PencilIcon,
  PlusIcon,
  SparklesIcon,
  SquareIcon,
  UnplugIcon,
} from '@lucide/vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useHlConnection } from '@/composables/useHlConnection'
import type { Phase } from '@/composables/useGeneration'
import { useWorkspace } from '@/composables/useWorkspace'
import type { ChatMessage, FileOpSummary } from '@/lib/types'

const ws = useWorkspace()
const gen = ws.generation
const { connection } = useHlConnection()

const input = ref('')
const scroller = ref<HTMLElement | null>(null)

const SUGGESTIONS = [
  'Build a contact dashboard with search and a list of upcoming appointments',
  'Create an inbox: recent conversations on the left, the message thread on the right',
  'Show each calendar with free slots for the next 7 days',
]

const PHASES: Record<Phase, string> = {
  idle: '',
  starting: 'Starting…',
  context: 'Reading your project and HighLevel account…',
  thinking: 'Planning the app…',
  generating: 'Writing code…',
  validating: 'Validating files…',
  saving: 'Saving snapshot…',
  reconnecting: 'Connection interrupted. Following progress on the server…',
}

/** Hide the live bubble once the persisted assistant message for this generation arrives. */
const showLive = computed(
  () => gen.state.running && !ws.messages.value.some((m) => m.role === 'assistant' && m.generationId === gen.state.generationId),
)

function send(text = input.value) {
  const prompt = text.trim()
  if (!prompt || gen.state.running) return
  input.value = ''
  void gen.start(prompt)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    send()
  }
}

async function scrollToBottom() {
  await nextTick()
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}
watch(() => [ws.messages.value.length, gen.state.text.length, gen.state.files.length, gen.state.phase], scrollToBottom, { immediate: true })

const opIcon = (op: FileOpSummary) => (op.action === 'create' ? PlusIcon : op.action === 'delete' ? MinusIcon : PencilIcon)
const STATUS_BADGES: Partial<Record<string, { label: string; cls: string }>> = {
  partial: { label: 'Partial', cls: 'bg-amber-100 text-amber-900' },
  cancelled: { label: 'Cancelled', cls: 'bg-zinc-100 text-zinc-700' },
  failed: { label: 'Failed', cls: 'bg-red-100 text-red-800' },
}
const statusBadge = (m: ChatMessage) => STATUS_BADGES[m.status ?? ''] ?? null

const showDiff = (snapshotId: string) => {
  ws.ui.diffSnapshotId = snapshotId
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex h-9 items-center border-b px-3">
      <span class="text-muted-foreground text-[11px] font-medium tracking-wider uppercase">Chat</span>
    </div>

    <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto">
      <div class="space-y-4 p-3">
        <!-- Empty state -->
        <div v-if="!ws.messages.value.length && !gen.state.running" class="space-y-4 py-6">
          <div class="space-y-1 text-center">
            <SparklesIcon class="mx-auto size-6 text-indigo-500" />
            <p class="font-medium">What should we build?</p>
            <p class="text-muted-foreground text-sm">Describe a HighLevel app. Genesis writes the code and runs it against your real data.</p>
          </div>
          <div class="space-y-2">
            <button
              v-for="s in SUGGESTIONS"
              :key="s"
              class="hover:bg-muted w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors"
              @click="send(s)"
            >
              {{ s }}
            </button>
          </div>
        </div>

        <template v-for="m in ws.messages.value" :key="m.id">
          <div v-if="m.role === 'user'" class="flex justify-end">
            <div class="bg-primary text-primary-foreground max-w-[90%] rounded-2xl rounded-br-sm px-3 py-2 text-sm whitespace-pre-wrap">
              {{ m.content }}
            </div>
          </div>
          <div v-else class="space-y-2">
            <div class="flex items-center gap-2">
              <span class="grid size-5 place-items-center rounded-full bg-zinc-900 text-indigo-300"><SparklesIcon class="size-3" /></span>
              <span class="text-xs font-medium">Genesis</span>
              <span v-if="statusBadge(m)" class="rounded px-1.5 py-0.5 text-[10px] font-medium" :class="statusBadge(m)!.cls">
                {{ statusBadge(m)!.label }}
              </span>
            </div>
            <p v-if="m.content" class="text-sm leading-relaxed whitespace-pre-wrap">{{ m.content }}</p>
            <div v-if="m.operations?.length" class="flex flex-wrap gap-1">
              <button
                v-for="op in m.operations"
                :key="op.path"
                class="hover:bg-muted inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px] disabled:opacity-50"
                :disabled="op.action === 'delete'"
                @click="ws.openFile(op.path)"
              >
                <component :is="opIcon(op)" class="size-3" />
                {{ op.path }}
              </button>
            </div>
            <div v-if="m.error" class="text-destructive flex items-start gap-1.5 text-xs">
              <AlertCircleIcon class="mt-0.5 size-3.5 shrink-0" /> {{ m.error.message }}
            </div>
            <ul v-if="m.warnings?.length" class="space-y-0.5 text-xs text-amber-700">
              <li v-for="w in m.warnings.slice(0, 3)" :key="w">⚠ {{ w }}</li>
              <li v-if="m.warnings.length > 3" class="text-muted-foreground">+{{ m.warnings.length - 3 }} more</li>
            </ul>
            <Button v-if="m.snapshotId" variant="ghost" size="xs" class="-ml-2" @click="showDiff(m.snapshotId)">
              <GitCompareIcon /> View changes
            </Button>
          </div>
        </template>

        <!-- Live generation -->
        <div v-if="showLive" class="space-y-2">
          <div class="flex items-center gap-2">
            <span class="grid size-5 place-items-center rounded-full bg-zinc-900 text-indigo-300"><SparklesIcon class="size-3" /></span>
            <span class="text-xs font-medium">Genesis</span>
            <Badge variant="secondary" class="gap-1 text-[10px]">
              <UnplugIcon v-if="gen.state.detached" class="size-3" />
              <Loader2Icon v-else class="size-3 animate-spin" />
              {{ PHASES[gen.state.phase] }}
            </Badge>
          </div>
          <p v-if="gen.state.text.trim()" class="text-sm leading-relaxed whitespace-pre-wrap">{{ gen.state.text.trim() }}</p>
          <ul v-if="gen.state.files.length" class="space-y-1">
            <li v-for="f in gen.state.files" :key="f.path + f.action" class="flex items-center gap-2 font-mono text-[11px]">
              <CheckIcon v-if="f.done" class="size-3 text-emerald-600" />
              <Loader2Icon v-else class="size-3 animate-spin text-indigo-500" />
              <button class="truncate hover:underline" @click="ws.openFile(f.path)">{{ f.path }}</button>
              <span class="text-muted-foreground">{{ f.action }}</span>
            </li>
          </ul>
          <p v-if="gen.state.detached && gen.state.progress" class="text-muted-foreground text-xs">
            {{ gen.state.progress.filesDone.length }} file(s) written<template v-if="gen.state.progress.currentFile">, now
              {{ gen.state.progress.currentFile }}</template>…
          </p>
        </div>
      </div>
    </div>

    <div class="border-t p-3">
      <p v-if="!connection" class="text-muted-foreground mb-2 text-xs">
        HighLevel isn't connected. Generated apps won't load live data until you
        <RouterLink to="/dashboard" class="text-foreground underline">connect it</RouterLink>.
      </p>
      <div class="focus-within:ring-ring/50 relative rounded-xl border focus-within:ring-2">
        <Textarea
          v-model="input"
          :placeholder="ws.messages.value.length ? 'Ask for a change…' : 'Describe your app…'"
          class="max-h-48 min-h-20 resize-none border-0 pr-12 shadow-none focus-visible:ring-0"
          :disabled="gen.state.running"
          @keydown="onKeydown"
        />
        <Button
          v-if="gen.state.running"
          size="icon-sm"
          variant="secondary"
          class="absolute right-2 bottom-2"
          :disabled="gen.state.cancelling"
          aria-label="Stop generation"
          title="Stop generation"
          @click="gen.cancel()"
        >
          <Loader2Icon v-if="gen.state.cancelling" class="animate-spin" />
          <SquareIcon v-else class="fill-current" />
        </Button>
        <Button v-else size="icon-sm" class="absolute right-2 bottom-2" :disabled="!input.trim()" aria-label="Send" @click="send()">
          <ArrowUpIcon />
        </Button>
      </div>
      <p class="text-muted-foreground mt-1.5 text-[11px]">Enter to send · Shift+Enter for a new line</p>
    </div>
  </div>
</template>
