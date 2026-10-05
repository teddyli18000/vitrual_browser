/**
 * The marker this fixture exists to write.
 *
 * It reports the addon's **own** runtime id rather than a hard-coded string, so the value the check
 * asserts on cannot drift from the manifest: if a different addon ran, or the id changed, the marker
 * says so. `verify-window.mjs` compares it with the id it read out of this directory's
 * `manifest.json` before installing it.
 *
 * Only ever installed into the throwaway profile `verify-window.mjs` creates, and only matched
 * against the loopback probe page, so it runs nowhere else.
 */
document.documentElement.dataset.vfoxAddon = browser.runtime.id
