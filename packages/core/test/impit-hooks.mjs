/**
 * Module-resolution hook for the sandboxed local runner: redirect `impit` to `./impit-stub.mjs`.
 *
 * See `impit-stub.mjs` for why. The hook is registered by `sandbox-preload.mjs` only when the
 * machine actually needs the sandbox workarounds, so CI and unsandboxed development resolve the
 * real addon.
 */

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'impit') {
    return { url: new URL('./impit-stub.mjs', import.meta.url).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
