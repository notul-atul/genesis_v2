<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { FileCode2Icon, FolderOpenIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon } from '@lucide/vue'
import AppLogo from '@/components/AppLogo.vue'
import HlConnectionCard from '@/components/dashboard/HlConnectionCard.vue'
import ProjectDialog from '@/components/dashboard/ProjectDialog.vue'
import UserMenu from '@/components/UserMenu.vue'
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
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/composables/useAuth'
import { useProjects } from '@/composables/useProjects'
import { api } from '@/lib/api'
import { relativeTime } from '@/lib/format'
import type { Project } from '@/lib/types'

const { user } = useAuth()
const route = useRoute()
const router = useRouter()
const { projects, loading, error } = useProjects(user.value!.uid)

const createOpen = ref(false)
const editing = ref<Project | null>(null)
const editOpen = ref(false)
const deleting = ref<Project | null>(null)

// Result of the HighLevel OAuth round trip.
onMounted(() => {
  if (route.query.hl === 'connected') toast.success('HighLevel connected')
  if (typeof route.query.hl_error === 'string') toast.error('HighLevel connection failed', { description: route.query.hl_error, duration: 10000 })
  if (route.query.hl || route.query.hl_error) router.replace({ query: {} })
})

async function createProject(v: { name: string; description: string }) {
  const { id } = await api<{ id: string }>('POST', '/projects', v)
  router.push({ name: 'workspace', params: { id } })
}

async function renameProject(v: { name: string; description: string }) {
  await api('PATCH', `/projects/${editing.value!.id}`, v)
  toast.success('Project updated')
}

async function confirmDelete() {
  const p = deleting.value
  if (!p) return
  try {
    await api('DELETE', `/projects/${p.id}`)
    toast.success(`Deleted "${p.name}"`)
  } catch (err) {
    toast.error('Could not delete project', { description: (err as Error).message })
  } finally {
    deleting.value = null
  }
}
</script>

<template>
  <div class="min-h-svh">
    <header class="bg-background/80 sticky top-0 z-10 border-b backdrop-blur">
      <div class="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <AppLogo />
        <UserMenu />
      </div>
    </header>

    <main class="mx-auto max-w-6xl space-y-8 px-4 py-8">
      <HlConnectionCard />

      <section class="space-y-4">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="text-xl font-semibold tracking-tight">Projects</h1>
            <p class="text-muted-foreground text-sm">Each project is one HighLevel app you build by chatting.</p>
          </div>
          <Button @click="createOpen = true">
            <PlusIcon />
            New project
          </Button>
        </div>

        <p v-if="error" class="text-destructive text-sm">Could not load projects: {{ error }}</p>

        <div v-if="loading" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton v-for="i in 3" :key="i" class="h-32 rounded-xl" />
        </div>

        <div
          v-else-if="!projects.length"
          class="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16 text-center"
        >
          <FolderOpenIcon class="text-muted-foreground size-8" />
          <div>
            <p class="font-medium">No projects yet</p>
            <p class="text-muted-foreground text-sm">Create one, then describe the app you want.</p>
          </div>
          <Button variant="outline" @click="createOpen = true"><PlusIcon />Create your first project</Button>
        </div>

        <div v-else class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card
            v-for="p in projects"
            :key="p.id"
            class="group hover:border-foreground/20 cursor-pointer transition-colors"
            @click="router.push({ name: 'workspace', params: { id: p.id } })"
          >
            <CardHeader>
              <div class="flex items-start justify-between gap-2">
                <CardTitle class="line-clamp-1">{{ p.name }}</CardTitle>
                <DropdownMenu>
                  <DropdownMenuTrigger as-child @click.stop>
                    <Button variant="ghost" size="icon-sm" class="-mt-1 -mr-2" aria-label="Project actions">
                      <MoreHorizontalIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" @click.stop>
                    <DropdownMenuItem @click="((editing = p), (editOpen = true))"><PencilIcon />Rename</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem class="text-destructive" @click="deleting = p"><Trash2Icon />Delete</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <CardDescription class="line-clamp-2 min-h-10">{{ p.description || 'No description' }}</CardDescription>
              <div class="text-muted-foreground flex items-center gap-3 pt-2 text-xs">
                <span class="flex items-center gap-1"><FileCode2Icon class="size-3.5" />{{ p.files.length }} files</span>
                <span>Updated {{ relativeTime(p.updatedAt) }}</span>
                <span v-if="p.generation?.status === 'running'" class="text-indigo-600">Generating…</span>
              </div>
            </CardHeader>
          </Card>
        </div>
      </section>
    </main>

    <ProjectDialog v-model:open="createOpen" title="New project" submit-label="Create project" :submit="createProject" />
    <ProjectDialog
      v-model:open="editOpen"
      title="Edit project"
      submit-label="Save"
      :initial="editing ?? undefined"
      :submit="renameProject"
    />
    <AlertDialog :open="!!deleting" @update:open="(o: boolean) => !o && (deleting = null)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete "{{ deleting?.name }}"?</AlertDialogTitle>
          <AlertDialogDescription>The project disappears from your dashboard. (It is soft-deleted and can be recovered by an admin.)</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction class="bg-destructive text-white hover:bg-destructive/90" @click="confirmDelete">Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
