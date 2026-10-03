const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const dtf = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function relativeTime(date: Date | null | undefined): string {
  if (!date) return 'just now'
  const diff = (date.getTime() - Date.now()) / 1000
  const abs = Math.abs(diff)
  if (abs < 45) return 'just now'
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  return rtf.format(Math.round(diff / 86400), 'day')
}

export const absoluteTime = (date: Date | null | undefined) => (date ? dtf.format(date) : '')

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
}

export function languageFor(path: string) {
  const ext = path.split('.').pop()?.toLowerCase()
  return (
    { js: 'javascript', mjs: 'javascript', html: 'html', css: 'css', json: 'json', md: 'markdown', svg: 'xml' }[ext ?? ''] ??
    'plaintext'
  )
}

export async function sha256(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
