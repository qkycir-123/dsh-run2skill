import type { TurnObservationV2 } from '../../domain/v2/index.js'
import type { SessionBatchCoordinator } from './session-batch-coordinator.js'

const MAX_TIMER_DELAY_MS = 2_147_483_647

export interface SessionBatchSchedulerOptions {
  readonly coordinator: SessionBatchCoordinator
  readonly onIdleBatchFrozen?: () => void
  readonly now?: () => number
  readonly setTimer?: (callback: () => void, delay: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
  readonly permitRequestedSynthesis?: (sessionLifecycleKey: string) => boolean | Promise<boolean>
}

export interface SynthesisRequestReceipt {
  readonly changed: boolean
  readonly disposition: 'EMPTY' | 'PROCESSING' | 'QUEUED'
}

// This scheduler only freezes authoritative work. The Detector worker must scan
// the durable table and claim FROZEN batches before making any model call.
export class SessionBatchScheduler {
  readonly #coordinator
  readonly #now
  readonly #setTimer
  readonly #clearTimer
  readonly #onIdleBatchFrozen
  readonly #permitRequestedSynthesis
  #timer: unknown
  #tail: Promise<void> = Promise.resolve()
  #startAttempt: Promise<void> | undefined
  #started = false
  #disposed = false

  constructor(options: SessionBatchSchedulerOptions) {
    this.#coordinator = options.coordinator
    this.#now = options.now ?? Date.now
    this.#setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
    this.#clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.#onIdleBatchFrozen = options.onIdleBatchFrozen ?? (() => undefined)
    this.#permitRequestedSynthesis = options.permitRequestedSynthesis ?? (() => true)
  }

  async start(): Promise<void> {
    if (this.#disposed) throw new Error('SessionBatchScheduler is disposed')
    if (this.#started) return await this.settle()
    if (this.#startAttempt !== undefined) return await this.#startAttempt
    const attempt = this.#enqueue(async () => {
      await this.#coordinator.recover(this.#now())
      const requested = await this.#coordinator.flushRequested(this.#permitRequestedSynthesis)
      if (requested.length > 0) this.#onIdleBatchFrozen()
    })
    this.#startAttempt = attempt
    try {
      await attempt
      this.#started = true
      this.#schedule()
    } finally {
      if (this.#startAttempt === attempt) this.#startAttempt = undefined
    }
  }

  async prepareSessionWindow(sessionLifecycleKey: string): Promise<void> {
    if (this.#disposed) throw new Error('SessionBatchScheduler is disposed')
    if (!this.#started) await this.start()
    await this.#enqueue(async () => {
      await this.#coordinator.prepareSessionWindow(sessionLifecycleKey)
    })
  }

  async observe(observation: TurnObservationV2): Promise<void> {
    if (this.#disposed) throw new Error('SessionBatchScheduler is disposed')
    if (!this.#started) await this.start()
    return await this.#enqueue(async () => {
      await this.#coordinator.recordObservation(observation)
    })
  }

  async requestSynthesis(sessionLifecycleKey: string): Promise<SynthesisRequestReceipt> {
    if (this.#disposed) throw new Error('SessionBatchScheduler is disposed')
    if (!this.#started) await this.start()
    return await this.#enqueue(async () => await this.#coordinator.requestSynthesis(sessionLifecycleKey))
  }

  wake(): void {
    if (!this.#started || this.#disposed) return
    void this.#enqueue(async () => {
      const requested = await this.#coordinator.flushRequested(this.#permitRequestedSynthesis)
      const idle = await this.#coordinator.flushIdle(this.#now())
      if (requested.length > 0 || idle.length > 0) this.#onIdleBatchFrozen()
    })
  }

  settle(): Promise<void> {
    return this.#tail
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    this.#cancelTimer()
    await this.settle()
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation)
    this.#tail = result.then(
      () => { this.#schedule() },
      () => { this.#schedule() },
    )
    return result
  }

  #schedule(): void {
    this.#cancelTimer()
    if (!this.#started || this.#disposed) return
    const deadline = this.#coordinator.nextIdleAt()
    if (deadline === undefined) return
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, deadline - this.#now()))
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined
      this.wake()
    }, delay)
  }

  #cancelTimer(): void {
    if (this.#timer === undefined) return
    this.#clearTimer(this.#timer)
    this.#timer = undefined
  }
}
