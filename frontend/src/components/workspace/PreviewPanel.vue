<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import {
  AlertTriangleIcon,
  Loader2Icon,
  RefreshCwIcon,
  SparklesIcon,
  TerminalIcon,
} from '@lucide/vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useHlConnection } from '@/composables/useHlConnection'
import { useWorkspace } from '@/composables/useWorkspace'
import { api, API_BASE, ApiError } from '@/lib/api'
import { buildPreview, messageDoc, type PreviewRuntime } from '@/lib/preview/buildPreview'

const ws = useWorkspace()
const router = useRouter()
const { connection } = useHlConnection()

const iframe = ref<HTMLIFrameElement | null>(null)
const srcdoc = ref(messageDoc('Loading preview…', ''))
const frameKey = ref(0)
const building = ref(false)
const buildProblems = ref<string[]>([])

interface LogEntry {
  id: number
  kind: 'error' | 'warn'
  message: string
}
interface RequestEntry {
  id: number
  method: string
  path: string
  status: number
  ms: number
}
const logs = ref<LogEntry[]>([])
const requests = ref<RequestEntry[]>([])
const consoleOpen = ref(false)
const consoleTab = ref('console')
let seq = 0

// ---- Preview session (short-lived token for the HighLevel proxy) ---------------
const runtime = ref<PreviewRuntime | null>(null)
const sessionError = ref<{ code: string; message: string } | null>(null)
let refreshTimer: ReturnType<typeof setTimeout> | undefined

async function loadSession() {
  clearTimeout(refreshTimer)
  try {
    const s = await api<{ token: string; expiresAt: number; locationId: string }>('POST', `/projects/${ws.projectId}/preview-session`)
    runtime.value = { baseUrl: `${API_BASE}/hl-proxy`, token: s.token, locationId: s.locationId }
    sessionError.value = null
    refreshTimer = setTimeout(loadSession, Math.max(60_000, s.expiresAt - Date.now() - 5 * 60_000))
  } catch (err) {
    runtime.value = null
    sessionError.value = err instanceof ApiError ? { code: err.code, message: err.message } : { code: 'UNKNOWN', message: String(err) }
  }
}

async function relink() {
  try {
    await api('PATCH', `/projects/${ws.projectId}`, { relinkLocation: true })
    await loadSession()
    rebuild()
  } catch (err) {
    toast.error('Could not relink project', { description: (err as Error).message })
  }
}

// ---- Build ----------------------------------------------------------------------
let debounce: ReturnType<typeof setTimeout> | undefined
async function rebuild() {
  if (!ws.allLoaded.value) return
  building.value = true
  try {
    const { html, problems } = await buildPreview(ws.savedFiles.value, runtime.value)
    buildProblems.value = problems
    logs.value = []
    requests.value = []
    srcdoc.value = html
    frameKey.value++ // fresh browsing context: no state leaks between builds
  } finally {
    building.value = false
  }
}
const scheduleRebuild = () => {
  clearTimeout(debounce)
  debounce = setTimeout(rebuild, 200)
}

// The preview reflects saved files and only updates once a generation has finished.
watch(
  () => [ws.savedFiles.value, ws.allLoaded.value, ws.generation.state.running] as const,
  ([, loaded, running]) => {
    if (loaded && !running) scheduleRebuild()
  },
)

// ---- Messages from the sandbox (see bridgeScript in buildPreview.ts) ----------
function onMessage(e: MessageEvent) {
  if (!iframe.value || e.source !== iframe.value.contentWindow || !e.data?.__genesis) return
  const d = e.data as { type: string; message?: string; level?: string; method?: string; path?: string; status?: number; ms?: number }
  if (d.type === 'error' || d.type === 'console') {
    const kind = d.type === 'error' || d.level === 'error' ? 'error' : 'warn'
    logs.value = [...logs.value.slice(-199), { id: ++seq, kind, message: String(d.message ?? '') }]
  } else if (d.type === 'request') {
    requests.value = [...requests.value.slice(-199), { id: ++seq, method: d.method ?? 'GET', path: d.path ?? '', status: d.status ?? 0, ms: d.ms ?? 0 }]
  }
}

const errorCount = computed(() => logs.value.filter((l) => l.kind === 'error').length + buildProblems.value.length)
const failedRequests = computed(() => requests.value.filter((r) => r.status === 0 || r.status >= 400).length)

function fixWithAi() {
  const errors = [...buildProblems.value, ...logs.value.filter((l) => l.kind === 'error').map((l) => l.message)]
  const failed = requests.value.filter((r) => r.status === 0 || r.status >= 400).map((r) => `${r.method} ${r.path} -> ${r.status}`)
  const prompt = [
    'The preview shows these problems. Find the root cause in the current files and fix it:',
    ...errors.slice(0, 8).map((m) => `- ${m.slice(0, 400)}`),
    ...(failed.length ? ['Failed HighLevel requests:', ...failed.slice(0, 8).map((f) => `- ${f}`)] : []),
  ].join('\n')
  void ws.generation.start(prompt)
}

onMounted(async () => {
  window.addEventListener('message', onMessage)
  await loadSession()
  rebuild()
})
onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
  clearTimeout(refreshTimer)
  clearTimeout(debounce)
})

// Reconnected HighLevel in another tab: get a fresh session.
watch(
  () => connection.value?.locationId,
  async (loc, prev) => {
    if (loc !== prev) {
      await loadSession()
      rebuild()
    }
  },
)

const statusClass = (s: number) => (s === 0 || s >= 400 ? 'text-destructive' : 'text-emerald-600')
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex h-9 items-center gap-2 border-b px-2">
      <span class="text-muted-foreground text-[11px] font-medium tracking-wider uppercase">Preview</span>
      <Badge v-if="runtime" variant="outline" class="max-w-40 truncate" :title="connection?.locationName">
        <span class="size-1.5 rounded-full bg-emerald-500" />
        {{ connection?.locationName ?? 'Live data' }}
      </Badge>
      <Loader2Icon v-if="building || ws.generation.state.running" class="text-muted-foreground size-3.5 animate-spin" />
      <div class="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="xs"
          :class="{ 'text-destructive': errorCount || failedRequests }"
          @click="consoleOpen = !consoleOpen"
        >
          <TerminalIcon />
          <template v-if="errorCount">{{ errorCount }} error{{ errorCount === 1 ? '' : 's' }}</template>
          <template v-else>{{ requests.length }} API calls</template>
        </Button>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon-xs" aria-label="Reload preview" @click="rebuild"><RefreshCwIcon /></Button>
          </TooltipTrigger>
          <TooltipContent>Reload preview</TooltipContent>
        </Tooltip>
      </div>
    </div>

    <div
      v-if="sessionError"
      class="flex items-start gap-2 border-b bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100"
    >
      <AlertTriangleIcon class="mt-0.5 size-3.5 shrink-0" />
      <div class="flex-1">
        <template v-if="sessionError.code === 'HL_NOT_CONNECTED'">Connect HighLevel to load live data in the preview.</template>
        <template v-else>{{ sessionError.message }}</template>
      </div>
      <Button v-if="sessionError.code === 'LOCATION_MISMATCH'" size="xs" variant="outline" @click="relink">Use current location</Button>
      <Button
        v-else-if="['HL_NOT_CONNECTED', 'HL_RECONNECT_REQUIRED'].includes(sessionError.code)"
        size="xs"
        variant="outline"
        @click="router.push('/dashboard')"
      >
        Connect
      </Button>
      <Button v-else size="xs" variant="outline" @click="loadSession().then(rebuild)">Retry</Button>
    </div>

    <div class="relative min-h-0 flex-1 bg-white">
      <iframe
        :key="frameKey"
        ref="iframe"
        :srcdoc="srcdoc"
        title="App preview"
        sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
        referrerpolicy="no-referrer"
        class="size-full border-0"
      />
      <div
        v-if="ws.generation.state.running"
        class="bg-background/90 absolute right-2 bottom-2 flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs shadow-sm"
      >
        <Loader2Icon class="size-3 animate-spin" /> Preview refreshes when generation finishes
      </div>
    </div>

    <div v-if="consoleOpen" class="flex h-56 flex-col border-t">
      <Tabs v-model="consoleTab" class="flex min-h-0 flex-1 flex-col gap-0">
        <div class="flex items-center justify-between border-b px-2 py-1">
          <TabsList class="h-7">
            <TabsTrigger value="console" class="text-xs">Console ({{ logs.length + buildProblems.length }})</TabsTrigger>
            <TabsTrigger value="network" class="text-xs">HighLevel API ({{ requests.length }})</TabsTrigger>
          </TabsList>
          <Button
            v-if="errorCount || failedRequests"
            size="xs"
            :disabled="ws.generation.state.running"
            @click="fixWithAi"
          >
            <SparklesIcon />
            Fix with AI
          </Button>
        </div>
        <TabsContent value="console" class="min-h-0 flex-1">
          <ScrollArea class="h-full">
            <ul class="divide-y font-mono text-[11px]">
              <li v-for="p in buildProblems" :key="p" class="text-destructive px-3 py-1.5">[build] {{ p }}</li>
              <li
                v-for="l in logs"
                :key="l.id"
                class="px-3 py-1.5 break-words whitespace-pre-wrap"
                :class="l.kind === 'error' ? 'text-destructive' : 'text-amber-700'"
              >
                {{ l.message }}
              </li>
              <li v-if="!logs.length && !buildProblems.length" class="text-muted-foreground px-3 py-3">No errors or warnings.</li>
            </ul>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="network" class="min-h-0 flex-1">
          <ScrollArea class="h-full">
            <table class="w-full font-mono text-[11px]">
              <tbody class="divide-y">
                <tr v-for="r in requests" :key="r.id">
                  <td class="w-12 px-3 py-1.5 font-semibold">{{ r.method }}</td>
                  <td class="max-w-0 truncate py-1.5" :title="r.path">{{ r.path }}</td>
                  <td class="w-12 px-2 text-right" :class="statusClass(r.status)">{{ r.status || 'ERR' }}</td>
                  <td class="text-muted-foreground w-16 px-3 text-right">{{ r.ms }} ms</td>
                </tr>
                <tr v-if="!requests.length">
                  <td class="text-muted-foreground px-3 py-3">No HighLevel requests yet.</td>
                </tr>
              </tbody>
            </table>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  </div>
</template>
