import { createRouter, createWebHistory } from 'vue-router'
import { authReady, useAuth } from './composables/useAuth'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/dashboard' },
    { path: '/login', name: 'login', component: () => import('./views/AuthView.vue'), meta: { guest: true } },
    { path: '/signup', name: 'signup', component: () => import('./views/AuthView.vue'), meta: { guest: true } },
    { path: '/dashboard', name: 'dashboard', component: () => import('./views/DashboardView.vue'), meta: { auth: true } },
    {
      path: '/projects/:id',
      name: 'workspace',
      component: () => import('./views/WorkspaceView.vue'),
      meta: { auth: true },
      props: true,
    },
    { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
  ],
})

router.beforeEach(async (to) => {
  await authReady
  const { user } = useAuth()
  if (to.meta.auth && !user.value) return { name: 'login', query: { next: to.fullPath } }
  if (to.meta.guest && user.value) return { name: 'dashboard' }
})
