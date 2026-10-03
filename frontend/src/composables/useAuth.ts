import { ref } from 'vue'
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  updateProfile,
  type User,
} from 'firebase/auth'
import { auth } from '@/lib/firebase'

const user = ref<User | null>(null)
let markReady: () => void
/** Resolves after Firebase restored (or failed to restore) the persisted session. */
export const authReady = new Promise<void>((resolve) => (markReady = resolve))

onAuthStateChanged(auth, (u) => {
  user.value = u
  markReady()
})

const AUTH_MESSAGES: Record<string, string> = {
  'auth/invalid-credential': 'Email or password is incorrect.',
  'auth/user-not-found': 'No account with that email.',
  'auth/wrong-password': 'Email or password is incorrect.',
  'auth/email-already-in-use': 'An account with this email already exists. Sign in instead.',
  'auth/weak-password': 'Use at least 6 characters for your password.',
  'auth/invalid-email': 'That email address looks invalid.',
  'auth/too-many-requests': 'Too many attempts. Wait a minute and try again.',
  'auth/network-request-failed': 'Network error. Check your connection.',
  'auth/configuration-not-found': 'Sign-in is not configured for this Firebase project (enable Authentication → Email/Password).',
  'auth/operation-not-allowed': 'Email/password sign-in is disabled for this Firebase project.',
}

export function authErrorMessage(err: unknown) {
  const code = (err as { code?: string })?.code ?? ''
  return AUTH_MESSAGES[code] ?? 'Something went wrong. Please try again.'
}

export function useAuth() {
  return {
    user,
    async signIn(email: string, password: string) {
      await signInWithEmailAndPassword(auth, email, password)
    },
    async signUp(name: string, email: string, password: string) {
      const cred = await createUserWithEmailAndPassword(auth, email, password)
      if (name) await updateProfile(cred.user, { displayName: name })
    },
    signOut: () => fbSignOut(auth),
  }
}
