/**
 * Guards the on-demand Element Plus registration.
 *
 * `plugins/element-plus.ts` registers components individually instead of `app.use(ElementPlus)`,
 * which cut the renderer from 3.08 MB to 1.65 MB. The failure mode it introduces is nasty: if a
 * name in that list is not an installable plugin, `app.use()` only logs a warning and the component
 * silently never registers — a blank or half-rendered UI that **typechecks and bundles perfectly**.
 * Neither `tsc`, `vue-tsc` nor `vite build` can see it.
 *
 * This imports the real `element-plus` ESM build in Node, reads the component list out of the
 * plugin source (so it cannot drift), and asserts every entry is installable. No browser needed,
 * which is why it runs where `screenshot-ui.mjs` cannot.
 *
 *   node scripts/check-ui-registration.mjs
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ElementPlus from 'element-plus'

const appRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const pluginPath = join(appRoot, 'src', 'renderer', 'src', 'plugins', 'element-plus.ts')
const source = await readFile(pluginPath, 'utf8')

const listBlock = source.match(/const components: Plugin\[\] = \[([\s\S]*?)\]/)?.[1]
if (!listBlock) {
  console.error(`Could not find the component list in ${pluginPath}`)
  process.exit(1)
}

const names = [...listBlock.matchAll(/\b(El[A-Za-z]+)\b/g)].map(match => match[1])
const styles = [...source.matchAll(/element-plus\/es\/components\/([\w-]+)\/style\/css/g)].map(
  match => match[1],
)

console.log(`components registered : ${names.length}`)
console.log(`style entries imported: ${styles.length}`)

let failures = 0
for (const name of names) {
  // Dynamic on purpose: the list is read from the plugin source so it cannot drift, and this
  // script is a build-time check that is never bundled, so tree shaking is irrelevant.
  // biome-ignore lint/performance/noDynamicNamespaceImportAccess: verifying a runtime-read list
  const exported = ElementPlus[name]
  if (typeof exported?.install !== 'function') {
    failures += 1
    console.error(
      `FAIL  ${name} is not installable (export is ${typeof exported}, install is ${typeof exported?.install})`,
    )
  }
}

// `ElMessage` / `ElMessageBox` are imported directly where used, so only their styles are listed.
const serviceStyles = ['message', 'message-box']
for (const style of serviceStyles) {
  if (!styles.includes(style)) {
    failures += 1
    console.error(`FAIL  the ${style} style entry is missing — those elements would be unstyled`)
  }
}

if (failures > 0) {
  console.error(`\n${failures} problem(s): the UI would render with missing components.`)
  process.exit(1)
}

console.log('\nOK — every registered component is installable and every style entry is present.')
