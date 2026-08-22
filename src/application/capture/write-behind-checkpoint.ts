import {
  GlobalV1Schema,
  type GlobalV1,
  type SessionCheckpointV1,
} from '../../domain/observe/schemas.js'
import { deriveSessionLifecycleKeyFromFacts } from '../../domain/observe/identity.js'
import type { Run2skillDomain } from '../../adapters/dsh-storage/types.js'
import { Run2skillGlobalStore } from '../../adapters/dsh-storage/global-store.js'

export const CHECKPOINT_TURN_BATCH = 32
export const CHECKPOINT_INTERVAL_MS = 30_000

interface CheckpointHold {
  readonly signals: Map<string, number>
  candidateNextSeq: number
}

export class WriteBehindCheckpoint {
  readonly #global
  readonly #now
  readonly #turnBatch
  readonly #runMutation
  #state: GlobalV1
  #completedSinceFlush = 0
  #lastFlushAt: number
  #tail: Promise<void> = Promise.resolve()
  readonly #dirtySessions = new Set<string>()
  readonly #holds = new Map<string, CheckpointHold>()

  constructor(domain: Run2skillDomain, options: {
    now?: () => number
    turnBatch?: number
    runMutation?: <T>(operation: () => Promise<T>) => Promise<T>
  } = {}) {
    this.#global = Run2skillGlobalStore.for(domain)
    this.#now = options.now ?? Date.now
    this.#turnBatch = options.turnBatch ?? CHECKPOINT_TURN_BATCH
    this.#runMutation = options.runMutation ?? (operation => operation())
    if (!Number.isSafeInteger(this.#turnBatch) || this.#turnBatch < 1) {
      throw new TypeError('Checkpoint Turn batch must be a positive safe integer')
    }
    this.#lastFlushAt = this.#now()
    this.#state = GlobalV1Schema.parse(domain.global.get())
  }

  snapshot(): GlobalV1 {
    return structuredClone(this.#state)
  }

  activate(sessions: readonly SessionCheckpointV1[]): Promise<void> {
    return this.#enqueue(async () => {
      const nextSessions = { ...this.#state.sessions }
      for (const session of sessions) {
        const key = deriveSessionLifecycleKeyFromFacts(session)
        nextSessions[key] = session
        this.#dirtySessions.add(key)
      }
      const pendingSessionCount = this.#dirtySessions.size
      this.#state = GlobalV1Schema.parse({
        ...this.#state,
        sessions: nextSessions,
        checkpoint: {
          ...this.#state.checkpoint,
          dirty: pendingSessionCount > 0,
          pendingSessionCount,
        },
      })
      const committed = GlobalV1Schema.parse({
        ...this.#state,
        lastSuccessfulStoreWriteAt: this.#isoNow(),
        checkpoint: {
          dirty: false,
          pendingSessionCount: 0,
          lastCheckpointAt: this.#isoNow(),
        },
      })
      this.#state = await this.#commit(committed)
      this.#dirtySessions.clear()
      this.#lastFlushAt = this.#now()
    })
  }

  observeCompletedRoot(session: SessionCheckpointV1): Promise<void> {
    return this.#enqueue(async () => {
      const key = deriveSessionLifecycleKeyFromFacts(session)
      const current = this.#state.sessions[key]
      if (current !== undefined && session.activationFenceSeq !== current.activationFenceSeq) {
        throw new Error('Activation fence cannot change during observation')
      }
      const observedTailSeq = Math.max(current?.observedTailSeq ?? 0, session.observedTailSeq)
      const requestedNextSeq = Math.max(current?.durableNextSeq ?? 0, session.durableNextSeq)
      const hold = this.#holds.get(key)
      if (hold !== undefined) hold.candidateNextSeq = Math.max(hold.candidateNextSeq, requestedNextSeq)
      const holdNextSeq = hold === undefined
        ? requestedNextSeq
        : Math.min(...hold.signals.values())
      const nextSession = {
        ...(current ?? session),
        ...session,
        durableNextSeq: Math.min(requestedNextSeq, holdNextSeq),
        observedTailSeq,
      }
      if (current !== undefined && JSON.stringify(current) === JSON.stringify(nextSession)) return
      const sessions = { ...this.#state.sessions, [key]: nextSession }
      this.#dirtySessions.add(key)
      const pendingSessionCount = this.#dirtySessions.size
      this.#state = GlobalV1Schema.parse({
        ...this.#state,
        sessions,
        checkpoint: { ...this.#state.checkpoint, dirty: true, pendingSessionCount },
      })
      this.#completedSinceFlush += 1
      if (this.#completedSinceFlush >= this.#turnBatch) await this.#flush()
    })
  }

  holdSignal(lifecycleKey: string, workItemId: string): Promise<void> {
    return this.#enqueue(async () => {
      const session = this.#state.sessions[lifecycleKey]
      if (session === undefined) throw new Error('Unknown session lifecycle')
      const hold = this.#holds.get(lifecycleKey) ?? {
        signals: new Map<string, number>(),
        candidateNextSeq: session.durableNextSeq,
      }
      hold.signals.set(workItemId, session.durableNextSeq)
      this.#holds.set(lifecycleKey, hold)
    })
  }

  releaseSignal(lifecycleKey: string, workItemId: string): Promise<void> {
    return this.#enqueue(async () => {
      const hold = this.#holds.get(lifecycleKey)
      if (hold === undefined) return
      hold.signals.delete(workItemId)
      if (hold.signals.size > 0) return
      this.#holds.delete(lifecycleKey)
      const session = this.#state.sessions[lifecycleKey]
      if (session === undefined) throw new Error('Unknown session lifecycle')
      const durableNextSeq = Math.min(hold.candidateNextSeq, session.observedTailSeq + 1)
      if (durableNextSeq === session.durableNextSeq) return
      this.#dirtySessions.add(lifecycleKey)
      this.#state = GlobalV1Schema.parse({
        ...this.#state,
        sessions: {
          ...this.#state.sessions,
          [lifecycleKey]: { ...session, durableNextSeq },
        },
        checkpoint: {
          ...this.#state.checkpoint,
          dirty: true,
          pendingSessionCount: this.#dirtySessions.size,
        },
      })
    })
  }

  flushIfDue(): Promise<boolean> {
    let flushed = false
    return this.#enqueue(async () => {
      if (
        this.#state.checkpoint.dirty
        && this.#now() - this.#lastFlushAt >= CHECKPOINT_INTERVAL_MS
      ) {
        await this.#flush()
        flushed = true
      }
    }).then(() => flushed)
  }

  rollbackToDurableTail(lifecycleKey: string, durableTailNextSeq: number): Promise<void> {
    return this.#enqueue(async () => {
      const session = this.#state.sessions[lifecycleKey]
      if (session === undefined) throw new Error('Unknown session lifecycle')
      const durableNextSeq = Math.max(
        session.activationFenceSeq,
        Math.min(session.durableNextSeq, durableTailNextSeq),
      )
      const counts = { ...this.#state.health.counts }
      counts['SESSION_LOG_ROLLBACK'] = (counts['SESSION_LOG_ROLLBACK'] ?? 0) + 1
      const committed = GlobalV1Schema.parse({
        ...this.#state,
        sessions: {
          ...this.#state.sessions,
          [lifecycleKey]: { ...session, durableNextSeq },
        },
        health: { counts, lastCode: 'SESSION_LOG_ROLLBACK' },
        lastSuccessfulStoreWriteAt: this.#isoNow(),
        checkpoint: {
          dirty: false,
          pendingSessionCount: 0,
          lastCheckpointAt: this.#isoNow(),
        },
      })
      this.#state = await this.#commit(committed)
      this.#dirtySessions.clear()
      this.#completedSinceFlush = 0
      this.#lastFlushAt = this.#now()
    })
  }

  setRecoveryCursor(cursor?: GlobalV1['recovery']['cursor']): Promise<void> {
    return this.#enqueue(async () => {
      const recovery = cursor === undefined
        ? { recoveryLag: false as const }
        : { recoveryLag: true as const, cursor }
      if (
        JSON.stringify(this.#state.recovery) === JSON.stringify(recovery)
        && !this.#state.checkpoint.dirty
      ) return
      const committed = GlobalV1Schema.parse({
        ...this.#state,
        recovery,
        lastSuccessfulStoreWriteAt: this.#isoNow(),
        checkpoint: {
          dirty: false,
          pendingSessionCount: 0,
          lastCheckpointAt: this.#isoNow(),
        },
      })
      this.#state = await this.#commit(committed)
      this.#dirtySessions.clear()
      this.#completedSinceFlush = 0
      this.#lastFlushAt = this.#now()
    })
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#tail.then(operation)
    this.#tail = result.then(() => {}, () => {})
    return result
  }

  async #flush(): Promise<void> {
    const committed = GlobalV1Schema.parse({
      ...this.#state,
      lastSuccessfulStoreWriteAt: this.#isoNow(),
      checkpoint: {
        dirty: false,
        pendingSessionCount: 0,
        lastCheckpointAt: this.#isoNow(),
      },
    })
    this.#state = await this.#commit(committed)
    this.#dirtySessions.clear()
    this.#completedSinceFlush = 0
    this.#lastFlushAt = this.#now()
  }

  #isoNow(): string {
    return new Date(this.#now()).toISOString()
  }

  async #commit(committed: GlobalV1): Promise<GlobalV1> {
    const {
      purgeJournal: _staleJournal,
      completedPurgeFences: _staleCompletedPurgeFences,
      recentSkillActivity: _staleRecentSkillActivity,
      ...checkpointState
    } = committed
    return await this.#runMutation(async () => await this.#global.update(current => GlobalV1Schema.parse({
        ...checkpointState,
        ...(current.purgeJournal === undefined ? {} : { purgeJournal: current.purgeJournal }),
        ...(current.completedPurgeFences === undefined
          ? {}
          : { completedPurgeFences: current.completedPurgeFences }),
        ...(current.recentSkillActivity === undefined
          ? {}
          : { recentSkillActivity: current.recentSkillActivity }),
      })))
  }
}
