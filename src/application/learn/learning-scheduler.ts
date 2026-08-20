import type { RuntimeNotices } from '../capture/runtime-notices.js'
import type { CaptureWorkItemV1 } from '../../domain/observe/schemas.js'
import {
  permitsLearning,
  type AutomaticLearningPolicyPort,
  type AutomaticLearningSnapshot,
} from '../automatic-learning-policy.js'

export const LEARNING_GLOBAL_CONCURRENCY = 2
export const LEARNING_DISPOSE_TIMEOUT_MS = 2_000

export interface LearningSchedulerStore {
  recoverInterrupted(): Promise<readonly CaptureWorkItemV1[]>
  resumeAvailableAgentScopes(
    available: (item: CaptureWorkItemV1) => boolean,
  ): Promise<readonly CaptureWorkItemV1[]>
  listEligible(now: string): readonly CaptureWorkItemV1[]
  nextEligibleAt(now: string): string | undefined
}

export interface LearningWorkerPort {
  canResolveScope(item: CaptureWorkItemV1): boolean
  run(
    item: CaptureWorkItemV1,
    signal: AbortSignal,
    settings: AutomaticLearningSnapshot,
  ): Promise<void>
}

export interface LearningSchedulerOptions {
  readonly store: LearningSchedulerStore
  readonly worker: LearningWorkerPort
  readonly policy: AutomaticLearningPolicyPort
  readonly notices: RuntimeNotices
  readonly now?: () => number
}

interface ActiveLearning {
  readonly sessionId: string
  readonly controller: AbortController
  readonly promise: Promise<void>
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

export class LearningScheduler {
  readonly #store
  readonly #worker
  readonly #notices
  readonly #policy
  readonly #now
  readonly #active = new Map<string, ActiveLearning>()
  #started = false
  #disposed = false
  #draining = false
  #wakeRequested = false
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(options: LearningSchedulerOptions) {
    this.#store = options.store
    this.#worker = options.worker
    this.#policy = options.policy
    this.#notices = options.notices
    this.#now = options.now ?? Date.now
  }

  async start(): Promise<void> {
    if (this.#started || this.#disposed) return
    this.#started = true
    try {
      await this.#store.recoverInterrupted()
    } catch {
      this.#notice('LEARNING_RECOVERY_FAILED')
    }
    await this.#drain()
  }

  wake(): void {
    if (!this.#started || this.#disposed) return
    this.#wakeRequested = true
    queueMicrotask(() => { void this.#drain() })
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    for (const active of this.#active.values()) {
      active.controller.abort(new Error('run2skill learning scheduler disposed'))
    }
    const settling = Promise.allSettled([...this.#active.values()].map(active => active.promise))
    await Promise.race([settling, wait(LEARNING_DISPOSE_TIMEOUT_MS)])
  }

  async #drain(): Promise<void> {
    if (this.#disposed || this.#draining) return
    this.#draining = true
    try {
      do {
        this.#wakeRequested = false
        try {
          await this.#store.resumeAvailableAgentScopes(item => this.#worker.canResolveScope(item))
        } catch {
          this.#notice('STORE_WRITE_FAILED')
        }
        if (this.#disposed) return
        const now = new Date(this.#now()).toISOString()
        let candidates: readonly CaptureWorkItemV1[]
        try {
          candidates = this.#store.listEligible(now)
        } catch {
          this.#notice('LEARNING_QUEUE_READ_FAILED')
          return
        }
        const activeSessions = new Set(
          [...this.#active.values()].map(active => active.sessionId),
        )
        const settings = this.#policy.snapshot()
        for (const item of candidates) {
          if (this.#active.size >= LEARNING_GLOBAL_CONCURRENCY) break
          if (
            this.#active.has(item.workItemId)
            || activeSessions.has(item.signalKey.rootSessionId)
            || !permitsLearning(item, settings)
          ) continue
          activeSessions.add(item.signalKey.rootSessionId)
          this.#launch(item, settings)
        }
      } while (this.#wakeRequested && !this.#disposed)
      this.#scheduleNext()
    } finally {
      this.#draining = false
      if (this.#wakeRequested && !this.#disposed) queueMicrotask(() => { void this.#drain() })
    }
  }

  #launch(item: CaptureWorkItemV1, settings: AutomaticLearningSnapshot): void {
    const controller = new AbortController()
    const promise = Promise.resolve().then(async () => {
      await this.#worker.run(item, controller.signal, settings)
    }).catch(() => {
      this.#notice('LEARNING_WORKER_FAILED', item)
    }).finally(() => {
      this.#active.delete(item.workItemId)
      this.wake()
    })
    this.#active.set(item.workItemId, {
      sessionId: item.signalKey.rootSessionId,
      controller,
      promise,
    })
  }

  #scheduleNext(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    if (this.#disposed) return
    const now = this.#now()
    let next: string | undefined
    try {
      next = this.#store.nextEligibleAt(new Date(now).toISOString())
    } catch {
      this.#notice('LEARNING_QUEUE_READ_FAILED')
      return
    }
    if (next === undefined) return
    const milliseconds = Math.max(0, Math.min(Date.parse(next) - now, 2_147_483_647))
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.wake()
    }, milliseconds)
  }

  #notice(healthCode: string, item?: CaptureWorkItemV1): void {
    this.#notices.record({
      healthCode,
      sessionId: item?.signalKey.rootSessionId ?? 'global',
      ...(item === undefined ? {} : { turnEndSeq: item.signalKey.turnEndSeq }),
    })
  }
}
