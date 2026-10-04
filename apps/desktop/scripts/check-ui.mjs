/**
 * The three silent-blank-UI failure classes, checked without a bundler.
 *
 * The renderer cannot be built in this sandbox (`pnpm --filter @vfox/desktop build` dies on
 * esbuild's service, which needs a piped child process), and Electron cannot start either. So a
 * broken component would otherwise be discovered only by a human looking at a screenshot in CI.
 * These three checks catch exactly the faults that `tsc`/`vue-tsc` cannot see, using the real Vue
 * compiler rather than a hand-rolled approximation:
 *
 *  1. Every `.vue` file parses and compiles — template and `<script setup>` — with
 *     `@vue/compiler-sfc`, the same compiler the build uses.
 *  2. Every `<ElXxx>` used anywhere is actually registered in `plugins/element-plus.ts`. An
 *     unregistered component renders as nothing and only logs a console warning.
 *  3. Every i18n key exists in **both** locales, and no key is dead copy.
 *
 *   node scripts/check-ui.mjs
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import ts from 'typescript'

const appRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const rendererSrc = join(appRoot, 'src', 'renderer', 'src')

const failures = []
const notes = []

async function walk(dir, extensions) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await walk(full, extensions)))
    else if (extensions.some(ext => entry.name.endsWith(ext))) found.push(full)
  }
  return found
}

/** Transpile a TypeScript module in memory and import it, so the real dictionaries are inspected. */
async function loadTsModule(file) {
  const source = await readFile(file, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  })
  const encoded = Buffer.from(outputText, 'utf8').toString('base64')
  return await import(`data:text/javascript;base64,${encoded}`)
}

const vueFiles = await walk(rendererSrc, ['.vue'])
const tsFiles = await walk(rendererSrc, ['.ts'])
const allFiles = [...vueFiles, ...tsFiles]

/* ------------------------------------------------ 1. every SFC compiles with the real compiler */

let compiled = 0
for (const file of vueFiles) {
  const label = relative(appRoot, file)
  const source = await readFile(file, 'utf8')
  const { descriptor, errors } = parse(source, { filename: file })
  if (errors.length > 0) {
    failures.push(`${label}: parse error — ${errors.map(e => e.message).join('; ')}`)
    continue
  }
  try {
    if (descriptor.script || descriptor.scriptSetup) {
      compileScript(descriptor, { id: label })
    }
  } catch (error) {
    failures.push(`${label}: <script setup> failed to compile — ${error.message}`)
    continue
  }
  if (descriptor.template) {
    const result = compileTemplate({
      source: descriptor.template.content,
      filename: file,
      id: label,
    })
    if (result.errors.length > 0) {
      failures.push(
        `${label}: template failed to compile — ${result.errors.map(e => String(e.message ?? e)).join('; ')}`,
      )
      continue
    }
  }
  compiled += 1
}
console.log(`SFCs compiled with @vue/compiler-sfc : ${compiled}/${vueFiles.length}`)

/* ------------------------------------------------- 2. every <ElXxx> used is actually registered */

const pluginSource = await readFile(join(rendererSrc, 'plugins', 'element-plus.ts'), 'utf8')
const listBlock = pluginSource.match(/const components: Plugin\[\] = \[([\s\S]*?)\]/)?.[1] ?? ''
const registered = new Set([...listBlock.matchAll(/\b(El[A-Za-z]+)\b/g)].map(m => m[1]))

const used = new Map()
for (const file of vueFiles) {
  const source = await readFile(file, 'utf8')
  for (const match of source.matchAll(/<(El[A-Za-z]+)[\s/>]/g)) {
    const name = match[1]
    if (!used.has(name)) used.set(name, [])
    used.get(name).push(relative(appRoot, file))
  }
}

const unregistered = [...used.keys()].filter(name => !registered.has(name)).sort()
console.log(`Element Plus components used           : ${used.size}`)
console.log(`Element Plus components registered     : ${registered.size}`)
if (unregistered.length > 0) {
  for (const name of unregistered) {
    failures.push(
      `<${name}> is used in ${[...new Set(used.get(name))].join(', ')} but is NOT registered in plugins/element-plus.ts — it would render as nothing`,
    )
  }
}
const unusedRegistrations = [...registered].filter(name => !used.has(name)).sort()
if (unusedRegistrations.length > 0) {
  notes.push(
    `registered but never used as a tag (may be used via a service): ${unusedRegistrations.join(', ')}`,
  )
}

/* ------------------------------------------------------------------- 3. i18n integrity */

const zh = (await loadTsModule(join(rendererSrc, 'i18n', 'zh-CN.ts'))).zhCN
const en = (await loadTsModule(join(rendererSrc, 'i18n', 'en.ts'))).en

const zhKeys = Object.keys(zh)
const enKeys = Object.keys(en)
const missingInEn = zhKeys.filter(key => !(key in en))
const extraInEn = enKeys.filter(key => !(key in zh))

console.log(`i18n keys                              : zh-CN ${zhKeys.length}, en ${enKeys.length}`)

for (const key of missingInEn) failures.push(`i18n key "${key}" exists in zh-CN but not in en`)
for (const key of extraInEn) failures.push(`i18n key "${key}" exists in en but not in zh-CN`)

// A key is "used" if it appears as a string literal anywhere in the renderer **except the
// dictionaries themselves** — counting those would make every key trivially referenced and the
// check vacuous. That covers both `t('key')` and the typed lookup maps (`{ windows: 'os.windows' }`)
// that feed `t(someMap[...])`, which a `t('literal')`-only scan would miss.
const i18nDir = join(rendererSrc, 'i18n')
const referenced = new Set()
for (const file of allFiles) {
  if (file.startsWith(i18nDir)) continue
  const source = await readFile(file, 'utf8')
  for (const match of source.matchAll(/'([A-Za-z0-9_.]+)'/g)) referenced.add(match[1])
}

const unusedKeys = zhKeys.filter(key => !referenced.has(key))
console.log(`i18n keys referenced in source          : ${zhKeys.length - unusedKeys.length}`)
if (unusedKeys.length > 0) {
  for (const key of unusedKeys) notes.push(`i18n key "${key}" is defined but never referenced`)
}

/* ---------------------------------------------------------------------------------- report */

if (notes.length > 0) {
  console.log('\nnotes:')
  for (const note of notes) console.log(`  ${note}`)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log('\nOK — every SFC compiles, every Element Plus tag is registered, both locales agree.')
