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

test('candidate privacy evidence observes proposal detail responses before rc.2 can prefetch them', async () => {
  const source = await readFile(fileURLToPath(new URL('candidate-probe.mjs', import.meta.url)), 'utf8')
  assert.match(source, /page\.on\('response'/u)
  assert.doesNotMatch(source, /detailResponsePromise\s*=\s*page\.waitForResponse/u)
})

test('candidate probe selects the current user-facing proposal label', async () => {
  const source = await readFile(fileURLToPath(new URL('candidate-probe.mjs', import.meta.url)), 'utf8')
  assert.match(source, /getByRole\('button', \{ name: \/generated-file-hygiene\/u \}\)/u)
  assert.doesNotMatch(source, /CREATE · generated-file-hygiene/u)
})

test('stable release probe covers published 0.2.0 and 0.3.0 before the 0.3.1 candidate', async () => {
  const probe = await readFile(fileURLToPath(new URL('release-upgrade-probe.mjs', import.meta.url)), 'utf8')
  const runner = await readFile(fileURLToPath(new URL('../run-install-lifecycle-probe.ps1', import.meta.url)), 'utf8')

  assert.match(probe, /<0\.1\.1-alpha\.tgz> <0\.2\.0\.tgz> <0\.3\.0\.tgz> <0\.3\.1\.tgz>/u)
  assert.match(probe, /candidateManifest\.version, '0\.3\.1'/u)
  assert.match(probe, /currentManifest\.version, '0\.3\.0'/u)
  assert.match(probe, /stableManifest\.version, '0\.2\.0'/u)
  assert.match(runner, /npm pack dsh-run2skill@0\.2\.0/u)
  assert.match(runner, /npm pack dsh-run2skill@0\.3\.0/u)
})
