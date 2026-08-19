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

async function items(caseRoot) {
  try { return JSON.parse(await readFile(join(caseRoot, 'work-items.json'), 'utf8')) }
  catch { return {} }
}

const beforeUpstream = run('before-upstream', 'crash-before-upstream', 23)
run('before-upstream', 'recover')
assert.equal(Object.keys(await items(beforeUpstream)).length, 0)

const afterTurn = run('after-turn', 'crash-after-turn', 23)
run('after-turn', 'recover')
assert.equal(Object.keys(await items(afterTurn)).length, 1)

const afterWorkItem = run('after-work-item', 'crash-after-work-item', 23)
run('after-work-item', 'recover')
assert.equal(Object.keys(await items(afterWorkItem)).length, 1)
const recoveredGlobal = JSON.parse(await readFile(join(afterWorkItem, 'global.json'), 'utf8'))
assert.equal(Object.values(recoveredGlobal.sessions)[0].durableNextSeq, 3)

const reusedTail = run('reused-tail', 'volatile-old-crash', 23)
run('reused-tail', 'recover-new')
assert.equal(Object.keys(await items(reusedTail)).length, 2)

console.log('CRASH_MATRIX_CASES=4')
console.log('CRASH_MATRIX=PASS')
