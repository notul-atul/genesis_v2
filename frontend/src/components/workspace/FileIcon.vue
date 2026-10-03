<script setup lang="ts">
import { computed } from 'vue'
import { FileCodeIcon, FileIcon, FileJsonIcon, FileTextIcon, ImageIcon, PaletteIcon } from '@lucide/vue'

const props = defineProps<{ path: string }>()
const icon = computed(() => {
  const ext = props.path.split('.').pop()?.toLowerCase()
  if (ext === 'js' || ext === 'mjs' || ext === 'html') return FileCodeIcon
  if (ext === 'css') return PaletteIcon
  if (ext === 'json') return FileJsonIcon
  if (ext === 'svg') return ImageIcon
  if (ext === 'md' || ext === 'txt') return FileTextIcon
  return FileIcon
})
const color = computed(() => {
  const ext = props.path.split('.').pop()?.toLowerCase()
  return { js: 'text-amber-500', mjs: 'text-amber-500', html: 'text-orange-500', css: 'text-sky-500', json: 'text-emerald-600', svg: 'text-fuchsia-500' }[ext ?? ''] ?? 'text-muted-foreground'
})
</script>

<template>
  <component :is="icon" class="size-3.5 shrink-0" :class="color" />
</template>
