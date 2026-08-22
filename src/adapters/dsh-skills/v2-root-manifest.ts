import { access, readFile, readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import type { SessionBatchV2 } from '../../domain/v2/index.js'
import type { StockSkillRuntimeConfiguration } from './stock-root-contract.js'

const EMPTY_DIGEST = sha256Utf8(canonicalJson([]))
const ROOT_MANIFEST_POLICY_VERSION = 'effective-filesystem-root-set-v1'

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

export interface DshV2RuntimeCatalogManifestPort {
  observeRuntimeCatalog(sessionLifecycleKey: string): Promise<{
    readonly complete: boolean
    readonly runtimeCatalogDigest: string
  }>
}

export interface DshV2RootManifestAdapterOptions {
  readonly resolveSession: (sessionLifecycleKey: string) => {
    readonly cwd?: string | undefined
    readonly configuration: StockSkillRuntimeConfiguration
  } | undefined
  readonly runtimeCatalog: DshV2RuntimeCatalogManifestPort
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly currentEnvironment?: () => Readonly<Record<string, string | undefined>>
  readonly homeDirectory?: () => string
  readonly now?: () => number
}

function absent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function canonicalPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

async function projectRoot(cwd: string): Promise<string> {
  const initial = resolve(cwd)
  let current = initial
  while (true) {
    try {
      await access(join(current, '.git'))
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) return initial
      current = parent
    }
  }
}

async function readCandidate(path: string): Promise<string | undefined> {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex')
  } catch (error) {
    if (absent(error)) return undefined
    throw error
  }
}

async function scanRoot(root: EffectiveRoot): Promise<readonly RootEntry[]> {
  let entries
  try {
    entries = await readdir(root.path, { withFileTypes: true, encoding: 'utf8' })
  } catch (error) {
    if (absent(error)) return []
    throw error
  }
  const rootIdentityDigest = sha256Utf8(canonicalJson({
    policyVersion: ROOT_MANIFEST_POLICY_VERSION,
    source: root.source,
    rank: root.rank,
    path: canonicalPath(root.path),
  }))
  const result: RootEntry[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (root.skipSystem === true && entry.name === '.system') continue
    const path = join(root.path, entry.name)
    let kind: 'directory' | 'file' | undefined
    if (entry.isDirectory()) kind = 'directory'
    else if (entry.isFile()) kind = 'file'
    else if (entry.isSymbolicLink()) {
      try {
        const target = await stat(path)
        if (target.isDirectory()) kind = 'directory'
        else if (target.isFile()) kind = 'file'
      } catch (error) {
        if (!absent(error)) throw error
      }
    }
    const layout = kind === 'directory' ? 'BUNDLE' : kind === 'file' && entry.name.endsWith('.md') ? 'FLAT' : undefined
    if (layout === undefined) continue
    const contentDigest = await readCandidate(layout === 'BUNDLE' ? join(path, 'SKILL.md') : path)
    if (contentDigest === undefined) continue
    result.push({ source: root.source, rank: root.rank, rootIdentityDigest, name: entry.name, layout, contentDigest })
  }
  return result
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

  constructor(private readonly options: DshV2RootManifestAdapterOptions) {
    const environment = options.environment ?? process.env
    this.#initialEnvironment = { ...environment }
    this.#currentEnvironment = options.currentEnvironment
      ?? (options.environment === undefined ? () => process.env : () => environment)
    this.#homeDirectory = options.homeDirectory ?? homedir
    this.#now = options.now ?? Date.now
  }

  async capture(sessionLifecycleKey: string): Promise<SessionBatchV2['batchManifestBaseline']> {
    const observedAt = new Date(this.#now()).toISOString()
    const unavailable = { observedAt, rootManifestDigest: EMPTY_DIGEST, runtimeCatalogDigest: EMPTY_DIGEST, complete: false }
    try {
      const session = this.options.resolveSession(sessionLifecycleKey)
      if (session === undefined) return unavailable
      const first = await this.#rootManifest(session.cwd, session.configuration)
      const runtime = await this.options.runtimeCatalog.observeRuntimeCatalog(sessionLifecycleKey)
      const second = await this.#rootManifest(session.cwd, session.configuration)
      if (
        first === undefined
        || second === undefined
        || first !== second
        || !runtime.complete
        || !validDigest(runtime.runtimeCatalogDigest)
      ) return { ...unavailable, runtimeCatalogDigest: validDigest(runtime.runtimeCatalogDigest) ? runtime.runtimeCatalogDigest : EMPTY_DIGEST }
      return { observedAt, rootManifestDigest: first, runtimeCatalogDigest: runtime.runtimeCatalogDigest, complete: true }
    } catch {
      return unavailable
    }
  }

  async #rootManifest(cwd: string | undefined, configuration: StockSkillRuntimeConfiguration): Promise<string | undefined> {
    if (
      configuration.profile !== 'web'
      || (configuration.presetId !== 'standard' && configuration.presetId !== 'code')
      || configuration.providerName.trim().length === 0
      || configuration.usesContextFileSystem === true
    ) return undefined
    const current = this.#currentEnvironment()
    for (const key of ['DSH_HOME', 'DSH_AGENTS_HOME', 'DSH_BUNDLED_SKILL_DIR'] as const) {
      const configured = key === 'DSH_HOME'
        ? configuration.configuredDshHome
        : key === 'DSH_AGENTS_HOME'
          ? configuration.configuredAgentsHome
          : configuration.configuredBundledSkillDir
      if (configured === undefined && current[key] !== this.#initialEnvironment[key]) return undefined
    }
    const home = this.#homeDirectory()
    const roots: EffectiveRoot[] = []
    if (configuration.includeDefaultRoots && cwd !== undefined) {
      const project = await projectRoot(cwd)
      roots.push(
        { path: join(project, '.dsh', 'skills'), source: 'project-dsh', rank: 100 },
        { path: join(project, '.agents', 'skills'), source: 'project-agents', rank: 200 },
      )
    }
    roots.push(...configuration.customSkillDirs.map(path => ({ path: resolve(path), source: 'custom' as const, rank: 300 as const })))
    if (configuration.includeDefaultRoots) {
      const dshHome = configuration.configuredDshHome
        ?? this.#initialEnvironment.DSH_HOME
        ?? join(home, '.dsh')
      const agentsHome = configuration.configuredAgentsHome
        ?? this.#initialEnvironment.DSH_AGENTS_HOME
        ?? join(home, '.agents')
      roots.push(
        { path: join(resolve(dshHome), 'skills'), source: 'user-dsh', rank: 400, skipSystem: true },
        { path: join(resolve(agentsHome), 'skills'), source: 'user-agents', rank: 500 },
      )
    }
    const bundled = configuration.configuredBundledSkillDir
      ?? (configuration.includeDefaultRoots ? this.#initialEnvironment.DSH_BUNDLED_SKILL_DIR : undefined)
    if (bundled !== undefined) roots.push({ path: resolve(bundled), source: 'bundled', rank: 600 })
    const entries = (await Promise.all(roots.map(scanRoot))).flat()
    return sha256Utf8(canonicalJson({
      policyVersion: ROOT_MANIFEST_POLICY_VERSION,
      providerName: configuration.providerName,
      includeDefaultRoots: configuration.includeDefaultRoots,
      roots: roots.map(root => ({
        source: root.source,
        rank: root.rank,
        identityDigest: sha256Utf8(canonicalJson({ source: root.source, rank: root.rank, path: canonicalPath(root.path) })),
      })),
      entries,
    }))
  }
}
