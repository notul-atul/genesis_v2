// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { buildPreview, resolvePath } from './buildPreview'

const runtime = { baseUrl: 'https://api.test/hl-proxy', token: 'tok', locationId: 'loc1' }

const files = new Map([
  [
    'index.html',
    `<!doctype html><html><head>
      <script type="importmap">{ "imports": { "vue": "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js" } }</script>
      <link rel="stylesheet" href="./styles.css">
      </head><body><div id="app"></div><script type="module" src="./js/main.js"></script></body></html>`,
  ],
  ['styles.css', 'body { color: red }'],
  ['js/main.js', `import { createApp } from 'vue'\nimport { list } from './api/contacts.js'\nimport '../extra.css'\ncreateApp({}).mount('#app')`],
  ['js/api/contacts.js', `import { hl } from '../hl-client.js'\nexport const list = () => hl.get('/contacts/')`],
  ['js/hl-client.js', `export const hl = { get: (p) => fetch(window.__HL_CONFIG__.baseUrl + p) }`],
  ['extra.css', '.x{}'],
])

function importMap(html: string) {
  const json = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)![1]
  return JSON.parse(json).imports as Record<string, string>
}
const decode = (dataUrl: string) => decodeURIComponent(dataUrl.split(',').slice(1).join(','))

describe('resolvePath', () => {
  it.each([
    ['js/main.js', './api/x.js', 'js/api/x.js'],
    ['js/api/x.js', '../hl-client.js', 'js/hl-client.js'],
    ['js/main.js', '/styles.css', 'styles.css'],
    ['index.html', './js/main.js', 'js/main.js'],
  ])('%s + %s', (from, spec, out) => expect(resolvePath(from, spec)).toBe(out))
})

describe('buildPreview', () => {
  it('inlines CSS, rewrites module graph to an import map and injects runtime config first', async () => {
    const { html, problems } = await buildPreview(files, runtime)
    expect(problems).toEqual([])
    const map = importMap(html)
    expect(map.vue).toContain('unpkg.com/vue')
    expect(Object.keys(map).sort()).toEqual(['@app/extra.css', '@app/js/api/contacts.js', '@app/js/hl-client.js', '@app/js/main.js', 'vue'])
    expect(decode(map['@app/js/main.js'])).toContain(`from '@app/js/api/contacts.js'`)
    expect(decode(map['@app/js/api/contacts.js'])).toContain(`from '@app/js/hl-client.js'`)
    expect(html).toContain('body { color: red }')
    expect(html).toContain('import "@app/js/main.js";')
    // config must run before anything else
    expect(html.indexOf('__HL_CONFIG__ =')).toBeLessThan(html.indexOf('type="importmap"'))
    expect(html.indexOf('type="importmap"')).toBeLessThan(html.indexOf('import "@app/js/main.js"'))
  })

  it('reports missing modules instead of failing the build', async () => {
    const broken = new Map(files)
    broken.set('js/main.js', `import { x } from './nope.js'`)
    const { html, problems } = await buildPreview(broken, runtime)
    expect(problems).toEqual(['js/main.js: cannot find module "js/nope.js"'])
    expect(decode(importMap(html)['@app/js/nope.js'])).toContain('Module not found')
  })

  it('handles missing index.html', async () => {
    const { problems } = await buildPreview(new Map([['a.js', '']]), runtime)
    expect(problems).toEqual(['index.html is missing'])
  })

  it('escapes the runtime config so it cannot break out of the script tag', async () => {
    const { html } = await buildPreview(files, { ...runtime, token: '</script><script>alert(1)</script>' })
    expect(html).not.toContain('</script><script>alert(1)')
  })
})
