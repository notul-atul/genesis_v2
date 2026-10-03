import { describe, expect, it } from 'vitest'
import { OutputParser, partialSuffixLength, type ParserEvent } from '../src/generation/parser.js'

const SAMPLE = `Building a contact dashboard.
<file path="index.html">
<!doctype html><html><body><div id="app"></div></body></html>
</file>
<file path="js/main.js">
const a = 1 < 2 && '</fil' + 'e>'.length
export default a
</file>
<delete path="js/old.js" />
Try searching by name.`

function run(chunks: string[]) {
  const events: ParserEvent[] = []
  const p = new OutputParser((e) => events.push(e))
  for (const c of chunks) p.push(c)
  return { result: p.finish(), events }
}

function chunk(s: string, size: number) {
  const out: string[] = []
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out
}

describe('OutputParser', () => {
  it('parses files, deletes and prose in one chunk', () => {
    const { result } = run([SAMPLE])
    expect(result.files.map((f) => f.path)).toEqual(['index.html', 'js/main.js'])
    expect(result.files[0].content).toBe('<!doctype html><html><body><div id="app"></div></body></html>')
    expect(result.files[1].content).toContain(`'</fil' + 'e>'`)
    expect(result.deletes).toEqual(['js/old.js'])
    expect(result.text).toBe('Building a contact dashboard.\n\nTry searching by name.')
    expect(result.incomplete).toBeNull()
  })

  it.each([1, 2, 3, 5, 7, 13])('gives identical results for %i-char chunks', (size) => {
    const whole = run([SAMPLE]).result
    const split = run(chunk(SAMPLE, size)).result
    expect(split).toEqual(whole)
  })

  it('streams file content before the file is closed', () => {
    const events: ParserEvent[] = []
    const p = new OutputParser((e) => events.push(e))
    p.push('<file path="a.js">\nconst x = 1\nconst y')
    expect(events[0]).toEqual({ type: 'file_start', path: 'a.js' })
    const streamed = events.filter((e) => e.type === 'file_delta').map((e) => (e as { delta: string }).delta).join('')
    expect(streamed).toBe('const x = 1\nconst y')
  })

  it('reports a truncated file as incomplete', () => {
    const { result } = run(['Hi\n<file path="a.js">\nconst x = 1\n'])
    expect(result.files).toEqual([])
    expect(result.incomplete).toEqual({ path: 'a.js', content: 'const x = 1\n' })
  })

  it('treats html-ish prose as text', () => {
    const { result } = run(['Use a <div> or a <filename> tag, x < y.'])
    expect(result.text).toBe('Use a <div> or a <filename> tag, x < y.')
    expect(result.files).toEqual([])
  })

  it('computes partial suffixes', () => {
    expect(partialSuffixLength('abc</fi', '</file>')).toBe(4)
    expect(partialSuffixLength('abc<', '</file>')).toBe(1)
    expect(partialSuffixLength('abc', '</file>')).toBe(0)
  })
})
