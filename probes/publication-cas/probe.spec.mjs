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
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PublicationConflict,
  createBundle,
  finalizeTransaction,
  mergeBundle,
  preparePublicationRoot,
  probeInternals,
  recoverTransaction,
  sha256,
} from '../../src/adapters/dsh-publication/filesystem-cas.mjs'

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

test('missing root is prepared one fixed segment at a time and resumes after a crash', async (t) => {
  const workspace = await fixture(t)
  const declaredRootPath = join(workspace, '.dsh', 'skills')
  const binding = {
    state: 'ABSENT',
    scope: 'PROJECT',
    declaredRootPath,
    canonicalExistingAncestorPath: workspace,
    ancestorIdentityDigest: 'a'.repeat(64),
    missingSegments: ['.dsh', 'skills'],
  }
  const crashConfig = join(workspace, 'root-crash.json')
  await writeFile(crashConfig, JSON.stringify({
    kind: 'PREPARE_ROOT',
    binding,
    crashAt: 'root-after-mkdir-0',
  }))
  await runCrashWorker(crashConfig)
  await writeFile(join(workspace, '.dsh', 'preserved.txt'), 'user bytes')

  const prepared = await preparePublicationRoot({
    binding,
    verifyIdentity: async (path, digest) => path === workspace && digest === 'a'.repeat(64),
    verifyParity: async (_approved, root) => root === declaredRootPath,
  })
  assert.equal(prepared.root, declaredRootPath)
  assert.deepEqual(prepared.createdSegments, ['skills'])
  assert.equal(await readFile(join(workspace, '.dsh', 'preserved.txt'), 'utf8'), 'user bytes')
  const result = await createBundle({
    root: prepared.root,
    name: 'first-skill',
    txid: 'first-create',
    nextBytes: '# first\n',
    rootPreparation: prepared,
  })
  assert.equal(result.status, 'written')
  const firstJournal = (await readdir(join(prepared.root, probeInternals.JOURNAL_DIR))).sort()[0]
  const rootRecord = JSON.parse(await readFile(join(prepared.root, probeInternals.JOURNAL_DIR, firstJournal), 'utf8'))
  assert.equal(rootRecord.state, 'ROOT_PREPARED')
  assert.deepEqual(rootRecord.createdRootSegments, ['skills'])
})

test('MERGE rejects stale and cutover races while preserving user bytes', async (t) => {
  const root = await fixture(t)
  const base = '# base\n'
  const userEdit = '# user edit\n'
  const proposal = '# proposal\n'
  const target = await seedBundle(root, 'merge-skill', base)

  const protectedTarget = await seedBundle(root, 'backup-collision', base)
  const protectedPaths = probeInternals.targetPaths(root, 'backup-collision', 'backup-collision-tx')
  await writeFile(protectedPaths.backup, '# existing backup\n')
  const backupCollision = await mergeBundle({
    root,
    name: 'backup-collision',
    txid: 'backup-collision-tx',
    expectedHash: sha256(base),
    nextBytes: proposal,
  })
  assert.equal(backupCollision.code, 'backup_exists')
  assert.equal(await readFile(protectedTarget, 'utf8'), base)
  assert.equal(await readFile(protectedPaths.backup, 'utf8'), '# existing backup\n')

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
    assert.equal((await finalizeTransaction({ root, txid, confirmedExactReadback: true })).status, 'finalized')
  }
})

test('path traversal and symlink or junction escape fail closed', async (t) => {
  const root = await fixture(t)
  const localProbeRoot = join(process.cwd(), '.probe-work')
  await mkdir(localProbeRoot, { recursive: true })
  const localRoot = await mkdtemp(join(localProbeRoot, 'cp-pub-relative-'))
  t.after(async () => {
    if (!basename(localRoot).startsWith('cp-pub-relative-')) throw new Error('Unsafe relative-root cleanup')
    await rm(localRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  await assert.rejects(
    createBundle({
      root: relative(process.cwd(), localRoot),
      name: 'relative-root',
      txid: 'relative-root',
      nextBytes: '# no\n',
    }),
    (error) => error instanceof PublicationConflict && error.code === 'unsafe_path',
  )
  await assert.rejects(
    createBundle({ root, name: '../escape', txid: 'escape-name', nextBytes: '# no\n' }),
    (error) => error instanceof PublicationConflict && error.code === 'unsafe_name',
  )

  const outside = await mkdtemp(join(tmpdir(), `${tempPrefix}outside-`))
  t.after(async () => {
    if (!basename(outside).startsWith(`${tempPrefix}outside-`)) throw new Error('Unsafe outside cleanup')
    await rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  const journalRoot = await fixture(t)
  await symlink(
    outside,
    join(journalRoot, probeInternals.JOURNAL_DIR),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  await assert.rejects(
    createBundle({ root: journalRoot, name: 'journal-escape', txid: 'journal-link', nextBytes: '# no\n' }),
    (error) => error instanceof PublicationConflict && error.code === 'unsafe_path',
  )
  assert.deepEqual(await readdir(outside), [])

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

  await assert.rejects(
    finalizeTransaction({ root, txid: result.txid }),
    (error) => error instanceof PublicationConflict && error.code === 'readback_confirmation_required',
  )
  assert.equal(await readFile(result.backup, 'utf8'), base)

  await writeFile(result.target, '# changed after write\n')
  await assert.rejects(
    finalizeTransaction({ root, txid: result.txid, confirmedExactReadback: true }),
    (error) => error instanceof PublicationConflict && error.code === 'readback_changed',
  )
  assert.equal(await readFile(result.backup, 'utf8'), base)
  assert.ok((await readdir(join(root, probeInternals.JOURNAL_DIR))).some((entry) => entry.startsWith('finalize-tx.')))
})

test('recovery stops on unknown hashes without deleting or overwriting them', async (t) => {
  const root = await fixture(t)
  const name = 'unknown-create'
  const txid = 'unknown-create-tx'
  const configPath = join(root, 'unknown-create.json')
  await writeFile(configPath, JSON.stringify({
    kind: 'CREATE',
    root,
    name,
    txid,
    nextBytes: '# approved\n',
    crashAt: 'create-after-stage',
  }))
  await runCrashWorker(configPath)
  const paths = probeInternals.targetPaths(root, name, txid)
  await writeFile(paths.stage, '# unknown user bytes\n')

  const result = await recoverTransaction({ root, txid })
  assert.equal(result.status, 'conflict')
  assert.equal(result.code, 'recovery_observed_unknown_create_state')
  assert.equal(await readFile(paths.stage, 'utf8'), '# unknown user bytes\n')
  await assert.rejects(readFile(paths.target, 'utf8'), { code: 'ENOENT' })

  const mergeName = 'unknown-merge'
  const mergeTxid = 'unknown-merge-tx'
  const base = '# base\n'
  const approved = '# approved merge\n'
  await seedBundle(root, mergeName, base)
  const mergeConfig = join(root, 'unknown-merge.json')
  await writeFile(mergeConfig, JSON.stringify({
    kind: 'MERGE',
    root,
    name: mergeName,
    txid: mergeTxid,
    expectedHash: sha256(base),
    nextBytes: approved,
    crashAt: 'merge-after-install-before-journal',
  }))
  await runCrashWorker(mergeConfig)
  const mergePaths = probeInternals.targetPaths(root, mergeName, mergeTxid)
  await writeFile(mergePaths.stage, '# unknown merge stage\n')

  const mergeResult = await recoverTransaction({ root, txid: mergeTxid })
  assert.equal(mergeResult.status, 'conflict')
  assert.equal(mergeResult.code, 'recovery_observed_unknown_merge_state')
  assert.equal(await readFile(mergePaths.target, 'utf8'), '# unknown merge stage\n')
  assert.equal(await readFile(mergePaths.backup, 'utf8'), base)
  assert.equal(await readFile(mergePaths.stage, 'utf8'), '# unknown merge stage\n')
})

test('journal records are bounded hash-chain facts and ignore a torn newest record', async (t) => {
  const root = await fixture(t)
  const txid = 'journal-chain'
  const bytes = '# journal chain\n'
  await createBundle({ root, name: 'journal-skill', txid, nextBytes: bytes })
  const journalDir = join(root, probeInternals.JOURNAL_DIR)
  const entries = (await readdir(journalDir)).filter(entry => entry.startsWith(`${txid}.`)).sort()
  const records = await Promise.all(entries.map(async entry => JSON.parse(await readFile(join(journalDir, entry), 'utf8'))))
  assert.ok(records.length < probeInternals.MAX_JOURNAL_RECORDS)
  for (const [index, record] of records.entries()) {
    const { recordHash, ...facts } = record
    assert.equal(recordHash, sha256(JSON.stringify(facts)))
    assert.equal(record.prevHash, index === 0 ? null : records[index - 1].recordHash)
  }

  const latest = records.at(-1)
  const injectedFacts = {
    ...latest,
    seq: latest.seq + 1,
    prevHash: latest.recordHash,
    unexpected: 'not part of the journal schema',
  }
  delete injectedFacts.recordHash
  await writeFile(join(journalDir, `${txid}.${String(injectedFacts.seq).padStart(4, '0')}.INTENT.json`), JSON.stringify({
    ...injectedFacts,
    recordHash: sha256(JSON.stringify(injectedFacts)),
  }))
  await writeFile(join(journalDir, `${txid}.0063.TORN.json`), '{')
  assert.equal((await recoverTransaction({ root, txid })).status, 'written')
  assert.equal(await readFile(join(root, 'journal-skill', 'SKILL.md'), 'utf8'), bytes)
  assert.equal(
    (await readdir(journalDir)).filter(entry => entry.startsWith(`${txid}.`) && !entry.endsWith('.TORN.json')).length,
    entries.length + 1,
  )

  let previous = latest
  for (let seq = previous.seq + 1; seq < probeInternals.MAX_JOURNAL_RECORDS; seq += 1) {
    const { recordHash: _recordHash, ...previousFacts } = previous
    const facts = {
      ...previousFacts,
      seq,
      state: `CONFLICT_BOUND_${seq % 2}`,
      prevHash: previous.recordHash,
    }
    previous = { ...facts, recordHash: sha256(JSON.stringify(facts)) }
    await writeFile(
      join(journalDir, `${txid}.${String(seq).padStart(4, '0')}.${previous.state}.json`),
      JSON.stringify(previous),
    )
  }
  await assert.rejects(
    recoverTransaction({ root, txid }),
    (error) => error instanceof PublicationConflict && error.code === 'journal_limit',
  )
})
