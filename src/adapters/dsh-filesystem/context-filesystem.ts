import { join } from 'node:path'

export interface DshContextFileSystemTarget {
  readonly targetKey: string
  readonly displayPath: string
}

export interface DshContextFileSystemInfo {
  readonly version: string
  readonly type: 'file' | 'directory' | 'other'
  readonly size?: number | undefined
}

export interface DshContextFileSystemPathInfo {
  readonly version: string
  readonly type: 'file' | 'directory' | 'symlink' | 'other'
  readonly size?: number | undefined
}

export interface DshContextFileSystemDirectoryEntry {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
  readonly target: DshContextFileSystemTarget
  readonly version?: string | undefined
  readonly size?: number | undefined
}

/** Structural observation-only projection of the exact DSH Agent `ctx.fs` capability. */
export interface DshContextFileSystemPort {
  resolve(
    path: string,
    options?: { readonly cwd?: string | undefined, readonly signal?: AbortSignal | undefined },
  ): Promise<DshContextFileSystemTarget>
  contains(parent: DshContextFileSystemTarget, child: DshContextFileSystemTarget): boolean
  stat(target: DshContextFileSystemTarget, signal?: AbortSignal): Promise<DshContextFileSystemInfo | undefined>
  lstat(
    path: string,
    options?: { readonly cwd?: string | undefined },
    signal?: AbortSignal,
  ): Promise<DshContextFileSystemPathInfo | undefined>
  readBytes(
    target: DshContextFileSystemTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array>
  listDir(
    target: DshContextFileSystemTarget,
    signal?: AbortSignal,
  ): Promise<readonly DshContextFileSystemDirectoryEntry[]>
}

export type DshContextFileSystemWriteIntent =
  | { readonly kind: 'createIfAbsent' }
  | { readonly kind: 'replaceIfVersion'; readonly version: string }

export interface DshContextFileSystemPublicationPolicy {
  readonly mode: 'workspace-write'
  readonly workspaceRoot: string
  readonly sessionId: string
}

export interface DshContextFileSystemWriteOutcome {
  readonly operation: 'create' | 'update'
  readonly version: string
  readonly before: string | null
  readonly after: string
}

/** Mutation-capable projection used only after an approved Proposal is revalidated. */
export interface DshWritableContextFileSystemPort extends DshContextFileSystemPort {
  readonly sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access' | undefined
  processPath(target: DshContextFileSystemTarget): string
  writeText(
    target: DshContextFileSystemTarget,
    content: string,
    expected?: DshContextFileSystemWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: DshContextFileSystemPublicationPolicy,
  ): Promise<DshContextFileSystemWriteOutcome>
}

export class DshContextFileSystemObservationError extends Error {}

export interface StableContextFile {
  readonly target: DshContextFileSystemTarget
  readonly version: string
  readonly bytes: Uint8Array
}

export interface StableContextDirectory {
  readonly target: DshContextFileSystemTarget
  readonly version: string
  readonly entries: readonly DshContextFileSystemDirectoryEntry[]
}

const REQUIRED_METHODS = ['resolve', 'contains', 'stat', 'lstat', 'readBytes', 'listDir'] as const

/** Validates an untyped `ctx.get('fs')` value without importing a DSH implementation package. */
export function parseDshContextFileSystem(value: unknown): DshContextFileSystemPort | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  for (const method of REQUIRED_METHODS) {
    if (typeof candidate[method] !== 'function') return undefined
  }
  return value as DshContextFileSystemPort
}

/** Requires the DSH process-path and atomic write seam in addition to observation. */
export function parseWritableDshContextFileSystem(value: unknown): DshWritableContextFileSystemPort | undefined {
  const observed = parseDshContextFileSystem(value)
  if (observed === undefined
    || !('processPath' in observed) || typeof observed.processPath !== 'function'
    || !('writeText' in observed) || typeof observed.writeText !== 'function') return undefined
  return observed as DshWritableContextFileSystemPort
}

function validTarget(value: unknown): value is DshContextFileSystemTarget {
  return typeof value === 'object' && value !== null
    && 'targetKey' in value && typeof value.targetKey === 'string' && value.targetKey.length > 0
    && 'displayPath' in value && typeof value.displayPath === 'string'
}

function validSize(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}

function validInfo(value: unknown): value is DshContextFileSystemInfo {
  return typeof value === 'object' && value !== null
    && 'version' in value && typeof value.version === 'string' && value.version.length > 0
    && 'type' in value && (value.type === 'file' || value.type === 'directory' || value.type === 'other')
    && (!('size' in value) || validSize(value.size))
}

function validPathInfo(value: unknown): value is DshContextFileSystemPathInfo {
  return typeof value === 'object' && value !== null
    && 'version' in value && typeof value.version === 'string' && value.version.length > 0
    && 'type' in value
    && (value.type === 'file' || value.type === 'directory' || value.type === 'symlink' || value.type === 'other')
    && (!('size' in value) || validSize(value.size))
}

function sameInfo(left: DshContextFileSystemInfo, right: DshContextFileSystemInfo): boolean {
  return left.version === right.version && left.type === right.type && left.size === right.size
}

function samePathInfo(left: DshContextFileSystemPathInfo, right: DshContextFileSystemPathInfo): boolean {
  return left.version === right.version && left.type === right.type && left.size === right.size
}

function safeEntryName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
}

function assertContained(
  filesystem: DshContextFileSystemPort,
  parent: DshContextFileSystemTarget | undefined,
  child: DshContextFileSystemTarget,
): void {
  if (parent !== undefined && !filesystem.contains(parent, child)) {
    throw new DshContextFileSystemObservationError('Context filesystem target escaped its observed root')
  }
}

/** Reads one lexical file through a stat/read/stat sandwich and rejects links or version drift. */
export async function readStableContextFile(
  filesystem: DshContextFileSystemPort,
  path: string,
  options: {
    readonly cwd?: string | undefined
    readonly signal?: AbortSignal | undefined
    readonly maxBytes: number
    readonly containWithin?: DshContextFileSystemTarget | undefined
  },
): Promise<StableContextFile | undefined> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new TypeError('Invalid context filesystem byte limit')
  }
  const lexicalBefore = await filesystem.lstat(path, { cwd: options.cwd }, options.signal)
  if (lexicalBefore === undefined) return undefined
  if (!validPathInfo(lexicalBefore) || lexicalBefore.type !== 'file') {
    throw new DshContextFileSystemObservationError('Context filesystem candidate is not a regular file')
  }
  const target = await filesystem.resolve(path, { cwd: options.cwd, signal: options.signal })
  if (!validTarget(target)) throw new DshContextFileSystemObservationError('Invalid context filesystem target')
  assertContained(filesystem, options.containWithin, target)
  const before = await filesystem.stat(target, options.signal)
  if (!validInfo(before) || before.type !== 'file' || before.version !== lexicalBefore.version) {
    throw new DshContextFileSystemObservationError('Context filesystem candidate changed before reading')
  }
  if (before.size !== undefined && before.size > options.maxBytes) {
    throw new DshContextFileSystemObservationError('Context filesystem candidate exceeds the byte limit')
  }
  const bytes = await filesystem.readBytes(target, options.signal, options.maxBytes)
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > options.maxBytes) {
    throw new DshContextFileSystemObservationError('Invalid bounded context filesystem read')
  }
  const after = await filesystem.stat(target, options.signal)
  const lexicalAfter = await filesystem.lstat(path, { cwd: options.cwd }, options.signal)
  if (!validInfo(after) || !sameInfo(before, after)
    || !validPathInfo(lexicalAfter) || !samePathInfo(lexicalBefore, lexicalAfter)) {
    throw new DshContextFileSystemObservationError('Context filesystem candidate changed while reading')
  }
  return { target, version: before.version, bytes }
}

/** Lists one lexical directory through a stat/list/stat sandwich and validates direct-child identities. */
export async function listStableContextDirectory(
  filesystem: DshContextFileSystemPort,
  path: string,
  options: {
    readonly cwd?: string | undefined
    readonly signal?: AbortSignal | undefined
  } = {},
): Promise<StableContextDirectory | undefined> {
  const lexicalBefore = await filesystem.lstat(path, { cwd: options.cwd }, options.signal)
  if (lexicalBefore === undefined) return undefined
  if (!validPathInfo(lexicalBefore) || lexicalBefore.type !== 'directory') {
    throw new DshContextFileSystemObservationError('Context filesystem root is not a regular directory')
  }
  const target = await filesystem.resolve(path, { cwd: options.cwd, signal: options.signal })
  if (!validTarget(target)) throw new DshContextFileSystemObservationError('Invalid context filesystem target')
  const before = await filesystem.stat(target, options.signal)
  if (!validInfo(before) || before.type !== 'directory' || before.version !== lexicalBefore.version) {
    throw new DshContextFileSystemObservationError('Context filesystem directory changed before listing')
  }
  const observed = await filesystem.listDir(target, options.signal)
  if (!Array.isArray(observed)) throw new DshContextFileSystemObservationError('Invalid context filesystem directory listing')
  const entries: DshContextFileSystemDirectoryEntry[] = []
  for (const entry of observed as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null
      || !('name' in entry) || typeof entry.name !== 'string' || !safeEntryName(entry.name)
      || !('type' in entry) || (entry.type !== 'file' && entry.type !== 'directory' && entry.type !== 'other')
      || !('target' in entry) || !validTarget(entry.target)
      || ('version' in entry && entry.version !== undefined && typeof entry.version !== 'string')
      || ('size' in entry && !validSize(entry.size))) {
      throw new DshContextFileSystemObservationError('Invalid context filesystem directory entry')
    }
    assertContained(filesystem, target, entry.target)
    const declaredTarget = await filesystem.resolve(join(path, entry.name), {
      cwd: options.cwd,
      signal: options.signal,
    })
    if (!validTarget(declaredTarget) || declaredTarget.targetKey !== entry.target.targetKey) {
      throw new DshContextFileSystemObservationError('Context filesystem directory entry identity mismatch')
    }
    entries.push(entry as DshContextFileSystemDirectoryEntry)
  }
  const after = await filesystem.stat(target, options.signal)
  const lexicalAfter = await filesystem.lstat(path, { cwd: options.cwd }, options.signal)
  if (!validInfo(after) || !sameInfo(before, after)
    || !validPathInfo(lexicalAfter) || !samePathInfo(lexicalBefore, lexicalAfter)) {
    throw new DshContextFileSystemObservationError('Context filesystem directory changed while listing')
  }
  return { target, version: before.version, entries }
}
