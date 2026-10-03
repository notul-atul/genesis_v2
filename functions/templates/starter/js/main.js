import { createApp, ref, onMounted } from 'vue'
import { hl, LOCATION_ID, HLApiError } from './hl-client.js'

const App = {
  setup() {
    const location = ref(null)
    const error = ref('')
    const loading = ref(true)

    onMounted(async () => {
      try {
        const data = await hl.get(`/locations/${LOCATION_ID}`)
        location.value = data.location
      } catch (err) {
        error.value = err instanceof HLApiError ? err.message : 'Could not reach HighLevel'
      } finally {
        loading.value = false
      }
    })

    return { location, error, loading }
  },
  template: `
    <main class="min-h-screen grid place-items-center p-8">
      <div class="max-w-md w-full rounded-2xl border bg-white p-8 shadow-sm text-center space-y-3">
        <div class="mx-auto size-12 rounded-full bg-indigo-50 grid place-items-center text-indigo-600 text-xl">✦</div>
        <h1 class="text-xl font-semibold">Your HighLevel app starts here</h1>
        <p v-if="loading" class="text-sm text-slate-500">Checking your HighLevel connection…</p>
        <p v-else-if="error" class="text-sm text-red-600">{{ error }}</p>
        <p v-else class="text-sm text-slate-600">
          Connected to <span class="font-medium text-slate-900">{{ location?.name }}</span>.
          Describe the app you want in the chat and Genesis will build it.
        </p>
      </div>
    </main>
  `,
}

createApp(App).mount('#app')
