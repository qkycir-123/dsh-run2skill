import { DshSessionGapReader } from '../adapters/dsh-session/gap-reader.js'
import { classifySessionRoot } from '../adapters/dsh-session/observation.js'
import type {
  DshSessionEvent,
  DshSessionHeader,
  SessionPersistencePort,
  TurnIngressCandidate,
} from '../adapters/dsh-session/types.js'
import { SessionCoordinateIngress } from '../adapters/dsh-session/ingress.js'
import { registerObserveSummaryRpc, type ObserveSummaryHostConnection } from '../adapters/dsh-connection/observe-summary-rpc.js'
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
import { ObserveSummaryV1Schema, type ObserveSummaryV1 } from '../domain/observe/observe-summary.js'
import { deriveSessionCwdDigest, deriveSessionLifecycleKey } from '../domain/observe/signal-key.js'

export const name = 'run2skill'
export const inject = [
  'sessions',
  'sessionPersistence',
  'storageDomain',
  'workspaceRegistry',
  'connection',
] as const

interface DshSessionProjection {
  readonly header: DshSessionHeader
}

export interface Run2skillHostContext extends Run2skillStorageContext {
  readonly sessions: unknown
  readonly sessionPersistence: SessionPersistencePort
  readonly workspaceRegistry: DshWorkspaceRegistryPort
  readonly connection: ObserveSummaryHostConnection
  on(
    event: 'session/event',
    listener: (session: DshSessionProjection, event: DshSessionEvent) => void,
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

  constructor(
    private readonly context: Run2skillHostContext,
    private readonly notices: RuntimeNotices,
  ) {}

  async open(): Promise<RecoveryRuntime> {
    const domain = await openRun2skillDomain(this.context)
    this.currentDomain = domain
    try {
      const checkpoint = new WriteBehindCheckpoint(domain)
      const reader = new DshSessionGapReader(this.context.sessionPersistence)
      const store = new DurableCaptureStore(domain)
      const coordinator = new DurableCaptureCoordinator(store, checkpoint, this.notices)
      const processor = new TurnCaptureProcessor(
        coordinator,
        this.notices,
        new DshWorkspaceBindingResolver(this.context.workspaceRegistry),
      )
      const scanner = new BoundedGapScanner(reader, checkpoint, processor, this.notices)
      const checkpointTimer = setInterval(() => {
        void checkpoint.flushIfDue().catch(() => {
          this.notices.record({ healthCode: 'CHECKPOINT_WRITE_FAILED', sessionId: 'global' })
        })
      }, 30_000)

      let closed = false
      return {
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
          if (current === undefined || candidate.turnEndSeq < current.activationFenceSeq) return
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
        },
        close: async () => {
          if (closed) return
          closed = true
          clearInterval(checkpointTimer)
          if (this.currentDomain === domain) this.currentDomain = undefined
          await domain.close()
        },
      }
    } catch (error) {
      if (this.currentDomain === domain) this.currentDomain = undefined
      await domain.close()
      throw error
    }
  }
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
  const factory = new Run2skillRuntimeFactory(context, notices)
  const lifecycle = new RecoveryLifecycle(factory, candidateKey, notices)
  const ingress = new SessionCoordinateIngress(
    candidate => { lifecycle.accept(candidate) },
    health => { notices.record({ healthCode: health.code, sessionId: 'global' }) },
  )
  let accepting = true

  context.on('session/event', (session, event) => {
    if (accepting) ingress.observe(session.header, event)
  })

  const disposeRpc = registerObserveSummaryRpc(context.connection, () => {
    const domain = factory.currentDomain
    return domain === undefined
      ? unavailableSummary(lifecycle, notices)
      : createObserveSummary({
          domain,
          lifecycle: lifecycle.snapshot(),
          notices,
          compatibility: 'COMPATIBLE',
        })
  })

  await lifecycle.start()
  return async () => {
    accepting = false
    try {
      await disposeRpc()
    } finally {
      await lifecycle.dispose()
    }
  }
}
