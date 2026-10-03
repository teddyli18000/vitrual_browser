#!/usr/bin/env node
/**
 * version.mjs — the single source of truth for the VFox application version.
 *
 * The version is duplicated by necessity (two package.json files) and by the release tag,
 * so this script is what turns that duplication into a checked invariant:
 *   - `package.json` (workspace root) and `apps/desktop/package.json` must agree;
 *   - the version must look like a release version (X.Y.Z, optional `-prerelease`);
 *   - when a release tag is supplied it must equal `v<version>`.
 *
 * Contract:
 *   stdout — exactly one line: the version, without any `v` prefix.
 *   stderr — diagnostics.
 *   exit 1 with a clear reason on any mismatch.
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

if (rootVersion !== desktopVersion) {
  fail(
    `package.json is ${rootVersion} but apps/desktop/package.json is ${desktopVersion}.\n` +
      '  Both must be bumped together — the installer is built from apps/desktop.',
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
