import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { dshWebArgs, supportsNoOpen } from './web-args.mjs'

test('uses --no-open only when the installed DSH advertises it', () => {
  assert.equal(supportsNoOpen('Usage: dsh web\n  --no-open  do not open the browser\n'), true)
  assert.equal(supportsNoOpen('Usage: dsh web\n  --port <port>\n'), false)
  assert.deepEqual(dshWebArgs(8751, true), ['web', '--port', '8751', '--no-open'])
  assert.deepEqual(dshWebArgs(8751, false), ['web', '--port', '8751'])
})

test('every run2skill Web probe uses the shared compatibility-aware command builder', async () => {
  for (const file of ['probe.mjs', 'candidate-probe.mjs']) {
    const source = await readFile(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
    assert.match(source, /dshWebArgs\(port, supportsNoOpen\(webHelp\)\)/u, `${file} bypasses the shared no-open command builder`)
    assert.doesNotMatch(source, /\[bin,\s*['"]web['"]/u, `${file} can launch a visible system browser`)
  }
})
