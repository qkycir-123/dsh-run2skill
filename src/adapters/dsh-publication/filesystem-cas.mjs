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
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// Production filesystem primitive; the cross-platform probe imports this file directly.
const JOURNAL_DIR = '.run2skill-publication'
const MAX_JOURNAL_RECORDS = 64
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const TX_PATTERN = /^[a-z0-9-]{1,80}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const JOURNAL_KEYS = new Set([
  'version', 'seq', 'state', 'kind', 'root', 'name', 'txid', 'expectedHash', 'nextHash',
  'prevHash', 'recordHash', 'createdRootSegments', 'targetDir', 'target', 'stage', 'backup', 'claim',
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

async function hashRegularFile(path) {
  const stat = await statOrNull(path)
  if (!stat) return null
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new PublicationConflict('unsafe_path', 'Expected a regular file')
  }
  return sha256(await readFile(path))
}

async function unlinkIfPresent(path) {
  try {
    await unlink(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
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
  return realpath(root)
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
    return { root, createdSegments: [] }
  }
  if (
    binding.state !== 'ABSENT'
    || !isAbsolute(binding.canonicalExistingAncestorPath)
    || !Array.isArray(binding.missingSegments)
    || !allowedMissingSegments(binding)
  ) {
    throw new PublicationConflict('unsafe_path', 'Missing root segments are not approved')
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
  return { root: current, createdSegments }
}

function validateIdentity(name, txid) {
  if (!NAME_PATTERN.test(name)) {
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

async function assertExistingBundleIsSafe(paths) {
  const dirStat = await lstat(paths.targetDir)
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new PublicationConflict('unsafe_path', 'Skill bundle is a symlink, junction, or non-directory')
  }
  await hashRegularFile(paths.target)
}

function maybeCrash(actual, requested) {
  if (actual === requested) process.exit(86)
}

async function appendJournal(rootReal, record) {
  if (!Number.isSafeInteger(record.seq) || record.seq < 0 || record.seq >= MAX_JOURNAL_RECORDS) {
    throw new PublicationConflict('journal_limit', 'Publication journal record limit reached')
  }
  const journalDir = await ensureJournalDirectory(rootReal, true)
  const sealed = { ...record, recordHash: sha256(JSON.stringify(record)) }
  const filename = `${record.txid}.${String(record.seq).padStart(4, '0')}.${record.state}.json`
  const path = join(journalDir, filename)
  await writeExclusiveFile(path, `${JSON.stringify(sealed)}\n`)
  await fsyncParent(journalDir)
  return sealed
}

async function nextRecord(current, state) {
  if (current.state === state) return current
  const { recordHash, ...facts } = current
  const record = { ...facts, seq: current.seq + 1, state, prevHash: recordHash }
  return appendJournal(current.root, record)
}

async function beginRecord({ root, name, txid, kind, expectedHash, nextBytes, rootPreparation }) {
  const paths = targetPaths(root, name, txid)
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
    ...(rootPreparation ? { createdRootSegments: [...rootPreparation.createdSegments] } : {}),
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
    await link(record.backup, record.target)
    await unlink(record.backup)
    await fsyncParent(record.targetDir)
    return 'restored'
  } catch (error) {
    if (error?.code === 'EEXIST') return 'preserved-both'
    throw error
  }
}

export async function createBundle({ root, name, txid, nextBytes, rootPreparation, crashAt, hooks }) {
  validateIdentity(name, txid)
  const rootReal = await ensureRoot(root)
  if (rootPreparation && (
    !samePath(rootPreparation.root, rootReal)
    || !Array.isArray(rootPreparation.createdSegments)
    || !new Set(['', 'skills', '.dsh\0skills']).has(rootPreparation.createdSegments.join('\0'))
  )) {
    throw new PublicationConflict('root_preparation_mismatch', 'Prepared root facts do not match publication root')
  }
  let record = await beginRecord({
    root: rootReal,
    name,
    txid,
    kind: 'CREATE',
    nextBytes,
    rootPreparation,
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

  await writeExclusiveFile(record.claim, `${txid}\n`)
  await writeExclusiveFile(record.stage, nextBytes)
  await fsyncParent(record.targetDir)
  record = await nextRecord(record, 'CREATE_STAGED')
  maybeCrash('create-after-stage', crashAt)
  await hooks?.beforeInstall?.(record)

  try {
    await link(record.stage, record.target)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      await unlinkIfPresent(record.stage)
      await unlinkIfPresent(record.claim)
      return conflict(record, 'target_appeared')
    }
    throw error
  }

  maybeCrash('create-after-install-before-journal', crashAt)
  if ((await hashRegularFile(record.target)) !== record.nextHash) {
    throw new PublicationConflict('post_write_mismatch', 'CREATE target changed during installation')
  }
  await unlinkIfPresent(record.stage)
  await unlinkIfPresent(record.claim)
  await fsyncParent(record.targetDir)
  return markWritten(record)
}

export async function mergeBundle({
  root,
  name,
  txid,
  expectedHash,
  nextBytes,
  crashAt,
  hooks,
}) {
  validateIdentity(name, txid)
  const rootReal = await ensureRoot(root)
  const paths = targetPaths(rootReal, name, txid)
  await assertExistingBundleIsSafe(paths)
  let record = await beginRecord({
    root: rootReal,
    name,
    txid,
    kind: 'MERGE',
    expectedHash,
    nextBytes,
  })

  await writeExclusiveFile(record.stage, nextBytes)
  await fsyncParent(record.targetDir)
  record = await nextRecord(record, 'MERGE_STAGED')

  if ((await hashRegularFile(record.target)) !== expectedHash) {
    await unlinkIfPresent(record.stage)
    return conflict(record, 'base_changed')
  }

  await hooks?.beforeBackupMove?.(record)
  if (await statOrNull(record.backup)) {
    await unlinkIfPresent(record.stage)
    return conflict(record, 'backup_exists')
  }
  try {
    await rename(record.target, record.backup)
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error?.code)) {
      await unlinkIfPresent(record.stage)
      return conflict(record, 'rename_race')
    }
    throw error
  }

  maybeCrash('merge-after-backup-move', crashAt)
  record = await nextRecord(record, 'BACKUP_MOVED')

  if ((await hashRegularFile(record.backup)) !== expectedHash) {
    await restoreBackupWithoutOverwrite(record)
    await unlinkIfPresent(record.stage)
    return conflict(record, 'base_changed_during_cutover')
  }

  await hooks?.beforeInstall?.(record)
  try {
    await link(record.stage, record.target)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      await unlinkIfPresent(record.stage)
      return conflict(record, 'target_appeared')
    }
    throw error
  }

  maybeCrash('merge-after-install-before-journal', crashAt)
  if ((await hashRegularFile(record.target)) !== record.nextHash) {
    throw new PublicationConflict('post_write_mismatch', 'MERGE target changed during installation')
  }
  await unlinkIfPresent(record.stage)
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
        && /^(?:INTENT|ROOT_PREPARED|CREATE_STAGED|MERGE_STAGED|BACKUP_MOVED|RECOVERY_BACKUP_MOVED|DISK_WRITTEN|CONFLICT_[A-Z0-9_]+)$/.test(record.state)
        && Number.isSafeInteger(record.seq)
        && record.seq >= 0
        && record.seq < MAX_JOURNAL_RECORDS
        && HASH_PATTERN.test(record.recordHash)
        && (record.prevHash === null || HASH_PATTERN.test(record.prevHash))
        && HASH_PATTERN.test(record.nextHash)
        && (record.expectedHash === null || HASH_PATTERN.test(record.expectedHash))
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

  let targetHash = await hashRegularFile(record.target)
  const stageHash = await hashRegularFile(record.stage)

  if (record.kind === 'CREATE') {
    const claim = await statOrNull(record.claim)
    if (claim?.isSymbolicLink() || (claim && !claim.isFile())) {
      throw new PublicationConflict('unsafe_path', 'CREATE claim is unsafe')
    }
    if (
      (targetHash !== null && targetHash !== record.nextHash)
      || (stageHash !== null && stageHash !== record.nextHash)
    ) {
      return conflict(record, 'recovery_observed_unknown_create_state')
    }
    if (targetHash === record.nextHash) {
      await unlinkIfPresent(record.stage)
      await unlinkIfPresent(record.claim)
      return markWritten(record)
    }
    if (targetHash === null && stageHash === record.nextHash && claim) {
      try {
        await link(record.stage, record.target)
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      targetHash = await hashRegularFile(record.target)
      if (targetHash === record.nextHash) {
        await unlinkIfPresent(record.stage)
        await unlinkIfPresent(record.claim)
        return markWritten(record)
      }
    }
    return conflict(record, 'recovery_observed_unknown_create_state')
  }

  let backupHash = await hashRegularFile(record.backup)
  if (
    (targetHash !== null && targetHash !== record.expectedHash && targetHash !== record.nextHash)
    || (stageHash !== null && stageHash !== record.nextHash)
    || (backupHash !== null && backupHash !== record.expectedHash)
  ) {
    return conflict(record, 'recovery_observed_unknown_merge_state')
  }
  if (targetHash === record.nextHash && backupHash === record.expectedHash) {
    await unlinkIfPresent(record.stage)
    return markWritten(record)
  }

  if (targetHash === record.expectedHash && backupHash === null && stageHash === record.nextHash) {
    await rename(record.target, record.backup)
    targetHash = null
    backupHash = await hashRegularFile(record.backup)
    record = await nextRecord(record, 'RECOVERY_BACKUP_MOVED')
  }

  if (targetHash === null && backupHash === record.expectedHash && stageHash === record.nextHash) {
    try {
      await link(record.stage, record.target)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    targetHash = await hashRegularFile(record.target)
    if (targetHash === record.nextHash) {
      await unlinkIfPresent(record.stage)
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
  if ((await hashRegularFile(record.target)) !== record.nextHash) {
    throw new PublicationConflict('readback_changed', 'Final target no longer matches approved bytes')
  }
  if (record.kind === 'MERGE' && (await hashRegularFile(record.backup)) !== record.expectedHash) {
    throw new PublicationConflict('backup_changed', 'Backup no longer matches the approved Base')
  }

  await unlinkIfPresent(record.stage)
  await unlinkIfPresent(record.claim)
  await unlinkIfPresent(record.backup)
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
