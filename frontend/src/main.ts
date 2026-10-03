import { createApp } from 'vue'
import { install as MonacoPlugin } from '@guolao/vue-monaco-editor'
import App from './App.vue'
import { router } from './router'
import './style.css'

createApp(App)
  .use(router)
  .use(MonacoPlugin, { paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.54.0/min/vs' } })
  .mount('#app')
