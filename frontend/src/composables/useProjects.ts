import { onScopeDispose, ref } from 'vue'
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import type { Project } from '@/lib/types'
import { toProject } from './converters'

export function useProjects(uid: string) {
  const projects = ref<Project[]>([])
  const loading = ref(true)
  const error = ref<string | null>(null)
  const q = query(
    collection(db, 'projects'),
    where('ownerId', '==', uid),
    where('deletedAt', '==', null),
    orderBy('updatedAt', 'desc'),
  )
  const unsub = onSnapshot(
    q,
    (snap) => {
      projects.value = snap.docs.map((d) => toProject(d.id, d.data()))
      loading.value = false
    },
    (err) => {
      error.value = err.message
      loading.value = false
    },
  )
  onScopeDispose(unsub)
  return { projects, loading, error }
}
