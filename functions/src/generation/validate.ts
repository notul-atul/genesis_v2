import { parse as parseJs } from 'acorn'
import { LIMITS } from '../config.js'
import type { ParseResult } from './parser.js'

export type FileOperation =
  | { action: 'create' | 'update'; path: string; content: string }
  | { action: 'delete'; path: string }

export interface ValidationOutcome {
  operations: FileOperation[]
  /** Non-fatal problems. Shown to the user next to the result. */
  warnings: string[]
  /** Operations that were refused entirely. */
  rejected: { path: string; reason: string }[]
}

const ALLOWED_EXT = /\.(html|css|js|mjs|json|svg|md|txt)$/i
const PROTECTED = new Set(['index.html'])

/** Normalises a model-supplied path or returns null if it is unsafe. */
export function normalizePath(raw: string): string | null {
  let p = raw.trim().replace(/\\/g, '/')
  p = p.replace(/^(\.\/)+/, '').replace(/^\/+/, '')
  if (!p || p.length > 200) return null
  if (/[\u0000-\u001f<>:"|?*]/.test(p)) return null
  const parts = p.split('/')
  if (parts.length > 6) return null
  if (parts.some((s) => !s || s === '.' || s === '..' || s.startsWith('.'))) return null
  if (!ALLOWED_EXT.test(p)) return null
  return p
}

/** Models occasionally wrap file content in markdown fences despite instructions. */
export function stripCodeFences(content: string): string {
  const m = content.match(/^\s*```[\w-]*\r?\n([\s\S]*?)\r?\n```\s*$/)
  return m ? m[1] : content
}

export function syntaxProblem(path: string, content: string): string | null {
  try {
    if (/\.(js|mjs)$/i.test(path)) parseJs(content, { ecmaVersion: 'latest', sourceType: 'module' })
    else if (/\.json$/i.test(path)) JSON.parse(content)
    else if (/\.html$/i.test(path) && !/<html[\s>]/i.test(content) && !/<body[\s>]/i.test(content)) {
      return 'does not look like an HTML document'
    }
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/**
 * Converts parsed model output into validated operations against the current file set.
 * Unsafe paths and oversized files are rejected; syntax errors are kept but reported,
 * because a slightly broken file the user can fix (or ask the AI to fix) is more useful
 * than silently losing the work.
 */
export function validateOutput(parsed: Pick<ParseResult, 'files' | 'deletes'>, existingPaths: Set<string>): ValidationOutcome {
  const warnings: string[] = []
  const rejected: { path: string; reason: string }[] = []
  const byPath = new Map<string, FileOperation>()

  for (const f of parsed.files) {
    const path = normalizePath(f.path)
    if (!path) {
      rejected.push({ path: f.path, reason: 'unsafe or unsupported path' })
      continue
    }
    const content = stripCodeFences(f.content)
    if (Buffer.byteLength(content, 'utf8') > LIMITS.maxFileBytes) {
      rejected.push({ path, reason: `larger than ${LIMITS.maxFileBytes / 1000} KB` })
      continue
    }
    if (!content.trim()) {
      rejected.push({ path, reason: 'empty file' })
      continue
    }
    if (byPath.has(path)) warnings.push(`${path} was written twice; kept the last version`)
    const problem = syntaxProblem(path, content)
    if (problem) warnings.push(`${path}: ${problem}`)
    byPath.set(path, { action: existingPaths.has(path) ? 'update' : 'create', path, content })
  }

  for (const raw of parsed.deletes) {
    const path = normalizePath(raw)
    if (!path) {
      rejected.push({ path: raw, reason: 'unsafe or unsupported path' })
      continue
    }
    if (PROTECTED.has(path)) {
      rejected.push({ path, reason: 'the entry file cannot be deleted' })
      continue
    }
    if (byPath.has(path)) {
      warnings.push(`${path} was both written and deleted; kept the written version`)
      continue
    }
    if (!existingPaths.has(path)) continue // deleting something that doesn't exist is a no-op
    byPath.set(path, { action: 'delete', path })
  }

  return { operations: [...byPath.values()], warnings, rejected }
}

/** Applies operations to a path->content map, returning the new map. */
export function applyOperations(current: Map<string, string>, ops: FileOperation[]): Map<string, string> {
  const next = new Map(current)
  for (const op of ops) {
    if (op.action === 'delete') next.delete(op.path)
    else next.set(op.path, op.content)
  }
  return next
}
