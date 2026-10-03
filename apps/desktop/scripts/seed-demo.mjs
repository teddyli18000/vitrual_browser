/**
 * Seeds a data directory with a realistic profile set, for manual QA and screenshots.
 *
 *   node scripts/seed-demo.mjs [dataDir]
 *
 * The data itself lives in `demo-data.mjs`, shared with `screenshot-ui.mjs`. Idempotent — safe to
 * re-run, and it never overwrites a profile a human has been testing with.
 */

import { join } from 'node:path'
import { seedDemoData } from './demo-data.mjs'

const dataDir = process.argv[2] ?? join(process.cwd(), '.cache', 'userdata')

console.log(`seeding ${dataDir}`)
const { profiles, groups } = await seedDemoData(dataDir)
console.log(`done: ${profiles.length} profile(s), ${groups.length} group(s) in ${dataDir}`)
