/** TEMPORARY: which piece of the tolerance path fails against the simulated 156 engine? */
import { launchOptions } from 'camoufox-js'
import {
  suppressUnknownKeys,
  unknownPropertyKey,
  withUnknownKeyTolerance,
} from '../dist/engine-config.js'

const base = { os: 'windows', headless: true, i_know_what_im_doing: true, geoip: false, config: {} }

// 1. the parser
try {
  await launchOptions({ ...base })
} catch (error) {
  console.log(`error message: ${JSON.stringify(error.message)}`)
  console.log(`parsed key: ${JSON.stringify(unknownPropertyKey(error))}`)
  console.log(`is Error: ${error instanceof Error}`)
}

// 2. suppression around the same call
try {
  await suppressUnknownKeys(['canvas:aaOffset'], () => launchOptions({ ...base }))
  console.log('suppressUnknownKeys([canvas:aaOffset]): OK')
} catch (error) {
  console.log(`suppressUnknownKeys([canvas:aaOffset]): ${error.message}`)
}

// 3. suppression of both keys
try {
  await suppressUnknownKeys(['canvas:aaOffset', 'canvas:aaCapOffset'], () =>
    launchOptions({ ...base }),
  )
  console.log('suppressUnknownKeys([both]): OK')
} catch (error) {
  console.log(`suppressUnknownKeys([both]): ${error.message}`)
}

// 4. the retry loop
const seen = []
try {
  await withUnknownKeyTolerance(
    () => launchOptions({ ...base }),
    message => seen.push(message),
  )
  console.log('withUnknownKeyTolerance: OK')
} catch (error) {
  console.log(`withUnknownKeyTolerance: ${error.message}`)
}
console.log(`warnings: ${JSON.stringify(seen)}`)
