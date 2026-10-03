import { logger } from 'firebase-functions'
import { LIMITS } from '../config.js'
import { db } from '../lib/firebase.js'
import { hlFetch } from '../hl/client.js'
import type { ProjectDoc } from '../projects/store.js'

/**
 * Everything the model sees besides the static system prompt. Each source has a
 * budget so a large project or a chatty session can't blow the context window,
 * and HighLevel lookups are time-boxed so a slow HL API never blocks generation.
 */
export async function buildUserMessage(opts: {
  uid: string
  pid: string
  project: ProjectDoc
  contents: Map<string, string>
  prompt: string
  hl: { locationId?: string; locationName?: string; timezone?: string | null } | undefined
}): Promise<{ text: string; notes: string[] }> {
  const notes: string[] = []
  const [history, hlContext] = await Promise.all([
    loadHistory(opts.pid),
    opts.hl?.locationId ? loadHlContext(opts.uid, opts.hl.locationId, notes) : Promise.resolve('Not connected.'),
  ])

  const parts: string[] = []
  parts.push(`<project name="${attr(opts.project.name)}">\n${opts.project.description || '(no description)'}\n</project>`)
  parts.push(`<highlevel_location>\n${opts.hl?.locationName ? `Name: ${opts.hl.locationName}\n` : ''}${opts.hl?.timezone ? `Timezone: ${opts.hl.timezone}\n` : ''}${hlContext}\n</highlevel_location>`)
  parts.push(`<current_files>\n${renderFiles(opts.contents, notes)}\n</current_files>`)
  if (history) parts.push(`<conversation_history>\n${history}\n</conversation_history>`)
  parts.push(`Today is ${new Date().toISOString().slice(0, 10)}.`)
  parts.push(`<user_request>\n${opts.prompt}\n</user_request>`)
  return { text: parts.join('\n\n'), notes }
}

const attr = (s: string) => s.replace(/"/g, "'")

function renderFiles(contents: Map<string, string>, notes: string[]) {
  let budget = LIMITS.contextFileChars
  const out: string[] = []
  const omitted: string[] = []
  // hl-client.js is documented in the system prompt, so it is the first to drop when over budget.
  const ordered = [...contents.entries()].sort(([a], [b]) => {
    const rank = (p: string) => (p === 'index.html' ? 0 : p === 'js/hl-client.js' ? 2 : 1)
    return rank(a) - rank(b) || a.localeCompare(b)
  })
  for (const [path, content] of ordered) {
    if (content.length > budget) {
      omitted.push(`${path} (${content.length} chars)`)
      continue
    }
    budget -= content.length
    out.push(`<current_file path="${attr(path)}">\n${content}\n</current_file>`)
  }
  if (omitted.length) {
    out.push(`Omitted for length (exist but not shown; do not rewrite unless needed): ${omitted.join(', ')}`)
    notes.push(`${omitted.length} file(s) omitted from context`)
  }
  return out.join('\n')
}

async function loadHistory(pid: string) {
  const snap = await db
    .collection('projects')
    .doc(pid)
    .collection('messages')
    .orderBy('createdAt', 'desc')
    .limit(LIMITS.contextHistoryMessages)
    .get()
  return snap.docs
    .reverse()
    .map((d) => {
      const m = d.data() as { role: string; content: string; operations?: { path: string; action: string }[] }
      const files = m.operations?.length ? `\n[changed: ${m.operations.map((o) => `${o.action} ${o.path}`).join(', ')}]` : ''
      return `${m.role}: ${m.content.slice(0, LIMITS.contextHistoryCharsEach)}${files}`
    })
    .join('\n\n')
}

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))])

/** Live, bounded facts about the location so the model can build against real data shapes. */
async function loadHlContext(uid: string, locationId: string, notes: string[]) {
  const [calendars, contacts, conversations] = await Promise.allSettled([
    withTimeout(hlFetch<{ calendars: { id: string; name: string; isActive?: boolean }[] }>(uid, '/calendars/', { query: { locationId } }), 5000),
    withTimeout(hlFetch<{ contacts: Record<string, unknown>[]; meta?: { total?: number } }>(uid, '/contacts/', { query: { locationId, limit: 3 } }), 5000),
    withTimeout(hlFetch<{ total?: number }>(uid, '/conversations/search', { query: { locationId, limit: 1 } }), 5000),
  ])
  const lines: string[] = [`Location ID: ${locationId}`]

  if (calendars.status === 'fulfilled') {
    const list = calendars.value.calendars ?? []
    lines.push(`Calendars (${list.length}): ${list.slice(0, 10).map((c) => `${c.name}${c.isActive === false ? ' [inactive]' : ''}`).join('; ') || 'none'}`)
  } else lines.push('Calendars: unavailable right now')

  if (contacts.status === 'fulfilled') {
    const sample = contacts.value.contacts ?? []
    lines.push(`Contacts: ${contacts.value.meta?.total ?? sample.length} total`)
    // Field names only (no PII) so the model knows which attributes are actually populated.
    const populated = new Set<string>()
    for (const c of sample) for (const [k, v] of Object.entries(c)) if (v !== null && v !== '' && !(Array.isArray(v) && !v.length)) populated.add(k)
    if (populated.size) lines.push(`Contact fields populated in this location: ${[...populated].sort().join(', ')}`)
  } else lines.push('Contacts: unavailable right now')

  if (conversations.status === 'fulfilled') lines.push(`Conversations: ${conversations.value.total ?? 'unknown'} total`)
  else lines.push('Conversations: unavailable right now')

  const failed = [calendars, contacts, conversations].filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
  if (failed.length) {
    notes.push('Some HighLevel context could not be loaded')
    logger.warn('HL context partially unavailable', { reasons: failed.map((f) => String(f.reason)) })
  }
  return lines.join('\n')
}
