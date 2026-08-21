import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { dshWebArgs } from './web-args.mjs'

test('every run2skill Web probe disables the DSH system-browser launch', async () => {
  assert.deepEqual(dshWebArgs(8751), ['web', '--port', '8751', '--no-open'])
  for (const file of ['probe.mjs', 'candidate-probe.mjs']) {
    const source = await readFile(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
    assert.match(source, /dshWebArgs\(port\)/u, `${file} bypasses the shared no-open command builder`)
    assert.doesNotMatch(source, /\[bin,\s*['"]web['"]/u, `${file} can launch a visible system browser`)
  }
})
