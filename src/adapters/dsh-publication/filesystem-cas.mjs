import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// Production filesystem primitive; the cross-platform probe imports this file directly.
const JOURNAL_DIR = '.run2skill-publication'
const MAX_JOURNAL_RECORDS = 64
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const TX_PATTERN = /^[a-z0-9-]{1,80}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const JOURNAL_KEYS = new Set([
  'version', 'seq', 'state', 'kind', 'root', 'name', 'txid', 'expectedHash', 'nextHash',
  'prevHash', 'recordHash', 'createdRootSegments', 'targetDir', 'target', 'stage', 'backup', 'claim',
  'targetDirIdentityDigest',
  'backupReservationNonce',
  'stageIdentityDigest', 'claimIdentityDigest', 'backupIdentityDigest',
  'rootIdentityDigest',
  'journalIdentityDigest', 'backupReservationIdentityDigest',
])

export class PublicationConflict extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PublicationConflict'
    this.code = code
  }
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function statOrNull(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function regularFileIdentityDigest(stat) {
  return sha256(JSON.stringify([
    String(stat.dev),
    String(stat.ino),
    String(stat.birthtimeNs),
  ]))
}

async function observeRegularFile(path) {
  const before = await identityStatOrNull(path)
  if (!before) return null
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new PublicationConflict('unsafe_path', 'Expected a regular file')
  }
  const bytes = await readFile(path)
  const after = await identityStatOrNull(path)
  if (!after || after.isSymbolicLink() || !after.isFile()) {
    throw new PublicationConflict('file_identity_changed', 'Regular file identity changed during observation')
  }
  const identityDigest = regularFileIdentityDigest(before)
  if (regularFileIdentityDigest(after) !== identityDigest) {
    throw new PublicationConflict('file_identity_changed', 'Regular file identity changed during observation')
  }
  return { hash: sha256(bytes), identityDigest }
}

async function hashRegularFile(path) {
  return (await observeRegularFile(path))?.hash ?? null
}

async function unlinkOwnedFileIfPresent(path, expectedIdentityDigest, expectedHash, code) {
  const facts = await observeRegularFile(path)
  if (!facts) return
  if (
    !expectedIdentityDigest
    || facts.identityDigest !== expectedIdentityDigest
    || facts.hash !== expectedHash
  ) {
    throw new PublicationConflict(code, 'Refusing to remove an unrecognized transaction artifact')
  }
  await unlink(path)
}

async function fsyncParent(path) {
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch (error) {
    // Windows does not consistently allow opening directories. File fsync plus
    // append-only journal records is the strongest portable Node probe surface.
    if (process.platform !== 'win32' || !['EACCES', 'EPERM', 'EINVAL'].includes(error?.code)) {
      throw error
    }
  } finally {
    await handle?.close()
  }
}

async function writeExclusiveFile(path, bytes) {
  const handle = await open(path, 'wx')
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function ensureRoot(root) {
  if (!isAbsolute(root)) {
    throw new PublicationConflict('unsafe_path', 'Publication root must be absolute')
  }
  const rootStat = await lstat(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new PublicationConflict('unsafe_path', 'Publication root must be a real directory')
  }
  const rootReal = await realpath(root)
  if (!samePath(rootReal, root)) {
    throw new PublicationConflict('unsafe_path', 'Publication root traverses a link or reparse point')
  }
  return rootReal
}

async function ensureJournalDirectory(rootReal, create = false) {
  const journalDir = join(rootReal, JOURNAL_DIR)
  if (create) {
    try {
      await mkdir(journalDir)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  const stat = await statOrNull(journalDir)
  if (stat === null) throw new PublicationConflict('journal_missing', 'Publication journal is absent')
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new PublicationConflict('unsafe_path', 'Publication journal is not a real directory')
  }
  const journalReal = await realpath(journalDir)
  if (!samePath(dirname(journalReal), rootReal)) {
    throw new PublicationConflict('unsafe_path', 'Publication journal escaped the approved root')
  }
  return journalReal
}

function samePath(left, right) {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function identityPath(path) {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

async function observeDirectoryIdentity(path, label) {
  const stat = await identityStatOrNull(path)
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new PublicationConflict('unsafe_path', `${label} is a symlink, junction, or non-directory`)
  }
  let canonical
  try {
    canonical = await realpath(path)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new PublicationConflict('directory_identity_changed', `${label} disappeared`)
    }
    throw error
  }
  if (!samePath(canonical, path)) {
    throw new PublicationConflict('unsafe_path', `${label} changed canonical location`)
  }
  return sha256(JSON.stringify([
    String(stat.dev),
    String(stat.ino),
    String(stat.birthtimeNs),
    identityPath(canonical),
  ]))
}

function allowedMissingSegments(binding) {
  const joined = binding.missingSegments.join('\0')
  return binding.scope === 'PROJECT'
    ? joined === '.dsh\0skills' || joined === 'skills'
    : binding.scope === 'USER' && joined === 'skills'
}

export async function preparePublicationRoot({ binding, verifyIdentity, verifyParity, crashAt }) {
  if (typeof verifyIdentity !== 'function') {
    throw new PublicationConflict('root_identity_unavailable', 'Root identity verifier is unavailable')
  }
  if (typeof verifyParity !== 'function') {
    throw new PublicationConflict('root_parity_unavailable', 'Provider root verifier is unavailable')
  }
  if (!binding || !isAbsolute(binding.declaredRootPath)) {
    throw new PublicationConflict('unsafe_path', 'Approved root path must be absolute')
  }
  if (binding.state === 'EXISTING') {
    if (!isAbsolute(binding.canonicalRootPath)) {
      throw new PublicationConflict('unsafe_path', 'Approved canonical root path must be absolute')
    }
    const root = await ensureRoot(binding.declaredRootPath)
    if (!samePath(root, binding.canonicalRootPath)) {
      throw new PublicationConflict('root_changed', 'Approved root canonical path changed')
    }
    if (!await verifyIdentity(root, binding.rootIdentityDigest)) {
      throw new PublicationConflict('root_changed', 'Approved root identity changed')
    }
    if (!await verifyParity(binding, root)) {
      throw new PublicationConflict('root_parity_changed', 'Provider root observation changed')
    }
    return {
      root,
      createdSegments: [],
      rootIdentityDigest: await observeDirectoryIdentity(root, 'Publication root'),
    }
  }
  if (
    binding.state !== 'ABSENT'
    || !isAbsolute(binding.canonicalExistingAncestorPath)
    || !Array.isArray(binding.missingSegments)
    || !allowedMissingSegments(binding)
  ) {
    throw new PublicationConflict('unsafe_path', 'Missing root segments are not approved')
  }
  const expectedRoot = binding.missingSegments.reduce(
    (parent, segment) => join(parent, segment),
    binding.canonicalExistingAncestorPath,
  )
  if (!samePath(expectedRoot, binding.declaredRootPath)) {
    throw new PublicationConflict('root_changed', 'Declared root does not match its approved ancestor and segments')
  }
  let current = await ensureRoot(binding.canonicalExistingAncestorPath)
  if (!samePath(current, binding.canonicalExistingAncestorPath)) {
    throw new PublicationConflict('root_changed', 'Approved ancestor canonical path changed')
  }
  if (!await verifyIdentity(current, binding.ancestorIdentityDigest)) {
    throw new PublicationConflict('root_changed', 'Approved ancestor identity changed')
  }
  const approvedAncestor = current
  const createdSegments = []
  for (const [index, segment] of binding.missingSegments.entries()) {
    const parentBefore = await realpath(current)
    const child = join(current, segment)
    let childStat = await statOrNull(child)
    if (childStat === null) {
      try {
        await mkdir(child)
        createdSegments.push(segment)
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      maybeCrash(`root-after-mkdir-${index}`, crashAt)
      childStat = await statOrNull(child)
    }
    if (!childStat || childStat.isSymbolicLink() || !childStat.isDirectory()) {
      throw new PublicationConflict('unsafe_path', 'Prepared root segment is not a real directory')
    }
    const parentAfter = await realpath(current)
    const childReal = await realpath(child)
    if (!samePath(parentBefore, parentAfter) || !samePath(dirname(childReal), parentAfter)) {
      throw new PublicationConflict('root_changed', 'Prepared root escaped its approved parent')
    }
    current = childReal
  }
  if (!await verifyIdentity(approvedAncestor, binding.ancestorIdentityDigest)) {
    throw new PublicationConflict('root_changed', 'Approved ancestor identity changed during preparation')
  }
  if (!samePath(current, binding.declaredRootPath)) {
    throw new PublicationConflict('root_changed', 'Prepared root does not match the declared root')
  }
  if (!await verifyParity(binding, current)) {
    throw new PublicationConflict('root_parity_changed', 'Provider root observation changed')
  }
  return {
    root: current,
    createdSegments,
    rootIdentityDigest: await observeDirectoryIdentity(current, 'Publication root'),
  }
}

async function identityStatOrNull(path) {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function validateIdentity(name, txid) {
  if (name.length > 128 || !NAME_PATTERN.test(name)) {
    throw new PublicationConflict('unsafe_name', `Unsafe Skill name: ${name}`)
  }
  if (!TX_PATTERN.test(txid)) {
    throw new PublicationConflict('unsafe_txid', `Unsafe transaction id: ${txid}`)
  }
}

function targetPaths(rootReal, name, txid) {
  const targetDir = join(rootReal, name)
  const target = join(targetDir, 'SKILL.md')
  const stage = join(targetDir, `.run2skill-${txid}.stage`)
  const backup = join(targetDir, `.run2skill-${txid}.backup`)
  const claim = join(targetDir, `.run2skill-${txid}.claim`)
  const rel = relative(rootReal, targetDir)

  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel) || basename(targetDir) !== name) {
    throw new PublicationConflict('unsafe_path', 'Target is not a direct child of the approved root')
  }

  return { targetDir, target, stage, backup, claim }
}

async function observeBundleDirectory(paths) {
  return observeDirectoryIdentity(paths.targetDir, 'Skill bundle')
}

async function assertExistingBundleIsSafe(paths) {
  const identityDigest = await observeBundleDirectory(paths)
  await hashRegularFile(paths.target)
  return identityDigest
}

async function assertBoundBundleDirectory(paths, expectedDigest) {
  if (
    paths.rootIdentityDigest
    && await observeDirectoryIdentity(paths.root, 'Publication root') !== paths.rootIdentityDigest
  ) {
    throw new PublicationConflict('root_identity_changed', 'Publication root directory identity changed')
  }
  if (paths.journalIdentityDigest) {
    const journalDir = await ensureJournalDirectory(paths.root)
    if (
      await observeDirectoryIdentity(journalDir, 'Publication journal')
      !== paths.journalIdentityDigest
    ) {
      throw new PublicationConflict('journal_identity_changed', 'Publication journal directory identity changed')
    }
  }
  if (!expectedDigest || await observeBundleDirectory(paths) !== expectedDigest) {
    throw new PublicationConflict('target_identity_changed', 'Skill bundle directory identity changed')
  }
}

function maybeCrash(actual, requested) {
  if (actual === requested) process.exit(86)
}

async function appendJournal(rootReal, record) {
  if (!Number.isSafeInteger(record.seq) || record.seq < 0 || record.seq >= MAX_JOURNAL_RECORDS) {
    throw new PublicationConflict('journal_limit', 'Publication journal record limit reached')
  }
  const journalDir = await ensureJournalDirectory(rootReal, true)
  if (
    !record.journalIdentityDigest
    || await observeDirectoryIdentity(journalDir, 'Publication journal') !== record.journalIdentityDigest
  ) {
    throw new PublicationConflict('journal_identity_changed', 'Publication journal directory identity changed')
  }
  const sealed = { ...record, recordHash: sha256(JSON.stringify(record)) }
  const filename = `${record.txid}.${String(record.seq).padStart(4, '0')}.${record.state}.json`
  const path = join(journalDir, filename)
  await writeExclusiveFile(path, `${JSON.stringify(sealed)}\n`)
  await fsyncParent(journalDir)
  if (await observeDirectoryIdentity(journalDir, 'Publication journal') !== record.journalIdentityDigest) {
    throw new PublicationConflict('journal_identity_changed', 'Publication journal directory identity changed')
  }
  return sealed
}

async function nextRecord(current, state, additionalFacts = {}) {
  if (current.state === state && Object.keys(additionalFacts).length === 0) return current
  const { recordHash, ...facts } = current
  const record = {
    ...facts,
    ...additionalFacts,
    seq: current.seq + 1,
    state,
    prevHash: recordHash,
  }
  return appendJournal(current.root, record)
}

async function beginRecord({
  root,
  name,
  txid,
  kind,
  expectedHash,
  nextBytes,
  rootPreparation,
  rootIdentityDigest,
  targetDirIdentityDigest,
}) {
  const paths = targetPaths(root, name, txid)
  const journalDir = await ensureJournalDirectory(root, true)
  const journalIdentityDigest = await observeDirectoryIdentity(journalDir, 'Publication journal')
  const record = {
    version: 1,
    seq: 0,
    state: rootPreparation ? 'ROOT_PREPARED' : 'INTENT',
    kind,
    root,
    name,
    txid,
    expectedHash: expectedHash ?? null,
    nextHash: sha256(nextBytes),
    prevHash: null,
    rootIdentityDigest,
    journalIdentityDigest,
    ...(rootPreparation ? { createdRootSegments: [...rootPreparation.createdSegments] } : {}),
    ...(targetDirIdentityDigest ? { targetDirIdentityDigest } : {}),
    ...paths,
  }
  return appendJournal(root, record)
}

async function conflict(record, code) {
  await nextRecord(record, `CONFLICT_${code.toUpperCase()}`)
  return { status: 'conflict', code, txid: record.txid, target: record.target }
}

async function markWritten(record) {
  const written = await nextRecord(record, 'DISK_WRITTEN')
  return {
    status: 'written',
    txid: written.txid,
    target: written.target,
    backup: written.kind === 'MERGE' ? written.backup : null,
  }
}

async function restoreBackupWithoutOverwrite(record) {
  try {
    await assertBoundBundleDirectory(record, record.targetDirIdentityDigest)
    await link(record.backup, record.target)
    await assertBoundBundleDirectory(record, record.targetDirIdentityDigest)
    await unlink(record.backup)
    await fsyncParent(record.targetDir)
    return 'restored'
  } catch (error) {
    if (error?.code === 'EEXIST') return 'preserved-both'
    throw error
  }
}

function backupReservationBytes(record) {
  return `run2skill-backup-reservation-v1:${record.txid}:${record.backupReservationNonce}\n`
}

function expectedBackupReservationHash(record) {
  if (!HASH_PATTERN.test(record.backupReservationNonce ?? '')) return null
  return sha256(backupReservationBytes(record))
}

async function fileMatches(path, expectedIdentityDigest, expectedHash) {
  const facts = await observeRegularFile(path)
  return Boolean(
    facts
    && expectedIdentityDigest
    && facts.identityDigest === expectedIdentityDigest
    && facts.hash === expectedHash,
  )
}

async function preserveUnknownInstall(record) {
  const targetFacts = await observeRegularFile(record.target)
  if (targetFacts?.identityDigest === record.stageIdentityDigest) {
    await assertBoundBundleDirectory(record, record.targetDirIdentityDigest)
    await unlink(record.target)
    if (record.kind === 'MERGE') await restoreBackupWithoutOverwrite(record)
  }
  return conflict(record, 'post_write_mismatch')
}

function rootPreparationMatches(rootPreparation, rootReal, rootIdentityDigest) {
  return Boolean(
    rootPreparation
    && samePath(rootPreparation.root, rootReal)
    && HASH_PATTERN.test(rootPreparation.rootIdentityDigest ?? '')
    && rootPreparation.rootIdentityDigest === rootIdentityDigest
    && Array.isArray(rootPreparation.createdSegments)
    && new Set(['', 'skills', '.dsh\0skills']).has(rootPreparation.createdSegments.join('\0')),
  )
}

export async function createBundle({ root, name, txid, nextBytes, rootPreparation, crashAt, hooks }) {
  validateIdentity(name, txid)
  const rootReal = await ensureRoot(root)
  const rootIdentityDigest = await observeDirectoryIdentity(rootReal, 'Publication root')
  if (rootPreparation && !rootPreparationMatches(rootPreparation, rootReal, rootIdentityDigest)) {
    throw new PublicationConflict('root_preparation_mismatch', 'Prepared root facts do not match publication root')
  }
  let record = await beginRecord({
    root: rootReal,
    name,
    txid,
    kind: 'CREATE',
    nextBytes,
    rootPreparation,
    rootIdentityDigest,
  })

  try {
    await mkdir(record.targetDir)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const existing = await statOrNull(record.targetDir)
      if (existing?.isSymbolicLink()) {
        throw new PublicationConflict('unsafe_path', 'Existing target is a symlink or junction')
      }
      return conflict(record, 'expected_absence_changed')
    }
    throw error
  }

  const targetDirIdentityDigest = await observeBundleDirectory(record)
  record = await nextRecord(record, 'TARGET_CLAIMED', { targetDirIdentityDigest })
  maybeCrash('create-after-target-claim', crashAt)
  await assertBoundBundleDirectory(record, targetDirIdentityDigest)
  await writeExclusiveFile(record.claim, `${txid}\n`)
  await assertBoundBundleDirectory(record, targetDirIdentityDigest)
  await writeExclusiveFile(record.stage, nextBytes)
  await fsyncParent(record.targetDir)
  const claimFacts = await observeRegularFile(record.claim)
  const stageFacts = await observeRegularFile(record.stage)
  if (!claimFacts || claimFacts.hash !== sha256(`${txid}\n`) || !stageFacts || stageFacts.hash !== record.nextHash) {
    throw new PublicationConflict('stage_write_mismatch', 'CREATE staging artifacts changed during preparation')
  }
  record = await nextRecord(record, 'CREATE_STAGED', {
    claimIdentityDigest: claimFacts.identityDigest,
    stageIdentityDigest: stageFacts.identityDigest,
  })
  maybeCrash('create-after-stage', crashAt)
  await hooks?.beforeInstall?.(record)
  await assertBoundBundleDirectory(record, targetDirIdentityDigest)
  if (!await fileMatches(record.stage, record.stageIdentityDigest, record.nextHash)) {
    return conflict(record, 'stage_changed')
  }

  try {
    await link(record.stage, record.target)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      await unlinkOwnedFileIfPresent(
        record.stage,
        record.stageIdentityDigest,
        record.nextHash,
        'stage_changed',
      )
      await unlinkOwnedFileIfPresent(
        record.claim,
        record.claimIdentityDigest,
        sha256(`${txid}\n`),
        'claim_changed',
      )
      return conflict(record, 'target_appeared')
    }
    throw error
  }

  await hooks?.afterInstall?.(record)
  maybeCrash('create-after-install-before-journal', crashAt)
  await assertBoundBundleDirectory(record, targetDirIdentityDigest)
  if (!await fileMatches(record.target, record.stageIdentityDigest, record.nextHash)) {
    return preserveUnknownInstall(record)
  }
  await assertBoundBundleDirectory(record, targetDirIdentityDigest)
  await unlinkOwnedFileIfPresent(record.stage, record.stageIdentityDigest, record.nextHash, 'stage_changed')
  await unlinkOwnedFileIfPresent(
    record.claim,
    record.claimIdentityDigest,
    sha256(`${txid}\n`),
    'claim_changed',
  )
  await fsyncParent(record.targetDir)
  return markWritten(record)
}

export async function mergeBundle({
  root,
  name,
  txid,
  expectedHash,
  nextBytes,
  rootPreparation,
  crashAt,
  hooks,
}) {
  validateIdentity(name, txid)
  const rootReal = await ensureRoot(root)
  const rootIdentityDigest = await observeDirectoryIdentity(rootReal, 'Publication root')
  if (rootPreparation && !rootPreparationMatches(rootPreparation, rootReal, rootIdentityDigest)) {
    throw new PublicationConflict('root_preparation_mismatch', 'Prepared root facts do not match publication root')
  }
  const paths = targetPaths(rootReal, name, txid)
  const targetDirIdentityDigest = await assertExistingBundleIsSafe(paths)
  let record = await beginRecord({
    root: rootReal,
    name,
    txid,
    kind: 'MERGE',
    expectedHash,
    nextBytes,
    rootPreparation,
    rootIdentityDigest,
    targetDirIdentityDigest,
  })

  await assertBoundBundleDirectory(record, targetDirIdentityDigest)
  await writeExclusiveFile(record.stage, nextBytes)
  await fsyncParent(record.targetDir)
  const stageFacts = await observeRegularFile(record.stage)
  if (!stageFacts || stageFacts.hash !== record.nextHash) {
    throw new PublicationConflict('stage_write_mismatch', 'MERGE stage changed during preparation')
  }
  record = await nextRecord(record, 'MERGE_STAGED', {
    stageIdentityDigest: stageFacts.identityDigest,
  })

  if ((await hashRegularFile(record.target)) !== expectedHash) {
    await unlinkOwnedFileIfPresent(record.stage, record.stageIdentityDigest, record.nextHash, 'stage_changed')
    return conflict(record, 'base_changed')
  }

  await hooks?.beforeBackupMove?.(record)
  await assertBoundBundleDirectory(record, targetDirIdentityDigest)
  if (!await fileMatches(record.stage, record.stageIdentityDigest, record.nextHash)) {
    return conflict(record, 'stage_changed')
  }
  record = await nextRecord(record, 'BACKUP_RESERVING', {
    backupReservationNonce: randomBytes(32).toString('hex'),
  })
  try {
    await writeExclusiveFile(record.backup, backupReservationBytes(record))
  } catch (error) {
    if (error?.code === 'EEXIST') {
      await unlinkOwnedFileIfPresent(record.stage, record.stageIdentityDigest, record.nextHash, 'stage_changed')
      return conflict(record, 'backup_exists')
    }
    throw error
  }
  const reservationFacts = await observeRegularFile(record.backup)
  if (!reservationFacts || reservationFacts.hash !== expectedBackupReservationHash(record)) {
    return conflict(record, 'backup_changed')
  }
  record = await nextRecord(record, 'BACKUP_RESERVED', {
    backupReservationIdentityDigest: reservationFacts.identityDigest,
  })
  maybeCrash('merge-after-backup-reservation', crashAt)
  await hooks?.beforeBackupRename?.(record)
  await assertBoundBundleDirectory(record, targetDirIdentityDigest)
  if (!await fileMatches(
    record.backup,
    record.backupReservationIdentityDigest,
    expectedBackupReservationHash(record),
  )) {
    await unlinkOwnedFileIfPresent(record.stage, record.stageIdentityDigest, record.nextHash, 'stage_changed')
    return conflict(record, 'backup_changed')
  }
  await assertBoundBundleDirectory(record, targetDirIdentityDigest)
  try {
    await rename(record.target, record.backup)
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error?.code)) {
      await unlinkOwnedFileIfPresent(record.stage, record.stageIdentityDigest, record.nextHash, 'stage_changed')
      return conflict(record, 'rename_race')
    }
    throw error
  }

  maybeCrash('merge-after-backup-move', crashAt)
  const backupFacts = await observeRegularFile(record.backup)
  if (!backupFacts || backupFacts.hash !== expectedHash) {
    await restoreBackupWithoutOverwrite(record)
    await unlinkOwnedFileIfPresent(record.stage, record.stageIdentityDigest, record.nextHash, 'stage_changed')
    return conflict(record, 'base_changed_during_cutover')
  }
  record = await nextRecord(record, 'BACKUP_MOVED', {
    backupIdentityDigest: backupFacts.identityDigest,
  })

  await hooks?.beforeInstall?.(record)
  await assertBoundBundleDirectory(record, targetDirIdentityDigest)
  if (!await fileMatches(record.stage, record.stageIdentityDigest, record.nextHash)) {
    await restoreBackupWithoutOverwrite(record)
    return conflict(record, 'stage_changed')
  }
  try {
    await link(record.stage, record.target)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      await unlinkOwnedFileIfPresent(record.stage, record.stageIdentityDigest, record.nextHash, 'stage_changed')
      return conflict(record, 'target_appeared')
    }
    throw error
  }

  await hooks?.afterInstall?.(record)
  maybeCrash('merge-after-install-before-journal', crashAt)
  await assertBoundBundleDirectory(record, targetDirIdentityDigest)
  if (!await fileMatches(record.target, record.stageIdentityDigest, record.nextHash)) {
    return preserveUnknownInstall(record)
  }
  await assertBoundBundleDirectory(record, targetDirIdentityDigest)
  await unlinkOwnedFileIfPresent(record.stage, record.stageIdentityDigest, record.nextHash, 'stage_changed')
  await fsyncParent(record.targetDir)
  return markWritten(record)
}

async function loadLatestRecord(rootReal, txid) {
  validateIdentity('probe', txid)
  const journalDir = await ensureJournalDirectory(rootReal)
  const entries = await readdir(journalDir)
  const prefix = `${txid}.`
  const candidates = new Map()

  for (const entry of entries.filter((value) => value.startsWith(prefix)).sort()) {
    try {
      const record = JSON.parse(await readFile(join(journalDir, entry), 'utf8'))
      if (
        record && typeof record === 'object' && !Array.isArray(record)
        && Object.keys(record).every(key => JOURNAL_KEYS.has(key))
        && record.version === 1
        && record.txid === txid
        && (record.kind === 'CREATE' || record.kind === 'MERGE')
        && typeof record.state === 'string'
        && /^(?:INTENT|ROOT_PREPARED|TARGET_CLAIMED|CREATE_STAGED|MERGE_STAGED|BACKUP_RESERVING|BACKUP_RESERVED|BACKUP_MOVED|RECOVERY_BACKUP_MOVED|DISK_WRITTEN|CONFLICT_[A-Z0-9_]+)$/.test(record.state)
        && Number.isSafeInteger(record.seq)
        && record.seq >= 0
        && record.seq < MAX_JOURNAL_RECORDS
        && HASH_PATTERN.test(record.recordHash)
        && (record.prevHash === null || HASH_PATTERN.test(record.prevHash))
        && HASH_PATTERN.test(record.nextHash)
        && (record.expectedHash === null || HASH_PATTERN.test(record.expectedHash))
        && (record.targetDirIdentityDigest === undefined || HASH_PATTERN.test(record.targetDirIdentityDigest))
        && (record.backupReservationNonce === undefined || HASH_PATTERN.test(record.backupReservationNonce))
        && (record.stageIdentityDigest === undefined || HASH_PATTERN.test(record.stageIdentityDigest))
        && (record.claimIdentityDigest === undefined || HASH_PATTERN.test(record.claimIdentityDigest))
        && (record.backupIdentityDigest === undefined || HASH_PATTERN.test(record.backupIdentityDigest))
        && HASH_PATTERN.test(record.rootIdentityDigest)
        && HASH_PATTERN.test(record.journalIdentityDigest)
        && (
          record.backupReservationIdentityDigest === undefined
          || HASH_PATTERN.test(record.backupReservationIdentityDigest)
        )
        && ['root', 'name', 'targetDir', 'target', 'stage', 'backup', 'claim']
          .every(key => typeof record[key] === 'string')
        && (record.createdRootSegments === undefined || (
          Array.isArray(record.createdRootSegments)
          && record.createdRootSegments.length <= 2
          && record.createdRootSegments.every(segment => segment === '.dsh' || segment === 'skills')
        ))
      ) {
        const { recordHash, ...facts } = record
        if (recordHash === sha256(JSON.stringify(facts))) {
          if (candidates.has(record.seq)) {
            throw new PublicationConflict('journal_fork', 'Publication journal has duplicate sequence facts')
          }
          candidates.set(record.seq, record)
        }
      }
    } catch (error) {
      if (error instanceof PublicationConflict) throw error
      // Append-only recovery ignores a torn or malformed newest record and uses
      // the latest valid fact instead of guessing from timestamps.
    }
  }

  let latest = candidates.get(0)
  if (!latest || latest.prevHash !== null) {
    throw new PublicationConflict('journal_missing', `No valid journal for ${txid}`)
  }
  for (let seq = 1; seq < MAX_JOURNAL_RECORDS; seq += 1) {
    const candidate = candidates.get(seq)
    if (!candidate || candidate.prevHash !== latest.recordHash) break
    latest = candidate
  }
  if (await observeDirectoryIdentity(journalDir, 'Publication journal') !== latest.journalIdentityDigest) {
    throw new PublicationConflict('journal_identity_changed', 'Publication journal directory identity changed')
  }
  return latest
}

function validateRecoveredRecord(rootReal, record) {
  validateIdentity(record.name, record.txid)
  const expectedPaths = targetPaths(rootReal, record.name, record.txid)
  if (record.root !== rootReal) {
    throw new PublicationConflict('journal_path_mismatch', 'Journal root does not match approved root')
  }
  for (const [key, value] of Object.entries(expectedPaths)) {
    if (record[key] !== value) {
      throw new PublicationConflict('journal_path_mismatch', `Journal ${key} is not canonical`)
    }
  }
}

export async function recoverTransaction({ root, txid }) {
  const rootReal = await ensureRoot(root)
  let record = await loadLatestRecord(rootReal, txid)
  validateRecoveredRecord(rootReal, record)

  const dirStat = await statOrNull(record.targetDir)
  if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new PublicationConflict('unsafe_path', 'Recovery target bundle is absent or unsafe')
  }
  await assertBoundBundleDirectory(record, record.targetDirIdentityDigest)

  let targetFacts = await observeRegularFile(record.target)
  const stageFacts = await observeRegularFile(record.stage)
  let targetHash = targetFacts?.hash ?? null
  const stageHash = stageFacts?.hash ?? null

  if (record.kind === 'CREATE') {
    const claimFacts = await observeRegularFile(record.claim)
    if (
      (targetHash !== null && targetHash !== record.nextHash)
      || (stageHash !== null && stageHash !== record.nextHash)
      || (stageFacts && stageFacts.identityDigest !== record.stageIdentityDigest)
      || (claimFacts && (
        claimFacts.identityDigest !== record.claimIdentityDigest
        || claimFacts.hash !== sha256(`${record.txid}\n`)
      ))
    ) {
      return conflict(record, 'recovery_observed_unknown_create_state')
    }
    if (
      targetHash === record.nextHash
      && targetFacts?.identityDigest === record.stageIdentityDigest
    ) {
      await assertBoundBundleDirectory(record, record.targetDirIdentityDigest)
      await unlinkOwnedFileIfPresent(record.stage, record.stageIdentityDigest, record.nextHash, 'stage_changed')
      await unlinkOwnedFileIfPresent(
        record.claim,
        record.claimIdentityDigest,
        sha256(`${record.txid}\n`),
        'claim_changed',
      )
      return markWritten(record)
    }
    if (
      targetHash === null
      && stageHash === record.nextHash
      && stageFacts?.identityDigest === record.stageIdentityDigest
      && claimFacts
      && claimFacts.identityDigest === record.claimIdentityDigest
    ) {
      await assertBoundBundleDirectory(record, record.targetDirIdentityDigest)
      try {
        await link(record.stage, record.target)
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      await assertBoundBundleDirectory(record, record.targetDirIdentityDigest)
      targetFacts = await observeRegularFile(record.target)
      targetHash = targetFacts?.hash ?? null
      if (
        targetHash === record.nextHash
        && targetFacts?.identityDigest === record.stageIdentityDigest
      ) {
        await unlinkOwnedFileIfPresent(record.stage, record.stageIdentityDigest, record.nextHash, 'stage_changed')
        await unlinkOwnedFileIfPresent(
          record.claim,
          record.claimIdentityDigest,
          sha256(`${record.txid}\n`),
          'claim_changed',
        )
        return markWritten(record)
      }
    }
    return conflict(record, 'recovery_observed_unknown_create_state')
  }

  let backupFacts = await observeRegularFile(record.backup)
  let backupHash = backupFacts?.hash ?? null
  let reservationHash = expectedBackupReservationHash(record)
  if (
    (targetHash !== null && targetHash !== record.expectedHash && targetHash !== record.nextHash)
    || (stageHash !== null && stageHash !== record.nextHash)
    || (stageFacts && stageFacts.identityDigest !== record.stageIdentityDigest)
    || (backupHash !== null && backupHash !== record.expectedHash && backupHash !== reservationHash)
    || (
      backupHash === record.expectedHash
      && record.backupIdentityDigest
      && backupFacts?.identityDigest !== record.backupIdentityDigest
    )
    || (
      backupHash === reservationHash
      && record.backupReservationIdentityDigest
      && backupFacts?.identityDigest !== record.backupReservationIdentityDigest
    )
  ) {
    return conflict(record, 'recovery_observed_unknown_merge_state')
  }
  if (
    targetHash === record.nextHash
    && targetFacts?.identityDigest === record.stageIdentityDigest
    && backupHash === record.expectedHash
    && backupFacts?.identityDigest === record.backupIdentityDigest
  ) {
    await assertBoundBundleDirectory(record, record.targetDirIdentityDigest)
    await unlinkOwnedFileIfPresent(record.stage, record.stageIdentityDigest, record.nextHash, 'stage_changed')
    return markWritten(record)
  }

  if (
    targetHash === record.expectedHash
    && (backupHash === null || backupHash === reservationHash)
    && stageHash === record.nextHash
  ) {
    await assertBoundBundleDirectory(record, record.targetDirIdentityDigest)
    if (backupHash === null) {
      if (!reservationHash) {
        record = await nextRecord(record, 'BACKUP_RESERVING', {
          backupReservationNonce: randomBytes(32).toString('hex'),
        })
        reservationHash = expectedBackupReservationHash(record)
      }
      try {
        await writeExclusiveFile(record.backup, backupReservationBytes(record))
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        return conflict(record, 'backup_exists')
      }
      backupFacts = await observeRegularFile(record.backup)
      backupHash = backupFacts?.hash ?? null
      if (!backupFacts || backupHash !== reservationHash) {
        return conflict(record, 'backup_changed')
      }
      record = await nextRecord(record, 'BACKUP_RESERVED', {
        backupReservationIdentityDigest: backupFacts.identityDigest,
      })
    } else if (!record.backupReservationIdentityDigest && backupFacts) {
      record = await nextRecord(record, 'BACKUP_RESERVED', {
        backupReservationIdentityDigest: backupFacts.identityDigest,
      })
    }
    await assertBoundBundleDirectory(record, record.targetDirIdentityDigest)
    if (!await fileMatches(
      record.backup,
      record.backupReservationIdentityDigest,
      reservationHash,
    )) {
      return conflict(record, 'backup_changed')
    }
    await rename(record.target, record.backup)
    targetHash = null
    targetFacts = null
    backupFacts = await observeRegularFile(record.backup)
    backupHash = backupFacts?.hash ?? null
    if (backupHash !== record.expectedHash || !backupFacts) {
      return conflict(record, 'recovery_observed_unknown_merge_state')
    }
    record = await nextRecord(record, 'RECOVERY_BACKUP_MOVED', {
      backupIdentityDigest: backupFacts.identityDigest,
    })
  }

  if (
    targetHash === null
    && backupHash === record.expectedHash
    && backupFacts
    && (!record.backupIdentityDigest || backupFacts.identityDigest === record.backupIdentityDigest)
    && stageHash === record.nextHash
    && stageFacts?.identityDigest === record.stageIdentityDigest
  ) {
    if (!record.backupIdentityDigest) {
      record = await nextRecord(record, 'RECOVERY_BACKUP_MOVED', {
        backupIdentityDigest: backupFacts.identityDigest,
      })
    }
    await assertBoundBundleDirectory(record, record.targetDirIdentityDigest)
    try {
      await link(record.stage, record.target)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    await assertBoundBundleDirectory(record, record.targetDirIdentityDigest)
    targetFacts = await observeRegularFile(record.target)
    targetHash = targetFacts?.hash ?? null
    if (
      targetHash === record.nextHash
      && targetFacts?.identityDigest === record.stageIdentityDigest
    ) {
      await unlinkOwnedFileIfPresent(record.stage, record.stageIdentityDigest, record.nextHash, 'stage_changed')
      return markWritten(record)
    }
  }
  return conflict(record, 'recovery_observed_unknown_merge_state')
}

export async function finalizeTransaction({ root, txid, confirmedExactReadback }) {
  if (confirmedExactReadback !== true) {
    throw new PublicationConflict('readback_confirmation_required', 'Exact Registry readback is not confirmed')
  }
  const rootReal = await ensureRoot(root)
  const record = await loadLatestRecord(rootReal, txid)
  validateRecoveredRecord(rootReal, record)
  await assertBoundBundleDirectory(record, record.targetDirIdentityDigest)
  if (!await fileMatches(record.target, record.stageIdentityDigest, record.nextHash)) {
    throw new PublicationConflict('readback_changed', 'Final target no longer matches approved bytes')
  }
  if (
    record.kind === 'MERGE'
    && !await fileMatches(record.backup, record.backupIdentityDigest, record.expectedHash)
  ) {
    throw new PublicationConflict('backup_changed', 'Backup no longer matches the approved Base')
  }

  await assertBoundBundleDirectory(record, record.targetDirIdentityDigest)
  await unlinkOwnedFileIfPresent(record.stage, record.stageIdentityDigest, record.nextHash, 'stage_changed')
  if (record.kind === 'CREATE') {
    await unlinkOwnedFileIfPresent(
      record.claim,
      record.claimIdentityDigest,
      sha256(`${record.txid}\n`),
      'claim_changed',
    )
  } else {
    await unlinkOwnedFileIfPresent(
      record.backup,
      record.backupIdentityDigest,
      record.expectedHash,
      'backup_changed',
    )
  }
  const journalDir = await ensureJournalDirectory(rootReal)
  for (const entry of await readdir(journalDir)) {
    if (entry.startsWith(`${txid}.`)) await unlink(join(journalDir, entry))
  }
  await fsyncParent(journalDir)
  return { status: 'finalized', txid }
}

export const probeInternals = {
  JOURNAL_DIR,
  MAX_JOURNAL_RECORDS,
  targetPaths,
}
