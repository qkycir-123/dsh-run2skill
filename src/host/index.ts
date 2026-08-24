import { DshSessionGapReader } from '../adapters/dsh-session/gap-reader.js'
import {
  RestrictedLearningClient,
  type DshLlmPort,
} from '../adapters/dsh-llm/restricted-learning-client.js'
import {
  ExactAgentScopeRegistry,
  type AgentScopeProjection,
} from '../adapters/dsh-skills/exact-agent-scope.js'
import {
  DshSkillCatalogAdapter,
  type DshSkillRegistryPort,
} from '../adapters/dsh-skills/skill-catalog.js'
import { LearningWorkItemStore } from '../adapters/dsh-storage/learning-work-item-store.js'
import {
  openLearningDiagnosticDomain,
  type LearningDiagnosticDomain,
} from '../adapters/dsh-storage/learning-diagnostic-domain.js'
import { LearningDiagnosticStore } from '../adapters/dsh-storage/learning-diagnostic-store.js'
import { classifySessionRoot } from '../adapters/dsh-session/observation.js'
import type {
  DshSessionEvent,
  DshSessionHeader,
  SessionPersistencePort,
  TurnIngressCandidate,
} from '../adapters/dsh-session/types.js'
import { SessionCoordinateIngress } from '../adapters/dsh-session/ingress.js'
import {
  registerObserveSummaryRpc,
  type ObserveSummaryHostConnection,
  type ObserveSummaryRpcHandler,
} from '../adapters/dsh-connection/observe-summary-rpc.js'
import { createPurgeRpcHandler } from '../adapters/dsh-connection/purge-rpc.js'
import { projectRuntimeAttention } from '../adapters/dsh-connection/attention-rpc.js'
import { createV2RecentSkillActivityRpcHandler } from '../adapters/dsh-connection/v2-recent-skill-activity-rpc.js'
import { createV2ProposalRpcHandler } from '../adapters/dsh-connection/v2-proposal-rpc.js'
import { V2CurrentScopeAuthorizer } from '../adapters/dsh-connection/v2-current-scope-authorizer.js'
import { openRun2skillDomain } from '../adapters/dsh-storage/domain.js'
import { DurableCaptureStore } from '../adapters/dsh-storage/durable-capture-store.js'
import type { Run2skillDomain, Run2skillStorageContext } from '../adapters/dsh-storage/types.js'
import { openRun2skillV2Domain } from '../adapters/dsh-storage/v2-domain.js'
import type { Run2skillV2Domain } from '../adapters/dsh-storage/v2-types.js'
import { DshWorkspaceBindingResolver, type DshWorkspaceRegistryPort } from '../adapters/dsh-workspace/binding.js'
import { BoundedGapScanner } from '../application/capture/bounded-gap-scanner.js'
import { DurableCaptureCoordinator } from '../application/capture/durable-capture-coordinator.js'
import { IncompleteCaptureRetrier } from '../application/capture/incomplete-capture-retrier.js'
import {
  RecoveryLifecycle,
  type RecoveryRuntime,
  type RecoveryRuntimeFactory,
} from '../application/capture/recovery-lifecycle.js'
import { RuntimeNotices } from '../application/capture/runtime-notices.js'
import { TurnCaptureProcessor } from '../application/capture/turn-capture-processor.js'
import { WriteBehindCheckpoint } from '../application/capture/write-behind-checkpoint.js'
import {
  LearningScheduler,
  LearningWorker,
  type LearningSkillView,
} from '../application/learn/index.js'
import { ObserveSummaryV1Schema, type ObserveSummaryV1 } from '../domain/observe/observe-summary.js'
import { deriveSessionCwdDigest, deriveSessionLifecycleKey } from '../domain/observe/signal-key.js'
import { normalize, resolve, sep } from 'node:path'
import { NodePublicationFactsAdapter } from '../adapters/dsh-publication/publication-facts.js'
import { C5PublicationFileSystemAdapter } from '../adapters/dsh-publication/publication-filesystem.js'
import { PublicationSagaStore } from '../adapters/dsh-storage/publication-saga-store.js'
import { ProposalReviewStore } from '../adapters/dsh-storage/proposal-review-store.js'
import { ProposalSnapshotBuilder } from '../application/curation/index.js'
import {
  ApprovalPublicationSaga,
  ApprovedProposalRevalidator,
  PublicationScheduler,
} from '../application/publication/index.js'
import { DshPublicationReadbackAdapter } from '../adapters/dsh-skills/publication-readback.js'
import {
  StockDshRootContractResolver,
  StockSkillRuntimeConfigurationCache,
  deriveStockResolutionContractDigest,
  resolveStockSkillRuntimeConfiguration,
  resolvePinnedStockPresetConfiguration,
  resolvePinnedStockPresetConfigurationById,
  type StockSkillRuntimeConfiguration,
  type StockWorkspaceContractBinding,
} from '../adapters/dsh-skills/stock-root-contract.js'
import { stockPresetMounts } from '../adapters/dsh-skills/stock-preset-mount.js'
import type { CaptureWorkItemV1 } from '../domain/observe/schemas.js'
import {
  registerAutomaticLearningSettings,
  type AutomaticLearningSettingsPolicy,
  type DshSettingsPort,
} from '../adapters/dsh-settings/automatic-learning.js'
import { PurgeVisibility } from '../adapters/dsh-storage/purge-visibility.js'
import {
  PurgeError,
  PurgeService,
  type PurgeScopeResolver,
} from '../application/purge/index.js'
import { HostMutationGate } from '../application/host-mutation-gate.js'
import type { PurgeScopeBindingV1 } from '../domain/purge/index.js'
import { DshV2ProductionRuntime } from './v2-production-runtime.js'

export {
  PublicationConflict,
  createBundle,
  finalizeTransaction,
  mergeBundle,
  preparePublicationRoot,
  recoverTransaction,
} from '../adapters/dsh-publication/filesystem-cas.mjs'
export { PublicationTargetSingleFlight } from '../adapters/dsh-publication/target-single-flight.js'
export * from '../application/publication/index.js'

export const name = 'run2skill'
export const inject = [
  'agents',
  'sessions',
  'sessionPersistence',
  'storageDomain',
  'workspaceRegistry',
  'connection',
  'llm',
  'skills',
  'settings',
  'agentPresets',
  'fs',
] as const

interface DshSessionProjection {
  readonly header: DshSessionHeader
}

type Run2skillAgent = object & AgentScopeProjection & Parameters<typeof resolveStockSkillRuntimeConfiguration>[1]

type Run2skillAgentPresets = Parameters<typeof resolvePinnedStockPresetConfiguration>[0] & {
  standingKeyFor(id?: string): Promise<object>
}

function exactAgentFileSystem(agent: Run2skillAgent): unknown {
  try {
    return agent.ctx.get?.('fs')
  } catch {
    return undefined
  }
}

interface AgentPreStepPayload {
  readonly agent: Run2skillAgent
  readonly step: number
}

interface AgentDisposedPayload {
  readonly agent: Run2skillAgent
}

export interface Run2skillHostContext extends Run2skillStorageContext {
  readonly agents: unknown
  readonly sessions: unknown
  readonly sessionPersistence: SessionPersistencePort
  readonly workspaceRegistry: DshWorkspaceRegistryPort
  readonly connection: ObserveSummaryHostConnection
  readonly llm: DshLlmPort
  readonly skills: DshSkillRegistryPort<LearningSkillView<Run2skillAgent>>
  readonly settings: DshSettingsPort
  readonly agentPresets: Run2skillAgentPresets
  /** Host-plane DSH filesystem used by the supported web presets. */
  readonly fs: unknown
  on(
    event: string,
    listener: (...args: never[]) => unknown,
  ): void
}

function candidateKey(candidate: TurnIngressCandidate): string {
  return JSON.stringify([
    candidate.header.id,
    candidate.header.createdAt,
    candidate.header.cwd ?? null,
    candidate.turn,
    candidate.turnEndSeq,
  ])
}

export class Run2skillRuntimeFactory implements RecoveryRuntimeFactory {
  currentDomain: Run2skillDomain | undefined
  currentScheduler: LearningScheduler | undefined
  currentPublicationScheduler: PublicationScheduler | undefined
  currentPurgeService: PurgeService | undefined
  currentDiagnosticStore: LearningDiagnosticStore | undefined
  readonly #stockRootResolver = new StockDshRootContractResolver()
  readonly #stockConfigurations: StockSkillRuntimeConfigurationCache<Run2skillAgent>

  constructor(
    private readonly context: Run2skillHostContext,
    private readonly notices: RuntimeNotices,
    private readonly scopes: ExactAgentScopeRegistry<Run2skillAgent>,
    private readonly automaticLearning: AutomaticLearningSettingsPolicy,
    private readonly mutationGate: HostMutationGate,
  ) {
    this.#stockConfigurations = new StockSkillRuntimeConfigurationCache<Run2skillAgent>(
      async agent => await resolveStockSkillRuntimeConfiguration(stockPresetMounts, agent)
        ?? await resolvePinnedStockPresetConfiguration(this.context.agentPresets, agent),
    )
  }

  wakeLearning(): void {
    this.currentScheduler?.wake()
  }

  wakePublication(): void {
    this.currentPublicationScheduler?.wake()
  }

  wakeCuration(): void {
    this.currentCurationWake?.()
  }

  async captureRootConfiguration(agent: Run2skillAgent): Promise<void> {
    await this.#stockConfigurations.capture(agent)
  }

  releaseRootConfiguration(agent: Run2skillAgent): void {
    this.#stockConfigurations.release(agent)
  }

  currentCurationWake: (() => void) | undefined

  async resolvePurgeScope(
    scope: 'PROJECT' | 'USER',
    workspaceId?: string,
  ): Promise<PurgeScopeBindingV1> {
    if (scope === 'USER') return { scope: 'USER' }
    if (workspaceId === undefined || this.context.workspaceRegistry.get === undefined) {
      throw new PurgeError('PURGE_SCOPE_UNAVAILABLE')
    }
    const workspace = this.context.workspaceRegistry.get(workspaceId)
    if (
      workspace === undefined
      || workspace.id !== workspaceId
      || (workspace.status !== undefined && await workspace.status() !== 'ok')
    ) throw new PurgeError('PURGE_SCOPE_UNAVAILABLE')
    const agentScope = this.scopes.resolveUniqueCwd(workspace.path)
    if (agentScope.status !== 'AVAILABLE') throw new PurgeError('PURGE_SCOPE_UNAVAILABLE')
    const configuration = this.#stockConfigurations.get(agentScope.agent)
    if (configuration === undefined) throw new PurgeError('PURGE_SCOPE_UNAVAILABLE')
    const root = this.#stockRootResolver.resolve({
      scope: 'PROJECT',
      workspaceBinding: { workspaceId, canonicalPath: workspace.path },
      configuration,
    })
    if (root.status !== 'SUPPORTED') throw new PurgeError('PURGE_SCOPE_UNAVAILABLE')
    return {
      scope: 'PROJECT',
      workspaceId,
      canonicalWorkspacePath: workspace.path,
      workspaceObservedAt: new Date().toISOString(),
      canonicalRootPath: root.declaredRootPath,
      rootContractVersion: 'stock-dsh-web-default-roots-v1',
      resolverVersion: 'stock-root-resolver-v2',
      resolutionContractDigest: deriveStockResolutionContractDigest(root, {
        kind: 'WORKSPACE', workspaceId, canonicalPath: workspace.path,
      }),
    }
  }

  async open(): Promise<RecoveryRuntime> {
    const domain = await openRun2skillDomain(this.context)
    let diagnosticDomain: LearningDiagnosticDomain | undefined
    let diagnosticStore: LearningDiagnosticStore | undefined
    let v2Domain: Run2skillV2Domain | undefined
    this.currentDomain = domain
    try {
      try {
        diagnosticDomain = await openLearningDiagnosticDomain(this.context)
        diagnosticStore = new LearningDiagnosticStore(
          domain,
          diagnosticDomain,
          operation => this.mutationGate.run(operation),
        )
        this.currentDiagnosticStore = diagnosticStore
        try {
          await diagnosticStore.cleanupOrphans()
          await diagnosticStore.verifyReady()
        } catch {
          this.notices.record({ healthCode: 'LEARNING_DIAGNOSTIC_UNAVAILABLE', sessionId: 'global' })
        }
      } catch {
        this.notices.record({ healthCode: 'LEARNING_DIAGNOSTIC_UNAVAILABLE', sessionId: 'global' })
        try {
          await diagnosticDomain?.close()
        } catch {
          // The main domain remains authoritative and can still start safely.
        }
        diagnosticDomain = undefined
        diagnosticStore = undefined
        this.currentDiagnosticStore = undefined
      }
      try {
        v2Domain = await openRun2skillV2Domain(this.context)
      } catch {
        v2Domain = undefined
      }
      const checkpoint = new WriteBehindCheckpoint(domain, {
        runMutation: operation => this.mutationGate.run(operation),
      })
      const reader = new DshSessionGapReader(this.context.sessionPersistence)
      const visibility = new PurgeVisibility(domain)
      const store = new DurableCaptureStore(
        domain,
        undefined,
        visibility,
        operation => this.mutationGate.run(operation),
      )
      const learningStore = new LearningWorkItemStore(
        domain,
        undefined,
        visibility,
        operation => this.mutationGate.run(operation),
      )
      const skillCatalog = new DshSkillCatalogAdapter(this.context.skills)
      const workspaceResolver = new DshWorkspaceBindingResolver(this.context.workspaceRegistry)
      const publicationAbort = new AbortController()
      const publicationView = (item: CaptureWorkItemV1): LearningSkillView<Run2skillAgent> | undefined => {
        let scope = this.scopes.resolve(item)
        if (
          scope.status === 'UNAVAILABLE'
          && item.review?.reviewDecision === 'APPROVED'
          && item.review.proposal.workspaceBinding !== undefined
          && item.review.proposal.actionBinding.kind !== 'DISCARD'
        ) {
          const approved = item.review.proposal
          const workspaceBinding = approved.workspaceBinding
          const actionBinding = approved.actionBinding
          if (workspaceBinding === undefined || actionBinding.kind === 'DISCARD') return undefined
          const recovered = this.scopes.resolveUniqueCwd(workspaceBinding.canonicalPath)
          if (recovered.status === 'AVAILABLE') {
            const configuration = this.#stockConfigurations.get(recovered.agent)
            const currentRoot = configuration === undefined
              ? undefined
              : this.#stockRootResolver.resolve({
                  scope: approved.persistenceScope,
                  workspaceBinding,
                  configuration,
                })
            const identity = approved.persistenceScope === 'PROJECT'
              ? {
                  kind: 'WORKSPACE' as const,
                  workspaceId: workspaceBinding.workspaceId,
                  canonicalPath: workspaceBinding.canonicalPath,
                }
              : approved.dshHomeBinding === undefined
                ? undefined
                : {
                    kind: 'DSH_HOME' as const,
                    resolutionKind: approved.dshHomeBinding.resolutionKind,
                    canonicalPath: approved.dshHomeBinding.canonicalPath,
                    identityDigest: approved.dshHomeBinding.identityDigest,
                  }
            const currentDigest = currentRoot?.status === 'SUPPORTED' && identity !== undefined
              ? deriveStockResolutionContractDigest(currentRoot, identity)
              : undefined
            if (currentDigest === actionBinding.rootBinding.resolutionContractDigest) scope = recovered
          }
        }
        return scope.status === 'UNAVAILABLE'
          ? undefined
          : {
              ...(scope.cwd === undefined ? {} : { cwd: scope.cwd }),
              scope: scope.agent,
              signal: publicationAbort.signal,
            }
      }
      const publicationFacts = new NodePublicationFactsAdapter()
      const rootContract = {
        resolve: async (input: {
          readonly scope: 'PROJECT' | 'USER'
          readonly workspaceBinding?: { readonly workspaceId: string; readonly canonicalPath: string } | undefined
          readonly view: LearningSkillView<Run2skillAgent>
        }) => {
          const configuration = this.#stockConfigurations.get(input.view.scope)
          if (configuration === undefined) {
            return { status: 'UNSUPPORTED' as const, code: 'ROOT_CONTRACT_UNSUPPORTED' as const }
          }
          return this.#stockRootResolver.resolve({
            scope: input.scope,
            ...(input.workspaceBinding === undefined ? {} : { workspaceBinding: input.workspaceBinding }),
            configuration,
          })
        },
        deriveResolutionContractDigest: deriveStockResolutionContractDigest,
      }
      const proposalBuilder = new ProposalSnapshotBuilder(
        skillCatalog,
        publicationFacts,
        workspaceResolver,
        { rootContract },
      )
      const proposalReviewStore = new ProposalReviewStore(domain, undefined, visibility)
      const stageLearned = async (item: CaptureWorkItemV1): Promise<void> => {
        const view = publicationView(item)
        if (view === undefined) return
        const built = await proposalBuilder.build(item, view)
        if (built.status !== 'READY') {
          this.notices.record({
            healthCode: `CURATION_${built.failureCode}`,
            sessionId: item.signalKey.rootSessionId,
            turnEndSeq: item.signalKey.turnEndSeq,
          })
          return
        }
        await this.mutationGate.run(async () => await proposalReviewStore.stage(
          item.workItemId,
          item.revision,
          built.proposal,
        ))
      }
      let staging = Promise.resolve()
      this.currentCurationWake = () => {
        staging = staging.then(async () => {
          for (const [, item] of domain.table('work_items').entries()) {
            if (visibility.workItemVisible(item) && item.processingState === 'LEARNED') await stageLearned(item)
          }
        }).catch(() => {
          this.notices.record({ healthCode: 'CURATION_STAGE_FAILED', sessionId: 'global' })
        })
      }
      const publicationStore = new PublicationSagaStore(domain, undefined, visibility)
      const publicationSaga = new ApprovalPublicationSaga({
        store: publicationStore,
        revalidation: new ApprovedProposalRevalidator(proposalBuilder, publicationView),
        fileSystem: new C5PublicationFileSystemAdapter({
          verifyParity: async (binding, canonicalRoot, item) => {
            const view = publicationView(item)
            if (view === undefined) return false
            const revalidated = await proposalBuilder.revalidateApproved(item, view)
            if (revalidated.status !== 'READY') return false
            const current = revalidated.proposal.actionBinding
            return current.kind !== 'DISCARD'
              && current.rootBinding.resolutionContractDigest === binding.resolutionContractDigest
              && sameHostPath(current.rootBinding.declaredRootPath, binding.declaredRootPath)
              && sameHostPath(canonicalRoot, binding.declaredRootPath)
          },
        }),
        readback: new DshPublicationReadbackAdapter(skillCatalog, publicationView, {
          refreshView: view => view.cwd === undefined
            ? view
            : { ...view, cwd: view.cwd.endsWith(sep) ? `${view.cwd}.${sep}` : `${view.cwd}${sep}` },
        }),
      })
      const publicationScheduler = new PublicationScheduler({
        store: publicationStore,
        worker: {
          run: workItemId => this.mutationGate.run(async () => await publicationSaga.run(workItemId)),
        },
        eligible: item => publicationView(item) !== undefined,
        onError: () => {
          this.notices.record({ healthCode: 'PUBLICATION_WORKER_FAILED', sessionId: 'global' })
        },
      })
      this.currentPublicationScheduler = publicationScheduler
      const worker = new LearningWorker({
        store: learningStore,
        sessionReader: reader,
        scopes: this.scopes,
        skills: skillCatalog,
        client: new RestrictedLearningClient(this.context.llm),
        notices: this.notices,
        ...(diagnosticStore === undefined ? {} : { diagnostics: diagnosticStore }),
        onCompleted: stageLearned,
      })
      const scheduler = new LearningScheduler({
        store: learningStore,
        worker,
        policy: this.automaticLearning,
        notices: this.notices,
      })
      this.currentScheduler = scheduler
      const scopeResolver: PurgeScopeResolver = {
        resolve: async (scope, workspaceId) => await this.resolvePurgeScope(scope, workspaceId),
      }
      const purgeDiagnostics = diagnosticStore
      const purgeService = new PurgeService(domain, scopeResolver, {
        ...(v2Domain === undefined ? {} : { v2Domain }),
        assertDeletionReady: async () => {
          if (purgeDiagnostics === undefined) {
            throw new Error('Learning diagnostic sidecar unavailable')
          }
          await purgeDiagnostics.verifyReady()
        },
        ...(purgeDiagnostics === undefined
          ? {}
          : {
              beforeDeleteWorkItem: async (id: string) => await purgeDiagnostics.deleteWorkItemWithinMutation(id),
              beforeDeleteAll: async () => await purgeDiagnostics.deleteAllWithinMutation(),
            }),
        onHidden: () => {
          scheduler.abortMatching(item => !visibility.workItemVisible(item))
          scheduler.wake()
          this.currentCurationWake?.()
        },
      })
      this.currentPurgeService = purgeService
      const coordinator = new DurableCaptureCoordinator(store, checkpoint, this.notices)
      const processor = new TurnCaptureProcessor(
        coordinator,
        this.notices,
        workspaceResolver,
        this.automaticLearning,
      )
      const scanner = new BoundedGapScanner(reader, checkpoint, processor, this.notices)
      const incompleteRetrier = new IncompleteCaptureRetrier(
        reader,
        store,
        checkpoint,
        processor,
        this.notices,
      )
      await incompleteRetrier.retryBatch()
      const checkpointTimer = setInterval(() => {
        void checkpoint.flushIfDue().catch(() => {
          this.notices.record({ healthCode: 'CHECKPOINT_WRITE_FAILED', sessionId: 'global' })
        })
        void incompleteRetrier.retryBatch().then((result) => {
          if (result.resolved > 0) scheduler.wake()
        }).catch(() => {
          this.notices.record({ healthCode: 'WORK_ITEM_WRITE_FAILED', sessionId: 'global' })
        })
      }, 30_000)

      let closed = false
      const runtime: RecoveryRuntime = {
        scanner,
        processCandidate: async (candidate) => {
          const root = classifySessionRoot(candidate.header)
          if (root.status === 'CHILD') return
          if (root.status === 'UNAVAILABLE') {
            this.notices.record({
              healthCode: root.healthCode,
              sessionId: candidate.header.id || 'global',
              turnEndSeq: candidate.turnEndSeq,
            })
            return
          }
          const lifecycleKey = deriveSessionLifecycleKey({
            rootSessionId: candidate.header.id,
            sessionCreatedAt: candidate.header.createdAt,
            sessionCwdDigest: deriveSessionCwdDigest(candidate.header.cwd),
          })
          let current = checkpoint.snapshot().sessions[lifecycleKey]
          if (current === undefined) {
            if (candidate.turnStartSeq === undefined) throw new Error('TURN_BOUNDARY_INCOMPLETE')
            await checkpoint.activate([{
              rootSessionId: candidate.header.id,
              sessionCreatedAt: candidate.header.createdAt,
              sessionCwdDigest: deriveSessionCwdDigest(candidate.header.cwd),
              triggerPolicyVersion: 'cheap-trigger-v1',
              activationFenceSeq: candidate.turnStartSeq,
              durableNextSeq: candidate.turnStartSeq,
              observedTailSeq: candidate.turnEndSeq,
            }])
            current = checkpoint.snapshot().sessions[lifecycleKey]
          }
          if (
            current === undefined
            || candidate.turnStartSeq === undefined
            || candidate.turnStartSeq < current.activationFenceSeq
          ) return
          const read = await reader.readFrom(candidate.header.id, 0)
          if (read.status === 'UNAVAILABLE') throw new Error(read.healthCode)
          const turnEnd = read.events.find((event) => (
            event.seq === candidate.turnEndSeq && event.type === 'turn/end'
          ))
          if (turnEnd === undefined) throw new Error('SESSION_LOG_UNAVAILABLE')
          const tail = read.events.at(-1)?.seq ?? 0
          await processor.processTurn({
            header: read.header,
            events: read.events,
            turnEndSeq: candidate.turnEndSeq,
            progress: {
              ...current,
              durableNextSeq: Math.max(current.durableNextSeq, candidate.turnEndSeq + 1),
              observedTailSeq: Math.max(current.observedTailSeq, tail),
              lastScannedAt: new Date().toISOString(),
            },
          })
          scheduler.wake()
        },
        close: async () => {
          if (closed) return
          closed = true
          clearInterval(checkpointTimer)
          if (this.currentScheduler === scheduler) this.currentScheduler = undefined
          if (this.currentPublicationScheduler === publicationScheduler) {
            this.currentPublicationScheduler = undefined
          }
          if (this.currentPurgeService === purgeService) this.currentPurgeService = undefined
          if (this.currentDiagnosticStore === diagnosticStore) this.currentDiagnosticStore = undefined
          publicationAbort.abort()
          if (this.currentDomain === domain) this.currentDomain = undefined
          if (this.currentCurationWake !== undefined) this.currentCurationWake = undefined
          try {
            await publicationScheduler.dispose()
          } finally {
            try {
              await scheduler.dispose()
            } finally {
              try {
                await v2Domain?.close()
              } finally {
                try {
                  await diagnosticDomain?.close()
                } finally {
                  await domain.close()
                }
              }
            }
          }
        },
      }
      try {
        await this.mutationGate.run(async () => await purgeService.recover())
      } catch {
        this.notices.record({ healthCode: 'PURGE_RECOVERY_FAILED', sessionId: 'global' })
      }
      await publicationScheduler.start()
      await scheduler.start()
      return runtime
    } catch (error) {
      this.currentScheduler = undefined
      this.currentPublicationScheduler = undefined
      this.currentPurgeService = undefined
      this.currentDiagnosticStore = undefined
      if (this.currentDomain === domain) this.currentDomain = undefined
      this.currentCurationWake = undefined
      try {
        await v2Domain?.close()
      } finally {
        try {
          await diagnosticDomain?.close()
        } finally {
          await domain.close()
        }
      }
      throw error
    }
  }
}

/**
 * Fresh v2 cutover factory. No v1 capture, learning, curation or publication
 * worker is constructed and old v1 cache is intentionally ignored.
 */
class Run2skillV2RuntimeFactory implements RecoveryRuntimeFactory {
  currentV2Domain: Run2skillV2Domain | undefined
  currentV2Runtime: DshV2ProductionRuntime<LearningSkillView<Run2skillAgent>> | undefined
  readonly #stockConfigurations: StockSkillRuntimeConfigurationCache<Run2skillAgent>
  readonly #workspaceBindings = new WeakMap<Run2skillAgent, {
    readonly workspaceId: string
    readonly canonicalPath: string
  }>()
  readonly #dormantSessions = new Map<string, {
    readonly header: DshSessionHeader
    readonly scope: object
    readonly configuration: StockSkillRuntimeConfiguration
    readonly filesystem: unknown
    readonly workspaceBinding?: StockWorkspaceContractBinding | undefined
  }>()

  constructor(
    private readonly context: Run2skillHostContext,
    private readonly notices: RuntimeNotices,
    private readonly scopes: ExactAgentScopeRegistry<Run2skillAgent>,
    private readonly automaticLearning: AutomaticLearningSettingsPolicy,
  ) {
    this.#stockConfigurations = new StockSkillRuntimeConfigurationCache<Run2skillAgent>(
      async agent => await resolveStockSkillRuntimeConfiguration(stockPresetMounts, agent)
        ?? await resolvePinnedStockPresetConfiguration(this.context.agentPresets, agent),
    )
  }

  wakeLearning(): void { this.currentV2Runtime?.pipeline.wake() }
  wakePublication(): void {}
  wakeCuration(): void {}

  async captureRootConfiguration(agent: Run2skillAgent): Promise<void> {
    const configuration = await this.#stockConfigurations.capture(agent)
    if (configuration === undefined) throw new Error('V2_ROOT_CONFIGURATION_UNAVAILABLE')
    const header = agent.session.header as DshSessionHeader
    const workspaceBinding = await this.#workspaceBinding(header.cwd)
    if (workspaceBinding === undefined) this.#workspaceBindings.delete(agent)
    else this.#workspaceBindings.set(agent, workspaceBinding)
    const presetId = configuration.presetId ?? header.agentPreset
    if (presetId === undefined) throw new Error('V2_SESSION_PRESET_UNAVAILABLE')
    const scope = await this.context.agentPresets.standingKeyFor(presetId)
    this.#rememberDormantSession(header, scope, configuration, workspaceBinding)
  }

  releaseRootConfiguration(agent: Run2skillAgent): void {
    this.#workspaceBindings.delete(agent)
    this.#stockConfigurations.release(agent)
  }

  async resolveCurrentWorkspace(workspaceId: string) {
    const workspace = this.context.workspaceRegistry.get?.(workspaceId)
    if (
      workspace === undefined
      || workspace.id !== workspaceId
      || workspace.path.length === 0
      || (workspace.status !== undefined && await workspace.status() !== 'ok')
    ) return undefined
    return { workspaceId: workspace.id, canonicalPath: workspace.path }
  }

  async #workspaceBinding(cwd: string | undefined): Promise<StockWorkspaceContractBinding | undefined> {
    if (cwd === undefined) return undefined
    const binding = await new DshWorkspaceBindingResolver(this.context.workspaceRegistry).resolve(cwd)
    return binding.status === 'BOUND'
      ? { workspaceId: binding.workspaceId, canonicalPath: binding.canonicalPath }
      : undefined
  }

  #rememberDormantSession(
    header: DshSessionHeader,
    scope: object,
    configuration: StockSkillRuntimeConfiguration,
    workspaceBinding: StockWorkspaceContractBinding | undefined,
  ): void {
    const lifecycleKey = deriveSessionLifecycleKey({
      rootSessionId: header.id,
      sessionCreatedAt: header.createdAt,
      sessionCwdDigest: deriveSessionCwdDigest(header.cwd),
    })
    this.#dormantSessions.set(lifecycleKey, {
      header,
      scope,
      configuration,
      filesystem: this.context.fs,
      ...(workspaceBinding === undefined ? {} : { workspaceBinding }),
    })
  }

  async #hydrateDormantSessions(): Promise<void> {
    let snapshots: readonly { readonly header: DshSessionHeader }[]
    try {
      snapshots = await this.context.sessionPersistence.listSnapshots()
    } catch {
      return
    }
    for (const { header } of snapshots) {
      if (classifySessionRoot(header).status !== 'ROOT') continue
      try {
        const configuration = await resolvePinnedStockPresetConfigurationById(
          this.context.agentPresets,
          header.agentPreset,
          true,
        )
        if (configuration === undefined) continue
        const scope = await this.context.agentPresets.standingKeyFor(configuration.presetId)
        const workspaceBinding = await this.#workspaceBinding(header.cwd)
        this.#rememberDormantSession(header, scope, configuration, workspaceBinding)
      } catch {
        // One unavailable historical Session must not block recovery of others.
      }
    }
  }

  #dormantForView(view: LearningSkillView<Run2skillAgent>) {
    const cwdDigest = deriveSessionCwdDigest(view.cwd)
    return [...this.#dormantSessions.values()].find(session => (
      session.scope === view.scope
      && deriveSessionCwdDigest(session.header.cwd) === cwdDigest
    ))
  }

  async open(): Promise<RecoveryRuntime> {
    let domain: Run2skillV2Domain | undefined
    let runtime: DshV2ProductionRuntime<LearningSkillView<Run2skillAgent>> | undefined
    try {
      domain = await openRun2skillV2Domain(this.context)
      const publicationAbort = new AbortController()
      await this.#hydrateDormantSessions()
      const viewForAgent = (agent: Run2skillAgent): LearningSkillView<Run2skillAgent> => ({
        ...(agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd }),
        scope: agent,
        signal: publicationAbort.signal,
      })
      const resolveSession = (lifecycleKey: string) => {
        const scope = this.scopes.resolveLifecycleKey(lifecycleKey)
        if (scope.status === 'AVAILABLE') {
          const configuration = this.#stockConfigurations.get(scope.agent)
          if (configuration !== undefined) {
            const workspaceBinding = this.#workspaceBindings.get(scope.agent)
            const filesystem = exactAgentFileSystem(scope.agent)
            return {
              header: scope.agent.session.header as DshSessionHeader,
              view: viewForAgent(scope.agent),
              configuration,
              ...(filesystem === undefined ? {} : { filesystem }),
              ...(workspaceBinding === undefined ? {} : { workspaceBinding }),
            }
          }
        }
        const dormant = this.#dormantSessions.get(lifecycleKey)
        if (dormant === undefined) return undefined
        return {
          header: dormant.header,
          view: {
            ...(dormant.header.cwd === undefined ? {} : { cwd: dormant.header.cwd }),
            scope: dormant.scope as Run2skillAgent,
            signal: publicationAbort.signal,
          },
          configuration: dormant.configuration,
          filesystem: dormant.filesystem,
          ...(dormant.workspaceBinding === undefined ? {} : { workspaceBinding: dormant.workspaceBinding }),
        }
      }
      const resolveSessionByView = (view: LearningSkillView<Run2skillAgent>) => {
        const dormant = this.#dormantForView(view)
        const configuration = this.#stockConfigurations.get(view.scope) ?? dormant?.configuration
        if (configuration === undefined) return undefined
        const workspaceBinding = this.#workspaceBindings.get(view.scope) ?? dormant?.workspaceBinding
        const filesystem = exactAgentFileSystem(view.scope) ?? dormant?.filesystem
        return {
          header: dormant?.header ?? view.scope.session.header as DshSessionHeader,
          view,
          configuration,
          ...(filesystem === undefined ? {} : { filesystem }),
          ...(workspaceBinding === undefined ? {} : { workspaceBinding }),
        }
      }
      const sessions = typeof this.context.sessions === 'object'
        && this.context.sessions !== null
        && 'get' in this.context.sessions
        && typeof this.context.sessions.get === 'function'
        ? this.context.sessions as { get(id: string): never }
        : { get: (_id: string) => undefined }
      const agents = typeof this.context.agents === 'object'
        && this.context.agents !== null
        && 'get' in this.context.agents
        && typeof this.context.agents.get === 'function'
        ? this.context.agents as { get(id: string): never }
        : { get: (_id: string) => undefined }
      runtime = new DshV2ProductionRuntime(domain, {
        persistence: this.context.sessionPersistence,
        sessions,
        agents,
        llm: this.context.llm,
        skills: this.context.skills,
        workspace: new DshWorkspaceBindingResolver(this.context.workspaceRegistry),
        resolveWorkspace: workspaceId => this.resolveCurrentWorkspace(workspaceId),
        notices: this.notices,
        resolveSession,
        resolveSessionByView,
        automaticLearning: () => this.automaticLearning.snapshot().automaticLearning,
        refreshView: view => view.cwd === undefined
          ? view
          : { ...view, cwd: view.cwd.endsWith(sep) ? `${view.cwd}.${sep}` : `${view.cwd}${sep}` },
      })
      await runtime.start()
      const activeRuntime = runtime
      this.currentV2Domain = domain
      this.currentV2Runtime = activeRuntime
      let closed = false
      return {
        scanner: activeRuntime.scanner,
        processCandidate: candidate => activeRuntime.processCandidate(candidate),
        close: async () => {
          if (closed) return
          closed = true
          publicationAbort.abort()
          if (this.currentV2Runtime === activeRuntime) this.currentV2Runtime = undefined
          if (this.currentV2Domain === domain) this.currentV2Domain = undefined
          await activeRuntime.close()
        },
      }
    } catch (error) {
      if (runtime !== undefined) await runtime.close().catch(() => undefined)
      else if (domain !== undefined) await domain.close().catch(() => undefined)
      throw error
    }
  }
}

function sameHostPath(left: string, right: string): boolean {
  const a = normalize(resolve(left))
  const b = normalize(resolve(right))
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function unavailableSummary(lifecycle: RecoveryLifecycle, notices: RuntimeNotices): ObserveSummaryV1 {
  const latest = notices.list().at(-1)
  return ObserveSummaryV1Schema.parse({
    apiVersion: 1,
    status: lifecycle.status === 'RECOVERING' ? 'RECOVERING' : 'DEGRADED',
    capturedCount: 0,
    blockedCaptureCount: 0,
    unsaved: { completeness: 'UNKNOWN', knownCount: 0 },
    recoveryLag: true,
    ...(latest === undefined ? {} : { lastHealthCode: latest.healthCode }),
  })
}

function v2Summary(
  domain: Run2skillV2Domain | undefined,
  lifecycle: RecoveryLifecycle,
  notices: RuntimeNotices,
): ObserveSummaryV1 {
  if (domain === undefined) return unavailableSummary(lifecycle, notices)
  const snapshot = lifecycle.snapshot()
  const latest = notices.list().at(-1)
  const status = lifecycle.status === 'READY' && !snapshot.recoveryLag
    ? 'READY'
    : lifecycle.status === 'RECOVERING'
      ? 'RECOVERING'
      : 'DEGRADED'
  return ObserveSummaryV1Schema.parse({
    apiVersion: 1,
    status,
    capturedCount: domain.table('turn_observations').size,
    blockedCaptureCount: 0,
    learning: { captured: 0, analyzing: 0, learned: 0, needsAttention: 0 },
    unsaved: {
      completeness: status === 'READY' && notices.unsavedCompletenessKnown() ? 'KNOWN' : 'UNKNOWN',
      knownCount: notices.list().filter(item => item.kind === 'UNSAVED_SIGNAL').length,
    },
    recoveryLag: snapshot.recoveryLag,
    ...(latest === undefined ? {} : { lastHealthCode: latest.healthCode }),
  })
}

export async function apply(context: Run2skillHostContext): Promise<() => Promise<void>> {
  const automaticLearning = registerAutomaticLearningSettings(context.settings)
  const notices = new RuntimeNotices()
  const scopes = new ExactAgentScopeRegistry<Run2skillAgent>()
  const scopeDisposers = new WeakMap<Run2skillAgent, () => void>()
  const mutationGate = new HostMutationGate()
  const factory = new Run2skillV2RuntimeFactory(context, notices, scopes, automaticLearning)
  const stopWatchingSettings = automaticLearning.watch((next, previous) => {
    if (!previous.automaticLearning && next.automaticLearning) factory.wakeLearning()
  })
  const lifecycle = new RecoveryLifecycle(factory, candidateKey, notices)
  const ingress = new SessionCoordinateIngress(
    candidate => { lifecycle.accept(candidate) },
    health => { notices.record({ healthCode: health.code, sessionId: 'global' }) },
  )
  let accepting = true

  context.on('session/event', (session: DshSessionProjection, event: DshSessionEvent) => {
    if (accepting) ingress.observe(session.header, event)
  })
  context.on('agent/pre-step', async ({ agent, step }: AgentPreStepPayload, next: () => Promise<unknown>) => {
    if (accepting && !scopeDisposers.has(agent)) {
      let disposeScope: (() => void) | undefined
      try {
        disposeScope = scopes.register(agent)
        await factory.captureRootConfiguration(agent)
        scopeDisposers.set(agent, disposeScope)
        factory.wakeLearning()
        factory.wakePublication()
        factory.wakeCuration()
      } catch {
        disposeScope?.()
        notices.record({ healthCode: 'AGENT_SCOPE_UNAVAILABLE', sessionId: agent.id || 'global' })
      }
    }
    if (
      accepting
      && step === 1
      && agent.id.length > 0
      && agent.session.header.id === agent.id
    ) {
      try {
        const runtime = factory.currentV2Runtime
        if (runtime !== undefined) {
          await ingress.whenDispatched()
          await lifecycle.whenIdle()
          const capture = lifecycle.snapshot()
          if (
            capture.status !== 'READY'
            || capture.recoveryLag
            || capture.catchupNeeded
            || capture.queueDepth > 0
          ) throw new Error('V2_CAPTURE_NOT_CAUGHT_UP')
          const header = agent.session.header
          await runtime.pipeline.prepareSessionWindow(deriveSessionLifecycleKey({
            rootSessionId: header.id,
            sessionCreatedAt: header.createdAt,
            sessionCwdDigest: deriveSessionCwdDigest(header.cwd),
          }))
        }
      } catch {
        notices.record({ healthCode: 'V2_BASELINE_UNAVAILABLE', sessionId: agent.id })
      }
    }
    return await next()
  })
  context.on('agent/disposed', ({ agent }: AgentDisposedPayload) => {
    scopeDisposers.get(agent)?.()
    scopeDisposers.delete(agent)
    factory.releaseRootConfiguration(agent)
    factory.wakeLearning()
  })

  const readSummary = (): ObserveSummaryV1 => {
    return v2Summary(factory.currentV2Domain, lifecycle, notices)
  }
  const resolveCurrentWorkspace = (workspaceId: string) => factory.resolveCurrentWorkspace(workspaceId)
  const unavailableV2Rpc: ObserveSummaryRpcHandler = async () => ({
    ok: false,
    error: { code: 'internal', message: 'run2skill v2 unavailable', details: {} },
  })
  const v2Authorizer = new V2CurrentScopeAuthorizer(resolveCurrentWorkspace)
  const v2LearningRpc: ObserveSummaryRpcHandler = async (endpoint, payload, signal) => {
    const attention = factory.currentV2Runtime?.attention
    return attention === undefined
      ? await unavailableV2Rpc(endpoint, payload, signal)
      : await attention.handler(unavailableV2Rpc)(endpoint, payload, signal)
  }
  const v2ProposalRpc = createV2ProposalRpcHandler(
    () => factory.currentV2Domain,
    {
      authorizer: v2Authorizer,
      reviews: domain => factory.currentV2Domain === domain
        ? factory.currentV2Runtime?.proposals.reviews
        : undefined,
      present: async input => {
        const presenter = factory.currentV2Runtime?.proposals.presenter
        if (presenter === undefined) throw new Error('V2_PROPOSAL_PRESENTER_UNAVAILABLE')
        return await presenter.present(input)
      },
      publications: domain => factory.currentV2Domain === domain
        ? factory.currentV2Runtime?.proposals.publications
        : undefined,
      refreshes: domain => factory.currentV2Domain === domain
        ? factory.currentV2Runtime?.proposals.refreshes
        : undefined,
      readHealth: () => {
        const snapshot = lifecycle.snapshot()
        return {
          status: lifecycle.status === 'READY'
            ? 'READY'
            : lifecycle.status === 'RECOVERING'
              ? 'RECOVERING'
              : 'DEGRADED',
          recoveryLag: snapshot.recoveryLag,
          ...(notices.list().at(-1)?.healthCode === undefined
            ? {}
            : { lastHealthCode: notices.list().at(-1)!.healthCode }),
        }
      },
      runtimeAttention: sessionId => projectRuntimeAttention(notices, sessionId),
      learningActions: async currentScope => await (factory.currentV2Runtime?.attention.project(currentScope) ?? []),
    },
    v2LearningRpc,
  )
  const v2Rpc = createV2RecentSkillActivityRpcHandler(
    () => factory.currentV2Domain,
    resolveCurrentWorkspace,
    createPurgeRpcHandler(
      () => factory.currentV2Runtime?.purge,
      v2ProposalRpc,
      { runMutation: operation => mutationGate.run(operation) },
    ),
  )
  const disposeRpc = registerObserveSummaryRpc(
    context.connection,
    readSummary,
    v2Rpc,
  )

  try {
    await lifecycle.start()
  } catch (error) {
    stopWatchingSettings()
    throw error
  }
  return async () => {
    accepting = false
    stopWatchingSettings()
    try {
      await disposeRpc()
    } finally {
      try {
        await lifecycle.dispose()
      } finally {
        scopes.clear()
      }
    }
  }
}
