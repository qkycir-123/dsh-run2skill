import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

const JOURNAL_DIR = '.run2skill-publication'
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const TX_PATTERN = /^[a-z0-9-]{1,80}$/

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
    throw new PublicationConflict('unsafe_path', `Expected a regular file: ${path}`)
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
  const journalDir = join(rootReal, JOURNAL_DIR)
  await mkdir(journalDir, { recursive: true })
  const seq = record.seq
  const filename = `${record.txid}.${String(seq).padStart(4, '0')}.${record.state}.json`
  const path = join(journalDir, filename)
  await writeExclusiveFile(path, `${JSON.stringify(record)}\n`)
  await fsyncParent(journalDir)
  return record
}

async function nextRecord(current, state) {
  const record = { ...current, seq: current.seq + 1, state }
  await appendJournal(current.root, record)
  return record
}

async function beginRecord({ root, name, txid, kind, expectedHash, nextBytes }) {
  const paths = targetPaths(root, name, txid)
  const record = {
    version: 1,
    seq: 0,
    state: 'INTENT',
    kind,
    root,
    name,
    txid,
    expectedHash: expectedHash ?? null,
    nextHash: sha256(nextBytes),
    ...paths,
  }
  await appendJournal(root, record)
  return record
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

export async function createBundle({ root, name, txid, nextBytes, crashAt, hooks }) {
  validateIdentity(name, txid)
  const rootReal = await ensureRoot(resolve(root))
  let record = await beginRecord({ root: rootReal, name, txid, kind: 'CREATE', nextBytes })

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
  const rootReal = await ensureRoot(resolve(root))
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
  const journalDir = join(rootReal, JOURNAL_DIR)
  const entries = await readdir(journalDir)
  const prefix = `${txid}.`
  const candidates = []

  for (const entry of entries.filter((value) => value.startsWith(prefix)).sort()) {
    try {
      const record = JSON.parse(await readFile(join(journalDir, entry), 'utf8'))
      if (record.txid === txid && Number.isInteger(record.seq)) candidates.push(record)
    } catch {
      // Append-only recovery ignores a torn or malformed newest record and uses
      // the latest valid fact instead of guessing from timestamps.
    }
  }

  if (candidates.length === 0) {
    throw new PublicationConflict('journal_missing', `No valid journal for ${txid}`)
  }
  return candidates.sort((a, b) => b.seq - a.seq)[0]
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
  const rootReal = await ensureRoot(resolve(root))
  let record = await loadLatestRecord(rootReal, txid)
  validateRecoveredRecord(rootReal, record)

  const dirStat = await statOrNull(record.targetDir)
  if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new PublicationConflict('unsafe_path', 'Recovery target bundle is absent or unsafe')
  }

  let targetHash = await hashRegularFile(record.target)
  let stageHash = await hashRegularFile(record.stage)

  if (record.kind === 'CREATE') {
    const claim = await statOrNull(record.claim)
    if (claim?.isSymbolicLink() || (claim && !claim.isFile())) {
      throw new PublicationConflict('unsafe_path', 'CREATE claim is unsafe')
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

  if (targetHash === null && backupHash && backupHash !== record.expectedHash) {
    await restoreBackupWithoutOverwrite(record)
  }
  return conflict(record, 'recovery_observed_unknown_merge_state')
}

export async function finalizeTransaction({ root, txid }) {
  const rootReal = await ensureRoot(resolve(root))
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
  const journalDir = join(rootReal, JOURNAL_DIR)
  for (const entry of await readdir(journalDir)) {
    if (entry.startsWith(`${txid}.`)) await unlink(join(journalDir, entry))
  }
  await fsyncParent(journalDir)
  return { status: 'finalized', txid }
}

export const probeInternals = {
  JOURNAL_DIR,
  targetPaths,
}
