import { access } from 'node:fs/promises'
import { dirname, join, normalize, resolve } from 'node:path'
import type { V2ProposalPublicationInput } from '../../application/publication/index.js'
import { RootBindingV2Schema } from '../../domain/review/index.js'
import { deriveProjectScopeIdentityDigest } from '../../domain/purge/index.js'
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
  readonly view: TView
  readonly configuration: StockSkillRuntimeConfiguration
  readonly workspaceBinding?: StockWorkspaceContractBinding | undefined
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
    if (session.configuration.usesContextFileSystem === true) return { status: 'STALE' }
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
          canonicalPath: await findStockProjectRoot(workspaceBinding.canonicalPath),
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
        home = await observePublicationRoot(resolution.dshHome.declaredPath)
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
    try {
      observed = await observePublicationRoot(resolution.declaredRootPath)
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
    return parsed.success
      ? { status: 'READY', rootBinding: parsed.data, view: session.view }
      : { status: 'STALE' }
  }
}
