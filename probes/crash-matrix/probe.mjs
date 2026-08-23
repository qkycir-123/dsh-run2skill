import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const candidate = resolve(process.argv[2] ?? '.')
const root = join(candidate, '.probe-work', 'crash-matrix')
await mkdir(root, { recursive: true })
const runRoot = await mkdtemp(join(root, 'run-'))
const worker = join(candidate, 'probes', 'crash-matrix', 'worker.mjs')

function run(caseName, mode, expected = 0) {
  const caseRoot = join(runRoot, caseName)
  const result = spawnSync(process.execPath, [worker, candidate, caseRoot, mode], {
    cwd: candidate,
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(result.status, expected, `${caseName}/${mode} exited unexpectedly: ${result.stderr}`)
  return caseRoot
}

async function records(caseRoot, table) {
  try { return JSON.parse(await readFile(join(caseRoot, `${table}.json`), 'utf8')) }
  catch { return {} }
}

async function global(caseRoot) {
  return JSON.parse(await readFile(join(caseRoot, 'global-v2.json'), 'utf8'))
}

const beforeUpstream = run('before-upstream', 'crash-before-upstream', 23)
run('before-upstream', 'recover')
assert.equal(Object.keys(await records(beforeUpstream, 'turn_observations')).length, 0)
assert.equal((await global(beforeUpstream)).migration.phase, 'COMMITTED')

const historical = run('historical-first-activation', 'historical-turn-crash', 23)
run('historical-first-activation', 'recover')
assert.equal(Object.keys(await records(historical, 'turn_observations')).length, 0)
assert.equal(Object.keys((await global(historical)).activation.observerStartWatermarks).length, 1)

const gap = run('gap-after-activation', 'activate')
run('gap-after-activation', 'offline-turn-crash', 23)
run('gap-after-activation', 'recover')
assert.equal(Object.keys(await records(gap, 'turn_observations')).length, 1)

const observationCrash = run('observation-crash', 'activate')
run('observation-crash', 'gap-crash-after-observation', 23)
run('observation-crash', 'recover')
assert.equal(Object.keys(await records(observationCrash, 'turn_observations')).length, 1)
assert.equal(Object.keys((await global(observationCrash)).sessions).length, 1)

const appended = run('new-tail', 'activate')
run('new-tail', 'offline-turn-crash', 23)
run('new-tail', 'recover')
run('new-tail', 'append-second-turn-crash', 23)
run('new-tail', 'recover')
assert.equal(Object.keys(await records(appended, 'turn_observations')).length, 2)

console.log('CRASH_MATRIX_CASES=5')
console.log('CRASH_MATRIX=PASS')
