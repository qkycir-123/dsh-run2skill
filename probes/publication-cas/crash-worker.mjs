import { readFile } from 'node:fs/promises'
import { createBundle, mergeBundle } from './adapter.mjs'

const config = JSON.parse(await readFile(process.argv[2], 'utf8'))

if (config.kind === 'CREATE') {
  await createBundle(config)
} else if (config.kind === 'MERGE') {
  await mergeBundle(config)
} else {
  throw new Error(`Unknown worker operation: ${config.kind}`)
}

throw new Error(`Crash point was not reached: ${config.crashAt}`)
