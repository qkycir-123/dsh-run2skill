import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PublicationConflict,
  createBundle,
  finalizeTransaction,
  mergeBundle,
  probeInternals,
  recoverTransaction,
  sha256,
} from './adapter.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const worker = join(here, 'crash-worker.mjs')
const tempPrefix = 'dsh-run2skill-cp-pub-'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), tempPrefix))
  t.after(async () => {
    if (!basename(root).startsWith(tempPrefix)) throw new Error(`Unsafe cleanup target: ${root}`)
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  return root
}

async function seedBundle(root, name, bytes) {
  const dir = join(root, name)
  await mkdir(dir)
  await writeFile(join(dir, 'SKILL.md'), bytes)
  return join(dir, 'SKILL.md')
}

async function runCrashWorker(configPath) {
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [worker, configPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', (code, signal) => resolveResult({ code, signal, stdout, stderr }))
  })
  assert.equal(result.signal, null)
  assert.equal(result.code, 86, `worker did not crash at the requested window\n${result.stderr}`)
}

test('CREATE atomically claims a bundle and never overwrites a competing writer', async (t) => {
  const root = await fixture(t)
  const a = '# writer-a\n'
  const b = '# writer-b\n'
  const results = await Promise.all([
    createBundle({ root, name: 'race-skill', txid: 'create-a', nextBytes: a }),
    createBundle({ root, name: 'race-skill', txid: 'create-b', nextBytes: b }),
  ])

  assert.equal(results.filter((result) => result.status === 'written').length, 1)
  assert.equal(results.filter((result) => result.status === 'conflict').length, 1)
  const actual = await readFile(join(root, 'race-skill', 'SKILL.md'), 'utf8')
  assert.ok(actual === a || actual === b)
})

test('MERGE rejects stale and cutover races while preserving user bytes', async (t) => {
  const root = await fixture(t)
  const base = '# base\n'
  const userEdit = '# user edit\n'
  const proposal = '# proposal\n'
  const target = await seedBundle(root, 'merge-skill', base)

  const stale = await mergeBundle({
    root,
    name: 'merge-skill',
    txid: 'stale-base',
    expectedHash: sha256('# other base\n'),
    nextBytes: proposal,
  })
  assert.equal(stale.status, 'conflict')
  assert.equal(await readFile(target, 'utf8'), base)

  const changedBeforeRename = await mergeBundle({
    root,
    name: 'merge-skill',
    txid: 'edit-before-rename',
    expectedHash: sha256(base),
    nextBytes: proposal,
    hooks: { beforeBackupMove: async () => writeFile(target, userEdit) },
  })
  assert.equal(changedBeforeRename.status, 'conflict')
  assert.equal(await readFile(target, 'utf8'), userEdit)

  await writeFile(target, base)
  const appearedDuringCutover = await mergeBundle({
    root,
    name: 'merge-skill',
    txid: 'target-appeared',
    expectedHash: sha256(base),
    nextBytes: proposal,
    hooks: { beforeInstall: async () => writeFile(target, userEdit, { flag: 'wx' }) },
  })
  assert.equal(appearedDuringCutover.status, 'conflict')
  assert.equal(await readFile(target, 'utf8'), userEdit)
  assert.equal(await readFile(join(root, 'merge-skill', '.run2skill-target-appeared.backup'), 'utf8'), base)
})

test('process-crash recovery completes CREATE and MERGE from hashes, not timestamps', async (t) => {
  const root = await fixture(t)
  const createConfig = join(root, 'create-crash.json')
  const createBytes = '# recovered create\n'
  await writeFile(createConfig, JSON.stringify({
    kind: 'CREATE',
    root,
    name: 'crash-create',
    txid: 'crash-create-tx',
    nextBytes: createBytes,
    crashAt: 'create-after-stage',
  }))
  await runCrashWorker(createConfig)
  assert.equal((await recoverTransaction({ root, txid: 'crash-create-tx' })).status, 'written')
  assert.equal(await readFile(join(root, 'crash-create', 'SKILL.md'), 'utf8'), createBytes)

  for (const [index, crashAt] of ['merge-after-backup-move', 'merge-after-install-before-journal'].entries()) {
    const name = `crash-merge-${index}`
    const txid = `crash-merge-tx-${index}`
    const base = `# base ${index}\n`
    const next = `# next ${index}\n`
    await seedBundle(root, name, base)
    const configPath = join(root, `${txid}.json`)
    await writeFile(configPath, JSON.stringify({
      kind: 'MERGE',
      root,
      name,
      txid,
      expectedHash: sha256(base),
      nextBytes: next,
      crashAt,
    }))
    await runCrashWorker(configPath)
    assert.equal((await recoverTransaction({ root, txid })).status, 'written')
    assert.equal(await readFile(join(root, name, 'SKILL.md'), 'utf8'), next)
    assert.equal(await readFile(join(root, name, `.run2skill-${txid}.backup`), 'utf8'), base)
    assert.equal((await finalizeTransaction({ root, txid })).status, 'finalized')
  }
})

test('path traversal and symlink or junction escape fail closed', async (t) => {
  const root = await fixture(t)
  await assert.rejects(
    createBundle({ root, name: '../escape', txid: 'escape-name', nextBytes: '# no\n' }),
    (error) => error instanceof PublicationConflict && error.code === 'unsafe_name',
  )

  const outside = await mkdtemp(join(tmpdir(), `${tempPrefix}outside-`))
  t.after(async () => {
    if (!basename(outside).startsWith(`${tempPrefix}outside-`)) throw new Error('Unsafe outside cleanup')
    await rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  const linkPath = join(root, 'linked-skill')
  await symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await lstat(linkPath)).isSymbolicLink(), true)
  await assert.rejects(
    createBundle({ root, name: 'linked-skill', txid: 'linked-target', nextBytes: '# no\n' }),
    (error) => error instanceof PublicationConflict && error.code === 'unsafe_path',
  )
  await assert.rejects(readFile(join(outside, 'SKILL.md'), 'utf8'), { code: 'ENOENT' })
})

test('backup is retained until exact readback finalization', async (t) => {
  const root = await fixture(t)
  const base = '# base\n'
  const next = '# next\n'
  await seedBundle(root, 'finalize-skill', base)
  const result = await mergeBundle({
    root,
    name: 'finalize-skill',
    txid: 'finalize-tx',
    expectedHash: sha256(base),
    nextBytes: next,
  })
  assert.equal(result.status, 'written')
  assert.equal(await readFile(result.backup, 'utf8'), base)

  await writeFile(result.target, '# changed after write\n')
  await assert.rejects(
    finalizeTransaction({ root, txid: result.txid }),
    (error) => error instanceof PublicationConflict && error.code === 'readback_changed',
  )
  assert.equal(await readFile(result.backup, 'utf8'), base)
  assert.ok((await readdir(join(root, probeInternals.JOURNAL_DIR))).some((entry) => entry.startsWith('finalize-tx.')))
})
