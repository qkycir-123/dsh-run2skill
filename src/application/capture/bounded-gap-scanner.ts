import { DshSessionGapReader } from '../../adapters/dsh-session/gap-reader.js'
import {
  classifySessionRoot,
} from '../../adapters/dsh-session/observation.js'
import type {
  DshSessionEvent,
  DshSessionHeader,
  SessionPersistenceSnapshot,
} from '../../adapters/dsh-session/types.js'
import type { SessionCheckpointV1 } from '../../domain/observe/schemas.js'
import {
  deriveSessionCwdDigest,
  deriveSessionLifecycleKey,
} from '../../domain/observe/signal-key.js'
import type { RuntimeNotices } from './runtime-notices.js'
import type { WriteBehindCheckpoint } from './write-behind-checkpoint.js'

export const GAP_SCAN_MAX_SESSIONS = 64
export const GAP_SCAN_MAX_EVENTS = 10_000
export const GAP_SCAN_TIME_SLICE_MS = 50

export interface GapTurnInput {
  readonly header: DshSessionHeader
  readonly events: readonly DshSessionEvent[]
  readonly turnEndSeq: number
  readonly progress: SessionCheckpointV1
}

export interface GapTurnSink {
  processTurn(input: GapTurnInput): Promise<void>
}

export interface GapScanMetrics {
  readonly processedSessions: number
  readonly processedEvents: number
  readonly maxReadFromLatencyMs: number
  readonly peakHeapBytes: number
}

export type GapScanResult = GapScanMetrics & (
  | { readonly status: 'COMPLETE' }
  | { readonly status: 'MORE'; readonly cursor: { readonly lifecycleKey: string; readonly nextSeq: number } }
  | { readonly status: 'UNAVAILABLE'; readonly healthCode: string }
)

interface RootSnapshot {
  readonly snapshot: SessionPersistenceSnapshot
  readonly lifecycleKey: string
  readonly checkpoint: SessionCheckpointV1
}

function tailNextSeq(events: readonly DshSessionEvent[]): number | undefined {
  if (events.length === 0) return 0
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]?.seq !== index) return undefined
  }
  const tail = events.at(-1)?.seq
  return tail === undefined ? 0 : tail + 1
}

function observedTail(tailNext: number): number {
  return Math.max(0, tailNext - 1)
}

function rootSnapshot(
  snapshot: SessionPersistenceSnapshot,
  activationFenceSeq: number,
  headerRevision?: string,
): RootSnapshot | undefined {
  if (classifySessionRoot(snapshot.header).status !== 'ROOT') return undefined
  try {
    const checkpoint: SessionCheckpointV1 = {
      rootSessionId: snapshot.header.id,
      sessionCreatedAt: snapshot.header.createdAt,
      sessionCwdDigest: deriveSessionCwdDigest(snapshot.header.cwd),
      triggerPolicyVersion: 'cheap-trigger-v1',
      activationFenceSeq,
      durableNextSeq: activationFenceSeq,
      observedTailSeq: observedTail(activationFenceSeq),
      ...(headerRevision === undefined ? {} : { headerRevision }),
    }
    return {
      snapshot,
      lifecycleKey: deriveSessionLifecycleKey({
        rootSessionId: checkpoint.rootSessionId,
        sessionCreatedAt: checkpoint.sessionCreatedAt,
        sessionCwdDigest: checkpoint.sessionCwdDigest,
      }),
      checkpoint,
    }
  } catch {
    return undefined
  }
}

export class BoundedGapScanner {
  readonly #now
  readonly #heapUsed
  readonly #yieldNow

  constructor(
    private readonly reader: DshSessionGapReader,
    private readonly checkpoint: WriteBehindCheckpoint,
    private readonly sink: GapTurnSink,
    private readonly notices: RuntimeNotices,
    options: {
      now?: () => number
      heapUsed?: () => number
      yieldNow?: () => Promise<void>
    } = {},
  ) {
    this.#now = options.now ?? Date.now
    this.#heapUsed = options.heapUsed ?? (() => process.memoryUsage().heapUsed)
    this.#yieldNow = options.yieldNow ?? (() => new Promise((resolve) => setTimeout(resolve, 0)))
  }

  async ensureActivated(signal?: AbortSignal): Promise<GapScanResult> {
    if (this.checkpoint.snapshot().lastSuccessfulStoreWriteAt !== undefined) {
      return this.#result('COMPLETE', 0, 0, 0, this.#heapUsed())
    }
    const listed = await this.reader.listSnapshots(signal)
    if (listed.status === 'UNAVAILABLE') {
      this.#record(listed.healthCode, 'global')
      return this.#result('UNAVAILABLE', 0, 0, 0, this.#heapUsed(), listed.healthCode)
    }

    const activation: SessionCheckpointV1[] = []
    let processedSessions = 0
    let processedEvents = 0
    let maxReadFromLatencyMs = 0
    let peakHeapBytes = this.#heapUsed()
    let sliceStartedAt = this.#now()
    let sliceSessions = 0
    let sliceEvents = 0

    for (const snapshot of listed.snapshots) {
      signal?.throwIfAborted()
      if (classifySessionRoot(snapshot.header).status !== 'ROOT') continue
      const readStartedAt = this.#now()
      const read = await this.reader.readFrom(snapshot.header.id, 0, signal)
      maxReadFromLatencyMs = Math.max(maxReadFromLatencyMs, this.#now() - readStartedAt)
      peakHeapBytes = Math.max(peakHeapBytes, this.#heapUsed())
      if (read.status === 'UNAVAILABLE') {
        this.#record(read.healthCode, snapshot.header.id)
        return this.#result(
          'UNAVAILABLE', processedSessions, processedEvents,
          maxReadFromLatencyMs, peakHeapBytes, read.healthCode,
        )
      }
      const tailNext = tailNextSeq(read.events)
      if (tailNext === undefined) {
        this.#record('SESSION_LOG_UNAVAILABLE', snapshot.header.id)
        return this.#result(
          'UNAVAILABLE', processedSessions, processedEvents,
          maxReadFromLatencyMs, peakHeapBytes, 'SESSION_LOG_UNAVAILABLE',
        )
      }
      const root = rootSnapshot(snapshot, tailNext, snapshot.revision)
      if (root === undefined) {
        this.#record('ROOT_IDENTITY_UNAVAILABLE', 'global')
        return this.#result(
          'UNAVAILABLE', processedSessions, processedEvents,
          maxReadFromLatencyMs, peakHeapBytes, 'ROOT_IDENTITY_UNAVAILABLE',
        )
      }
      activation.push(root.checkpoint)
      processedSessions += 1
      processedEvents += read.events.length
      sliceSessions += 1
      sliceEvents += read.events.length
      if (
        sliceSessions >= GAP_SCAN_MAX_SESSIONS
        || sliceEvents >= GAP_SCAN_MAX_EVENTS
        || this.#now() - sliceStartedAt >= GAP_SCAN_TIME_SLICE_MS
      ) {
        await this.#yieldNow()
        sliceStartedAt = this.#now()
        sliceSessions = 0
        sliceEvents = 0
      }
    }

    await this.checkpoint.activate(activation)
    return this.#result(
      'COMPLETE', processedSessions, processedEvents,
      maxReadFromLatencyMs, peakHeapBytes,
    )
  }

  async scanBatch(signal?: AbortSignal): Promise<GapScanResult> {
    const activation = await this.ensureActivated(signal)
    if (activation.status !== 'COMPLETE' || activation.processedSessions > 0) return activation
    const listed = await this.reader.listSnapshots(signal)
    if (listed.status === 'UNAVAILABLE') {
      this.#record(listed.healthCode, 'global')
      return this.#result('UNAVAILABLE', 0, 0, 0, this.#heapUsed(), listed.healthCode)
    }

    let state = this.checkpoint.snapshot()
    const roots: RootSnapshot[] = []
    for (const snapshot of listed.snapshots) {
      const classification = classifySessionRoot(snapshot.header)
      if (classification.status === 'CHILD') continue
      const root = classification.status === 'ROOT' ? rootSnapshot(snapshot, 0) : undefined
      if (root === undefined) {
        this.#record('ROOT_IDENTITY_UNAVAILABLE', 'global')
        return this.#result(
          'UNAVAILABLE', 0, 0, 0, this.#heapUsed(), 'ROOT_IDENTITY_UNAVAILABLE',
        )
      }
      roots.push(root)
    }
    roots.sort((left, right) => left.lifecycleKey.localeCompare(right.lifecycleKey))
    let changed = roots.filter(({ snapshot, lifecycleKey }) => (
      state.sessions[lifecycleKey]?.headerRevision !== snapshot.revision
    ))
    if (changed.length === 0) {
      await this.checkpoint.setRecoveryCursor()
      return this.#result('COMPLETE', 0, 0, 0, this.#heapUsed())
    }

    const registrations = changed
      .slice(0, GAP_SCAN_MAX_SESSIONS + 1)
      .filter(({ lifecycleKey }) => state.sessions[lifecycleKey] === undefined)
      .map(({ checkpoint }) => checkpoint)
    if (registrations.length > 0) {
      await this.checkpoint.activate(registrations)
      state = this.checkpoint.snapshot()
    }

    let processedSessions = 0
    let processedEvents = 0
    let maxReadFromLatencyMs = 0
    let peakHeapBytes = this.#heapUsed()
    const batchStartedAt = this.#now()

    for (const root of changed) {
      if (
        processedSessions >= GAP_SCAN_MAX_SESSIONS
        || processedEvents >= GAP_SCAN_MAX_EVENTS
      ) break
      signal?.throwIfAborted()
      let current = this.checkpoint.snapshot().sessions[root.lifecycleKey]
      if (current === undefined) break
      const readStartedAt = this.#now()
      const read = await this.reader.readFrom(root.snapshot.header.id, 0, signal)
      maxReadFromLatencyMs = Math.max(maxReadFromLatencyMs, this.#now() - readStartedAt)
      peakHeapBytes = Math.max(peakHeapBytes, this.#heapUsed())
      if (read.status === 'UNAVAILABLE') {
        this.#record(read.healthCode, root.snapshot.header.id)
        await this.checkpoint.setRecoveryCursor({
          lifecycleKey: root.lifecycleKey,
          nextSeq: current.durableNextSeq,
        })
        return this.#result(
          'UNAVAILABLE', processedSessions, processedEvents,
          maxReadFromLatencyMs, peakHeapBytes, read.healthCode,
        )
      }
      const tailNext = tailNextSeq(read.events)
      if (tailNext === undefined) {
        this.#record('SESSION_LOG_UNAVAILABLE', root.snapshot.header.id)
        await this.checkpoint.setRecoveryCursor({
          lifecycleKey: root.lifecycleKey,
          nextSeq: current.durableNextSeq,
        })
        return this.#result(
          'UNAVAILABLE', processedSessions, processedEvents,
          maxReadFromLatencyMs, peakHeapBytes, 'SESSION_LOG_UNAVAILABLE',
        )
      }
      if (current.durableNextSeq > tailNext) {
        await this.checkpoint.rollbackToDurableTail(root.lifecycleKey, tailNext)
        current = this.checkpoint.snapshot().sessions[root.lifecycleKey]
        if (current === undefined) throw new Error('Session checkpoint disappeared after rollback')
      }

      processedSessions += 1
      const fromSeq = Math.max(current.activationFenceSeq, current.durableNextSeq)
      const remainingBudget = GAP_SCAN_MAX_EVENTS - processedEvents
      const suffix = read.events.filter((event) => event.seq >= fromSeq)
      const window = suffix.slice(0, remainingBudget)
      const lastTurnEndSeq = suffix.findLast((event) => event.type === 'turn/end')?.seq
      processedEvents += window.length
      let turnSliceStart = 0

      for (let index = 0; index < window.length; index += 1) {
        const event = window[index]
        if (event?.type !== 'turn/end') continue
        const turnEvents = window.slice(turnSliceStart, index + 1)
        const hasLaterTurnEnd = event.seq !== lastTurnEndSeq
        const progress: SessionCheckpointV1 = {
          ...current,
          durableNextSeq: event.seq + 1,
          observedTailSeq: Math.max(current.observedTailSeq, observedTail(tailNext)),
          lastScannedAt: new Date(this.#now()).toISOString(),
          ...(hasLaterTurnEnd ? {} : { headerRevision: root.snapshot.revision }),
        }
        await this.sink.processTurn({
          header: read.header,
          events: turnEvents,
          turnEndSeq: event.seq,
          progress,
        })
        current = progress
        turnSliceStart = index + 1
      }

      const exhaustedWindow = window.length < suffix.length
      if (!exhaustedWindow) {
        const latest = this.checkpoint.snapshot().sessions[root.lifecycleKey] ?? current
        if (latest.headerRevision !== root.snapshot.revision) {
          await this.checkpoint.observeCompletedRoot({
            ...latest,
            observedTailSeq: Math.max(latest.observedTailSeq, observedTail(tailNext)),
            lastScannedAt: new Date(this.#now()).toISOString(),
            headerRevision: root.snapshot.revision,
          })
        }
      }
      if (this.#now() - batchStartedAt >= GAP_SCAN_TIME_SLICE_MS) break
    }

    state = this.checkpoint.snapshot()
    changed = roots.filter(({ snapshot, lifecycleKey }) => (
      state.sessions[lifecycleKey]?.headerRevision !== snapshot.revision
    ))
    const next = changed[0]
    if (next === undefined) {
      await this.checkpoint.setRecoveryCursor()
      return this.#result(
        'COMPLETE', processedSessions, processedEvents,
        maxReadFromLatencyMs, peakHeapBytes,
      )
    }
    if (state.sessions[next.lifecycleKey] === undefined) {
      await this.checkpoint.activate([next.checkpoint])
      state = this.checkpoint.snapshot()
    }
    const cursor = {
      lifecycleKey: next.lifecycleKey,
      nextSeq: state.sessions[next.lifecycleKey]?.durableNextSeq ?? 0,
    }
    await this.checkpoint.setRecoveryCursor(cursor)
    return {
      status: 'MORE',
      cursor,
      processedSessions,
      processedEvents,
      maxReadFromLatencyMs,
      peakHeapBytes,
    }
  }

  #record(healthCode: string, sessionId: string): void {
    this.notices.record({ healthCode, sessionId })
  }

  #result(
    status: 'COMPLETE' | 'UNAVAILABLE',
    processedSessions: number,
    processedEvents: number,
    maxReadFromLatencyMs: number,
    peakHeapBytes: number,
    healthCode?: string,
  ): GapScanResult {
    if (status === 'UNAVAILABLE') {
      return {
        status,
        healthCode: healthCode ?? 'RECOVERY_UNAVAILABLE',
        processedSessions,
        processedEvents,
        maxReadFromLatencyMs,
        peakHeapBytes,
      }
    }
    return {
      status,
      processedSessions,
      processedEvents,
      maxReadFromLatencyMs,
      peakHeapBytes,
    }
  }
}
