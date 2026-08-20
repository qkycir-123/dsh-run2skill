import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import {
  ROOT_CONTRACT_VERSION_V2,
  ROOT_RESOLVER_VERSION_V2,
} from '../../domain/review/schemas.js'

export const STOCK_DSH_BASELINE_COMMIT = '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca'
export const STOCK_ROOT_CONTRACT_VERSION = ROOT_CONTRACT_VERSION_V2
export const STOCK_ROOT_RESOLVER_VERSION = ROOT_RESOLVER_VERSION_V2

const SUPPORTED_PRESETS = new Set(['standard', 'code'])
export const STOCK_PRESET_COMPOSITION_DIGESTS = Object.freeze({
  standard: '4edeb70bf995a0324f234e2adf8db6b394c3d26e1bcb76821976950fb0237bc9',
  code: 'dbab55b31753028956e700223420b586476313045f8527d07ed1e080df223718',
})

export interface StockSkillRuntimeConfiguration {
  readonly profile: string
  readonly presetId?: string | undefined
  readonly providerName: string
  readonly includeDefaultRoots: boolean
  readonly customSkillDirs: readonly string[]
  readonly configuredDshHome?: string | undefined
}

interface StockFiberProjection {
  readonly parent: { readonly fiber: StockFiberProjection }
  readonly config: unknown
}

interface StockPluginRuntimeProjection {
  readonly name?: string | undefined
  readonly fibers: Iterable<StockFiberProjection>
}

export interface StockPresetMountProjection {
  readonly presetId: string
  readonly fiber: StockFiberProjection
}

export interface StockPresetMountPort {
  standingMountFor(
    agentContext: object,
  ): StockPresetMountProjection | undefined | Promise<StockPresetMountProjection | undefined>
}

export interface StockComposedAgentProjection {
  readonly ctx: {
    readonly registry: { values(): Iterable<StockPluginRuntimeProjection> }
  }
}

export interface StockAgentPresetObservationPort {
  composedPreset(agentContext: object): string | undefined
  resolve(id: string): Promise<{ readonly id: string; readonly trust: 'system' | 'user' }>
  read(id: string): Promise<string>
}

export async function resolvePinnedStockPresetConfiguration(
  presets: StockAgentPresetObservationPort,
  agent: { readonly ctx: object },
  expectedDigests: Readonly<Record<'standard' | 'code', string>> = STOCK_PRESET_COMPOSITION_DIGESTS,
): Promise<StockSkillRuntimeConfiguration | undefined> {
  const presetId = presets.composedPreset(agent.ctx)
  if (presetId !== 'standard' && presetId !== 'code') return undefined
  try {
    const preset = await presets.resolve(presetId)
    if (preset.id !== presetId || preset.trust !== 'system') return undefined
    const content = await presets.read(presetId)
    if (sha256Utf8(content) !== expectedDigests[presetId]) return undefined
    return {
      profile: 'web',
      presetId,
      providerName: 'filesystem',
      includeDefaultRoots: true,
      customSkillDirs: [],
    }
  } catch {
    return undefined
  }
}

export class StockSkillRuntimeConfigurationCache<TAgent extends object> {
  readonly #entries = new WeakMap<TAgent, StockSkillRuntimeConfiguration>()

  constructor(
    private readonly observe: (
      agent: TAgent,
    ) => Promise<StockSkillRuntimeConfiguration | undefined>,
  ) {}

  async capture(agent: TAgent): Promise<StockSkillRuntimeConfiguration | undefined> {
    const observed = await this.observe(agent)
    if (observed === undefined) {
      this.#entries.delete(agent)
      return undefined
    }
    const snapshot = Object.freeze({
      ...observed,
      customSkillDirs: Object.freeze([...observed.customSkillDirs]),
    })
    this.#entries.set(agent, snapshot)
    return snapshot
  }

  get(agent: TAgent): StockSkillRuntimeConfiguration | undefined {
    return this.#entries.get(agent)
  }

  release(agent: TAgent): void {
    this.#entries.delete(agent)
  }
}

export interface StockWorkspaceContractBinding {
  readonly workspaceId: string
  readonly canonicalPath: string
}

export type StockRootContractResolution = {
  readonly status: 'SUPPORTED'
  readonly baselineCommit: typeof STOCK_DSH_BASELINE_COMMIT
  readonly profile: 'web'
  readonly presetId: 'standard' | 'code'
  readonly expectedProvider: 'filesystem'
  readonly expectedSource: 'project-dsh' | 'user-dsh'
  readonly resolverVersion: typeof STOCK_ROOT_RESOLVER_VERSION
  readonly rootContractVersion: typeof STOCK_ROOT_CONTRACT_VERSION
  readonly configurationDigest: string
  readonly declaredRootPath: string
  readonly dshHome?: {
    readonly resolutionKind: 'CONFIGURATION' | 'ENVIRONMENT' | 'DEFAULT'
    readonly declaredPath: string
  } | undefined
}

export type StockRootContractResult = StockRootContractResolution | {
  readonly status: 'UNSUPPORTED'
  readonly code: 'ROOT_CONTRACT_UNSUPPORTED' | 'WORKSPACE_BINDING_UNAVAILABLE'
}

export type StockRootScopeIdentity =
  | {
    readonly kind: 'WORKSPACE'
    readonly workspaceId: string
    readonly canonicalPath: string
  }
  | {
    readonly kind: 'DSH_HOME'
    readonly resolutionKind: 'CONFIGURATION' | 'ENVIRONMENT' | 'DEFAULT'
    readonly canonicalPath: string
    readonly identityDigest: string
  }

export interface StockDshRootContractResolverOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly currentEnvironment?: () => Readonly<Record<string, string | undefined>>
  readonly homeDirectory?: () => string
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWithinFiber(candidate: StockFiberProjection, root: StockFiberProjection): boolean {
  let current = candidate
  while (true) {
    if (current === root) return true
    const parent = current.parent.fiber
    if (parent === current) return false
    current = parent
  }
}

/** Reads the exact stock filesystem fiber mounted for one Agent's joined generation. */
export async function resolveStockSkillRuntimeConfiguration(
  mounts: StockPresetMountPort,
  agent: StockComposedAgentProjection,
): Promise<StockSkillRuntimeConfiguration | undefined> {
  const mount = await mounts.standingMountFor(agent.ctx)
  if (mount === undefined) return undefined
  const fibers = [...agent.ctx.registry.values()]
    .filter(runtime => runtime.name === 'skill-filesystem')
    .flatMap(runtime => [...runtime.fibers])
    .filter(fiber => isWithinFiber(fiber, mount.fiber))
  if (fibers.length !== 1) return undefined
  const raw = fibers[0]!.config
  if (raw !== undefined && !isRecord(raw)) return undefined
  const config = raw ?? {}
  const providerName = config.providerName ?? 'filesystem'
  const includeDefaultRoots = config.includeDefaultRoots ?? true
  const customSkillDirs = config.customSkillDirs ?? []
  const configuredDshHome = config.dshHome
  if (
    typeof providerName !== 'string'
    || typeof includeDefaultRoots !== 'boolean'
    || !Array.isArray(customSkillDirs)
    || !customSkillDirs.every(value => typeof value === 'string')
    || (configuredDshHome !== undefined && typeof configuredDshHome !== 'string')
  ) return undefined
  return {
    profile: 'web',
    presetId: mount.presetId,
    providerName,
    includeDefaultRoots,
    customSkillDirs: [...customSkillDirs],
    ...(configuredDshHome === undefined ? {} : { configuredDshHome }),
  }
}

function expandHomePath(value: string, homeDirectory: string): string {
  if (value === '~') return homeDirectory
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homeDirectory, value.slice(2))
  }
  return value
}

function canonicalConfiguration(configuration: StockSkillRuntimeConfiguration) {
  return {
    baselineCommit: STOCK_DSH_BASELINE_COMMIT,
    profile: configuration.profile,
    presetId: configuration.presetId ?? null,
    providerName: configuration.providerName,
    includeDefaultRoots: configuration.includeDefaultRoots,
    customSkillDirs: [...configuration.customSkillDirs],
    configuredDshHome: configuration.configuredDshHome ?? null,
  }
}

function supportedConfiguration(
  configuration: StockSkillRuntimeConfiguration,
): configuration is StockSkillRuntimeConfiguration & { readonly presetId: 'standard' | 'code' } {
  return configuration.profile === 'web'
    && configuration.presetId !== undefined
    && SUPPORTED_PRESETS.has(configuration.presetId)
    && configuration.providerName === 'filesystem'
    && configuration.includeDefaultRoots
    && configuration.customSkillDirs.length === 0
}

export class StockDshRootContractResolver {
  readonly #environment: Readonly<Record<string, string | undefined>>
  readonly #currentEnvironment: () => Readonly<Record<string, string | undefined>>
  readonly #homeDirectory: () => string

  constructor(options: StockDshRootContractResolverOptions = {}) {
    const environment = options.environment ?? process.env
    this.#environment = { ...environment }
    this.#currentEnvironment = options.currentEnvironment
      ?? (options.environment === undefined ? () => process.env : () => environment)
    this.#homeDirectory = options.homeDirectory ?? homedir
  }

  resolve(input: {
    readonly scope: 'PROJECT' | 'USER'
    readonly configuration: StockSkillRuntimeConfiguration
    readonly workspaceBinding?: StockWorkspaceContractBinding | undefined
  }): StockRootContractResult {
    if (!supportedConfiguration(input.configuration)) {
      return { status: 'UNSUPPORTED', code: 'ROOT_CONTRACT_UNSUPPORTED' }
    }
    const common = {
      status: 'SUPPORTED' as const,
      baselineCommit: STOCK_DSH_BASELINE_COMMIT,
      profile: 'web' as const,
      presetId: input.configuration.presetId,
      expectedProvider: 'filesystem' as const,
      resolverVersion: STOCK_ROOT_RESOLVER_VERSION,
      rootContractVersion: STOCK_ROOT_CONTRACT_VERSION,
      configurationDigest: sha256Utf8(canonicalJson(canonicalConfiguration(input.configuration))),
    } as const
    if (input.scope === 'PROJECT') {
      if (input.workspaceBinding === undefined) {
        return { status: 'UNSUPPORTED', code: 'WORKSPACE_BINDING_UNAVAILABLE' }
      }
      return {
        ...common,
        expectedSource: 'project-dsh',
        declaredRootPath: join(input.workspaceBinding.canonicalPath, '.dsh', 'skills'),
      }
    }
    const configuredHome = input.configuration.configuredDshHome
    const environmentHome = this.#environment.DSH_HOME
    if (
      configuredHome === undefined
      && !sameResolvedDshHome(
        environmentHome,
        this.#currentEnvironment().DSH_HOME,
        this.#homeDirectory(),
      )
    ) return { status: 'UNSUPPORTED', code: 'ROOT_CONTRACT_UNSUPPORTED' }
    const selected = configuredHome
      ?? (environmentHome !== undefined && environmentHome.trim().length > 0
        ? environmentHome
        : join(this.#homeDirectory(), '.dsh'))
    const declaredPath = resolve(expandHomePath(selected, this.#homeDirectory()))
    return {
      ...common,
      expectedSource: 'user-dsh',
      declaredRootPath: join(declaredPath, 'skills'),
      dshHome: {
        resolutionKind: configuredHome !== undefined
          ? 'CONFIGURATION'
          : environmentHome !== undefined && environmentHome.trim().length > 0
            ? 'ENVIRONMENT'
            : 'DEFAULT',
        declaredPath,
      },
    }
  }
}

function sameResolvedDshHome(
  left: string | undefined,
  right: string | undefined,
  homeDirectory: string,
): boolean {
  const fallback = join(homeDirectory, '.dsh')
  const resolveEnvironmentHome = (value: string | undefined) => resolve(expandHomePath(
    value !== undefined && value.trim().length > 0 ? value : fallback,
    homeDirectory,
  ))
  const a = resolveEnvironmentHome(left)
  const b = resolveEnvironmentHome(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

export function deriveStockResolutionContractDigest(
  resolution: StockRootContractResolution,
  scopeIdentity: StockRootScopeIdentity,
): string {
  return sha256Utf8(canonicalJson({
    baselineCommit: resolution.baselineCommit,
    profile: resolution.profile,
    presetId: resolution.presetId,
    expectedProvider: resolution.expectedProvider,
    expectedSource: resolution.expectedSource,
    resolverVersion: resolution.resolverVersion,
    rootContractVersion: resolution.rootContractVersion,
    configurationDigest: resolution.configurationDigest,
    declaredRootPath: resolution.declaredRootPath,
    scopeIdentity,
  }))
}
