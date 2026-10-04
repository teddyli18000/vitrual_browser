#!/usr/bin/env node
/**
 * version.mjs — the single source of truth for the VFox application version.
 *
 * The version is duplicated by necessity (three package.json files) and by the release tag, so
 * this script turns that duplication into a checked invariant:
 *   - `package.json` (workspace root), `apps/desktop/package.json` and `packages/cli/package.json`
 *     must agree;
 *   - the version must look like a release version (X.Y.Z, optional `-prerelease`);
 *   - when a release tag is supplied it must equal `v<version>`.
 *
 * Contract:
 *   stdout — exactly one line: the version, without any `v` prefix.
 *   stderr — diagnostics.
 *   exit 1 with a clear reason on any mismatch.
 *
 * `packages/cli/package.json` is checked because `vfox --version` and the CLI help header print
 * that package's own version, and nothing kept it in step with the application: it drifted to
 * 0.1.0 while the app shipped 0.2.x, so the CLI told users a version that never existed as a
 * release. A version a user can read must be one the release process maintains. The other
 * workspace packages stay at their own placeholder version on purpose — they are private and
 * nothing displays them.
 *
 * Usage:
 *   node scripts/version.mjs
 *   node scripts/version.mjs --tag v0.1.0
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** @param {string} message */
function fail(message) {
  console.error(`[version] ${message}`)
  process.exit(1)
}

function readVersion(relativePath) {
  const file = path.join(repoRoot, relativePath)
  let pkg
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return fail(`cannot read ${relativePath}: ${error.message}`)
  }
  if (typeof pkg.version !== 'string' || !RELEASE_VERSION.test(pkg.version)) {
    return fail(
      `${relativePath} has version ${JSON.stringify(pkg.version)}, which is not a release ` +
        'version of the form X.Y.Z or X.Y.Z-prerelease.',
    )
  }
  return pkg.version
}

const rootVersion = readVersion('package.json')
const desktopVersion = readVersion('apps/desktop/package.json')
const cliVersion = readVersion('packages/cli/package.json')

if (rootVersion !== desktopVersion) {
  fail(
    `package.json is ${rootVersion} but apps/desktop/package.json is ${desktopVersion}.\n` +
      '  Both must be bumped together — the installer is built from apps/desktop.',
  )
}

if (rootVersion !== cliVersion) {
  fail(
    `package.json is ${rootVersion} but packages/cli/package.json is ${cliVersion}.\n` +
      "  They must be bumped together — `vfox --version` and the CLI help header print the CLI's\n" +
      '  own package version, so a stale one tells the user a version that was never released.',
  )
}

const tagIndex = process.argv.indexOf('--tag')
if (tagIndex !== -1) {
  const tag = process.argv[tagIndex + 1]
  if (!tag) fail('--tag requires a value, e.g. --tag v0.1.0')
  if (tag !== `v${rootVersion}`) {
    fail(
      `release tag ${tag} does not match the package version v${rootVersion}.\n` +
        `  Bump package.json and apps/desktop/package.json to ${tag.slice(1)}, or retag.`,
    )
  }
}

console.log(rootVersion)
