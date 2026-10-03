<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Loader2Icon } from '@lucide/vue'
import AppLogo from '@/components/AppLogo.vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { authErrorMessage, useAuth } from '@/composables/useAuth'

const route = useRoute()
const router = useRouter()
const { signIn, signUp } = useAuth()

const isSignup = computed(() => route.name === 'signup')
const name = ref('')
const email = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)

async function submit() {
  error.value = ''
  busy.value = true
  try {
    if (isSignup.value) await signUp(name.value.trim(), email.value.trim(), password.value)
    else await signIn(email.value.trim(), password.value)
    const next = typeof route.query.next === 'string' && route.query.next.startsWith('/') ? route.query.next : '/dashboard'
    router.replace(next)
  } catch (err) {
    error.value = authErrorMessage(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="bg-muted/40 flex min-h-svh flex-col items-center justify-center gap-6 p-4">
    <AppLogo class="text-lg" />
    <Card class="w-full max-w-sm">
      <CardHeader>
        <CardTitle class="text-xl">{{ isSignup ? 'Create your account' : 'Welcome back' }}</CardTitle>
        <CardDescription>
          {{ isSignup ? 'Build HighLevel apps by describing them.' : 'Sign in to continue building.' }}
        </CardDescription>
      </CardHeader>
      <form @submit.prevent="submit">
        <CardContent class="grid gap-4">
          <div v-if="isSignup" class="grid gap-2">
            <Label for="name">Name</Label>
            <Input id="name" v-model="name" autocomplete="name" placeholder="Ada Lovelace" />
          </div>
          <div class="grid gap-2">
            <Label for="email">Email</Label>
            <Input id="email" v-model="email" type="email" autocomplete="email" required placeholder="you@company.com" />
          </div>
          <div class="grid gap-2">
            <Label for="password">Password</Label>
            <Input
              id="password"
              v-model="password"
              type="password"
              :autocomplete="isSignup ? 'new-password' : 'current-password'"
              required
              minlength="6"
            />
          </div>
          <Alert v-if="error" variant="destructive">
            <AlertDescription>{{ error }}</AlertDescription>
          </Alert>
        </CardContent>
        <CardFooter class="mt-6 flex flex-col gap-3">
          <Button type="submit" class="w-full" :disabled="busy">
            <Loader2Icon v-if="busy" class="animate-spin" />
            {{ isSignup ? 'Create account' : 'Sign in' }}
          </Button>
          <p class="text-muted-foreground text-center text-sm">
            <template v-if="isSignup">
              Already have an account?
              <RouterLink :to="{ name: 'login', query: route.query }" class="text-foreground underline underline-offset-4">Sign in</RouterLink>
            </template>
            <template v-else>
              New here?
              <RouterLink :to="{ name: 'signup', query: route.query }" class="text-foreground underline underline-offset-4">Create an account</RouterLink>
            </template>
          </p>
        </CardFooter>
      </form>
    </Card>
  </div>
</template>
