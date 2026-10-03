/**
 * Incremental parser for the LLM output protocol:
 *
 *   prose...
 *   <file path="js/app.js">
 *   ...content...
 *   </file>
 *   <delete path="old.js" />
 *
 * Tokens arrive in arbitrary chunks, so a tag may be split across pushes. The parser
 * only holds back the shortest tail that could still become a tag; everything else is
 * emitted immediately so the editor can render content in real time.
 */
export type ParserEvent =
  | { type: 'text'; delta: string }
  | { type: 'file_start'; path: string }
  | { type: 'file_delta'; path: string; delta: string }
  | { type: 'file_end'; path: string; content: string }
  | { type: 'delete'; path: string }

export interface ParseResult {
  /** Prose outside of file blocks (shown as the assistant chat message). */
  text: string
  files: { path: string; content: string }[]
  deletes: string[]
  /** A file block that was still open when the stream ended (truncated output). */
  incomplete: { path: string; content: string } | null
}

const OPEN_FILE = /<file\s+path\s*=\s*"([^"]{1,300})"\s*>/
const DELETE = /<delete\s+path\s*=\s*"([^"]{1,300})"\s*\/?>/
const CLOSE_FILE = '</file>'
/** If a "<file" or "<delete" opener has not closed within this many chars it is just text. */
const MAX_TAG_LENGTH = 400

export class OutputParser {
  private buf = ''
  private mode: 'text' | 'file' = 'text'
  private currentPath = ''
  private currentContent = ''
  private atFileStart = false
  private result: ParseResult = { text: '', files: [], deletes: [], incomplete: null }

  constructor(private emit: (e: ParserEvent) => void = () => {}) {}

  push(chunk: string) {
    this.buf += chunk
    this.drain(false)
  }

  /** Flush everything. Call once when the stream ends (normally or not). */
  finish(): ParseResult {
    this.drain(true)
    if (this.mode === 'file') {
      this.result.incomplete = { path: this.currentPath, content: this.currentContent }
    }
    this.result.text = this.result.text.replace(/\n{3,}/g, '\n\n').trim()
    return this.result
  }

  private drain(final: boolean) {
    for (;;) {
      const progressed = this.mode === 'text' ? this.drainText(final) : this.drainFile(final)
      if (!progressed) return
    }
  }

  private emitText(s: string) {
    if (!s) return
    this.result.text += s
    this.emit({ type: 'text', delta: s })
  }

  private emitFileContent(s: string) {
    if (!s) return
    if (this.atFileStart) {
      // Drop the newline right after the opening tag.
      s = s.replace(/^\r?\n/, '')
      if (!s) return
      this.atFileStart = false
    }
    this.currentContent += s
    this.emit({ type: 'file_delta', path: this.currentPath, delta: s })
  }

  /** Returns true if it consumed something and should be called again. */
  private drainText(final: boolean): boolean {
    const lt = this.buf.indexOf('<')
    if (lt === -1) {
      this.emitText(this.buf)
      this.buf = ''
      return false
    }
    this.emitText(this.buf.slice(0, lt))
    this.buf = this.buf.slice(lt)

    const open = this.buf.match(OPEN_FILE)
    if (open && open.index === 0) {
      this.buf = this.buf.slice(open[0].length)
      this.mode = 'file'
      this.currentPath = open[1].trim()
      this.currentContent = ''
      this.atFileStart = true
      this.emit({ type: 'file_start', path: this.currentPath })
      return true
    }
    const del = this.buf.match(DELETE)
    if (del && del.index === 0) {
      this.buf = this.buf.slice(del[0].length)
      const path = del[1].trim()
      this.result.deletes.push(path)
      this.emit({ type: 'delete', path })
      return true
    }

    // Could this still become a tag once more tokens arrive?
    const head = this.buf.slice(0, MAX_TAG_LENGTH)
    const maybeTag =
      !final &&
      this.buf.length < MAX_TAG_LENGTH &&
      !head.includes('>') &&
      (isPrefixOf(head, '<file') || isPrefixOf(head, '<delete') || /^<(file|delete)\s/.test(head))
    if (maybeTag) return false

    // Not a tag: emit the "<" as text and keep scanning.
    this.emitText('<')
    this.buf = this.buf.slice(1)
    return true
  }

  private drainFile(final: boolean): boolean {
    const close = this.buf.indexOf(CLOSE_FILE)
    if (close !== -1) {
      this.emitFileContent(this.buf.slice(0, close))
      this.buf = this.buf.slice(close + CLOSE_FILE.length)
      // Drop the newline right before the closing tag.
      const content = this.currentContent.replace(/\r?\n$/, '')
      this.result.files.push({ path: this.currentPath, content })
      this.emit({ type: 'file_end', path: this.currentPath, content })
      this.mode = 'text'
      this.currentPath = ''
      this.currentContent = ''
      return true
    }
    // Hold back a tail that could be the start of "</file>".
    const keep = final ? 0 : partialSuffixLength(this.buf, CLOSE_FILE)
    this.emitFileContent(this.buf.slice(0, this.buf.length - keep))
    this.buf = this.buf.slice(this.buf.length - keep)
    return false
  }
}

/** True if `s` is a (possibly complete) prefix of `target`, or `target` is a prefix of `s`. */
function isPrefixOf(s: string, target: string) {
  return target.startsWith(s) || s.startsWith(target)
}

/** Length of the longest suffix of `s` that is a proper prefix of `token`. */
export function partialSuffixLength(s: string, token: string) {
  for (let n = Math.min(token.length - 1, s.length); n > 0; n--) {
    if (s.endsWith(token.slice(0, n))) return n
  }
  return 0
}
