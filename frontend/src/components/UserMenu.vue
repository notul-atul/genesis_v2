<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { LogOutIcon } from '@lucide/vue'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuth } from '@/composables/useAuth'

const { user, signOut } = useAuth()
const router = useRouter()
const initials = computed(() => (user.value?.displayName || user.value?.email || '?').slice(0, 2).toUpperCase())

async function logout() {
  await signOut()
  router.replace({ name: 'login' })
}
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button variant="ghost" size="icon" class="rounded-full" aria-label="Account">
        <Avatar class="size-7">
          <AvatarFallback class="text-[11px]">{{ initials }}</AvatarFallback>
        </Avatar>
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-56">
      <DropdownMenuLabel class="font-normal">
        <div class="text-sm font-medium">{{ user?.displayName || 'Signed in' }}</div>
        <div class="text-muted-foreground truncate text-xs">{{ user?.email }}</div>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem @click="logout">
        <LogOutIcon />
        Sign out
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
