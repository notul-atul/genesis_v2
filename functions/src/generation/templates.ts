import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// Compiled to lib/generation/*.js, templates live at <functions>/templates
const TEMPLATES_DIR = join(__dirname, '..', '..', 'templates')

export const SYSTEM_PROMPT = readFileSync(join(TEMPLATES_DIR, 'system-prompt.md'), 'utf8')

function readTree(dir: string): { path: string; content: string }[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return readTree(full)
    return [{ path: relative(STARTER_DIR, full).split('\\').join('/'), content: readFileSync(full, 'utf8') }]
  })
}

const STARTER_DIR = join(TEMPLATES_DIR, 'starter')
export const STARTER_FILES = readTree(STARTER_DIR)
