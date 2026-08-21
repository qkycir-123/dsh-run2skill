import type { SessionBatchV2, TurnObservationV2 } from '../../domain/v2/index.js'
import type { ObservationBatchResult, SessionBatchCoordinator } from './session-batch-coordinator.js'

const MAX_TIMER_DELAY_MS = 2_147_483_647

export interface SessionBatchSchedulerOptions {
  readonly coordinator: SessionBatchCoordinator
  readonly onFrozen: (batch: SessionBatchV2) => unknown | Promise<unknown>
  readonly now?: () => number
  readonly setTimer?: (callback: () => void, delay: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

export class SessionBatchScheduler {
  readonly #coordinator
  readonly #onFrozen
  readonly #now
  readonly #setTimer
  readonly #clearTimer
  #timer: unknown
  #tail: Promise<void> = Promise.resolve()
  #started = false
  #disposed = false

  constructor(options: SessionBatchSchedulerOptions) {
    this.#coordinator = options.coordinator
    this.#onFrozen = options.onFrozen
    this.#now = options.now ?? Date.now
    this.#setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
    this.#clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  async start(): Promise<void> {
    if (this.#disposed) throw new Error('SessionBatchScheduler is disposed')
    if (this.#started) return await this.settle()
    this.#started = true
    return await this.#enqueue(async () => {
      await this.#emit(await this.#coordinator.recover(this.#now()))
    })
  }

  async observe(observation: TurnObservationV2): Promise<void> {
    if (this.#disposed) throw new Error('SessionBatchScheduler is disposed')
    if (!this.#started) await this.start()
    return await this.#enqueue(async () => {
      const result = await this.#coordinator.recordObservation(observation)
      await this.#emitObservationResult(result)
    })
  }

  wake(): void {
    if (!this.#started || this.#disposed) return
    void this.#enqueue(async () => {
      await this.#emit(await this.#coordinator.flushIdle(this.#now()))
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

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#tail.then(operation)
    this.#tail = result.then(
      () => { this.#schedule() },
      () => { this.#schedule() },
    )
    return result
  }

  async #emitObservationResult(result: ObservationBatchResult): Promise<void> {
    if (result.batchChanged && result.batch !== undefined) await this.#onFrozen(result.batch)
  }

  async #emit(batches: readonly SessionBatchV2[]): Promise<void> {
    for (const batch of batches) await this.#onFrozen(batch)
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
