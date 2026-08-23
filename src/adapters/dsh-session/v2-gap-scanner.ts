import type { WorkspaceBindingPort } from '../../application/capture/turn-capture-processor.js'
import type { GapScanResult } from '../../application/capture/bounded-gap-scanner.js'
import {
  GAP_SCAN_MAX_EVENTS,
  GAP_SCAN_MAX_SESSIONS,
  GAP_SCAN_TIME_SLICE_MS,
} from '../../application/capture/bounded-gap-scanner.js'
import type { RuntimeNotices } from '../../application/capture/runtime-notices.js'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import { deriveSessionCwdDigest, deriveSessionLifecycleKey } from '../../domain/observe/signal-key.js'
import {
  GlobalV2Schema,
  deriveLegacyPendingProposalCatalogV2,
} from '../../domain/v2/index.js'
import type { Run2skillV2Domain } from '../dsh-storage/v2-types.js'
import { Run2skillV2GlobalStore } from '../dsh-storage/v2-global-store.js'
import { classifySessionRoot } from './observation.js'
import type { DshSessionEvent, DshSessionHeader } from './types.js'
import type { DshSessionGapReader } from './gap-reader.js'

const EMPTY_COUNTS = Object.freeze({ workItems: 0, lineages: 0, activeLegacyProposals: 0 })
const LOG_PREFIX_GENESIS = sha256Utf8(canonicalJson({ contract: 'dsh-session-log-prefix-v1' }))

interface RootSnapshot {
  readonly header: DshSessionHeader
  readonly revision: string
  readonly lifecycleKey: string
}

interface PartialScan {
  readonly fromSeq: number
  readonly inspectedEvents: number
}

export interface FreshV2ActivationResult {
  readonly status: 'ACTIVATED' | 'ALREADY_ACTIVATED'
  readonly observedSessions: number
}

export interface V2GapTurnSink {
  prepareSessionWindow(sessionLifecycleKey: string): Promise<void>
  observeTurn(
    header: DshSessionHeader,
    events: readonly DshSessionEvent[],
    turnEndSeq: number,
    workspace: WorkspaceBindingPort,
  ): Promise<
    | { readonly status: 'OBSERVED' }
    | { readonly status: 'CHILD' }
    | { readonly status: 'UNAVAILABLE'; readonly healthCode: string }
  >
}

function lifecycleKey(header: DshSessionHeader): string {
  return deriveSessionLifecycleKey({
    rootSessionId: header.id,
    sessionCreatedAt: header.createdAt,
    sessionCwdDigest: deriveSessionCwdDigest(header.cwd),
  })
}

function assertContiguous(events: readonly DshSessionEvent[], fromSeq: number): void {
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]?.seq !== fromSeq + index) throw new Error('SESSION_LOG_UNAVAILABLE')
  }
}

function extendLogPrefixDigest(
  initial: string,
  events: readonly DshSessionEvent[],
): string {
  let digest = initial
  for (const event of events) digest = sha256Utf8(canonicalJson({ previous: digest, event }))
  return digest
}

function logPrefixDigest(events: readonly DshSessionEvent[], throughSeq: number): string | undefined {
  const prefix = events.filter(event => event.seq <= throughSeq)
  if (prefix.length !== throughSeq + 1) return undefined
  return extendLogPrefixDigest(LOG_PREFIX_GENESIS, prefix)
}

function activationTail(
  events: readonly DshSessionEvent[],
  activationFenceTime: number,
): DshSessionEvent | undefined {
  let openTurn = false
  let tail: DshSessionEvent | undefined
  let index = 0
  for (; index < events.length; index += 1) {
    const event = events[index]!
    if (event.time >= activationFenceTime) break
    if (event.type === 'session/end-seed') {
      openTurn = false
    } else if (event.type === 'turn/start') {
      if (openTurn) throw new Error('SESSION_LOG_UNAVAILABLE')
      openTurn = true
    } else if (event.type === 'turn/end') {
      if (!openTurn) throw new Error('SESSION_LOG_UNAVAILABLE')
      openTurn = false
    }
    tail = event
  }
  if (!openTurn) return tail

  for (; index < events.length; index += 1) {
    const event = events[index]!
    if (event.type === 'session/end-seed' || event.type === 'turn/end') {
      openTurn = false
      tail = event
      index += 1
      break
    }
  }
  if (openTurn) throw new Error('SESSION_NOT_QUIESCENT')
  for (; index < events.length; index += 1) {
    const event = events[index]!
    if (event.type === 'turn/start') break
    tail = event
  }
  return tail
}

function rootsFromSnapshots(
  snapshots: readonly { readonly header: DshSessionHeader; readonly revision: string }[],
): RootSnapshot[] {
  const roots: RootSnapshot[] = []
  for (const snapshot of snapshots) {
    const classification = classifySessionRoot(snapshot.header)
    if (classification.status === 'CHILD') continue
    if (classification.status !== 'ROOT') throw new Error(classification.healthCode)
    roots.push({
      header: snapshot.header,
      revision: snapshot.revision,
      lifecycleKey: lifecycleKey(snapshot.header),
    })
  }
  return roots.sort((left, right) => left.lifecycleKey.localeCompare(right.lifecycleKey))
}

function v2TablesAreEmpty(domain: Run2skillV2Domain): boolean {
  return domain.table('turn_observations').size === 0
    && domain.table('session_batches').size === 0
    && domain.table('experience_intents').size === 0
    && domain.table('proposal_lineages').size === 0
    && domain.table('legacy_items').size === 0
}

/**
 * Enables v2 as a fresh product. Existing DSH Session history becomes the
 * activation fence; no v1-derived cache or Proposal is copied.
 */
export async function activateFreshRun2skillV2(
  domain: Run2skillV2Domain,
  reader: DshSessionGapReader,
  options: {
    readonly now?: () => string
    readonly signal?: AbortSignal
    readonly activationFenceTime?: number
  } = {},
): Promise<FreshV2ActivationResult> {
  const current = GlobalV2Schema.parse(domain.global.get())
  if (current.migration.phase === 'COMMITTED' && current.activation !== undefined) {
    return {
      status: 'ALREADY_ACTIVATED',
      observedSessions: Object.keys(current.activation.observerStartWatermarks).length,
    }
  }
  if (current.migration.phase !== 'NOT_STARTED' || !v2TablesAreEmpty(domain)) {
    throw new Error('V2_CACHE_NOT_EMPTY')
  }

  const listed = await reader.listSnapshots(options.signal)
  if (listed.status === 'UNAVAILABLE') throw new Error(listed.healthCode)
  const roots = rootsFromSnapshots(listed.snapshots)
  const observerStartWatermarks: Record<string, {
    nextSeq: number
    observedTailSeq: number
    headerRevision: string
  }> = {}
  const sessions: Record<string, {
    observedThroughTurnEndSeq: number
    detectedThroughTurnEndSeq: number
    headerRevision: string
    observedLogPrefixDigest: string
    openExperienceCarry: []
    updatedAt: string
  }> = {}
  const committedAt = options.now?.() ?? new Date().toISOString()

  for (const root of roots) {
    options.signal?.throwIfAborted()
    const read = await reader.readFrom(root.header.id, 0, options.signal)
    if (read.status === 'UNAVAILABLE') throw new Error(read.healthCode)
    assertContiguous(read.events, 0)
    if (read.events.length === 0) continue
    const tail = activationTail(read.events, options.activationFenceTime ?? Number.POSITIVE_INFINITY)
    if (tail === undefined) continue
    observerStartWatermarks[root.lifecycleKey] = {
      nextSeq: tail.seq + 1,
      observedTailSeq: tail.seq,
      headerRevision: root.revision,
    }
    sessions[root.lifecycleKey] = {
      observedThroughTurnEndSeq: tail.seq,
      detectedThroughTurnEndSeq: tail.seq,
      headerRevision: root.revision,
      observedLogPrefixDigest: logPrefixDigest(read.events, tail.seq)!,
      openExperienceCarry: [],
      updatedAt: committedAt,
    }
  }

  const sourceFingerprint = sha256Utf8(canonicalJson({
    cutover: 'FRESH_V2',
    observerStartWatermarks,
  }))
  const activationFenceDigest = sha256Utf8(canonicalJson({
    sourceFingerprint,
    counts: EMPTY_COUNTS,
    committedAt,
  }))
  const emptyPending = deriveLegacyPendingProposalCatalogV2([])
  await domain.global.set(GlobalV2Schema.parse({
    ...current,
    migration: {
      schemaVersion: 1,
      phase: 'COMMITTED',
      source: current.migration.source,
      sourceFingerprint,
      counts: EMPTY_COUNTS,
      startedAt: committedAt,
      updatedAt: committedAt,
      committedAt,
      activationFenceDigest,
    },
    sessions,
    activation: {
      committedAt,
      sourceFingerprint,
      observerStartWatermarks,
      observerStartWatermarkDigest: sha256Utf8(canonicalJson(observerStartWatermarks)),
      legacyPendingCatalogDigest: emptyPending.digest,
      legacyPendingCandidateCount: 0,
    },
  }))
  return { status: 'ACTIVATED', observedSessions: Object.keys(observerStartWatermarks).length }
}

export class DshV2GapScanner {
  readonly #partial = new Map<string, PartialScan>()
  readonly #now
  readonly #heapUsed
  readonly #activationFenceTime

  constructor(
    private readonly reader: DshSessionGapReader,
    private readonly domain: Run2skillV2Domain,
    private readonly sink: V2GapTurnSink,
    private readonly workspace: WorkspaceBindingPort,
    private readonly notices: RuntimeNotices,
    options: {
      readonly now?: () => number
      readonly heapUsed?: () => number
      readonly activationFenceTime?: number
    } = {},
  ) {
    this.#now = options.now ?? Date.now
    this.#heapUsed = options.heapUsed ?? (() => process.memoryUsage().heapUsed)
    this.#activationFenceTime = options.activationFenceTime ?? this.#now()
  }

  async ensureActivated(signal?: AbortSignal): Promise<GapScanResult> {
    try {
      await activateFreshRun2skillV2(
        this.domain,
        this.reader,
        {
          activationFenceTime: this.#activationFenceTime,
          ...(signal === undefined ? {} : { signal }),
        },
      )
      return this.#result('COMPLETE', 0, 0, 0, this.#heapUsed())
    } catch (error) {
      const healthCode = error instanceof Error ? error.message : 'RECOVERY_UNAVAILABLE'
      this.notices.record({ healthCode, sessionId: 'global' })
      return this.#result('UNAVAILABLE', 0, 0, 0, this.#heapUsed(), healthCode)
    }
  }

  async scanBatch(signal?: AbortSignal): Promise<GapScanResult> {
    const activation = await this.ensureActivated(signal)
    if (activation.status !== 'COMPLETE') return activation
    const listed = await this.reader.listSnapshots(signal)
    if (listed.status === 'UNAVAILABLE') {
      this.notices.record({ healthCode: listed.healthCode, sessionId: 'global' })
      return this.#result('UNAVAILABLE', 0, 0, 0, this.#heapUsed(), listed.healthCode)
    }

    let roots: RootSnapshot[]
    try {
      roots = rootsFromSnapshots(listed.snapshots)
    } catch (error) {
      const healthCode = error instanceof Error ? error.message : 'ROOT_IDENTITY_UNAVAILABLE'
      this.notices.record({ healthCode, sessionId: 'global' })
      return this.#result('UNAVAILABLE', 0, 0, 0, this.#heapUsed(), healthCode)
    }
    const rootKeys = new Set(roots.map(root => root.lifecycleKey))
    for (const key of this.#partial.keys()) if (!rootKeys.has(key)) this.#partial.delete(key)

    let processedSessions = 0
    let processedEvents = 0
    let maxReadFromLatencyMs = 0
    let peakHeapBytes = this.#heapUsed()
    const startedAt = this.#now()
    let visitedRoots = 0

    for (const root of roots) {
      if (processedSessions >= GAP_SCAN_MAX_SESSIONS || processedEvents >= GAP_SCAN_MAX_EVENTS) break
      signal?.throwIfAborted()
      const cursor = GlobalV2Schema.parse(this.domain.global.get()).sessions[root.lifecycleKey]
      const fromSeq = cursor === undefined ? 0 : cursor.observedThroughTurnEndSeq + 1
      const mustValidatePrefix = cursor !== undefined && cursor.headerRevision !== root.revision
      const readFromSeq = mustValidatePrefix ? 0 : fromSeq
      const readStartedAt = this.#now()
      const read = await this.reader.readFrom(root.header.id, readFromSeq, signal)
      maxReadFromLatencyMs = Math.max(maxReadFromLatencyMs, this.#now() - readStartedAt)
      peakHeapBytes = Math.max(peakHeapBytes, this.#heapUsed())
      if (read.status === 'UNAVAILABLE') {
        this.notices.record({ healthCode: read.healthCode, sessionId: root.header.id })
        return this.#result(
          'UNAVAILABLE', processedSessions, processedEvents,
          maxReadFromLatencyMs, peakHeapBytes, read.healthCode,
        )
      }
      try {
        assertContiguous(read.events, readFromSeq)
      } catch {
        this.notices.record({ healthCode: 'SESSION_LOG_UNAVAILABLE', sessionId: root.header.id })
        return this.#result(
          'UNAVAILABLE', processedSessions, processedEvents,
          maxReadFromLatencyMs, peakHeapBytes, 'SESSION_LOG_UNAVAILABLE',
        )
      }
      if (mustValidatePrefix) {
        const actual = logPrefixDigest(read.events, cursor.observedThroughTurnEndSeq)
        if (actual === undefined || actual !== cursor.observedLogPrefixDigest) {
          this.notices.record({ healthCode: 'SESSION_LOG_ROLLBACK', sessionId: root.header.id })
          return this.#result(
            'UNAVAILABLE', processedSessions, processedEvents,
            maxReadFromLatencyMs, peakHeapBytes, 'SESSION_LOG_ROLLBACK',
          )
        }
      }
      const scanEvents = mustValidatePrefix
        ? read.events.filter(event => event.seq >= fromSeq)
        : read.events
      visitedRoots += 1
      if (scanEvents.length === 0) {
        this.#partial.delete(root.lifecycleKey)
        await this.#updateRecoveryMetadata(root, cursor, read.events, mustValidatePrefix)
        continue
      }

      processedSessions += 1
      const saved = this.#partial.get(root.lifecycleKey)
      const startOffset = saved?.fromSeq === fromSeq ? saved.inspectedEvents : 0
      const remainingBudget = GAP_SCAN_MAX_EVENTS - processedEvents
      const inspectedThrough = Math.min(scanEvents.length, startOffset + remainingBudget)
      processedEvents += inspectedThrough - startOffset
      let turnSliceStart = 0
      for (let index = startOffset; index < inspectedThrough; index += 1) {
        const event = scanEvents[index]
        if (event?.type !== 'turn/end') continue
        const turnEvents = scanEvents.slice(turnSliceStart, index + 1)
        await this.sink.prepareSessionWindow(root.lifecycleKey)
        const observed = await this.sink.observeTurn(
          read.header,
          turnEvents,
          event.seq,
          this.workspace,
        )
        if (observed.status !== 'OBSERVED') {
          const healthCode = observed.status === 'UNAVAILABLE'
            ? observed.healthCode
            : 'ROOT_IDENTITY_UNAVAILABLE'
          this.notices.record({ healthCode, sessionId: root.header.id, turnEndSeq: event.seq })
          return this.#result(
            'UNAVAILABLE', processedSessions, processedEvents,
            maxReadFromLatencyMs, peakHeapBytes, healthCode,
          )
        }
        turnSliceStart = index + 1
      }

      if (inspectedThrough < scanEvents.length) {
        this.#partial.set(root.lifecycleKey, { fromSeq, inspectedEvents: inspectedThrough })
      } else {
        this.#partial.delete(root.lifecycleKey)
      }
      await this.#updateRecoveryMetadata(root, cursor, read.events, mustValidatePrefix)
      if (this.#now() - startedAt >= GAP_SCAN_TIME_SLICE_MS) break
    }

    const partial = [...this.#partial.entries()].sort(([left], [right]) => left.localeCompare(right))[0]
    const hasUnvisitedRoots = visitedRoots < roots.length
    if (partial !== undefined || hasUnvisitedRoots) {
      const [key, progress] = partial ?? [roots.at(-1)?.lifecycleKey ?? 'global', { fromSeq: 0, inspectedEvents: 0 }]
      return {
        status: 'MORE',
        cursor: { lifecycleKey: key, nextSeq: progress.fromSeq + progress.inspectedEvents },
        processedSessions,
        processedEvents,
        maxReadFromLatencyMs,
        peakHeapBytes,
      }
    }
    return this.#result(
      'COMPLETE', processedSessions, processedEvents,
      maxReadFromLatencyMs, peakHeapBytes,
    )
  }

  async #updateRecoveryMetadata(
    root: RootSnapshot,
    previous: ReturnType<typeof GlobalV2Schema.parse>['sessions'][string] | undefined,
    readEvents: readonly DshSessionEvent[],
    fullRead: boolean,
  ): Promise<void> {
    const store = Run2skillV2GlobalStore.for(this.domain)
    await store.runExclusive(async current => {
      const cursor = current.sessions[root.lifecycleKey]
      if (cursor === undefined) return { value: undefined }
      let digest: string | undefined
      if (fullRead || previous === undefined) {
        digest = logPrefixDigest(readEvents, cursor.observedThroughTurnEndSeq)
      } else if (
        previous.observedLogPrefixDigest !== undefined
        && cursor.observedThroughTurnEndSeq >= previous.observedThroughTurnEndSeq
      ) {
        digest = extendLogPrefixDigest(
          previous.observedLogPrefixDigest,
          readEvents.filter(event => event.seq <= cursor.observedThroughTurnEndSeq),
        )
      }
      if (digest === undefined) return { value: undefined }
      return {
        value: undefined,
        global: {
          ...current,
          sessions: {
            ...current.sessions,
            [root.lifecycleKey]: {
              ...cursor,
              headerRevision: root.revision,
              observedLogPrefixDigest: digest,
            },
          },
        },
      }
    })
  }

  #result(
    status: 'COMPLETE' | 'UNAVAILABLE',
    processedSessions: number,
    processedEvents: number,
    maxReadFromLatencyMs: number,
    peakHeapBytes: number,
    healthCode?: string,
  ): GapScanResult {
    return status === 'UNAVAILABLE'
      ? {
          status, healthCode: healthCode ?? 'RECOVERY_UNAVAILABLE', processedSessions,
          processedEvents, maxReadFromLatencyMs, peakHeapBytes,
        }
      : { status, processedSessions, processedEvents, maxReadFromLatencyMs, peakHeapBytes }
  }
}
