import { Run2skillV2GlobalStore } from '../../adapters/dsh-storage/v2-global-store.js'
import type { Run2skillV2Domain } from '../../adapters/dsh-storage/v2-types.js'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import {
  SessionBatchV2Schema,
  TurnObservationV2Schema,
  deriveSessionBatchIdV2,
  type GlobalV2,
  type SessionBatchV2,
  type TurnObservationV2,
} from '../../domain/v2/index.js'

export const SESSION_BATCH_COMPLETE_TURN_THRESHOLD = 5
export const SESSION_BATCH_IDLE_MS = 30 * 60_000
export const SESSION_BATCH_DETECTOR_POLICY_VERSION = 'batch-detector-v1'

const TERMINAL_BATCH_STATES = new Set<SessionBatchV2['state']>([
  'COMMITTED_NONE', 'COMMITTED_DEFER', 'COMMITTED_READY', 'NEEDS_ATTENTION',
])
const TRIGGER_ORDER = ['EXPLICIT', 'THRESHOLD', 'IDLE'] as const

export class SessionBatchIdentityConflictError extends Error {
  constructor(message = 'Durable v2 identity already contains different facts') {
    super(message)
    this.name = 'SessionBatchIdentityConflictError'
  }
}

export class SessionBatchStateConflictError extends Error {
  constructor(message = 'Durable v2 batch state is contradictory') {
    super(message)
    this.name = 'SessionBatchStateConflictError'
  }
}

export interface SessionBatchCoordinatorOptions {
  readonly captureBaseline: (
    sessionLifecycleKey: string,
  ) => Promise<SessionBatchV2['batchManifestBaseline']>
  readonly captureRouteSnapshot: (
    sessionLifecycleKey: string,
    observations: readonly TurnObservationV2[],
  ) => Promise<SessionBatchV2['routeSnapshot']>
  readonly now?: () => number
  readonly detectorPolicyVersion?: string
}

export interface ObservationBatchResult {
  readonly observationChanged: boolean
  readonly batchChanged: boolean
  readonly batch?: SessionBatchV2
}

interface FreezeCandidate {
  readonly observations: readonly TurnObservationV2[]
  readonly reasons: readonly SessionBatchV2['triggerReasons'][number][]
}

type SessionCursorV2 = NonNullable<GlobalV2['sessions'][string]>
type CursorBatchManifestBaseline = NonNullable<SessionCursorV2['batchManifestBaseline']>

function withoutUndefinedActiveBatch(
  cursor: SessionCursorV2,
): SessionCursorV2 {
  const { activeBatchId: _activeBatchId, ...rest } = cursor
  return rest
}

function withoutBatchManifestBaseline(cursor: SessionCursorV2): SessionCursorV2 {
  const { batchManifestBaseline: _batchManifestBaseline, ...rest } = cursor
  return rest
}

function canonicalReasons(reasons: Iterable<SessionBatchV2['triggerReasons'][number]>): SessionBatchV2['triggerReasons'] {
  const unique = new Set(reasons)
  return TRIGGER_ORDER.filter(reason => unique.has(reason))
}

function latestIso(left: string | undefined, right: string): string {
  if (left === undefined) return right
  return Date.parse(left) >= Date.parse(right) ? left : right
}

export class SessionBatchCoordinator {
  readonly #global: Run2skillV2GlobalStore
  readonly #observations
  readonly #batches
  readonly #captureBaseline
  readonly #captureRouteSnapshot
  readonly #now
  readonly #detectorPolicyVersion
  #recovered = false
  #recovery: Promise<void> | undefined

  constructor(domain: Run2skillV2Domain, options: SessionBatchCoordinatorOptions) {
    this.#global = Run2skillV2GlobalStore.for(domain)
    this.#observations = domain.table('turn_observations')
    this.#batches = domain.table('session_batches')
    this.#captureBaseline = options.captureBaseline
    this.#captureRouteSnapshot = options.captureRouteSnapshot
    this.#now = options.now ?? Date.now
    this.#detectorPolicyVersion = options.detectorPolicyVersion ?? SESSION_BATCH_DETECTOR_POLICY_VERSION
  }

  prepareSessionWindow(sessionLifecycleKey: string): Promise<boolean> {
    return this.#global.runExclusive(async current => {
      const cursor = current.sessions[sessionLifecycleKey]
      const afterTurnEndSeq = this.#windowStart(cursor)
      if (cursor?.batchManifestBaseline?.afterTurnEndSeq === afterTurnEndSeq) return { value: false }
      const baseline = await this.#safeBaseline(
        sessionLifecycleKey,
        afterTurnEndSeq,
        (cursor?.observedThroughTurnEndSeq ?? 0) === afterTurnEndSeq,
      )
      const nextCursor: SessionCursorV2 = {
        observedThroughTurnEndSeq: cursor?.observedThroughTurnEndSeq ?? 0,
        detectedThroughTurnEndSeq: cursor?.detectedThroughTurnEndSeq ?? 0,
        ...(cursor?.activeBatchId === undefined ? {} : { activeBatchId: cursor.activeBatchId }),
        ...(cursor?.lastActivityAt === undefined ? {} : { lastActivityAt: cursor.lastActivityAt }),
        batchManifestBaseline: baseline,
        openExperienceCarry: cursor?.openExperienceCarry ?? [],
        updatedAt: this.#isoNow(),
      }
      return {
        value: true,
        global: { ...current, sessions: { ...current.sessions, [sessionLifecycleKey]: nextCursor } },
      }
    })
  }

  recordObservation(value: TurnObservationV2): Promise<ObservationBatchResult> {
    return this.#global.runExclusive(async current => {
      const stored = this.#observations.get(value.observationId)
      if (stored !== undefined && canonicalJson(stored) !== canonicalJson(value)) {
        throw new SessionBatchIdentityConflictError('Observation identity conflict')
      }
      const observation = TurnObservationV2Schema.parse(value)
      if (observation.revision !== 1) throw new SessionBatchStateConflictError('New TurnObservation must start at revision 1')
      const cursor = current.sessions[observation.sessionLifecycleKey]
      if (
        stored === undefined
        && cursor !== undefined
        && observation.turnEndSeq <= cursor.observedThroughTurnEndSeq
      ) throw new SessionBatchStateConflictError('Observation arrived behind the durable session cursor')

      const observationChanged = stored === undefined
      if (observationChanged) await this.#observations.put(observation.observationId, observation)
      const windowStart = this.#windowStart(cursor)
      const boundBaseline = cursor?.batchManifestBaseline?.afterTurnEndSeq === windowStart
        ? cursor.batchManifestBaseline
        : undefined
      const baseline = boundBaseline ?? (
        stored === undefined
          ? await this.#safeBaseline(observation.sessionLifecycleKey, windowStart, false)
          : undefined
      )
      const nextCursor: SessionCursorV2 = {
        observedThroughTurnEndSeq: Math.max(cursor?.observedThroughTurnEndSeq ?? 0, observation.turnEndSeq),
        detectedThroughTurnEndSeq: cursor?.detectedThroughTurnEndSeq ?? 0,
        ...(cursor?.activeBatchId === undefined ? {} : { activeBatchId: cursor.activeBatchId }),
        lastActivityAt: latestIso(cursor?.lastActivityAt, observation.observedAt),
        ...(baseline === undefined ? {} : { batchManifestBaseline: baseline }),
        openExperienceCarry: cursor?.openExperienceCarry ?? [],
        updatedAt: this.#isoNow(),
      }
      const withObservation: GlobalV2 = {
        ...current,
        sessions: { ...current.sessions, [observation.sessionLifecycleKey]: nextCursor },
      }
      const frozen = await this.#freezeOne(withObservation, observation.sessionLifecycleKey, undefined)
      return {
        value: {
          observationChanged,
          batchChanged: frozen.changed,
          ...(frozen.batch === undefined ? {} : { batch: frozen.batch }),
        },
        global: frozen.global,
      }
    })
  }

  flushIdle(now = this.#now()): Promise<readonly SessionBatchV2[]> {
    return this.#global.runExclusive(async current => {
      let next = current
      const frozen: SessionBatchV2[] = []
      for (const lifecycleKey of Object.keys(current.sessions).sort()) {
        const result = await this.#freezeOne(next, lifecycleKey, now)
        next = result.global
        if (result.changed && result.batch !== undefined) frozen.push(result.batch)
      }
      return { value: frozen, global: next }
    })
  }

  recover(now = this.#now()): Promise<void> {
    if (this.#recovered) return Promise.resolve()
    if (this.#recovery !== undefined) return this.#recovery
    const attempt = this.#global.runExclusive(async current => {
      let next = this.#rebuildCursors(current)
      for (const lifecycleKey of Object.keys(next.sessions).sort()) {
      const activeId = next.sessions[lifecycleKey]?.activeBatchId
      if (activeId !== undefined) {
        continue
      }
        const result = await this.#freezeOne(next, lifecycleKey, now)
        next = result.global
      }
      return { value: undefined, global: next }
    }).then(() => {
      this.#recovered = true
    })
    this.#recovery = attempt
    return attempt.finally(() => {
      if (this.#recovery === attempt) this.#recovery = undefined
    })
  }

  nextIdleAt(): number | undefined {
    const current = this.#global.get()
    let next: number | undefined
    for (const cursor of Object.values(current.sessions)) {
      if (
        cursor.activeBatchId !== undefined
        || cursor.observedThroughTurnEndSeq <= cursor.detectedThroughTurnEndSeq
        || cursor.lastActivityAt === undefined
      ) continue
      const deadline = Date.parse(cursor.lastActivityAt) + SESSION_BATCH_IDLE_MS
      if (!Number.isFinite(deadline)) continue
      next = next === undefined ? deadline : Math.min(next, deadline)
    }
    return next
  }

  #rebuildCursors(current: GlobalV2): GlobalV2 {
    const sessions = { ...current.sessions }
    const grouped = new Map<string, TurnObservationV2[]>()
    const detectedBySession = new Map<string, number>()
    const carryBySession = new Map<string, { readonly through: number; readonly carry: SessionBatchV2['detector']['carry'] }>()
    for (const [, raw] of this.#observations.entries()) {
      const item = TurnObservationV2Schema.parse(raw)
      const values = grouped.get(item.sessionLifecycleKey) ?? []
      values.push(item)
      grouped.set(item.sessionLifecycleKey, values)
    }
    const activeBySession = new Map<string, SessionBatchV2[]>()
    for (const [, raw] of this.#batches.entries()) {
      const batch = SessionBatchV2Schema.parse(raw)
      if (TERMINAL_BATCH_STATES.has(batch.state)) {
        detectedBySession.set(
          batch.sessionLifecycleKey,
          Math.max(detectedBySession.get(batch.sessionLifecycleKey) ?? 0, batch.lastTurnEndSeq),
        )
        const previousCarry = carryBySession.get(batch.sessionLifecycleKey)
        if (previousCarry === undefined || batch.lastTurnEndSeq > previousCarry.through) {
          carryBySession.set(batch.sessionLifecycleKey, {
            through: batch.lastTurnEndSeq,
            carry: ['DEFER', 'NEEDS_ATTENTION'].includes(batch.detector.result) ? batch.detector.carry : [],
          })
        }
        continue
      }
      const active = activeBySession.get(batch.sessionLifecycleKey) ?? []
      active.push(batch)
      activeBySession.set(batch.sessionLifecycleKey, active)
    }
    for (const [lifecycleKey, values] of grouped.entries()) {
      values.sort((left, right) => left.turnEndSeq - right.turnEndSeq)
      const tail = values.at(-1)!
      const existing = sessions[lifecycleKey]
      sessions[lifecycleKey] = {
        observedThroughTurnEndSeq: Math.max(existing?.observedThroughTurnEndSeq ?? 0, tail.turnEndSeq),
        detectedThroughTurnEndSeq: Math.max(
          existing?.detectedThroughTurnEndSeq ?? 0,
          detectedBySession.get(lifecycleKey) ?? 0,
        ),
        ...(existing?.activeBatchId === undefined ? {} : { activeBatchId: existing.activeBatchId }),
        lastActivityAt: latestIso(existing?.lastActivityAt, tail.observedAt),
        ...(existing?.batchManifestBaseline === undefined
          ? {}
          : { batchManifestBaseline: existing.batchManifestBaseline }),
        openExperienceCarry: carryBySession.get(lifecycleKey)?.carry ?? existing?.openExperienceCarry ?? [],
        updatedAt: this.#isoNow(),
      }
    }
    for (const [lifecycleKey, detectedThrough] of detectedBySession.entries()) {
      const cursor = sessions[lifecycleKey]
      if (cursor === undefined) continue
      sessions[lifecycleKey] = {
        ...withoutUndefinedActiveBatch(cursor),
        detectedThroughTurnEndSeq: Math.max(cursor.detectedThroughTurnEndSeq, detectedThrough),
        openExperienceCarry: carryBySession.get(lifecycleKey)?.carry ?? cursor.openExperienceCarry,
        updatedAt: this.#isoNow(),
      }
    }
    for (const [lifecycleKey, active] of activeBySession.entries()) {
      if (active.length !== 1) throw new SessionBatchStateConflictError('Multiple active batches for one Session lifecycle')
      const cursor = sessions[lifecycleKey]
      if (cursor === undefined) throw new SessionBatchStateConflictError('Active batch has no durable Session cursor')
      sessions[lifecycleKey] = { ...cursor, activeBatchId: active[0]!.batchId, updatedAt: this.#isoNow() }
    }
    for (const [lifecycleKey, cursor] of Object.entries(sessions)) {
      const windowStart = this.#windowStart(cursor)
      const baseline = cursor.batchManifestBaseline
      if (baseline?.afterTurnEndSeq === windowStart) continue
      if (cursor.observedThroughTurnEndSeq > windowStart) {
        sessions[lifecycleKey] = {
          ...cursor,
          batchManifestBaseline: this.#unavailableBaseline(windowStart),
          updatedAt: this.#isoNow(),
        }
      } else if (baseline !== undefined) {
        sessions[lifecycleKey] = withoutBatchManifestBaseline(cursor)
      }
    }
    return { ...current, sessions }
  }

  async #freezeOne(
    current: GlobalV2,
    lifecycleKey: string,
    idleNow: number | undefined,
  ): Promise<{ readonly global: GlobalV2; readonly batch?: SessionBatchV2; readonly changed: boolean }> {
    const cursor = current.sessions[lifecycleKey]
    if (cursor === undefined) return { global: current, changed: false }
    if (cursor.activeBatchId !== undefined) {
      const active = this.#batches.get(cursor.activeBatchId)
      if (active === undefined || TERMINAL_BATCH_STATES.has(active.state)) {
        throw new SessionBatchStateConflictError('Session cursor references a missing or terminal active batch')
      }
      return { global: current, batch: active, changed: false }
    }
    const pending = [...this.#observations.entries()]
      .map(([, value]) => TurnObservationV2Schema.parse(value))
      .filter(item => item.sessionLifecycleKey === lifecycleKey && item.turnEndSeq > cursor.detectedThroughTurnEndSeq)
      .sort((left, right) => left.turnEndSeq - right.turnEndSeq)
    const candidate = this.#candidate(pending, cursor, idleNow)
    if (candidate === undefined) return { global: current, changed: false }
    const first = candidate.observations[0]!
    const last = candidate.observations.at(-1)!
    const windowStart = cursor.detectedThroughTurnEndSeq
    const boundBaseline = cursor.batchManifestBaseline?.afterTurnEndSeq === windowStart
      ? cursor.batchManifestBaseline
      : await this.#safeBaseline(lifecycleKey, windowStart, false)
    const { afterTurnEndSeq: _afterTurnEndSeq, ...baseline } = boundBaseline
    const routeSnapshot = await this.#captureRouteSnapshot(lifecycleKey, candidate.observations)
    const facts = {
      sessionLifecycleKey: lifecycleKey,
      firstTurnEndSeq: first.turnEndSeq,
      lastTurnEndSeq: last.turnEndSeq,
      detectorPolicyVersion: this.#detectorPolicyVersion,
    }
    const observationManifest = candidate.observations.map(item => ({
      observationId: item.observationId,
      turnEndSeq: item.turnEndSeq,
      evidenceDigest: item.evidenceDigest,
      completeness: item.completeness,
    }))
    const batchId = deriveSessionBatchIdV2(facts)
    const existing = this.#batches.get(batchId)
    if (existing !== undefined) {
      const expectedStableFacts = canonicalJson({
        ...facts,
        triggerReasons: canonicalReasons(candidate.reasons),
        observationManifest,
      })
      const existingStableFacts = canonicalJson({
        sessionLifecycleKey: existing.sessionLifecycleKey,
        firstTurnEndSeq: existing.firstTurnEndSeq,
        lastTurnEndSeq: existing.lastTurnEndSeq,
        detectorPolicyVersion: existing.detectorPolicyVersion,
        triggerReasons: existing.triggerReasons,
        observationManifest: existing.observationManifest,
      })
      if (expectedStableFacts !== existingStableFacts || existing.state !== 'FROZEN') {
        throw new SessionBatchIdentityConflictError('Batch identity conflict')
      }
      return {
        batch: existing,
        changed: false,
        global: {
          ...current,
          sessions: {
            ...current.sessions,
            [lifecycleKey]: {
              ...withoutBatchManifestBaseline(cursor),
              activeBatchId: existing.batchId,
              updatedAt: this.#isoNow(),
            },
          },
        },
      }
    }
    const now = this.#isoNow()
    const batch = SessionBatchV2Schema.parse({
      schemaVersion: 1,
      revision: 1,
      batchId,
      ...facts,
      triggerReasons: canonicalReasons(candidate.reasons),
      observationManifest,
      observationManifestDigest: sha256Utf8(canonicalJson(observationManifest)),
      batchManifestBaseline: baseline,
      manifestEndObservation: { state: 'PENDING' },
      routeSnapshot,
      detector: { result: 'NOT_RUN', calls: [], intentIds: [], carry: [] },
      state: 'FROZEN',
      createdAt: now,
      updatedAt: now,
    })
    await this.#batches.put(batch.batchId, batch)
    return {
      batch,
      changed: true,
      global: {
        ...current,
        sessions: {
          ...current.sessions,
          [lifecycleKey]: {
            ...withoutBatchManifestBaseline(cursor),
            activeBatchId: batch.batchId,
            updatedAt: now,
          },
        },
      },
    }
  }

  #candidate(
    pending: readonly TurnObservationV2[],
    cursor: SessionCursorV2,
    idleNow: number | undefined,
  ): FreezeCandidate | undefined {
    if (pending.length === 0) return undefined
    const explicitIndex = pending.findIndex(item => item.explicitSaveRequested)
    let completeCount = 0
    let thresholdIndex = -1
    for (const [index, item] of pending.entries()) {
      if (item.completeness === 'COMPLETE') completeCount += 1
      if (completeCount === SESSION_BATCH_COMPLETE_TURN_THRESHOLD) {
        thresholdIndex = index
        break
      }
    }
    const immediateIndexes = [explicitIndex, thresholdIndex].filter(index => index >= 0)
    if (immediateIndexes.length > 0) {
      const endIndex = Math.min(...immediateIndexes)
      const reasons: SessionBatchV2['triggerReasons'][number][] = []
      if (explicitIndex === endIndex) reasons.push('EXPLICIT')
      if (thresholdIndex === endIndex) reasons.push('THRESHOLD')
      return { observations: pending.slice(0, endIndex + 1), reasons }
    }
    if (idleNow === undefined || cursor.lastActivityAt === undefined) return undefined
    const deadline = Date.parse(cursor.lastActivityAt) + SESSION_BATCH_IDLE_MS
    if (!Number.isFinite(deadline) || idleNow < deadline) return undefined
    return { observations: pending, reasons: ['IDLE'] }
  }

  #isoNow(): string {
    return new Date(this.#now()).toISOString()
  }

  async #safeBaseline(
    sessionLifecycleKey: string,
    afterTurnEndSeq: number,
    atPreTurnBoundary: boolean,
  ): Promise<CursorBatchManifestBaseline> {
    try {
      const baseline = await this.#captureBaseline(sessionLifecycleKey)
      return {
        ...baseline,
        afterTurnEndSeq,
        complete: atPreTurnBoundary && baseline.complete,
      }
    } catch {
      return this.#unavailableBaseline(afterTurnEndSeq)
    }
  }

  #unavailableBaseline(afterTurnEndSeq: number): CursorBatchManifestBaseline {
    return {
      observedAt: this.#isoNow(),
      rootManifestDigest: sha256Utf8(''),
      runtimeCatalogDigest: sha256Utf8(''),
      complete: false,
      afterTurnEndSeq,
    }
  }

  #windowStart(cursor: SessionCursorV2 | undefined): number {
    if (cursor?.activeBatchId !== undefined) {
      const active = this.#batches.get(cursor.activeBatchId)
      if (active !== undefined && !TERMINAL_BATCH_STATES.has(active.state)) return active.lastTurnEndSeq
    }
    return cursor?.detectedThroughTurnEndSeq ?? 0
  }
}
