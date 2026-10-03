<script setup lang="ts">
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import { CheckCircle2Icon, Link2Icon, Loader2Icon, PlugZapIcon, TriangleAlertIcon, UnplugIcon } from '@lucide/vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useHlConnection } from '@/composables/useHlConnection'
import { relativeTime } from '@/lib/format'

const { connection, loaded, connect, disconnect } = useHlConnection()
const busy = ref<'connect' | 'disconnect' | null>(null)

async function onConnect() {
  busy.value = 'connect'
  try {
    await connect() // navigates away to HighLevel
  } catch (err) {
    toast.error('Could not start HighLevel connection', { description: (err as Error).message })
    busy.value = null
  }
}

async function onDisconnect() {
  busy.value = 'disconnect'
  try {
    await disconnect()
    toast.success('HighLevel disconnected')
  } catch (err) {
    toast.error('Could not disconnect', { description: (err as Error).message })
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <Card>
    <CardHeader class="flex flex-row items-start justify-between gap-4">
      <div class="space-y-1.5">
        <CardTitle class="flex items-center gap-2">
          <PlugZapIcon class="size-4" />
          HighLevel connection
        </CardTitle>
        <CardDescription>Generated apps read and write data in this sub-account through the HighLevel API.</CardDescription>
      </div>
      <Skeleton v-if="!loaded" class="h-5 w-24" />
      <Badge v-else-if="connection?.status === 'connected'" class="bg-emerald-600 text-white">
        <CheckCircle2Icon />
        Connected
      </Badge>
      <Badge v-else-if="connection?.status === 'expired'" class="bg-amber-500 text-white">
        <TriangleAlertIcon />
        Needs reconnect
      </Badge>
      <Badge v-else variant="outline">Not connected</Badge>
    </CardHeader>
    <CardContent>
      <div v-if="!loaded" class="space-y-2">
        <Skeleton class="h-4 w-48" />
        <Skeleton class="h-8 w-40" />
      </div>
      <div v-else-if="connection" class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div class="font-medium">{{ connection.locationName }}</div>
          <div class="text-muted-foreground text-xs">
            Location {{ connection.locationId }}
            <template v-if="connection.timezone"> · {{ connection.timezone }}</template>
            <template v-if="connection.connectedAt"> · connected {{ relativeTime(connection.connectedAt) }}</template>
          </div>
        </div>
        <div class="flex gap-2">
          <Button v-if="connection.status === 'expired'" size="sm" :disabled="!!busy" @click="onConnect">
            <Loader2Icon v-if="busy === 'connect'" class="animate-spin" />
            <Link2Icon v-else />
            Reconnect
          </Button>
          <Button v-else variant="outline" size="sm" :disabled="!!busy" @click="onConnect">
            <Link2Icon />
            Switch location
          </Button>
          <Button variant="ghost" size="sm" :disabled="!!busy" @click="onDisconnect">
            <Loader2Icon v-if="busy === 'disconnect'" class="animate-spin" />
            <UnplugIcon v-else />
            Disconnect
          </Button>
        </div>
      </div>
      <div v-else class="flex flex-wrap items-center justify-between gap-4">
        <p class="text-muted-foreground max-w-md text-sm">
          Connect a HighLevel sub-account (use a sandbox account for testing). You'll pick the location on HighLevel's consent screen.
        </p>
        <Button :disabled="!!busy" @click="onConnect">
          <Loader2Icon v-if="busy === 'connect'" class="animate-spin" />
          <Link2Icon v-else />
          Connect HighLevel
        </Button>
      </div>
    </CardContent>
  </Card>
</template>
