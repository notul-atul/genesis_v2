<script setup lang="ts">
import { watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAuth } from '@/composables/useAuth'
import 'vue-sonner/style.css'

const { user } = useAuth()
const router = useRouter()
const route = useRoute()

// Signed out in another tab or session revoked: leave protected pages.
watch(user, (u) => {
  if (!u && route.meta.auth) router.replace({ name: 'login' })
})
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <RouterView />
  </TooltipProvider>
  <Toaster rich-colors close-button position="bottom-right" />
</template>
