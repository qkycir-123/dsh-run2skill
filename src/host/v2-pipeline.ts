import type { DshLlmPort } from '../adapters/dsh-llm/restricted-learning-client.js'
import { DshV2RouteSnapshotAdapter } from '../adapters/dsh-llm/v2-route-snapshot.js'
import { DshV2StageLlmClient } from '../adapters/dsh-llm/v2-stage-client.js'
import type { DshTurnObservationV2Result } from '../adapters/dsh-session/v2-turn-observation.js'
import { projectDshTurnObservationV2 } from '../adapters/dsh-session/v2-turn-observation.js'
import type { DshSessionEvent, DshSessionHeader } from '../adapters/dsh-session/types.js'
import type { Run2skillV2Domain } from '../adapters/dsh-storage/v2-types.js'
import { SessionBatchCoordinator, SessionBatchScheduler } from '../application/batch/index.js'
import { CompleteCoverageWorker } from '../application/coverage-analysis/index.js'
import { BatchDetectorWorker } from '../application/detection/index.js'
import { GenerationWorker, type GenerationCatalogPort } from '../application/generation/index.js'
import { AgentFirstOwnershipCoordinator, type OwnershipObservationPort } from '../application/ownership/index.js'
import { Run2skillV2PipelineRuntime } from '../application/pipeline/index.js'
import { SessionQuiescenceCoordinator, type SessionActivityObservationPort } from '../application/quiescence/index.js'
import { CompleteCatalogRecallWorker, type CompleteRecallCatalogPort } from '../application/recall/index.js'
import type { WorkspaceBindingPort } from '../application/capture/turn-capture-processor.js'
import type { SessionBatchV2 } from '../domain/v2/index.js'

export interface DshV2PipelineCatalogPorts {
  readonly recall: CompleteRecallCatalogPort
  readonly generation: GenerationCatalogPort
}

export interface DshV2PipelineRuntimeOptions {
  readonly llm: DshLlmPort
  readonly baseline: {
    capture(sessionLifecycleKey: string): Promise<SessionBatchV2['batchManifestBaseline']>
  }
  readonly activity: SessionActivityObservationPort
  readonly ownership: OwnershipObservationPort
  readonly catalog: DshV2PipelineCatalogPorts
  readonly onError?: (error: unknown) => void
  readonly now?: () => number
  /** @internal Deterministic clock adapter for Host assembly tests. */
  readonly internalTimer?: {
    readonly set: (callback: () => void, delay: number) => unknown
    readonly clear: (handle: unknown) => void
  }
}

/**
 * Fully assembles the v2 workers, but does not perform migration or enable the
 * Host path. Production cutover must construct this only after v2 migration is
 * durably COMMITTED and the legacy mutation gate is sealed.
 */
export class DshV2PipelineRuntime {
  readonly #runtime: Run2skillV2PipelineRuntime

  constructor(
    domain: Run2skillV2Domain,
    options: DshV2PipelineRuntimeOptions,
  ) {
    const stageClient = new DshV2StageLlmClient(options.llm)
    const routeSnapshot = new DshV2RouteSnapshotAdapter(options.llm)
    const coordinator = new SessionBatchCoordinator(domain, {
      captureBaseline: sessionLifecycleKey => options.baseline.capture(sessionLifecycleKey),
      captureRouteSnapshot: (sessionLifecycleKey, observations) => (
        routeSnapshot.capture(sessionLifecycleKey, observations)
      ),
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    let wakePipeline = (): void => undefined
    const batchScheduler = new SessionBatchScheduler({
      coordinator,
      onIdleBatchFrozen: () => { wakePipeline() },
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    const quiescence = new SessionQuiescenceCoordinator(domain, {
      activity: options.activity,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    const detector = new BatchDetectorWorker(domain, {
      client: stageClient,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    const ownership = new AgentFirstOwnershipCoordinator(domain, {
      observation: options.ownership,
      quiescence,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    const recall = new CompleteCatalogRecallWorker(domain, {
      catalog: options.catalog.recall,
      classifier: { classify: input => stageClient.classifyCatalog(input) },
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    const coverage = new CompleteCoverageWorker(domain, {
      catalog: options.catalog.recall,
      classifier: { classify: input => stageClient.classifyCoverage(input) },
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    const generation = new GenerationWorker(domain, {
      catalog: options.catalog.generation,
      quiescence,
      generator: { generate: input => stageClient.generate(input) },
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    const stages = [detector, quiescence, ownership, recall, coverage, generation]
    this.#runtime = new Run2skillV2PipelineRuntime({
      batchScheduler,
      stages,
      recoveryOrder: [generation, detector, ownership, recall, coverage],
      nextWakeAt: () => quiescence.nextEligibleAt(),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.internalTimer === undefined ? {} : {
        setTimer: options.internalTimer.set,
        clearTimer: options.internalTimer.clear,
      }),
    })
    wakePipeline = () => { this.#runtime.wake() }
  }

  start(): Promise<void> { return this.#runtime.start() }

  prepareSessionWindow(sessionLifecycleKey: string): Promise<void> {
    return this.#runtime.prepareSessionWindow(sessionLifecycleKey)
  }

  observe(observation: Parameters<Run2skillV2PipelineRuntime['observe']>[0]): Promise<void> {
    return this.#runtime.observe(observation)
  }

  async observeTurn(
    header: DshSessionHeader,
    events: readonly DshSessionEvent[],
    turnEndSeq: number,
    workspace: WorkspaceBindingPort,
    recovery?: { readonly headerRevision: string; readonly observedLogPrefixDigest: string },
  ): Promise<DshTurnObservationV2Result> {
    const projected = await projectDshTurnObservationV2(
      header,
      events,
      turnEndSeq,
      workspace,
      recovery,
    )
    if (projected.status === 'OBSERVED') await this.#runtime.observe(projected.observation)
    return projected
  }

  wake(): void { this.#runtime.wake() }
  settle(): Promise<void> { return this.#runtime.settle() }
  dispose(): Promise<void> { return this.#runtime.dispose() }
}

export function createDshV2PipelineRuntime(
  domain: Run2skillV2Domain,
  options: DshV2PipelineRuntimeOptions,
): DshV2PipelineRuntime {
  return new DshV2PipelineRuntime(domain, options)
}
