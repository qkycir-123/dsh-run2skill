import { access } from 'node:fs/promises'
import { basename, dirname, join, normalize, resolve } from 'node:path'
import type { V2ProposalPublicationInput } from '../../application/publication/index.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import { RootBindingV2Schema } from '../../domain/review/index.js'
import { deriveProjectScopeIdentityDigest } from '../../domain/purge/index.js'
import {
  parseWritableDshContextFileSystem,
  type DshContextFileSystemTarget,
  type DshWritableContextFileSystemPort,
} from '../dsh-filesystem/context-filesystem.js'
import {
  StockDshRootContractResolver,
  deriveStockResolutionContractDigest,
  type StockSkillRuntimeConfiguration,
  type StockWorkspaceContractBinding,
} from '../dsh-skills/stock-root-contract.js'
import { observePublicationRoot } from './filesystem-cas.mjs'
import type {
  V2DshPublicationBindingPort,
  V2DshPublicationBindingResult,
} from './v2-proposal-filesystem.js'

export interface V2StockPublicationSession<TView extends object> {
  readonly sessionId?: string
  readonly view: TView
  readonly configuration: StockSkillRuntimeConfiguration
  readonly workspaceBinding?: StockWorkspaceContractBinding | undefined
  readonly filesystem?: unknown
}

export interface DshV2StockPublicationBindingOptions<TView extends object> {
  readonly resolveSession: (
    sessionLifecycleKey: string,
  ) => V2StockPublicationSession<TView> | undefined
  readonly rootResolver?: StockDshRootContractResolver
}

function samePath(left: string, right: string): boolean {
  const a = normalize(resolve(left))
  const b = normalize(resolve(right))
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

async function findStockProjectRoot(cwd: string): Promise<string> {
  const fallback = resolve(cwd)
  let current = fallback
  while (true) {
    try {
      await access(join(current, '.git'))
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) return fallback
      current = parent
    }
  }
}

function validTarget(value: unknown): value is DshContextFileSystemTarget {
  return typeof value === 'object' && value !== null
    && 'targetKey' in value && typeof value.targetKey === 'string' && value.targetKey.length > 0
    && 'displayPath' in value && typeof value.displayPath === 'string' && value.displayPath.length > 0
}

function validDirectoryInfo(value: unknown): value is { readonly version: string, readonly type: 'directory' } {
  return typeof value === 'object' && value !== null
    && 'version' in value && typeof value.version === 'string' && value.version.length > 0
    && 'type' in value && value.type === 'directory'
    && (!('size' in value) || value.size === undefined
      || (typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0))
}

async function findContextProjectRoot(
  filesystem: DshWritableContextFileSystemPort,
  cwd: string,
): Promise<string> {
  const fallback = cwd
  let current = fallback
  while (true) {
    const marker = await filesystem.lstat(join(current, '.git'))
    if (marker !== undefined) {
      if (typeof marker !== 'object' || marker === null
        || typeof marker.version !== 'string' || marker.version.length === 0
        || (marker.type !== 'file' && marker.type !== 'directory')) {
        throw new Error('Invalid context filesystem project marker')
      }
      return current
    }
    const parent = dirname(current)
    if (parent === current) return fallback
    current = parent
  }
}

type ContextRootObservation =
  | {
      readonly status: 'EXISTING'
      readonly target: DshContextFileSystemTarget
      readonly canonicalRootPath: string
      readonly rootIdentityDigest: string
    }
  | {
      readonly status: 'ABSENT'
      readonly target: DshContextFileSystemTarget
      readonly canonicalExistingAncestorPath: string
      readonly ancestorIdentityDigest: string
      readonly missingSegments: readonly string[]
    }

async function observeContextRoot(
  filesystem: DshWritableContextFileSystemPort,
  declaredPath: string,
): Promise<ContextRootObservation> {
  const target = await filesystem.resolve(declaredPath)
  if (!validTarget(target)) throw new Error('Invalid context filesystem root target')
  const missingSegments: string[] = []
  let current = declaredPath
  while (true) {
    const lexicalBefore = await filesystem.lstat(current)
    if (lexicalBefore === undefined) {
      const parent = dirname(current)
      if (parent === current || missingSegments.length === 2) {
        throw new Error('Context filesystem root has no approved ancestor')
      }
      missingSegments.unshift(basename(current))
      current = parent
      continue
    }
    if (!validDirectoryInfo(lexicalBefore)) {
      throw new Error('Context filesystem root path is not a regular directory')
    }
    const ancestor = await filesystem.resolve(current)
    if (!validTarget(ancestor) || !filesystem.contains(ancestor, target)) {
      throw new Error('Context filesystem root escaped its observed ancestor')
    }
    const statBefore = await filesystem.stat(ancestor)
    let missingPath = current
    for (const segment of missingSegments) {
      missingPath = join(missingPath, segment)
      if (await filesystem.lstat(missingPath) !== undefined) {
        throw new Error('Context filesystem root changed during observation')
      }
    }
    const statAfter = await filesystem.stat(ancestor)
    const lexicalAfter = await filesystem.lstat(current)
    if (!validDirectoryInfo(statBefore) || !validDirectoryInfo(statAfter)
      || !validDirectoryInfo(lexicalAfter)
      || statBefore.version !== lexicalBefore.version
      || statAfter.version !== statBefore.version
      || lexicalAfter.version !== lexicalBefore.version) {
      throw new Error('Context filesystem root changed during observation')
    }
    const identityDigest = sha256Utf8(ancestor.targetKey)
    return missingSegments.length === 0
      ? {
          status: 'EXISTING',
          target,
          canonicalRootPath: ancestor.displayPath,
          rootIdentityDigest: identityDigest,
        }
      : {
          status: 'ABSENT',
          target,
          canonicalExistingAncestorPath: ancestor.displayPath,
          ancestorIdentityDigest: identityDigest,
          missingSegments,
        }
  }
}

/** Resolves only the pinned stock PROJECT/USER filesystem publication roots. */
export class DshV2StockPublicationBindingResolver<TView extends object>
implements V2DshPublicationBindingPort<TView> {
  readonly #rootResolver: StockDshRootContractResolver

  constructor(private readonly options: DshV2StockPublicationBindingOptions<TView>) {
    this.#rootResolver = options.rootResolver ?? new StockDshRootContractResolver()
  }

  async resolve(input: V2ProposalPublicationInput): Promise<V2DshPublicationBindingResult<TView>> {
    if (
      input.intent.sessionLifecycleKey !== input.batch.sessionLifecycleKey
      || input.batch.sessionLifecycleKey.length === 0
    ) return { status: 'STALE' }
    const session = this.options.resolveSession(input.batch.sessionLifecycleKey)
    if (session === undefined) return { status: 'UNAVAILABLE' }
    const usesContextFileSystem = session.configuration.usesContextFileSystem === true
    const contextFileSystem = usesContextFileSystem
      ? parseWritableDshContextFileSystem(session.filesystem)
      : undefined
    if (usesContextFileSystem && contextFileSystem === undefined) return { status: 'UNAVAILABLE' }
    const scope = input.lineage.persistenceScope
    let workspaceBinding = session.workspaceBinding
    if (scope === 'PROJECT') {
      if (workspaceBinding === undefined) return { status: 'STALE' }
      const approved = input.proposal.projectScopeBinding
      if (
        approved === undefined
        || approved.workspaceId !== workspaceBinding.workspaceId
        || approved.scopeIdentityDigest !== deriveProjectScopeIdentityDigest(workspaceBinding.canonicalPath)
      ) return { status: 'STALE' }
      try {
        workspaceBinding = {
          ...workspaceBinding,
          canonicalPath: contextFileSystem === undefined
            ? await findStockProjectRoot(workspaceBinding.canonicalPath)
            : await findContextProjectRoot(contextFileSystem, workspaceBinding.canonicalPath),
        }
      } catch {
        return { status: 'UNAVAILABLE' }
      }
    }
    const resolution = this.#rootResolver.resolve({
      scope,
      configuration: session.configuration,
      ...(scope === 'PROJECT' ? { workspaceBinding } : {}),
    })
    if (resolution.status !== 'SUPPORTED') return { status: 'STALE' }

    let resolutionContractDigest: string
    if (scope === 'PROJECT') {
      if (workspaceBinding === undefined) return { status: 'STALE' }
      resolutionContractDigest = deriveStockResolutionContractDigest(resolution, {
        kind: 'WORKSPACE',
        workspaceId: workspaceBinding.workspaceId,
        canonicalPath: workspaceBinding.canonicalPath,
      })
    } else {
      if (resolution.dshHome === undefined) return { status: 'STALE' }
      let home
      try {
        home = contextFileSystem === undefined
          ? await observePublicationRoot(resolution.dshHome.declaredPath)
          : await observeContextRoot(contextFileSystem, resolution.dshHome.declaredPath)
      } catch {
        return { status: 'UNAVAILABLE' }
      }
      if (
        home.status !== 'EXISTING'
        || !samePath(home.canonicalRootPath, resolution.dshHome.declaredPath)
      ) return { status: 'STALE' }
      resolutionContractDigest = deriveStockResolutionContractDigest(resolution, {
        kind: 'DSH_HOME',
        resolutionKind: resolution.dshHome.resolutionKind,
        canonicalPath: home.canonicalRootPath,
        identityDigest: home.rootIdentityDigest,
      })
    }

    let observed
    let contextRootTarget: DshContextFileSystemTarget | undefined
    try {
      if (contextFileSystem === undefined) {
        observed = await observePublicationRoot(resolution.declaredRootPath)
      } else {
        const contextObservation = await observeContextRoot(
          contextFileSystem,
          resolution.declaredRootPath,
        )
        observed = contextObservation
        contextRootTarget = contextObservation.target
      }
    } catch {
      return { status: 'UNAVAILABLE' }
    }
    if (observed.status === 'UNAVAILABLE') return { status: 'UNAVAILABLE' }
    const common = {
      scope,
      expectedProvider: resolution.expectedProvider,
      expectedSource: resolution.expectedSource,
      resolverVersion: resolution.resolverVersion,
      rootContractVersion: resolution.rootContractVersion,
      resolutionContractDigest,
      declaredRootPath: resolution.declaredRootPath,
    }
    const parsed = RootBindingV2Schema.safeParse(observed.status === 'EXISTING'
      ? {
          ...common,
          state: 'EXISTING',
          canonicalRootPath: observed.canonicalRootPath,
          rootIdentityDigest: observed.rootIdentityDigest,
        }
      : {
          ...common,
          state: 'ABSENT',
          canonicalExistingAncestorPath: observed.canonicalExistingAncestorPath,
          ancestorIdentityDigest: observed.ancestorIdentityDigest,
          missingSegments: observed.missingSegments,
        })
    if (!parsed.success) return { status: 'STALE' }
    if (contextFileSystem === undefined) {
      return { status: 'READY', rootBinding: parsed.data, view: session.view }
    }
    if (contextRootTarget === undefined) return { status: 'UNAVAILABLE' }
    let workspaceRoot: string
    try {
      workspaceRoot = contextFileSystem.processPath(contextRootTarget)
    } catch {
      return { status: 'UNAVAILABLE' }
    }
    if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
      return { status: 'UNAVAILABLE' }
    }
    return {
      status: 'READY',
      rootBinding: parsed.data,
      view: session.view,
      filesystem: contextFileSystem,
      rootTarget: contextRootTarget,
      publicationPolicy: {
        mode: 'workspace-write',
        workspaceRoot,
        sessionId: session.sessionId ?? input.batch.sessionLifecycleKey,
      },
    }
  }
}
