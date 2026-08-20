import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
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

async function replaceDirectoryWithLink(directory, holdingRoot, movedName) {
  const moved = join(holdingRoot, movedName)
  await rename(directory, moved)
  await symlink(moved, directory, process.platform === 'win32' ? 'junction' : 'dir')
  return moved
}

async function replaceDirectoryWithDirectory(directory, holdingRoot, movedName) {
  const moved = join(holdingRoot, movedName)
  await rename(directory, moved)
  await mkdir(directory)
  return moved
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

  const maxName = 'a'.repeat(128)
  assert.equal((await createBundle({
    root,
    name: maxName,
    txid: 'max-length-name',
    nextBytes: '# max name\n',
  })).status, 'written')
  assert.equal(await readFile(join(root, maxName, 'SKILL.md'), 'utf8'), '# max name\n')
})

test('missing root is prepared one fixed segment at a time and resumes after a crash', async (t) => {
  const workspace = await fixture(t)
  await assert.rejects(
    preparePublicationRoot({
      binding: {
        state: 'ABSENT',
        scope: 'USER',
        declaredRootPath: join(workspace, 'unrelated', 'skills'),
        canonicalExistingAncestorPath: workspace,
        ancestorIdentityDigest: 'b'.repeat(64),
        missingSegments: ['skills'],
      },
      verifyIdentity: async () => true,
      verifyParity: async () => true,
    }),
    (error) => error instanceof PublicationConflict && error.code === 'root_changed',
  )
  await assert.rejects(lstat(join(workspace, 'skills')), { code: 'ENOENT' })

  const existingRoot = join(workspace, 'existing-skills')
  const holding = await fixture(t)
  const movedRoot = join(holding, 'original-root')
  await mkdir(existingRoot)
  const existingPreparation = await preparePublicationRoot({
    binding: {
      state: 'EXISTING',
      scope: 'PROJECT',
      declaredRootPath: existingRoot,
      canonicalRootPath: existingRoot,
      rootIdentityDigest: 'c'.repeat(64),
    },
    verifyIdentity: async () => true,
    verifyParity: async () => true,
  })
  await rename(existingRoot, movedRoot)
  await mkdir(existingRoot)
  await assert.rejects(
    createBundle({
      root: existingRoot,
      name: 'replaced-root',
      txid: 'replaced-root-tx',
      nextBytes: '# no\n',
      rootPreparation: existingPreparation,
    }),
    (error) => error instanceof PublicationConflict && error.code === 'root_preparation_mismatch',
  )
  await assert.rejects(readFile(join(existingRoot, 'replaced-root', 'SKILL.md'), 'utf8'), { code: 'ENOENT' })
  await assert.rejects(readFile(join(movedRoot, 'replaced-root', 'SKILL.md'), 'utf8'), { code: 'ENOENT' })

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

  const racedTarget = await seedBundle(root, 'backup-race', base)
  const racedPaths = probeInternals.targetPaths(root, 'backup-race', 'backup-race-tx')
  const backupRace = await mergeBundle({
    root,
    name: 'backup-race',
    txid: 'backup-race-tx',
    expectedHash: sha256(base),
    nextBytes: proposal,
    hooks: { beforeBackupMove: async () => writeFile(racedPaths.backup, '# unseen competitor\n') },
  })
  assert.equal(backupRace.code, 'backup_exists')
  assert.equal(await readFile(racedTarget, 'utf8'), base)
  assert.equal(await readFile(racedPaths.backup, 'utf8'), '# unseen competitor\n')

  const reservedTarget = await seedBundle(root, 'reservation-race', base)
  const reservedPaths = probeInternals.targetPaths(root, 'reservation-race', 'reservation-race-tx')
  const reservationRace = await mergeBundle({
    root,
    name: 'reservation-race',
    txid: 'reservation-race-tx',
    expectedHash: sha256(base),
    nextBytes: proposal,
    hooks: { beforeBackupRename: async () => writeFile(reservedPaths.backup, '# changed reservation\n') },
  })
  assert.equal(reservationRace.code, 'backup_changed')
  assert.equal(await readFile(reservedTarget, 'utf8'), base)
  assert.equal(await readFile(reservedPaths.backup, 'utf8'), '# changed reservation\n')

  const identicalTarget = await seedBundle(root, 'identical-reservation', base)
  const identicalPaths = probeInternals.targetPaths(root, 'identical-reservation', 'identical-reservation-tx')
  let savedReservation
  const identicalReservation = await mergeBundle({
    root,
    name: 'identical-reservation',
    txid: 'identical-reservation-tx',
    expectedHash: sha256(base),
    nextBytes: proposal,
    hooks: {
      beforeBackupRename: async (record) => {
        savedReservation = join(root, 'saved-identical-reservation')
        await rename(record.backup, savedReservation)
        await writeFile(
          record.backup,
          `run2skill-backup-reservation-v1:${record.txid}:${record.backupReservationNonce}\n`,
        )
      },
    },
  })
  assert.equal(identicalReservation.code, 'backup_changed')
  assert.equal(await readFile(identicalTarget, 'utf8'), base)
  assert.equal(await readFile(identicalPaths.backup, 'utf8'), await readFile(savedReservation, 'utf8'))

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
  const claimedConfig = join(root, 'create-claimed-crash.json')
  await writeFile(claimedConfig, JSON.stringify({
    kind: 'CREATE',
    root,
    name: 'crash-create-claimed',
    txid: 'crash-create-claimed-tx',
    nextBytes: '# never staged\n',
    crashAt: 'create-after-target-claim',
  }))
  await runCrashWorker(claimedConfig)
  const claimedRecovery = await recoverTransaction({ root, txid: 'crash-create-claimed-tx' })
  assert.equal(claimedRecovery.status, 'conflict')
  assert.equal(claimedRecovery.code, 'recovery_observed_unknown_create_state')
  await assert.rejects(readFile(join(root, 'crash-create-claimed', 'SKILL.md'), 'utf8'), { code: 'ENOENT' })

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

  const mergeCrashPoints = [
    'merge-after-backup-reservation',
    'merge-after-backup-move',
    'merge-after-install-before-journal',
  ]
  for (const [index, crashAt] of mergeCrashPoints.entries()) {
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

  const tornName = 'crash-merge-torn-reservation'
  const tornTxid = 'crash-merge-torn-reservation-tx'
  const tornBase = '# torn reservation base\n'
  const tornNext = '# torn reservation next\n'
  const tornTarget = await seedBundle(root, tornName, tornBase)
  const tornConfig = join(root, `${tornTxid}.json`)
  await writeFile(tornConfig, JSON.stringify({
    kind: 'MERGE',
    root,
    name: tornName,
    txid: tornTxid,
    expectedHash: sha256(tornBase),
    nextBytes: tornNext,
    crashAt: 'merge-after-backup-reservation',
  }))
  await runCrashWorker(tornConfig)

  const tornJournalDir = join(root, probeInternals.JOURNAL_DIR)
  const tornJournalEntries = (await readdir(tornJournalDir))
    .filter(entry => entry.startsWith(`${tornTxid}.`))
  const reservedEntry = await Promise.all(tornJournalEntries.map(async entry => ({
    entry,
    record: JSON.parse(await readFile(join(tornJournalDir, entry), 'utf8')),
  }))).then(entries => entries.find(({ record }) => record.state === 'BACKUP_RESERVED'))
  assert.ok(reservedEntry)
  await rm(join(tornJournalDir, reservedEntry.entry))

  const tornPaths = probeInternals.targetPaths(root, tornName, tornTxid)
  const reservationBytes = await readFile(tornPaths.backup)
  await rename(tornPaths.backup, join(root, 'saved-torn-reservation'))
  await writeFile(tornPaths.backup, reservationBytes, { flag: 'wx' })

  const tornRecovery = await recoverTransaction({ root, txid: tornTxid })
  assert.equal(tornRecovery.status, 'conflict')
  assert.equal(tornRecovery.code, 'recovery_observed_unknown_merge_state')
  assert.equal(await readFile(tornTarget, 'utf8'), tornBase)
  assert.equal(await readFile(tornPaths.stage, 'utf8'), tornNext)
  assert.deepEqual(await readFile(tornPaths.backup), reservationBytes)
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

  const linkedParentRoot = await fixture(t)
  const linkedParentOutside = await fixture(t)
  await mkdir(join(linkedParentOutside, 'skills'))
  await symlink(
    linkedParentOutside,
    join(linkedParentRoot, '.dsh'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  await assert.rejects(
    createBundle({
      root: join(linkedParentRoot, '.dsh', 'skills'),
      name: 'parent-link',
      txid: 'parent-link-tx',
      nextBytes: '# no\n',
    }),
    (error) => error instanceof PublicationConflict && error.code === 'unsafe_path',
  )
  await assert.rejects(readFile(join(linkedParentOutside, 'skills', 'parent-link', 'SKILL.md'), 'utf8'), { code: 'ENOENT' })

  const swapHolding = await fixture(t)
  const createSwapRoot = await fixture(t)
  let movedCreate
  await assert.rejects(
    createBundle({
      root: createSwapRoot,
      name: 'create-swap',
      txid: 'create-swap-tx',
      nextBytes: '# approved create\n',
      hooks: {
        beforeInstall: async (record) => {
          movedCreate = await replaceDirectoryWithLink(record.targetDir, swapHolding, 'moved-create')
        },
      },
    }),
    (error) => error instanceof PublicationConflict && ['unsafe_path', 'target_identity_changed'].includes(error.code),
  )
  await assert.rejects(readFile(join(movedCreate, 'SKILL.md'), 'utf8'), { code: 'ENOENT' })

  const mergeSwapRoot = await fixture(t)
  await seedBundle(mergeSwapRoot, 'merge-swap', '# base\n')
  let movedMerge
  await assert.rejects(
    mergeBundle({
      root: mergeSwapRoot,
      name: 'merge-swap',
      txid: 'merge-swap-tx',
      expectedHash: sha256('# base\n'),
      nextBytes: '# approved merge\n',
      hooks: {
        beforeBackupMove: async (record) => {
          movedMerge = await replaceDirectoryWithLink(record.targetDir, swapHolding, 'moved-merge')
        },
      },
    }),
    (error) => error instanceof PublicationConflict && ['unsafe_path', 'target_identity_changed'].includes(error.code),
  )
  assert.equal(await readFile(join(movedMerge, 'SKILL.md'), 'utf8'), '# base\n')

  const installSwapRoot = await fixture(t)
  await seedBundle(installSwapRoot, 'install-swap', '# base\n')
  let movedInstall
  await assert.rejects(
    mergeBundle({
      root: installSwapRoot,
      name: 'install-swap',
      txid: 'install-swap-tx',
      expectedHash: sha256('# base\n'),
      nextBytes: '# approved merge\n',
      hooks: {
        beforeInstall: async (record) => {
          movedInstall = await replaceDirectoryWithLink(record.targetDir, swapHolding, 'moved-install')
        },
      },
    }),
    (error) => error instanceof PublicationConflict && ['unsafe_path', 'target_identity_changed'].includes(error.code),
  )
  await assert.rejects(readFile(join(movedInstall, 'SKILL.md'), 'utf8'), { code: 'ENOENT' })
  assert.equal(await readFile(join(movedInstall, '.run2skill-install-swap-tx.backup'), 'utf8'), '# base\n')
  await assert.rejects(
    recoverTransaction({ root: installSwapRoot, txid: 'install-swap-tx' }),
    (error) => error instanceof PublicationConflict && ['unsafe_path', 'target_identity_changed'].includes(error.code),
  )

  const journalSwapHolding = await fixture(t)
  const createJournalRoot = await fixture(t)
  let movedCreateJournal
  await assert.rejects(
    createBundle({
      root: createJournalRoot,
      name: 'create-journal-swap',
      txid: 'create-journal-swap-tx',
      nextBytes: '# approved create\n',
      hooks: {
        beforeInstall: async () => {
          movedCreateJournal = await replaceDirectoryWithDirectory(
            join(createJournalRoot, probeInternals.JOURNAL_DIR),
            journalSwapHolding,
            'moved-create-journal',
          )
        },
      },
    }),
    (error) => error instanceof PublicationConflict && error.code === 'journal_identity_changed',
  )
  await assert.rejects(readFile(join(createJournalRoot, 'create-journal-swap', 'SKILL.md'), 'utf8'), { code: 'ENOENT' })
  assert.deepEqual(await readdir(join(createJournalRoot, probeInternals.JOURNAL_DIR)), [])
  assert.ok((await readdir(movedCreateJournal)).length > 0)

  const mergeJournalRoot = await fixture(t)
  await seedBundle(mergeJournalRoot, 'merge-journal-swap', '# base\n')
  let movedMergeJournal
  await assert.rejects(
    mergeBundle({
      root: mergeJournalRoot,
      name: 'merge-journal-swap',
      txid: 'merge-journal-swap-tx',
      expectedHash: sha256('# base\n'),
      nextBytes: '# approved merge\n',
      hooks: {
        beforeInstall: async () => {
          movedMergeJournal = await replaceDirectoryWithDirectory(
            join(mergeJournalRoot, probeInternals.JOURNAL_DIR),
            journalSwapHolding,
            'moved-merge-journal',
          )
        },
      },
    }),
    (error) => error instanceof PublicationConflict && error.code === 'journal_identity_changed',
  )
  await assert.rejects(readFile(join(mergeJournalRoot, 'merge-journal-swap', 'SKILL.md'), 'utf8'), { code: 'ENOENT' })
  assert.equal(
    await readFile(join(mergeJournalRoot, 'merge-journal-swap', '.run2skill-merge-journal-swap-tx.backup'), 'utf8'),
    '# base\n',
  )
  assert.deepEqual(await readdir(join(mergeJournalRoot, probeInternals.JOURNAL_DIR)), [])
  assert.ok((await readdir(movedMergeJournal)).length > 0)
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

  const finalizePaths = probeInternals.targetPaths(root, 'finalize-skill', result.txid)
  await writeFile(finalizePaths.stage, '# unseen finalize stage\n')
  await assert.rejects(
    finalizeTransaction({ root, txid: result.txid, confirmedExactReadback: true }),
    (error) => error instanceof PublicationConflict && error.code === 'stage_changed',
  )
  assert.equal(await readFile(finalizePaths.stage, 'utf8'), '# unseen finalize stage\n')

  await writeFile(result.target, '# changed after write\n')
  await assert.rejects(
    finalizeTransaction({ root, txid: result.txid, confirmedExactReadback: true }),
    (error) => error instanceof PublicationConflict && error.code === 'readback_changed',
  )
  assert.equal(await readFile(result.backup, 'utf8'), base)
  assert.ok((await readdir(join(root, probeInternals.JOURNAL_DIR))).some((entry) => entry.startsWith('finalize-tx.')))

  const swapRoot = await fixture(t)
  const holding = await fixture(t)
  await seedBundle(swapRoot, 'finalize-swap', base)
  const swapResult = await mergeBundle({
    root: swapRoot,
    name: 'finalize-swap',
    txid: 'finalize-swap-tx',
    expectedHash: sha256(base),
    nextBytes: next,
  })
  const moved = await replaceDirectoryWithLink(dirname(swapResult.target), holding, 'moved-finalize')
  await assert.rejects(
    finalizeTransaction({ root: swapRoot, txid: swapResult.txid, confirmedExactReadback: true }),
    (error) => error instanceof PublicationConflict && ['unsafe_path', 'target_identity_changed'].includes(error.code),
  )
  assert.equal(await readFile(join(moved, 'SKILL.md'), 'utf8'), next)
  assert.equal(await readFile(join(moved, '.run2skill-finalize-swap-tx.backup'), 'utf8'), base)
})

test('recovery stops on unknown hashes without deleting or overwriting them', async (t) => {
  const root = await fixture(t)
  let createStagePath
  const changedCreateStage = await createBundle({
    root,
    name: 'changed-create-stage',
    txid: 'changed-create-stage-tx',
    nextBytes: '# approved create\n',
    hooks: {
      beforeInstall: async (record) => {
        createStagePath = record.stage
        await writeFile(record.stage, '# unseen create stage\n')
      },
    },
  })
  assert.equal(changedCreateStage.code, 'stage_changed')
  assert.equal(await readFile(createStagePath, 'utf8'), '# unseen create stage\n')
  await assert.rejects(readFile(join(root, 'changed-create-stage', 'SKILL.md'), 'utf8'), { code: 'ENOENT' })

  const changedMergeTarget = await seedBundle(root, 'changed-merge-stage', '# base\n')
  let mergeStagePath
  const changedMergeStage = await mergeBundle({
    root,
    name: 'changed-merge-stage',
    txid: 'changed-merge-stage-tx',
    expectedHash: sha256('# base\n'),
    nextBytes: '# approved merge\n',
    hooks: {
      beforeInstall: async (record) => {
        mergeStagePath = record.stage
        await writeFile(record.stage, '# unseen merge stage\n')
      },
    },
  })
  assert.equal(changedMergeStage.code, 'stage_changed')
  assert.equal(await readFile(changedMergeTarget, 'utf8'), '# base\n')
  assert.equal(await readFile(mergeStagePath, 'utf8'), '# unseen merge stage\n')

  let changedInstalledStagePath
  const changedInstalled = await createBundle({
    root,
    name: 'changed-installed-create',
    txid: 'changed-installed-create-tx',
    nextBytes: '# approved installed create\n',
    hooks: {
      afterInstall: async (record) => {
        changedInstalledStagePath = record.stage
        await writeFile(record.stage, '# unseen after install\n')
      },
    },
  })
  assert.equal(changedInstalled.code, 'post_write_mismatch')
  assert.equal(await readFile(changedInstalledStagePath, 'utf8'), '# unseen after install\n')
  await assert.rejects(readFile(join(root, 'changed-installed-create', 'SKILL.md'), 'utf8'), { code: 'ENOENT' })

  const changedInstalledMergeTarget = await seedBundle(root, 'changed-installed-merge', '# base\n')
  let changedInstalledMergeStage
  const changedInstalledMerge = await mergeBundle({
    root,
    name: 'changed-installed-merge',
    txid: 'changed-installed-merge-tx',
    expectedHash: sha256('# base\n'),
    nextBytes: '# approved installed merge\n',
    hooks: {
      afterInstall: async (record) => {
        changedInstalledMergeStage = record.stage
        await writeFile(record.stage, '# unseen merge after install\n')
      },
    },
  })
  assert.equal(changedInstalledMerge.code, 'post_write_mismatch')
  assert.equal(await readFile(changedInstalledMergeTarget, 'utf8'), '# base\n')
  assert.equal(await readFile(changedInstalledMergeStage, 'utf8'), '# unseen merge after install\n')

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
