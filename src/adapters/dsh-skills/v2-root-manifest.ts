import { createReadStream } from 'node:fs'
import { access, opendir, realpath, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import type { SessionBatchV2 } from '../../domain/v2/index.js'
import {
  DshContextFileSystemObservationError,
  listStableContextDirectory,
  parseDshContextFileSystem,
  readStableContextFile,
  type DshContextFileSystemPort,
  type DshContextFileSystemTarget,
} from '../dsh-filesystem/context-filesystem.js'
import type { StockSkillRuntimeConfiguration } from './stock-root-contract.js'

const EMPTY_DIGEST = sha256Utf8(canonicalJson([]))
const ROOT_MANIFEST_POLICY_VERSION = 'effective-filesystem-root-set-v1'
const CONTEXT_ROOT_MANIFEST_POLICY_VERSION = 'effective-context-filesystem-root-set-v1'
const DEFAULT_ROOT_MANIFEST_POLICY = Object.freeze({
  maxRootEntries: 16_384,
  maxCandidateFiles: 4_096,
  maxTotalBytes: 128 * 1024 * 1024,
  maxDurationMs: 5_000,
})

interface RootManifestPolicy {
  readonly maxRootEntries: number
  readonly maxCandidateFiles: number
  readonly maxTotalBytes: number
  readonly maxDurationMs: number
}

interface EffectiveRoot {
  readonly source: 'project-dsh' | 'project-agents' | 'custom' | 'user-dsh' | 'user-agents' | 'bundled'
  readonly rank: 100 | 200 | 300 | 400 | 500 | 600
  readonly path: string
  readonly skipSystem?: boolean
}

interface RootEntry {
  readonly source: EffectiveRoot['source']
  readonly rank: EffectiveRoot['rank']
  readonly rootIdentityDigest: string
  readonly name: string
  readonly layout: 'BUNDLE' | 'FLAT'
  readonly contentDigest: string
}

interface ScannedRoot {
  readonly source: EffectiveRoot['source']
  readonly rank: EffectiveRoot['rank']
  readonly rootIdentityDigest: string
  readonly state: 'ABSENT' | 'DIRECTORY'
  readonly resolvedIdentityDigest?: string
  readonly entries: readonly RootEntry[]
}

class RootManifestBudgetError extends Error {}

class RootManifestBudget {
  readonly #deadline: number
  #rootEntries = 0
  #candidateFiles = 0
  #totalBytes = 0

  constructor(private readonly policy: RootManifestPolicy) {
    this.#deadline = Date.now() + policy.maxDurationMs
  }

  remainingMs(): number {
    this.assertTime()
    return Math.max(1, this.#deadline - Date.now())
  }

  maxReadBytes(): number {
    return this.policy.maxTotalBytes
  }

  observeRootEntry(): void {
    this.assertTime()
    this.#rootEntries += 1
    if (this.#rootEntries > this.policy.maxRootEntries) throw new RootManifestBudgetError()
  }

  observeCandidate(): void {
    this.assertTime()
    this.#candidateFiles += 1
    if (this.#candidateFiles > this.policy.maxCandidateFiles) throw new RootManifestBudgetError()
  }

  observeBytes(bytes: number): void {
    this.assertTime()
    this.#totalBytes += bytes
    if (this.#totalBytes > this.policy.maxTotalBytes) throw new RootManifestBudgetError()
  }

  assertTime(): void {
    if (Date.now() > this.#deadline) throw new RootManifestBudgetError()
  }
}

export interface DshV2RuntimeCatalogManifestPort {
  observeRuntimeCatalog(sessionLifecycleKey: string): Promise<{
    readonly complete: boolean
    readonly runtimeCatalogDigest: string
  }>
  observeOwnershipCatalog?(sessionLifecycleKey: string): Promise<{
    readonly complete: boolean
    readonly runtimeCatalogDigest: string
    readonly candidates: readonly {
      readonly candidateId: string
      readonly name: string
      readonly provider: string
      readonly source: string
      readonly scope: 'PROJECT' | 'USER'
      readonly writable: boolean
      readonly targetPathDigest?: string
      readonly bodyDigest: string
    }[]
  }>
}

export interface DshV2RootManifestAdapterOptions {
  readonly resolveSession: (sessionLifecycleKey: string) => {
    readonly cwd?: string | undefined
    /** Exact `agent.ctx.get('fs')` value for this Session lifecycle. */
    readonly filesystem?: unknown
    readonly configuration: StockSkillRuntimeConfiguration
  } | undefined
  readonly runtimeCatalog: DshV2RuntimeCatalogManifestPort
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly currentEnvironment?: () => Readonly<Record<string, string | undefined>>
  readonly homeDirectory?: () => string
  readonly now?: () => number
  /** @internal Allows deterministic boundary tests; Host wiring uses the frozen default policy. */
  readonly internalPolicy?: Partial<RootManifestPolicy>
}

function absent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function canonicalPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function expandDshHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

function resolveDshHomeCompatible(
  configured: string | undefined,
  environmentValue: string | undefined,
  home: string,
): string {
  const selected = configured
    ?? (environmentValue !== undefined && environmentValue.trim().length > 0
      ? environmentValue
      : join(home, '.dsh'))
  return resolve(expandDshHome(selected, home))
}

async function projectRoot(cwd: string, budget: RootManifestBudget): Promise<string> {
  const initial = resolve(cwd)
  let current = initial
  while (true) {
    try {
      await withBudgetDeadline(access(join(current, '.git')), budget)
      return current
    } catch (error) {
      if (error instanceof RootManifestBudgetError) throw error
      const parent = dirname(current)
      if (parent === current) return initial
      current = parent
    }
  }
}

async function stableContextPathExists(
  filesystem: DshContextFileSystemPort,
  path: string,
  budget: RootManifestBudget,
): Promise<boolean> {
  const lexicalBefore = await withBudgetDeadline(filesystem.lstat(path), budget)
  if (lexicalBefore === undefined) return false
  if (lexicalBefore.type === 'symlink' || lexicalBefore.version.length === 0) {
    throw new DshContextFileSystemObservationError('Unsafe context filesystem project marker')
  }
  const target = await withBudgetDeadline(filesystem.resolve(path), budget)
  if (target.targetKey.length === 0) throw new DshContextFileSystemObservationError('Invalid context filesystem project marker')
  const before = await withBudgetDeadline(filesystem.stat(target), budget)
  const after = await withBudgetDeadline(filesystem.stat(target), budget)
  const lexicalAfter = await withBudgetDeadline(filesystem.lstat(path), budget)
  if (before === undefined || after === undefined || lexicalAfter === undefined
    || before.version !== lexicalBefore.version || after.version !== before.version
    || after.type !== before.type || after.size !== before.size
    || lexicalAfter.version !== lexicalBefore.version || lexicalAfter.type !== lexicalBefore.type
    || lexicalAfter.size !== lexicalBefore.size) {
    throw new DshContextFileSystemObservationError('Context filesystem project marker changed')
  }
  return true
}

async function contextProjectRoot(
  filesystem: DshContextFileSystemPort,
  cwd: string,
  budget: RootManifestBudget,
): Promise<string> {
  const initial = resolve(cwd)
  let current = initial
  while (true) {
    if (await stableContextPathExists(filesystem, join(current, '.git'), budget)) return current
    const parent = dirname(current)
    if (parent === current) return initial
    current = parent
  }
}

function withinRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && path !== '..' && !isAbsolute(path))
}

async function withBudgetDeadline<T>(operation: Promise<T>, budget: RootManifestBudget): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RootManifestBudgetError()), budget.remainingMs())
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function readCandidate(
  path: string,
  resolvedRoot: string,
  budget: RootManifestBudget,
): Promise<string | undefined> {
  let target
  try {
    target = await withBudgetDeadline(realpath(path), budget)
  } catch (error) {
    if (absent(error)) return undefined
    throw error
  }
  if (!withinRoot(resolvedRoot, target)) throw new RootManifestBudgetError()
  budget.observeCandidate()
  const hash = createHash('sha256')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new RootManifestBudgetError()), budget.remainingMs())
  try {
    for await (const chunk of createReadStream(target, { signal: controller.signal })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      budget.observeBytes(bytes.byteLength)
      hash.update(bytes)
    }
    return hash.digest('hex')
  } catch (error) {
    if (controller.signal.aborted) throw new RootManifestBudgetError()
    if (absent(error)) return undefined
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function scanRoot(root: EffectiveRoot, budget: RootManifestBudget): Promise<ScannedRoot> {
  const rootIdentityDigest = sha256Utf8(canonicalJson({
    policyVersion: ROOT_MANIFEST_POLICY_VERSION,
    source: root.source,
    rank: root.rank,
    path: canonicalPath(root.path),
  }))
  let resolvedRoot
  try {
    resolvedRoot = await withBudgetDeadline(realpath(root.path), budget)
  } catch (error) {
    if (absent(error)) return { source: root.source, rank: root.rank, rootIdentityDigest, state: 'ABSENT', entries: [] }
    throw error
  }
  const rootInfo = await withBudgetDeadline(stat(resolvedRoot), budget)
  if (!rootInfo.isDirectory()) throw new RootManifestBudgetError()
  let directory
  try {
    directory = await withBudgetDeadline(opendir(root.path), budget)
  } catch (error) {
    if (absent(error)) return { source: root.source, rank: root.rank, rootIdentityDigest, state: 'ABSENT', entries: [] }
    throw error
  }
  const result: RootEntry[] = []
  try {
    while (true) {
      const entry = await withBudgetDeadline(directory.read(), budget)
      if (entry === null) break
      budget.observeRootEntry()
      if (root.skipSystem === true && entry.name === '.system') continue
      const path = join(root.path, entry.name)
      let kind: 'directory' | 'file' | undefined
      if (entry.isDirectory()) kind = 'directory'
      else if (entry.isFile()) kind = 'file'
      else if (entry.isSymbolicLink()) {
        try {
          const target = await withBudgetDeadline(stat(path), budget)
          if (target.isDirectory()) kind = 'directory'
          else if (target.isFile()) kind = 'file'
        } catch (error) {
          if (!absent(error)) throw error
        }
      }
      const layout = kind === 'directory' ? 'BUNDLE' : kind === 'file' && entry.name.endsWith('.md') ? 'FLAT' : undefined
      if (layout === undefined) continue
      const contentDigest = await readCandidate(
        layout === 'BUNDLE' ? join(path, 'SKILL.md') : path,
        resolvedRoot,
        budget,
      )
      if (contentDigest === undefined) continue
      result.push({ source: root.source, rank: root.rank, rootIdentityDigest, name: entry.name, layout, contentDigest })
    }
  } finally {
    await withBudgetDeadline(directory.close(), budget).catch(() => undefined)
  }
  budget.assertTime()
  result.sort((left, right) => left.name.localeCompare(right.name) || left.layout.localeCompare(right.layout))
  return {
    source: root.source,
    rank: root.rank,
    rootIdentityDigest,
    state: 'DIRECTORY',
    resolvedIdentityDigest: sha256Utf8(canonicalJson({ resolvedRoot: canonicalPath(resolvedRoot) })),
    entries: result,
  }
}

function contextTargetDigest(target: DshContextFileSystemTarget): string {
  return sha256Utf8(canonicalJson({ targetKey: target.targetKey }))
}

async function scanContextRoot(
  filesystem: DshContextFileSystemPort,
  root: EffectiveRoot,
  budget: RootManifestBudget,
): Promise<ScannedRoot> {
  const declaredTarget = await withBudgetDeadline(filesystem.resolve(root.path), budget)
  if (declaredTarget.targetKey.length === 0) throw new DshContextFileSystemObservationError('Invalid context filesystem root')
  const targetDigest = contextTargetDigest(declaredTarget)
  const rootIdentityDigest = sha256Utf8(canonicalJson({
    policyVersion: CONTEXT_ROOT_MANIFEST_POLICY_VERSION,
    source: root.source,
    rank: root.rank,
    targetIdentityDigest: targetDigest,
  }))
  const directory = await withBudgetDeadline(listStableContextDirectory(filesystem, root.path), budget)
  if (directory === undefined) {
    return { source: root.source, rank: root.rank, rootIdentityDigest, state: 'ABSENT', entries: [] }
  }
  if (directory.target.targetKey !== declaredTarget.targetKey) {
    throw new DshContextFileSystemObservationError('Context filesystem root identity changed')
  }
  const result: RootEntry[] = []
  for (const entry of directory.entries) {
    budget.observeRootEntry()
    if (root.skipSystem === true && entry.name === '.system') continue
    const path = join(root.path, entry.name)
    const lexical = await withBudgetDeadline(filesystem.lstat(path), budget)
    if (lexical === undefined) throw new DshContextFileSystemObservationError('Context filesystem root entry disappeared')
    if (lexical.type === 'symlink') throw new DshContextFileSystemObservationError('Context filesystem root entry is a link')
    const layout = lexical.type === 'directory'
      ? 'BUNDLE' as const
      : lexical.type === 'file' && entry.name.endsWith('.md') ? 'FLAT' as const : undefined
    if (layout === undefined) continue
    const candidate = await withBudgetDeadline(readStableContextFile(
      filesystem,
      layout === 'BUNDLE' ? join(path, 'SKILL.md') : path,
      { maxBytes: budget.maxReadBytes(), containWithin: directory.target },
    ), budget)
    if (candidate === undefined) continue
    budget.observeCandidate()
    budget.observeBytes(candidate.bytes.byteLength)
    const contentDigest = createHash('sha256').update(candidate.bytes).digest('hex')
    result.push({ source: root.source, rank: root.rank, rootIdentityDigest, name: entry.name, layout, contentDigest })
  }
  budget.assertTime()
  result.sort((left, right) => left.name.localeCompare(right.name) || left.layout.localeCompare(right.layout))
  return {
    source: root.source,
    rank: root.rank,
    rootIdentityDigest,
    state: 'DIRECTORY',
    resolvedIdentityDigest: targetDigest,
    entries: result,
  }
}

function validDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value)
}

/** Captures the path-free ownership baseline for one exact Session lifecycle. */
export class DshV2RootManifestAdapter {
  readonly #initialEnvironment: Readonly<Record<string, string | undefined>>
  readonly #currentEnvironment: () => Readonly<Record<string, string | undefined>>
  readonly #homeDirectory: () => string
  readonly #now: () => number
  readonly #policy: RootManifestPolicy

  constructor(private readonly options: DshV2RootManifestAdapterOptions) {
    const environment = options.environment ?? process.env
    this.#initialEnvironment = { ...environment }
    this.#currentEnvironment = options.currentEnvironment
      ?? (options.environment === undefined ? () => process.env : () => environment)
    this.#homeDirectory = options.homeDirectory ?? homedir
    this.#now = options.now ?? Date.now
    this.#policy = { ...DEFAULT_ROOT_MANIFEST_POLICY, ...options.internalPolicy }
    if (!Object.values(this.#policy).every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new TypeError('Invalid v2 root manifest policy')
    }
  }

  async capture(sessionLifecycleKey: string): Promise<SessionBatchV2['batchManifestBaseline']> {
    const observedAt = new Date(this.#now()).toISOString()
    const unavailable = { observedAt, rootManifestDigest: EMPTY_DIGEST, runtimeCatalogDigest: EMPTY_DIGEST, complete: false }
    try {
      const budget = new RootManifestBudget(this.#policy)
      const session = this.options.resolveSession(sessionLifecycleKey)
      if (session === undefined) return unavailable
      const filesystem = session.configuration.usesContextFileSystem === true
        ? parseDshContextFileSystem(session.filesystem)
        : undefined
      if (session.configuration.usesContextFileSystem === true && filesystem === undefined) return unavailable
      const first = await this.#rootManifest(session.cwd, session.configuration, budget, filesystem)
      let runtime: Awaited<ReturnType<DshV2RuntimeCatalogManifestPort['observeRuntimeCatalog']>>
      let ownershipCandidates: SessionBatchV2['batchManifestBaseline']['ownershipCandidates']
      if (this.options.runtimeCatalog.observeOwnershipCatalog === undefined) {
        runtime = await withBudgetDeadline(
          this.options.runtimeCatalog.observeRuntimeCatalog(sessionLifecycleKey),
          budget,
        )
      } else {
        const detailed = await withBudgetDeadline(
          this.options.runtimeCatalog.observeOwnershipCatalog(sessionLifecycleKey),
          budget,
        )
        runtime = detailed
        ownershipCandidates = [...detailed.candidates]
      }
      const second = await this.#rootManifest(session.cwd, session.configuration, budget, filesystem)
      if (
        first === undefined
        || second === undefined
        || first !== second
        || !runtime.complete
        || !validDigest(runtime.runtimeCatalogDigest)
      ) return { ...unavailable, runtimeCatalogDigest: validDigest(runtime.runtimeCatalogDigest) ? runtime.runtimeCatalogDigest : EMPTY_DIGEST }
      return {
        observedAt,
        rootManifestDigest: first,
        runtimeCatalogDigest: runtime.runtimeCatalogDigest,
        complete: true,
        ...(ownershipCandidates === undefined ? {} : { ownershipCandidates }),
      }
    } catch {
      return unavailable
    }
  }

  async #rootManifest(
    cwd: string | undefined,
    configuration: StockSkillRuntimeConfiguration,
    budget: RootManifestBudget,
    filesystem: DshContextFileSystemPort | undefined,
  ): Promise<string | undefined> {
    if (
      configuration.profile !== 'web'
      || configuration.presetId !== 'standard'
      || configuration.providerName.trim().length === 0
      || (configuration.usesContextFileSystem === true && filesystem === undefined)
    ) return undefined
    const home = this.#homeDirectory()
    const current = this.#currentEnvironment()
    if (
      configuration.configuredDshHome === undefined
      && resolveDshHomeCompatible(undefined, current.DSH_HOME, home)
        !== resolveDshHomeCompatible(undefined, this.#initialEnvironment.DSH_HOME, home)
    ) return undefined
    if (
      configuration.configuredAgentsHome === undefined
      && current.DSH_AGENTS_HOME !== this.#initialEnvironment.DSH_AGENTS_HOME
    ) return undefined
    if (
      configuration.configuredBundledSkillDir === undefined
      && current.DSH_BUNDLED_SKILL_DIR !== this.#initialEnvironment.DSH_BUNDLED_SKILL_DIR
    ) return undefined
    const roots: EffectiveRoot[] = []
    if (configuration.includeDefaultRoots && cwd !== undefined) {
      const project = filesystem === undefined
        ? await projectRoot(cwd, budget)
        : await contextProjectRoot(filesystem, cwd, budget)
      roots.push(
        { path: join(project, '.dsh', 'skills'), source: 'project-dsh', rank: 100 },
        { path: join(project, '.agents', 'skills'), source: 'project-agents', rank: 200 },
      )
    }
    roots.push(...configuration.customSkillDirs.map(path => ({ path: resolve(path), source: 'custom' as const, rank: 300 as const })))
    if (configuration.includeDefaultRoots) {
      const dshHome = resolveDshHomeCompatible(
        configuration.configuredDshHome,
        this.#initialEnvironment.DSH_HOME,
        home,
      )
      const agentsHome = configuration.configuredAgentsHome
        ?? this.#initialEnvironment.DSH_AGENTS_HOME
        ?? join(home, '.agents')
      roots.push(
        { path: join(dshHome, 'skills'), source: 'user-dsh', rank: 400, skipSystem: true },
        { path: join(resolve(agentsHome), 'skills'), source: 'user-agents', rank: 500 },
      )
    }
    const bundled = configuration.configuredBundledSkillDir
      ?? (configuration.includeDefaultRoots ? this.#initialEnvironment.DSH_BUNDLED_SKILL_DIR : undefined)
    if (bundled !== undefined) roots.push({ path: resolve(bundled), source: 'bundled', rank: 600 })
    const scans: ScannedRoot[] = []
    for (const root of roots) scans.push(filesystem === undefined
      ? await scanRoot(root, budget)
      : await scanContextRoot(filesystem, root, budget))
    return sha256Utf8(canonicalJson({
      policyVersion: filesystem === undefined
        ? ROOT_MANIFEST_POLICY_VERSION
        : CONTEXT_ROOT_MANIFEST_POLICY_VERSION,
      providerName: configuration.providerName,
      includeDefaultRoots: configuration.includeDefaultRoots,
      roots: scans.map(scan => ({
        source: scan.source,
        rank: scan.rank,
        rootIdentityDigest: scan.rootIdentityDigest,
        state: scan.state,
        ...(scan.resolvedIdentityDigest === undefined ? {} : { resolvedIdentityDigest: scan.resolvedIdentityDigest }),
      })),
      entries: scans.flatMap(scan => scan.entries),
    }))
  }
}
