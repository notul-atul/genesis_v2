import { ref, watch } from 'vue'
import { doc, onSnapshot, type Timestamp, type Unsubscribe } from 'firebase/firestore'
import { api } from '@/lib/api'
import { db } from '@/lib/firebase'
import type { HlConnection } from '@/lib/types'
import { useAuth } from './useAuth'

const connection = ref<HlConnection | null>(null)
const loaded = ref(false)
let unsub: Unsubscribe | null = null

const { user } = useAuth()
watch(
  user,
  (u) => {
    unsub?.()
    connection.value = null
    loaded.value = false
    if (!u) return
    unsub = onSnapshot(
      doc(db, 'users', u.uid),
      (snap) => {
        const hl = snap.get('hl') as (Omit<HlConnection, 'connectedAt'> & { connectedAt?: Timestamp }) | undefined
        connection.value = hl?.locationId ? { ...hl, connectedAt: hl.connectedAt?.toDate() ?? null } : null
        loaded.value = true
      },
      () => (loaded.value = true),
    )
  },
  { immediate: true },
)

export function useHlConnection() {
  return {
    connection,
    loaded,
    /** Starts the OAuth flow: the API returns HighLevel's consent URL with a single-use state. */
    async connect() {
      const { url } = await api<{ url: string }>('POST', '/oauth/start')
      window.location.assign(url)
    },
    disconnect: () => api('POST', '/oauth/disconnect'),
  }
}
