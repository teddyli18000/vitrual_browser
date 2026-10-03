// TEMPORARY probe — verifies whether camoufox-js launchServer() + playwright-core's
// internal `_userDataDir` hook yields a persistent profile AND a wsEndpoint.
import fs from 'node:fs'
import path from 'node:path'
import { firefox } from 'playwright-core'
import { launchServer } from 'camoufox-js'

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..')
const userDataDir = path.join(repoRoot, '.cache', 'tmp', 'probe-profile')
fs.rmSync(userDataDir, { recursive: true, force: true })
fs.mkdirSync(userDataDir, { recursive: true })

const t0 = Date.now()
const server = await launchServer({
  _userDataDir: userDataDir,
  _sharedBrowser: true,
  headless: false,
  noDefaultViewport: true,
  os: 'windows',
  geoip: false,
  locale: 'en-US',
})
console.log('[probe] launch ms:', Date.now() - t0)
console.log('[probe] wsEndpoint:', server.wsEndpoint())
console.log('[probe] pid:', server.process()?.pid)

const browser = await firefox.connect(server.wsEndpoint())
const ctx = browser.contexts()[0]
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto('about:blank')
const fp = await page.evaluate(() => ({
  userAgent: navigator.userAgent,
  hardwareConcurrency: navigator.hardwareConcurrency,
  platform: navigator.platform,
  language: navigator.language,
  outerWidth: window.outerWidth,
  outerHeight: window.outerHeight,
}))
console.log('[probe] fingerprint:', JSON.stringify(fp))
console.log('[probe] userDataDir entries:', fs.readdirSync(userDataDir).length)

await browser.close() // client disconnect
await new Promise((r) => setTimeout(r, 1500))
console.log('[probe] alive after client disconnect:', server.process()?.exitCode === null)

const again = await firefox.connect(server.wsEndpoint())
console.log('[probe] reconnect ok, contexts:', again.contexts().length, 'pages:', again.contexts()[0]?.pages().length)
await again.close()

await server.close()
await new Promise((r) => setTimeout(r, 1500))
console.log('[probe] exitCode after close:', server.process()?.exitCode, 'killed:', server.process()?.killed)
