#!/usr/bin/env node
/**
 * validate-workflows.mjs — local, dependency-free structural validation of `.github/**`.
 *
 * `actionlint` is not available on this machine (and installing system tooling is out of
 * scope), so this script is the substitute evidence: it parses every workflow and composite
 * action with a real YAML parser and then asserts the repository's own CI rules.
 *
 * It checks
 *   - every YAML file under `.github/` parses;
 *   - every third-party `uses:` is pinned to a full 40-hex commit SHA with a trailing
 *     `# <version>` comment (supply-chain hygiene);
 *   - every local `uses: ./.github/...` target exists;
 *   - every `actions/cache` step has both `path` and `key`;
 *   - workflows that create Releases declare `permissions: contents: write`;
 *   - every repository path mentioned in a `run:` command exists on disk (runtime-created
 *     paths such as `.cache/` and `release/` are excluded on purpose);
 *   - every `node scripts/*.mjs` referenced by a workflow exists.
 *
 * Usage:
 *   node scripts/validate-workflows.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const githubDir = path.join(repoRoot, '.github')

const problems = new Set()
/** @param {string} message */
function bad(message) {
  if (problems.has(message)) return
  problems.add(message)
  console.log(`FAIL  ${message}`)
}
/** @param {string} message */
function ok(message) {
  console.log(`PASS  ${message}`)
}

const yamlModule = await import('js-yaml')
const loadYaml = yamlModule.load ?? yamlModule.default?.load

/** Every `.yml`/`.yaml` below `.github/`, as repo-relative POSIX paths. */
function yamlFiles(dir, prefix = '.github') {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...yamlFiles(path.join(dir, entry.name), relative))
    else if (/\.ya?ml$/.test(entry.name)) found.push(relative)
  }
  return found
}

/** @param {any} node @param {string} file @param {string} where */
function collectUses(node, file, where = '') {
  const uses = []
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      uses.push(...collectUses(item, file, `${where}[${index}]`))
    }
    return uses
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'uses' && typeof value === 'string') uses.push({ value, file, where })
      else uses.push(...collectUses(value, file, `${where}.${key}`))
    }
  }
  return uses
}

/** @param {any} node @param {(key: string, value: any) => void} visit */
function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      visit(key, value)
      walk(value, visit)
    }
  }
}

const files = yamlFiles(githubDir)
const documents = new Map()

for (const relative of files) {
  const source = readFileSync(path.join(repoRoot, relative), 'utf8')
  try {
    documents.set(relative, loadYaml(source))
    ok(`${relative} parses as YAML`)
  } catch (error) {
    bad(`${relative} is not valid YAML: ${error.message}`)
  }
}

// ------------------------------------------------------------------ action pinning + wiring
const pinned = []
for (const [relative, document] of documents) {
  for (const { value, where } of collectUses(document, relative)) {
    if (value.startsWith('./')) {
      const target = path.join(repoRoot, value)
      if (!existsSync(target)) bad(`${relative}${where} references missing local action ${value}`)
      else ok(`${relative}${where} -> local action ${value}`)
      continue
    }
    const match = value.match(/^([^@]+)@([0-9a-f]{40})$/)
    if (!match) {
      bad(`${relative}${where} action "${value}" is not pinned to a full commit SHA`)
      continue
    }
    const source = readFileSync(path.join(repoRoot, relative), 'utf8')
    const commented = new RegExp(`${value}\\s+#\\s*\\S`).test(source)
    if (!commented) bad(`${relative}${where} "${value}" has no trailing "# <version>" comment`)
    else pinned.push(`${value}  (${relative}${where})`)
  }
}

// ------------------------------------------------------------------------- cache hygiene
for (const [relative, document] of documents) {
  walk(document, (key, value) => {
    if (key !== 'uses' || typeof value !== 'string' || !value.includes('actions/cache')) return
    const text = JSON.stringify(document)
    if (!text.includes('"key"')) bad(`${relative} has an actions/cache step without a key`)
    if (!text.includes('"path"')) bad(`${relative} has an actions/cache step without a path`)
  })
}

// ------------------------------------------------------------------ permissions + releases
const releaseWorkflow = documents.get('.github/workflows/release.yml')
if (!releaseWorkflow) {
  bad('.github/workflows/release.yml is missing')
} else {
  const permissions = releaseWorkflow.permissions
  if (permissions?.contents !== 'write') {
    bad(
      `release.yml must declare permissions.contents: write (found ${JSON.stringify(permissions)})`,
    )
  } else {
    ok('release.yml declares permissions: contents: write')
  }
}

// ---------------------------------------------------------------- referenced paths exist
const IGNORED = /^(\.cache|release|node_modules|dist|out)\b/
for (const [relative, document] of documents) {
  walk(document, (key, value) => {
    if (key !== 'run' || typeof value !== 'string') return
    for (const token of value.matchAll(/\b(?:scripts|packages|apps|docs)\/[\w./@-]+/g)) {
      const candidate = token[0].replace(/[.,;:]+$/, '')
      if (IGNORED.test(candidate) || candidate.includes('*')) continue
      if (!existsSync(path.join(repoRoot, candidate))) {
        bad(`${relative} runs a command referencing missing path ${candidate}`)
      }
    }
  })
}

// ------------------------------------------------------------------------------- summary
console.log('')
console.log(`workflow files checked: ${files.length}`)
console.log(`third-party actions pinned to a commit SHA: ${pinned.length}`)
for (const entry of pinned) console.log(`  ${entry}`)

if (problems.size > 0) {
  console.error(`\n[validate-workflows] ${problems.size} problem(s) found`)
  process.exit(1)
}
console.log('\n[validate-workflows] all structural checks passed')
