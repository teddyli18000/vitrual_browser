/**
 * Resolve a module inside `camoufox-js` so it loads from a REAL directory when the app is packaged.
 *
 * This exists because of one defect with two symptoms. In the packaged app the dependency lives
 * inside `app.asar`, and `dist/webgl/sample.js` computes its SQLite path from its own module URL:
 *
 *     const DB_PATH = path.join(currentDir, '..', 'data-files', 'webgl_data.db')
 *
 * Native code cannot open a file inside an asar — Electron's shim patches Node's `fs` layer, and
 * better-sqlite3 calls into libuv directly — so every profile creation died with
 * `SqliteError: unable to open database file`. Unpacking the file is not enough on its own: the
 * module still computes the `app.asar` path, because that is where it was loaded from.
 *
 * `electron-builder` unpacks the whole package to `app.asar.unpacked/node_modules/camoufox-js`,
 * which is a real directory. Loading from there makes the computed path real, and because the
 * package's own internal imports resolve relative to it, this one redirect covers every call site —
 * including `utils.js`'s call inside `launchOptions`, which would otherwise fail on launch rather
 * than on creation and look like a different bug.
 *
 * Outside a packaged app the bare specifier is returned unchanged, so development, the CLI and the
 * tests are untouched.
 *
 * @param subpath a path inside the package, e.g. `dist/pkgman.js`
 */
export function camoufoxModule(subpath = ''): string {
  const specifier = subpath ? `camoufox-js/${subpath}` : 'camoufox-js'
  const here = import.meta.url
  if (!here.includes('/app.asar/')) return specifier

  // The bundle sits at app.asar/out/main/index.cjs, so the package is two levels up and across.
  const unpacked = here.replace('/app.asar/', '/app.asar.unpacked/')
  const target = subpath || 'dist/index.js'
  return new URL(`../../node_modules/camoufox-js/${target}`, unpacked).href
}
