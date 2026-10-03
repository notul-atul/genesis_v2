<script setup lang="ts">
import { ref, watch } from 'vue'
import { Loader2Icon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

const props = defineProps<{
  title: string
  submitLabel: string
  initial?: { name: string; description: string }
  submit: (v: { name: string; description: string }) => Promise<void>
}>()
const open = defineModel<boolean>('open', { required: true })

const name = ref('')
const description = ref('')
const busy = ref(false)
const error = ref('')

watch(open, (o) => {
  if (!o) return
  name.value = props.initial?.name ?? ''
  description.value = props.initial?.description ?? ''
  error.value = ''
})

async function onSubmit() {
  if (!name.value.trim()) return
  busy.value = true
  error.value = ''
  try {
    await props.submit({ name: name.value.trim(), description: description.value.trim() })
    open.value = false
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>The description gives the AI extra context about what this app is for.</DialogDescription>
      </DialogHeader>
      <form id="project-form" class="grid gap-4" @submit.prevent="onSubmit">
        <div class="grid gap-2">
          <Label for="project-name">Name</Label>
          <Input id="project-name" v-model="name" maxlength="80" placeholder="Sales cockpit" required autofocus />
        </div>
        <div class="grid gap-2">
          <Label for="project-description">Description</Label>
          <Textarea
            id="project-description"
            v-model="description"
            maxlength="500"
            rows="3"
            placeholder="Dashboard for the front desk team to find contacts and see today's appointments."
          />
        </div>
        <p v-if="error" class="text-destructive text-sm">{{ error }}</p>
      </form>
      <DialogFooter>
        <Button variant="outline" @click="open = false">Cancel</Button>
        <Button type="submit" form="project-form" :disabled="busy || !name.trim()">
          <Loader2Icon v-if="busy" class="animate-spin" />
          {{ submitLabel }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
