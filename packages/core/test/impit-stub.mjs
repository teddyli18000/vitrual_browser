/**
 * Stand-in for `impit`, camoufox-js's native HTTP addon, used only by the sandboxed local runner.
 *
 * `camoufox-js/dist/utils.js` imports `./ip.js`, which does `import { Impit } from 'impit'` at
 * module load and keeps constructed clients in a module-level Map. That native addon cannot survive
 * a Vitest worker thread being torn down: importing it and doing nothing else crashed the process
 * with `0xC0000005` in 4 of 6 measured runs. Nothing in this package's tests performs an HTTP
 * request (the fingerprints are generated with `geoip: false`), so the addon is never needed.
 *
 * This is deliberately a loud stub rather than a silent one: if a test ever does need the real
 * client, constructing it fails immediately instead of quietly making a network call.
 */

export class Impit {
  constructor() {
    throw new Error(
      'impit is stubbed by the sandboxed local test runner (native addon crashes Vitest worker ' +
        'threads on this machine); run the suite in CI or unsandboxed to exercise it',
    )
  }
}

export default { Impit }
