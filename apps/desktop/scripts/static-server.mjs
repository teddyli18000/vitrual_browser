/**
 * A ~30-line static file server for the built renderer, used by `screenshot-ui.mjs`.
 *
 * No dependency on purpose: `vite preview` would drag the whole Vite CLI in, and the app uses hash
 * routing so there is nothing to rewrite — an unknown path simply falls back to `index.html`.
 */

import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

export function createStaticServer(root) {
  return createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    const relative = normalize(pathname === '/' ? 'index.html' : pathname).replace(/^[/\\]+/, '')
    const target = join(root, relative)

    const send = (body, type, code = 200) => {
      response.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
      response.end(body)
    }

    // `normalize` collapses `..`, so this is belt and braces; the check is what makes it safe.
    if (target !== root && !target.startsWith(root + sep)) {
      send('forbidden', 'text/plain; charset=utf-8', 403)
      return
    }

    try {
      send(await readFile(target), MIME[extname(target)] ?? 'application/octet-stream')
    } catch {
      try {
        send(await readFile(join(root, 'index.html')), MIME['.html'])
      } catch {
        send('not found', 'text/plain; charset=utf-8', 404)
      }
    }
  })
}
