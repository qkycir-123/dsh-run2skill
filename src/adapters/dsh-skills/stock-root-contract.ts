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

export interface StockSkillRuntimeConfiguration {
  readonly profile: string
  readonly presetId?: string | undefined
  readonly providerName: string
  readonly includeDefaultRoots: boolean
  readonly customSkillDirs: readonly string[]
  readonly configuredDshHome?: string | undefined
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
    readonly resolutionKind: 'ENVIRONMENT' | 'DEFAULT'
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
    readonly resolutionKind: 'ENVIRONMENT' | 'DEFAULT'
    readonly canonicalPath: string
    readonly identityDigest: string
  }

export interface StockDshRootContractResolverOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly homeDirectory?: () => string
}

export interface StockPresetSessionProjection {
  readonly header: { readonly agentPreset?: string | undefined }
  readonly events?: readonly { readonly type: string; readonly data?: unknown }[] | undefined
}

/** Mirrors stock DSH's last-selected preset rule without importing its runtime. */
export function resolveStockSessionPreset(session: StockPresetSessionProjection): string | undefined {
  const events = session.events ?? []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'agent-preset/selected') continue
    if (typeof event.data !== 'object' || event.data === null) return undefined
    const selected = Reflect.get(event.data, 'agentPreset')
    return typeof selected === 'string' && selected.length > 0 ? selected : undefined
  }
  return session.header.agentPreset
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
    && configuration.configuredDshHome === undefined
}

export class StockDshRootContractResolver {
  readonly #environment: Readonly<Record<string, string | undefined>>
  readonly #homeDirectory: () => string

  constructor(options: StockDshRootContractResolverOptions = {}) {
    this.#environment = options.environment ?? process.env
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
    const environmentHome = this.#environment.DSH_HOME
    const selected = environmentHome !== undefined && environmentHome.trim().length > 0
      ? environmentHome
      : join(this.#homeDirectory(), '.dsh')
    const declaredPath = resolve(expandHomePath(selected, this.#homeDirectory()))
    return {
      ...common,
      expectedSource: 'user-dsh',
      declaredRootPath: join(declaredPath, 'skills'),
      dshHome: {
        resolutionKind: environmentHome !== undefined && environmentHome.trim().length > 0
          ? 'ENVIRONMENT'
          : 'DEFAULT',
        declaredPath,
      },
    }
  }
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
