import { init as initLexer, parse as parseModule } from 'es-module-lexer'

/**
 * Turns the project's flat file map into a single HTML document for an iframe `srcdoc`.
 *
 * A sandboxed srcdoc iframe cannot fetch sibling files, so every local module becomes a
 * `data:` URL registered in an import map under a bare `@app/<path>` specifier. Relative
 * imports inside modules are rewritten to those bare specifiers (a data: URL can't be a
 * base for relative resolution). Local stylesheets and classic scripts are inlined.
 * No bundler, no server round-trip: rebuilding a preview takes a few milliseconds.
 */

export interface PreviewRuntime {
  /** Base URL of the HighLevel proxy (the generated hl-client calls `${baseUrl}/contacts/...`). */
  baseUrl: string
  token: string
  locationId: string
}

export interface PreviewBuild {
  html: string
  problems: string[]
}

const APP_PREFIX = '@app/'
const isExternal = (url: string) => /^(https?:)?\/\//i.test(url) || /^(data|blob):/i.test(url)

export function resolvePath(fromFile: string, spec: string): string {
  const baseParts = spec.startsWith('/') ? [] : fromFile.split('/').slice(0, -1)
  for (const part of spec.replace(/^\//, '').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') baseParts.pop()
    else baseParts.push(part)
  }
  return baseParts.join('/')
}

const toDataUrl = (code: string, mime = 'text/javascript') => `data:${mime};charset=utf-8,${encodeURIComponent(code)}`

export async function buildPreview(files: Map<string, string>, runtime: PreviewRuntime | null): Promise<PreviewBuild> {
  await initLexer
  const problems: string[] = []
  const entry = files.get('index.html')
  if (entry === undefined) {
    return { html: messageDoc('No index.html yet', 'Ask Genesis to build something.'), problems: ['index.html is missing'] }
  }

  const imports: Record<string, string> = {}
  const visiting = new Set<string>()

  /** Registers a local file as a module and returns its bare specifier. */
  const registerModule = (path: string, importer: string): string => {
    let resolved = path
    if (!files.has(resolved) && files.has(`${resolved}.js`)) resolved = `${resolved}.js`
    const key = APP_PREFIX + resolved
    if (imports[key] || visiting.has(resolved)) return key
    const content = files.get(resolved)
    if (content === undefined) {
      problems.push(`${importer}: cannot find module "${path}"`)
      imports[key] = toDataUrl(`throw new Error(${JSON.stringify(`Module not found: ${path} (imported from ${importer})`)})`)
      return key
    }
    if (/\.css$/i.test(resolved)) {
      imports[key] = toDataUrl(
        `const s = document.createElement('style'); s.dataset.file = ${JSON.stringify(resolved)}; s.textContent = ${JSON.stringify(content)}; document.head.appendChild(s); export default s.textContent;`,
      )
      return key
    }
    if (/\.json$/i.test(resolved)) {
      imports[key] = toDataUrl(`export default ${safeJson(content, resolved, problems)};`)
      return key
    }
    visiting.add(resolved)
    imports[key] = toDataUrl(rewriteImports(content, resolved, registerModule, problems))
    visiting.delete(resolved)
    return key
  }

  const doc = new DOMParser().parseFromString(entry, 'text/html')

  // Merge any import map the app declares (e.g. "vue" -> CDN) with ours.
  for (const el of Array.from(doc.querySelectorAll('script[type="importmap"]'))) {
    try {
      Object.assign(imports, JSON.parse(el.textContent || '{}').imports ?? {})
    } catch {
      problems.push('index.html: invalid import map JSON')
    }
    el.remove()
  }

  for (const link of Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]'))) {
    const href = link.getAttribute('href')!
    if (isExternal(href)) continue
    const path = resolvePath('index.html', href)
    const css = files.get(path)
    const style = doc.createElement('style')
    style.dataset.file = path
    if (css === undefined) problems.push(`index.html: stylesheet "${href}" not found`)
    style.textContent = css ?? ''
    link.replaceWith(style)
  }

  for (const script of Array.from(doc.querySelectorAll<HTMLScriptElement>('script'))) {
    const src = script.getAttribute('src')
    const isModule = script.getAttribute('type') === 'module'
    if (src && isExternal(src)) continue
    if (src) {
      const path = resolvePath('index.html', src)
      const inline = doc.createElement('script')
      if (isModule) {
        inline.type = 'module'
        inline.textContent = `import ${JSON.stringify(registerModule(path, 'index.html'))};`
      } else {
        const code = files.get(path)
        if (code === undefined) problems.push(`index.html: script "${src}" not found`)
        inline.textContent = code ?? ''
      }
      script.replaceWith(inline)
    } else if (isModule) {
      script.textContent = rewriteImports(script.textContent ?? '', 'index.html', registerModule, problems)
    }
  }

  // Local SVG images.
  for (const img of Array.from(doc.querySelectorAll<HTMLImageElement>('img[src]'))) {
    const src = img.getAttribute('src')!
    if (isExternal(src)) continue
    const svg = files.get(resolvePath('index.html', src))
    if (svg !== undefined) img.setAttribute('src', toDataUrl(svg, 'image/svg+xml'))
  }

  // Runtime prelude must run before any module, and the import map must precede module scripts.
  const head = doc.head
  const map = doc.createElement('script')
  map.type = 'importmap'
  map.textContent = JSON.stringify({ imports })
  head.prepend(map)
  const bridge = doc.createElement('script')
  bridge.textContent = bridgeScript(runtime?.baseUrl ?? '')
  head.prepend(bridge)
  const config = doc.createElement('script')
  config.textContent = `window.__HL_CONFIG__ = ${JSON.stringify(runtime ?? {}).replace(/</g, '\\u003c')};`
  head.prepend(config)

  return { html: `<!doctype html>\n${doc.documentElement.outerHTML}`, problems }
}

function safeJson(content: string, path: string, problems: string[]) {
  try {
    return JSON.stringify(JSON.parse(content))
  } catch {
    problems.push(`${path}: invalid JSON`)
    return 'null'
  }
}

function rewriteImports(
  code: string,
  file: string,
  register: (path: string, importer: string) => string,
  problems: string[],
): string {
  let imports
  try {
    ;[imports] = parseModule(code)
  } catch (err) {
    problems.push(`${file}: syntax error (${err instanceof Error ? err.message.split('\n')[0] : 'parse failed'})`)
    return `throw new SyntaxError(${JSON.stringify(`Syntax error in ${file}`)});`
  }
  let out = code
  // Replace from the end so earlier offsets stay valid.
  for (const imp of [...imports].sort((a, b) => b.start - a.start)) {
    const spec = imp.specifier
    if (!spec || !/^(\.{1,2}\/|\/)/.test(spec)) continue
    const bare = register(resolvePath(file, spec), file)
    const replacement = imp.type === 'dynamic' ? JSON.stringify(bare) : bare
    out = out.slice(0, imp.start) + replacement + out.slice(imp.end)
  }
  return out
}

/**
 * Injected into the preview. Reports runtime errors, console errors and HighLevel
 * requests to the parent window so the workspace can surface them (and offer "Fix with AI").
 */
function bridgeScript(proxyBase: string) {
  return `(() => {
  const BASE = ${JSON.stringify(proxyBase)};
  const send = (type, payload) => { try { parent.postMessage({ __genesis: true, type, ...payload }, '*'); } catch {} };
  const text = (v) => { try { return v instanceof Error ? (v.stack || v.message) : typeof v === 'object' ? JSON.stringify(v) : String(v); } catch { return String(v); } };
  window.addEventListener('error', (e) => {
    if (e.target && e.target !== window) {
      send('error', { message: 'Failed to load ' + (e.target.src || e.target.href || e.target.tagName) });
    } else {
      send('error', { message: e.message || text(e.error), line: e.lineno });
    }
  }, true);
  window.addEventListener('unhandledrejection', (e) => send('error', { message: 'Unhandled promise rejection: ' + text(e.reason) }));
  for (const level of ['error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      const message = args.map(text).join(' ');
      if (!/cdn\\.tailwindcss\\.com should not be used in production/.test(message)) send('console', { level, message });
      orig(...args);
    };
  }
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init && init.method) || (input && input.method) || 'GET';
    const tracked = BASE && url.startsWith(BASE);
    const started = performance.now();
    try {
      const res = await origFetch(input, init);
      if (tracked) send('request', { method, path: url.slice(BASE.length), status: res.status, ms: Math.round(performance.now() - started) });
      return res;
    } catch (err) {
      if (tracked) send('request', { method, path: url.slice(BASE.length), status: 0, ms: Math.round(performance.now() - started), error: text(err) });
      throw err;
    }
  };
  window.addEventListener('load', () => send('ready', {}));
})();`
}

export function messageDoc(title: string, body: string) {
  return `<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;color:#64748b;background:#f8fafc"><div style="text-align:center;max-width:320px"><p style="font-weight:600;color:#0f172a;margin:0 0 6px">${title}</p><p style="margin:0;font-size:14px">${body}</p></div></body></html>`
}
