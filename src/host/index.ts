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
import { classifySessionRoot } from '../adapters/dsh-session/observation.js'
import type {
  DshSessionEvent,
  DshSessionHeader,
  SessionPersistencePort,
  TurnIngressCandidate,
} from '../adapters/dsh-session/types.js'
import { SessionCoordinateIngress } from '../adapters/dsh-session/ingress.js'
import { registerObserveSummaryRpc, type ObserveSummaryHostConnection } from '../adapters/dsh-connection/observe-summary-rpc.js'
import { createProposalReviewRpcHandler } from '../adapters/dsh-connection/proposal-review-rpc.js'
import { openRun2skillDomain } from '../adapters/dsh-storage/domain.js'
import { DurableCaptureStore } from '../adapters/dsh-storage/durable-capture-store.js'
import type { Run2skillDomain, Run2skillStorageContext } from '../adapters/dsh-storage/types.js'
import { DshWorkspaceBindingResolver, type DshWorkspaceRegistryPort } from '../adapters/dsh-workspace/binding.js'
import { BoundedGapScanner } from '../application/capture/bounded-gap-scanner.js'
import { DurableCaptureCoordinator } from '../application/capture/durable-capture-coordinator.js'
import {
  RecoveryLifecycle,
  type RecoveryRuntime,
  type RecoveryRuntimeFactory,
} from '../application/capture/recovery-lifecycle.js'
import { RuntimeNotices } from '../application/capture/runtime-notices.js'
import { TurnCaptureProcessor } from '../application/capture/turn-capture-processor.js'
import { WriteBehindCheckpoint } from '../application/capture/write-behind-checkpoint.js'
import { createObserveSummary } from '../application/observe-summary.js'
import {
  LearningScheduler,
  LearningWorker,
  type LearningSkillView,
} from '../application/learn/index.js'
import { ObserveSummaryV1Schema, type ObserveSummaryV1 } from '../domain/observe/observe-summary.js'
import { deriveSessionCwdDigest, deriveSessionLifecycleKey } from '../domain/observe/signal-key.js'
import { normalize, resolve } from 'node:path'
import { NodePublicationFactsAdapter } from '../adapters/dsh-publication/publication-facts.js'
import { C5PublicationFileSystemAdapter } from '../adapters/dsh-publication/publication-filesystem.js'
import { PublicationSagaStore } from '../adapters/dsh-storage/publication-saga-store.js'
import { ProposalSnapshotBuilder } from '../application/curation/index.js'
import {
  ApprovalPublicationSaga,
  ApprovedProposalRevalidator,
  PublicationScheduler,
} from '../application/publication/index.js'
import { DshPublicationReadbackAdapter } from '../adapters/dsh-skills/publication-readback.js'
import {
  StockDshRootContractResolver,
  deriveStockResolutionContractDigest,
  resolveStockSkillRuntimeConfiguration,
  resolveStockSessionPreset,
  type StockLoaderProjection,
} from '../adapters/dsh-skills/stock-root-contract.js'
import type { CaptureWorkItemV1 } from '../domain/observe/schemas.js'

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
  'loader',
  'sessions',
  'sessionPersistence',
  'storageDomain',
  'workspaceRegistry',
  'connection',
  'llm',
  'skills',
] as const

interface DshSessionProjection {
  readonly header: DshSessionHeader
}

type Run2skillAgent = object & AgentScopeProjection

interface AgentPreStepPayload {
  readonly agent: Run2skillAgent
}

interface AgentDisposedPayload {
  readonly agent: Run2skillAgent
}

export interface Run2skillHostContext extends Run2skillStorageContext {
  readonly loader: StockLoaderProjection
  readonly sessions: unknown
  readonly sessionPersistence: SessionPersistencePort
  readonly workspaceRegistry: DshWorkspaceRegistryPort
  readonly connection: ObserveSummaryHostConnection
  readonly llm: DshLlmPort
  readonly skills: DshSkillRegistryPort<LearningSkillView<Run2skillAgent>>
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

class Run2skillRuntimeFactory implements RecoveryRuntimeFactory {
  currentDomain: Run2skillDomain | undefined
  currentScheduler: LearningScheduler | undefined
  currentPublicationScheduler: PublicationScheduler | undefined

  constructor(
    private readonly context: Run2skillHostContext,
    private readonly notices: RuntimeNotices,
    private readonly scopes: ExactAgentScopeRegistry<Run2skillAgent>,
  ) {}

  wakeLearning(): void {
    this.currentScheduler?.wake()
  }

  wakePublication(): void {
    this.currentPublicationScheduler?.wake()
  }

  async open(): Promise<RecoveryRuntime> {
    const domain = await openRun2skillDomain(this.context)
    this.currentDomain = domain
    try {
      const checkpoint = new WriteBehindCheckpoint(domain)
      const reader = new DshSessionGapReader(this.context.sessionPersistence)
      const store = new DurableCaptureStore(domain)
      const learningStore = new LearningWorkItemStore(domain)
      const skillCatalog = new DshSkillCatalogAdapter(this.context.skills)
      const workspaceResolver = new DshWorkspaceBindingResolver(this.context.workspaceRegistry)
      const publicationAbort = new AbortController()
      const publicationView = (item: CaptureWorkItemV1): LearningSkillView<Run2skillAgent> | undefined => {
        const scope = this.scopes.resolve(item)
        return scope.status === 'UNAVAILABLE'
          ? undefined
          : {
              ...(scope.cwd === undefined ? {} : { cwd: scope.cwd }),
              scope: scope.agent,
              signal: publicationAbort.signal,
            }
      }
      const publicationFacts = new NodePublicationFactsAdapter()
      const stockRootResolver = new StockDshRootContractResolver()
      const rootContract = {
        resolve: (input: {
          readonly scope: 'PROJECT' | 'USER'
          readonly workspaceBinding?: { readonly workspaceId: string; readonly canonicalPath: string } | undefined
          readonly view: LearningSkillView<Run2skillAgent>
        }) => {
          const configuration = resolveStockSkillRuntimeConfiguration(
            this.context.loader,
            input.view.scope,
            resolveStockSessionPreset(input.view.scope.session),
          )
          if (configuration === undefined) {
            return { status: 'UNSUPPORTED' as const, code: 'ROOT_CONTRACT_UNSUPPORTED' as const }
          }
          return stockRootResolver.resolve({
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
      const publicationStore = new PublicationSagaStore(domain)
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
        readback: new DshPublicationReadbackAdapter(skillCatalog, publicationView),
      })
      const publicationScheduler = new PublicationScheduler({
        store: publicationStore,
        worker: publicationSaga,
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
      })
      const scheduler = new LearningScheduler({ store: learningStore, worker, notices: this.notices })
      this.currentScheduler = scheduler
      const coordinator = new DurableCaptureCoordinator(store, checkpoint, this.notices)
      const processor = new TurnCaptureProcessor(
        coordinator,
        this.notices,
        workspaceResolver,
      )
      const scanner = new BoundedGapScanner(reader, checkpoint, processor, this.notices)
      const checkpointTimer = setInterval(() => {
        void checkpoint.flushIfDue().catch(() => {
          this.notices.record({ healthCode: 'CHECKPOINT_WRITE_FAILED', sessionId: 'global' })
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
          publicationAbort.abort()
          if (this.currentDomain === domain) this.currentDomain = undefined
          try {
            await publicationScheduler.dispose()
          } finally {
            try {
              await scheduler.dispose()
            } finally {
              await domain.close()
            }
          }
        },
      }
      await publicationScheduler.start()
      await scheduler.start()
      return runtime
    } catch (error) {
      this.currentScheduler = undefined
      this.currentPublicationScheduler = undefined
      if (this.currentDomain === domain) this.currentDomain = undefined
      await domain.close()
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

export async function apply(context: Run2skillHostContext): Promise<() => Promise<void>> {
  const notices = new RuntimeNotices()
  const scopes = new ExactAgentScopeRegistry<Run2skillAgent>()
  const scopeDisposers = new WeakMap<Run2skillAgent, () => void>()
  const factory = new Run2skillRuntimeFactory(context, notices, scopes)
  const lifecycle = new RecoveryLifecycle(factory, candidateKey, notices)
  const ingress = new SessionCoordinateIngress(
    candidate => { lifecycle.accept(candidate) },
    health => { notices.record({ healthCode: health.code, sessionId: 'global' }) },
  )
  let accepting = true

  context.on('session/event', (session: DshSessionProjection, event: DshSessionEvent) => {
    if (accepting) ingress.observe(session.header, event)
  })
  context.on('agent/pre-step', async ({ agent }: AgentPreStepPayload, next: () => Promise<unknown>) => {
    if (accepting && !scopeDisposers.has(agent)) {
      try {
        scopeDisposers.set(agent, scopes.register(agent))
        factory.wakeLearning()
        factory.wakePublication()
      } catch {
        notices.record({ healthCode: 'AGENT_SCOPE_UNAVAILABLE', sessionId: agent.id || 'global' })
      }
    }
    return await next()
  })
  context.on('agent/disposed', ({ agent }: AgentDisposedPayload) => {
    scopeDisposers.get(agent)?.()
    scopeDisposers.delete(agent)
  })

  const readSummary = (): ObserveSummaryV1 => {
    const domain = factory.currentDomain
    return domain === undefined
      ? unavailableSummary(lifecycle, notices)
      : createObserveSummary({
          domain,
          lifecycle: lifecycle.snapshot(),
          notices,
          compatibility: 'COMPATIBLE',
        })
  }
  const disposeRpc = registerObserveSummaryRpc(
    context.connection,
    readSummary,
    createProposalReviewRpcHandler(() => factory.currentDomain, () => {
      const summary = readSummary()
      return {
        status: summary.status,
        recoveryLag: summary.recoveryLag,
        ...(summary.lastHealthCode === undefined ? {} : { lastHealthCode: summary.lastHealthCode }),
      }
    }, { onPublicationRequested: () => { factory.wakePublication() } }),
  )

  await lifecycle.start()
  return async () => {
    accepting = false
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
