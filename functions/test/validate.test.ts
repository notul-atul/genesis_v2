import { describe, expect, it } from 'vitest'
import { applyOperations, normalizePath, stripCodeFences, validateOutput } from '../src/generation/validate.js'

describe('normalizePath', () => {
  it.each([
    ['./js/app.js', 'js/app.js'],
    ['/index.html', 'index.html'],
    ['js\\api\\contacts.js', 'js/api/contacts.js'],
  ])('normalises %s', (input, out) => expect(normalizePath(input)).toBe(out))

  it.each(['../secret.js', 'js/../../x.js', '.env', 'js/.hidden.js', 'app.exe', 'a/b/c/d/e/f/g.js', '', 'js//a.js'])(
    'rejects %s',
    (p) => expect(normalizePath(p)).toBeNull(),
  )
})

describe('validateOutput', () => {
  const existing = new Set(['index.html', 'js/main.js', 'js/old.js'])

  it('classifies create/update/delete and reports syntax problems', () => {
    const out = validateOutput(
      {
        files: [
          { path: 'js/main.js', content: 'export const a = 1' },
          { path: 'js/new.js', content: 'export const = broken' },
        ],
        deletes: ['js/old.js', 'index.html', 'missing.js'],
      },
      existing,
    )
    expect(out.operations).toEqual([
      { action: 'update', path: 'js/main.js', content: 'export const a = 1' },
      { action: 'create', path: 'js/new.js', content: 'export const = broken' },
      { action: 'delete', path: 'js/old.js' },
    ])
    expect(out.warnings.some((w) => w.startsWith('js/new.js:'))).toBe(true)
    expect(out.rejected).toEqual([{ path: 'index.html', reason: 'the entry file cannot be deleted' }])
  })

  it('rejects unsafe paths and strips code fences', () => {
    const out = validateOutput({ files: [{ path: '../x.js', content: 'x' }, { path: 'a.css', content: '```css\nbody{}\n```' }], deletes: [] }, new Set())
    expect(out.rejected[0].path).toBe('../x.js')
    expect(out.operations).toEqual([{ action: 'create', path: 'a.css', content: 'body{}' }])
  })

  it('applies operations', () => {
    const next = applyOperations(new Map([['a.js', '1'], ['b.js', '2']]), [
      { action: 'update', path: 'a.js', content: '3' },
      { action: 'delete', path: 'b.js' },
    ])
    expect([...next.entries()]).toEqual([['a.js', '3']])
  })

  it('leaves unfenced content alone', () => {
    expect(stripCodeFences('const a = "```"')).toBe('const a = "```"')
  })
})
