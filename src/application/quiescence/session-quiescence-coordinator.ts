import { z } from 'zod'
import type { Run2skillV2Domain } from '../../adapters/dsh-storage/v2-types.js'
import {
  ExperienceIntentV2Schema,
  SessionBatchV2Schema,
  deriveSessionQuiescenceFenceDigestV2,
  type ExperienceIntentV2,
} from '../../domain/v2/index.js'

const activityObservationSchema = z.object({
  complete: z.boolean(),
  activeAgent: z.boolean(),
  activityRevision: z.string().min(1).max(256),
  durableLatestTurnEndSeq: z.number().int().nonnegative().safe(),
  durableOpenTurn: z.boolean(),
}).strict()

export interface SessionActivityObservationPort {
  observe(sessionLifecycleKey: string): Promise<unknown>
}

export interface SessionQuiescenceCoordinatorOptions {
  readonly activity: SessionActivityObservationPort
  readonly now?: () => number
}

type FenceValidation = 'VALID' | 'STALE' | 'INCOMPLETE'
type SessionCursor = NonNullable<ReturnType<Run2skillV2Domain['global']['get']>['sessions'][string]>

/**
 * Releases detector READY facts only after the Session tail is fully detected,
 * idle (or an explicit save has just ended), and no Agent is running.
 */
export class SessionQuiescenceCoordinator {
  readonly #intents
  readonly #batches
  readonly #activity
  readonly #now

  constructor(domain: Run2skillV2Domain, options: SessionQuiescenceCoordinatorOptions) {
    this.#intents = domain.table('experience_intents')
    this.#batches = domain.table('session_batches')
    this.#global = domain.global
    this.#activity = options.activity
    this.#now = options.now ?? Date.now
  }

  readonly #global: Run2skillV2Domain['global']

  async runOnce(): Promise<'IDLE' | 'PROCESSED'> {
    const candidates = [...this.#intents.entries()]
      .map(([, value]) => ExperienceIntentV2Schema.parse(value))
      .filter(intent => intent.status === 'WAITING_FOR_QUIESCENCE')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.ordinal - right.ordinal)
    for (const intent of candidates) {
      if (await this.#tryRelease(intent)) return 'PROCESSED'
    }
    return 'IDLE'
  }

  /** Returns only a future automatic-idle deadline; elapsed deadlines never poll. */
  nextEligibleAt(now = this.#now()): number | undefined {
    let earliest: number | undefined
    for (const [, raw] of this.#intents.entries()) {
      const parsed = ExperienceIntentV2Schema.safeParse(raw)
      if (!parsed.success) continue
      const intent = parsed.data
      if (
        intent.status !== 'WAITING_FOR_QUIESCENCE'
        || intent.quiescence.state !== 'WAITING'
        || intent.explicitSave
      ) continue
      const batch = SessionBatchV2Schema.safeParse(this.#batches.get(intent.batchId))
      if (
        !batch.success
        || batch.data.state !== 'COMMITTED_READY'
        || batch.data.sessionLifecycleKey !== intent.sessionLifecycleKey
        || batch.data.lastTurnEndSeq !== intent.quiescence.batchLastTurnEndSeq
      ) continue
      const cursor = this.#cursor(intent.sessionLifecycleKey)
      if (
        cursor === undefined
        || cursor.activeBatchId !== undefined
        || cursor.observedThroughTurnEndSeq !== batch.data.lastTurnEndSeq
        || cursor.observedThroughTurnEndSeq !== cursor.detectedThroughTurnEndSeq
      ) continue
      const lastActivity = cursor.lastActivityAt === undefined ? Number.NaN : Date.parse(cursor.lastActivityAt)
      if (!Number.isFinite(lastActivity)) continue
      const deadline = lastActivity + intent.quiescence.requiredIdleMs
      if (deadline <= now) continue
      earliest = earliest === undefined ? deadline : Math.min(earliest, deadline)
    }
    return earliest
  }

  async validate(intentId: string): Promise<FenceValidation> {
    const raw = this.#intents.get(intentId)
    const parsed = ExperienceIntentV2Schema.safeParse(raw)
    if (!parsed.success) return 'INCOMPLETE'
    const intent = parsed.data
    const fence = intent.quiescence
    if (fence.state !== 'SATISFIED') return 'INCOMPLETE'
    const cursor = this.#cursor(intent.sessionLifecycleKey)
    if (cursor === undefined) return 'INCOMPLETE'
    if (
      cursor.activeBatchId !== undefined
      || cursor.observedThroughTurnEndSeq !== fence.observedThroughTurnEndSeq
      || cursor.detectedThroughTurnEndSeq !== fence.detectedThroughTurnEndSeq
      || cursor.observedThroughTurnEndSeq !== cursor.detectedThroughTurnEndSeq
    ) return 'STALE'
    const activity = await this.#observe(intent.sessionLifecycleKey)
    if (activity === undefined || !activity.complete) return 'INCOMPLETE'
    const afterActivity = this.#cursor(intent.sessionLifecycleKey)
    if (afterActivity === undefined) return 'INCOMPLETE'
    if (!this.#sameCursorFence(cursor, afterActivity)) return 'STALE'
    return activity.activeAgent
      || activity.durableOpenTurn
      || activity.durableLatestTurnEndSeq !== cursor.observedThroughTurnEndSeq
      || activity.activityRevision !== fence.activityRevision
      ? 'STALE'
      : 'VALID'
  }

  async #tryRelease(intent: ExperienceIntentV2): Promise<boolean> {
    if (intent.quiescence.state !== 'WAITING') return false
    const batchRaw = this.#batches.get(intent.batchId)
    const batch = SessionBatchV2Schema.safeParse(batchRaw)
    if (
      !batch.success
      || batch.data.state !== 'COMMITTED_READY'
      || batch.data.sessionLifecycleKey !== intent.sessionLifecycleKey
      || batch.data.lastTurnEndSeq !== intent.quiescence.batchLastTurnEndSeq
    ) return false
    const cursor = this.#cursor(intent.sessionLifecycleKey)
    if (cursor === undefined || cursor.activeBatchId !== undefined) return false
    if (
      cursor.observedThroughTurnEndSeq !== batch.data.lastTurnEndSeq
      || cursor.observedThroughTurnEndSeq !== cursor.detectedThroughTurnEndSeq
    ) return false
    const explicitImmediate = intent.explicitSave
      && cursor.observedThroughTurnEndSeq === batch.data.lastTurnEndSeq
    if (!explicitImmediate) {
      const lastActivity = cursor.lastActivityAt === undefined ? Number.NaN : Date.parse(cursor.lastActivityAt)
      if (!Number.isFinite(lastActivity) || this.#now() < lastActivity + intent.quiescence.requiredIdleMs) return false
    }
    const activity = await this.#observe(intent.sessionLifecycleKey)
    if (
      activity === undefined
      || !activity.complete
      || activity.activeAgent
      || activity.durableOpenTurn
      || activity.durableLatestTurnEndSeq !== cursor.observedThroughTurnEndSeq
    ) return false
    const afterActivity = this.#cursor(intent.sessionLifecycleKey)
    if (afterActivity === undefined || !this.#sameCursorFence(cursor, afterActivity)) return false
    const satisfiedAt = this.#isoNow()
    const fenceFacts = {
      intentId: intent.intentId,
      batchId: intent.batchId,
      sessionLifecycleKey: intent.sessionLifecycleKey,
      batchLastTurnEndSeq: intent.quiescence.batchLastTurnEndSeq,
      observedThroughTurnEndSeq: cursor.observedThroughTurnEndSeq,
      detectedThroughTurnEndSeq: cursor.detectedThroughTurnEndSeq,
      activityRevision: activity.activityRevision,
    }
    let released = false
    await this.#intents.update(intent.intentId, current => {
      const latest = ExperienceIntentV2Schema.parse(current)
      if (latest.revision !== intent.revision || latest.status !== 'WAITING_FOR_QUIESCENCE') return latest
      released = true
      return ExperienceIntentV2Schema.parse({
        ...latest,
        revision: latest.revision + 1,
        status: 'READY',
        quiescence: {
          state: 'SATISFIED',
          batchLastTurnEndSeq: latest.quiescence.batchLastTurnEndSeq,
          requiredIdleMs: latest.quiescence.requiredIdleMs,
          observedThroughTurnEndSeq: cursor.observedThroughTurnEndSeq,
          detectedThroughTurnEndSeq: cursor.detectedThroughTurnEndSeq,
          activityRevision: activity.activityRevision,
          satisfiedAt,
          fenceDigest: deriveSessionQuiescenceFenceDigestV2(fenceFacts),
        },
        updatedAt: satisfiedAt,
      })
    })
    if (!released) return false
    if (await this.validate(intent.intentId) === 'VALID') return true
    await this.#intents.update(intent.intentId, current => {
      const latest = ExperienceIntentV2Schema.parse(current)
      if (
        latest.status !== 'READY'
        || latest.quiescence.state !== 'SATISFIED'
        || latest.quiescence.fenceDigest !== deriveSessionQuiescenceFenceDigestV2(fenceFacts)
      ) return latest
      return ExperienceIntentV2Schema.parse({
        ...latest,
        revision: latest.revision + 1,
        status: 'WAITING_FOR_QUIESCENCE',
        quiescence: {
          state: 'WAITING',
          batchLastTurnEndSeq: latest.quiescence.batchLastTurnEndSeq,
          requiredIdleMs: latest.quiescence.requiredIdleMs,
        },
        updatedAt: this.#isoNow(),
      })
    })
    return false
  }

  async #observe(sessionLifecycleKey: string) {
    try {
      const parsed = activityObservationSchema.safeParse(await this.#activity.observe(sessionLifecycleKey))
      return parsed.success ? parsed.data : undefined
    } catch {
      return undefined
    }
  }

  #cursor(sessionLifecycleKey: string) {
    return this.#global.get().sessions[sessionLifecycleKey]
  }

  #sameCursorFence(
    left: SessionCursor,
    right: SessionCursor,
  ): boolean {
    return left.observedThroughTurnEndSeq === right.observedThroughTurnEndSeq
      && left.detectedThroughTurnEndSeq === right.detectedThroughTurnEndSeq
      && left.activeBatchId === right.activeBatchId
  }

  #isoNow(): string { return new Date(this.#now()).toISOString() }
}
