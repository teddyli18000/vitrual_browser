/**
 * A failed engine install must not leave `version.json` in the target.
 *
 * `camoufox-js`'s own `setVersion()` writes `<INSTALL_DIR>/version.json` — the target, not the incoming
 * directory — and it runs before the extraction, so a failure there leaves a marker in a directory whose
 * engine is absent or stale. `inspectKernel` keys on that file, so the next `listInstalledKernels` reports
 * a kernel that cannot launch.
 *
 * WHY THIS IS A SCRIPT AND NOT A VITEST CASE: vitest cannot run in the development sandbox (vite spawns a
 * child with a pipe and the sandbox forbids it), so a local check has to be a plain `.mjs` over the built
 * `dist/`. Run it after `pnpm --filter @vfox/core build`.
 *
 * KNOWN LIMITATION, and it has already produced one false positive here: this passes `targetDir: root`, so
 * its target IS the legacy root, while the product puts kernels under `<engineRoot>/kernels/<version>` and
 * keeps the root marker separate. It therefore cannot express the real layout, and a green here is not
 * evidence about it — `verify-install.mjs` and the `engine install from scratch` job are. It is left this
 * shape deliberately rather than reshaped to fit a failure, because a check edited until it agrees is how
 * this repository has lost guards before.
 */ import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { installCamoufoxEngine } from '../dist/kernel.js'

const mode = process.argv[2] ?? 'corrupt'
const root = path.resolve(`.cache/tmp/marker-root-${mode}`)
await fs.rm(root, { recursive: true, force: true })
await fs.mkdir(root, { recursive: true })

const payload = Buffer.from('PK not a zip')
const server = createServer((req, res) => {
  if (mode === 'download-fails') {
    req.socket.destroy()
    return
  }
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-length': String(payload.length),
  })
  if (req.method === 'HEAD') return res.end()
  res.end(payload)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
process.env.CAMOUFOX_INSTALL_DIR = root
process.env.VFOX_ENGINE_URL = `http://127.0.0.1:${server.address().port}/engine.zip`
process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'

let failure = null
await installCamoufoxEngine(() => {}, { version: '152.0.4-beta.30', targetDir: root }).catch(
  error => {
    failure = String(error?.message ?? error)
  },
)
server.close()

const marker = await fs.stat(path.join(root, 'version.json')).then(
  () => true,
  () => false,
)
console.log(
  JSON.stringify({ mode, markerLeftInTarget: marker, installError: failure, ok: !marker }, null, 2),
)
process.exit(marker ? 1 : 0)
