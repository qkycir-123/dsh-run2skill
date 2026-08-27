import type { DshLlmPort } from '../adapters/dsh-llm/restricted-learning-client.js'
import { DshV2GapScanner } from '../adapters/dsh-session/v2-gap-scanner.js'
import { DshSessionGapReader } from '../adapters/dsh-session/gap-reader.js'
import {
  DshSessionActivityAdapter,
  type DshLiveAgentRegistryPort,
  type DshLiveSessionRegistryPort,
} from '../adapters/dsh-session/v2-session-activity.js'
import type { DshSessionHeader, SessionPersistencePort } from '../adapters/dsh-session/types.js'
import type { DshSkillRegistryPort } from '../adapters/dsh-skills/skill-catalog.js'
import {
  StockDshRootContractResolver,
  type StockSkillRuntimeConfiguration,
  type StockWorkspaceContractBinding,
} from '../adapters/dsh-skills/stock-root-contract.js'
import { DshV2CatalogAdapter, type V2StockWritableRootBinding } from '../adapters/dsh-skills/v2-catalog-adapter.js'
import { DshV2OwnershipObservationAdapter } from '../adapters/dsh-skills/v2-ownership-observation.js'
import { DshV2RootManifestAdapter } from '../adapters/dsh-skills/v2-root-manifest.js'
import type { Run2skillV2Domain } from '../adapters/dsh-storage/v2-types.js'
import type { WorkspaceBindingPort } from '../application/capture/turn-capture-processor.js'
import type { RuntimeNotices } from '../application/capture/runtime-notices.js'
import type { TurnIngressCandidate } from '../adapters/dsh-session/types.js'
import type { RecoveryRuntime } from '../application/capture/recovery-lifecycle.js'
import { createDshV2PipelineRuntime, type DshV2PipelineRuntime } from './v2-pipeline.js'
import { V2ProposalHostServices } from './v2-proposal-services.js'
import { V2PurgeService } from '../application/purge/index.js'
import { V2LearningAttentionService } from '../adapters/dsh-connection/v2-learning-attention-rpc.js'
import type { CurrentWorkspaceResolver } from '../adapters/dsh-connection/current-scope-authorizer.js'
import { deriveSessionCwdDigest, deriveSessionLifecycleKey } from '../domain/observe/signal-key.js'
import { classifySessionRoot } from '../adapters/dsh-session/observation.js'
import type { DshContextFileSystemTarget } from '../adapters/dsh-filesystem/context-filesystem.js'

export interface V2ProductionHostSession<TView extends object> {
  readonly header: DshSessionHeader
  readonly view: TView
  readonly configuration: StockSkillRuntimeConfiguration
  readonly workspaceBinding?: StockWorkspaceContractBinding | undefined
  readonly filesystem?: unknown
}

export interface DshV2ProductionRuntimeOptions<TView extends object> {
  readonly persistence: SessionPersistencePort
  readonly sessions: DshLiveSessionRegistryPort
  readonly agents: DshLiveAgentRegistryPort
  readonly llm: DshLlmPort
  readonly skills: DshSkillRegistryPort<TView>
  readonly workspace: WorkspaceBindingPort
  readonly resolveWorkspace: CurrentWorkspaceResolver
  readonly notices: RuntimeNotices
  readonly resolveSession: (sessionLifecycleKey: string) => V2ProductionHostSession<TView> | undefined
  readonly resolveSessionByView: (view: TView) => V2ProductionHostSession<TView> | undefined
  readonly automaticLearning?: () => boolean
  readonly onSkillMutation?: (target: DshContextFileSystemTarget, version: string) => void
  readonly refreshView?: (view: TView) => TView
  readonly now?: () => number
}

function writableRoot<TView extends object>(
  resolver: StockDshRootContractResolver,
  session: V2ProductionHostSession<TView> | undefined,
  source: string,
): V2StockWritableRootBinding | undefined {
  if (session === undefined) return undefined
  const scope = source === 'project-dsh' ? 'PROJECT' : source === 'user-dsh' ? 'USER' : undefined
  if (scope === undefined) return undefined
  const resolution = resolver.resolve({
    scope,
    configuration: session.configuration,
    ...(scope === 'PROJECT' && session.workspaceBinding !== undefined
      ? { workspaceBinding: session.workspaceBinding }
      : {}),
  })
  return resolution.status === 'SUPPORTED'
    ? {
        scope,
        expectedProvider: resolution.expectedProvider,
        expectedSource: resolution.expectedSource,
        canonicalRootPath: resolution.declaredRootPath,
      }
    : undefined
}

/** Production v2 assembly. This is the only learning runtime enabled after cutover. */
export class DshV2ProductionRuntime<TView extends object> implements RecoveryRuntime<TurnIngressCandidate> {
  readonly scanner: DshV2GapScanner
  readonly pipeline: DshV2PipelineRuntime
  readonly proposals: V2ProposalHostServices<TView>
  readonly purge: V2PurgeService
  readonly attention: V2LearningAttentionService
  readonly #domain: Run2skillV2Domain
  #closed = false

  constructor(
    domain: Run2skillV2Domain,
    private readonly options: DshV2ProductionRuntimeOptions<TView>,
  ) {
    this.#domain = domain
    const rootResolver = new StockDshRootContractResolver()
    const resolveWritableRoot = (source: string, view: TView) => writableRoot(
      rootResolver,
      options.resolveSessionByView(view),
      source,
    )
    const catalog = new DshV2CatalogAdapter(domain, {
      registry: options.skills,
      resolveView: lifecycleKey => options.resolveSession(lifecycleKey)?.view,
      resolveFileSystem: view => options.resolveSessionByView(view)?.filesystem,
      resolveStockWritableRoot: (summary, view) => resolveWritableRoot(summary.source, view),
    })
    const manifest = new DshV2RootManifestAdapter({
      resolveSession: lifecycleKey => {
        const session = options.resolveSession(lifecycleKey)
        return session === undefined
          ? undefined
          : {
              cwd: session.header.cwd,
              configuration: session.configuration,
              ...(session.filesystem === undefined ? {} : { filesystem: session.filesystem }),
            }
      },
      runtimeCatalog: catalog,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    const activity = new DshSessionActivityAdapter({
      persistence: options.persistence,
      sessions: options.sessions,
      agents: options.agents,
    })
    const ownership = new DshV2OwnershipObservationAdapter({
      persistence: options.persistence,
      resolveSession: lifecycleKey => {
        const session = options.resolveSession(lifecycleKey)
        return session === undefined
          ? undefined
          : {
              header: session.header,
              ...(session.filesystem === undefined ? {} : { filesystem: session.filesystem }),
            }
      },
      manifest,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    this.pipeline = createDshV2PipelineRuntime(domain, {
      llm: options.llm,
      baseline: manifest,
      activity,
      ownership,
      catalog,
      permitBatchDetection: batch => options.automaticLearning?.() !== false
        || batch.triggerReasons.includes('EXPLICIT'),
      onError: () => options.notices.record({ healthCode: 'V2_PIPELINE_FAILED', sessionId: 'global' }),
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    this.scanner = new DshV2GapScanner(
      new DshSessionGapReader(options.persistence),
      domain,
      this.pipeline,
      options.workspace,
      options.notices,
      options.now === undefined ? {} : { now: options.now },
    )
    this.proposals = new V2ProposalHostServices(domain, {
      llm: options.llm,
      registry: options.skills,
      resolveSession: lifecycleKey => {
        const session = options.resolveSession(lifecycleKey)
        return session === undefined
          ? undefined
          : {
              sessionId: session.header.id,
              view: session.view,
              configuration: session.configuration,
              ...(session.workspaceBinding === undefined ? {} : { workspaceBinding: session.workspaceBinding }),
              ...(session.filesystem === undefined ? {} : { filesystem: session.filesystem }),
            }
      },
      resolveFileSystem: view => options.resolveSessionByView(view)?.filesystem,
      resolveStockWritableRoot: (summary, view) => resolveWritableRoot(summary.source, view),
      sessionCoordinate: input => {
        const session = options.resolveSession(input.batch.sessionLifecycleKey)
        const observation = domain.table('turn_observations').entries()
        let turn: number | undefined
        for (const [, item] of observation) {
          if (
            item.sessionLifecycleKey === input.batch.sessionLifecycleKey
            && item.turnEndSeq === input.batch.lastTurnEndSeq
          ) turn = item.turn
        }
        return session === undefined || turn === undefined
          ? undefined
          : {
              rootSessionId: session.header.id,
              sessionCreatedAt: session.header.createdAt,
              turn,
              turnEndSeq: input.batch.lastTurnEndSeq,
            }
      },
      ...(options.onSkillMutation === undefined ? {} : { onSkillMutation: options.onSkillMutation }),
      ...(options.refreshView === undefined ? {} : { refreshView: options.refreshView }),
      ...(options.now === undefined ? {} : { now: () => new Date(options.now!()).toISOString() }),
    })
    this.purge = new V2PurgeService(domain, options.now)
    this.attention = new V2LearningAttentionService(
      domain,
      options.resolveWorkspace,
      options.now === undefined ? undefined : () => new Date(options.now!()).toISOString(),
    )
  }

  async start(): Promise<void> {
    const activation = await this.scanner.ensureActivated()
    if (activation.status === 'UNAVAILABLE') throw new Error(activation.healthCode)
    if (activation.status !== 'COMPLETE') throw new Error('V2_ACTIVATION_INCOMPLETE')
    await this.purge.recover()
    await this.attention.recover()
    await this.proposals.refreshes.recover()
    await this.proposals.revisions.recover()
    await this.proposals.reviews.recover()
    await this.proposals.publications.recover()
    await this.pipeline.start()
  }

  async processCandidate(candidate: TurnIngressCandidate): Promise<void> {
    const classification = classifySessionRoot(candidate.header)
    if (classification.status === 'CHILD') return
    if (classification.status === 'UNAVAILABLE') throw new Error(classification.healthCode)
    const durable = await this.options.persistence.readFrom(candidate.header.id, candidate.turnEndSeq)
    const turnEnd = durable.events.find(event => (
      event.seq === candidate.turnEndSeq && event.type === 'turn/end'
    ))
    if (turnEnd === undefined) throw new Error('TURN_NOT_DURABLE')
    const sessionLifecycleKey = deriveSessionLifecycleKey({
      rootSessionId: candidate.header.id,
      sessionCreatedAt: candidate.header.createdAt,
      sessionCwdDigest: deriveSessionCwdDigest(candidate.header.cwd),
    })
    while (true) {
      const result = await this.scanner.scanBatch()
      if (result.status === 'UNAVAILABLE') throw new Error(result.healthCode)
      if (result.status === 'COMPLETE') {
        const cursor = this.#domain.global.get().sessions[sessionLifecycleKey]
        if (cursor === undefined || cursor.observedThroughTurnEndSeq < candidate.turnEndSeq) {
          throw new Error('TURN_NOT_CAPTURED')
        }
        return
      }
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }

  async requestSynthesis(sessionLifecycleKey: string): Promise<{
    readonly changed: boolean
    readonly disposition: 'EMPTY' | 'PROCESSING' | 'QUEUED'
  }> {
    const receipt = await this.pipeline.requestSynthesis(sessionLifecycleKey)
    if (receipt.disposition === 'QUEUED') this.pipeline.wake()
    return receipt
  }

  learningStatusSession(sessionLifecycleKey: string) {
    const session = this.options.resolveSession(sessionLifecycleKey)
    return session === undefined
      ? undefined
      : {
          sessionId: session.header.id,
          ...(session.workspaceBinding === undefined ? {} : {
            workspaceBinding: {
              workspaceId: session.workspaceBinding.workspaceId,
              canonicalPath: session.workspaceBinding.canonicalPath,
            },
          }),
        }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    try {
      await this.pipeline.dispose()
    } finally {
      this.proposals.dispose()
      await this.#domain.close()
    }
  }
}
