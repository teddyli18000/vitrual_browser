/**
 * Does the viewport a real window reports agree with the window the OS actually gave it?
 *
 * Anchored on `osRect` — a second, independent source — rather than on the page's own `outer*`, because
 * comparing our number to our number cannot catch a wrong allowance. `devicePixelRatio` converts the
 * page's CSS pixels into the physical pixels the OS rectangle is measured in.
 *
 * The fingerprint's `innerWidth`/`innerHeight` are `0` and never reach the engine: `_castToProperties`
 * skips falsy entries (`if (!data) continue`, camoufox-js `dist/fingerprints.js:12`), so the key is
 * absent from CAMOU_CONFIG and Firefox reports its own true viewport. This check exists so that stops
 * being true by accident — if anyone ever emits a non-zero value, the engine starts overriding, and
 * this is where it shows up.
 *
 * What it catches: a viewport that is zero, negative, larger than the window it sits in, or offset far
 * enough to leave an implausible amount of chrome.
 *
 * What it cannot catch, and no geometry check can: a plausible-but-wrong value. The real chrome on the
 * CI runner is 16x65; an allowance of 16x90 would be indistinguishable from the truth by geometry
 * alone. The honest answer to that is to emit nothing and let the browser report its own viewport.
 */

/** A real window's chrome: 0-160 px wide and 0-200 px tall, before the display scale is applied. */
export const VIEWPORT_LIMITS = { maxChromeWidth: 160, maxChromeHeight: 200 }

/**
 * @param {{ osRect: { width: number, height: number }, innerWidth: number, innerHeight: number,
 *           devicePixelRatio?: number }} view
 * @returns {{ ok: boolean, failures: string[], chrome: { width: number, height: number } }}
 */
export function checkViewportAgainstOs({ osRect, innerWidth, innerHeight, devicePixelRatio }) {
  const scale = devicePixelRatio > 0 ? devicePixelRatio : 1
  const chromeWidth = osRect.width - innerWidth * scale
  const chromeHeight = osRect.height - innerHeight * scale
  const failures = []

  if (!(innerWidth > 0) || !(innerHeight > 0)) {
    failures.push(`the page reports a ${innerWidth}x${innerHeight} viewport`)
  }
  if (chromeWidth < 0 || chromeWidth > VIEWPORT_LIMITS.maxChromeWidth * scale) {
    failures.push(
      `the OS window is ${osRect.width}px wide and the page claims a ${innerWidth}px viewport at ` +
        `${scale}x, leaving ${Math.round(chromeWidth)}px of chrome`,
    )
  }
  if (chromeHeight < 0 || chromeHeight > VIEWPORT_LIMITS.maxChromeHeight * scale) {
    failures.push(
      `the OS window is ${osRect.height}px tall and the page claims a ${innerHeight}px viewport at ` +
        `${scale}x, leaving ${Math.round(chromeHeight)}px of chrome`,
    )
  }

  return {
    ok: failures.length === 0,
    failures,
    chrome: { width: Math.round(chromeWidth), height: Math.round(chromeHeight) },
  }
}
