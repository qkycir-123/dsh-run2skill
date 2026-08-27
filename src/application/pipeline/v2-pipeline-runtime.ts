import type { TurnObservationV2 } from '../../domain/v2/index.js'

const MAX_TIMER_DELAY_MS = 2_147_483_647

export interface V2PipelineBatchScheduler {
  start(): Promise<void>
  prepareSessionWindow(sessionLifecycleKey: string): Promise<void>
  observe(observation: TurnObservationV2): Promise<void>
  requestSynthesis?(sessionLifecycleKey: string): Promise<{
    readonly changed: boolean
    readonly disposition: 'EMPTY' | 'PROCESSING' | 'QUEUED'
  }>
  wake(): void
  settle(): Promise<void>
  dispose(): Promise<void>
}

export interface V2PipelineStageWorker {
  runOnce(): Promise<'IDLE' | 'PROCESSED'>
  recover?(): Promise<void>
}

export interface Run2skillV2PipelineRuntimeOptions {
  readonly batchScheduler: V2PipelineBatchScheduler
  readonly stages: readonly V2PipelineStageWorker[]
  readonly recoveryOrder: readonly V2PipelineStageWorker[]
  readonly maxTransitionsPerDrain?: number
  readonly onError?: (error: unknown) => void
  readonly nextWakeAt?: () => number | undefined
  readonly now?: () => number
  readonly setTimer?: (callback: () => void, delay: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
  readonly abortActive?: () => void
}

/**
 * Serializes the durable v2 queue. Worker truth always remains in the Store;
 * this runtime only wakes and drains it with one in-process execution tail.
 */
export class Run2skillV2PipelineRuntime {
  readonly #batchScheduler: V2PipelineBatchScheduler
  readonly #stages: readonly V2PipelineStageWorker[]
  readonly #recoveryOrder: readonly V2PipelineStageWorker[]
  readonly #maxTransitionsPerDrain: number
  readonly #onError: (error: unknown) => void
  readonly #nextWakeAt: () => number | undefined
  readonly #now: () => number
  readonly #setTimer: (callback: () => void, delay: number) => unknown
  readonly #clearTimer: (handle: unknown) => void
  readonly #abortActive: () => void
  #tail: Promise<void> = Promise.resolve()
  #timer: unknown
  #startAttempt: Promise<void> | undefined
  #disposeAttempt: Promise<void> | undefined
  #started = false
  #disposed = false

  constructor(options: Run2skillV2PipelineRuntimeOptions) {
    this.#batchScheduler = options.batchScheduler
    this.#stages = options.stages
    this.#recoveryOrder = options.recoveryOrder
    this.#maxTransitionsPerDrain = options.maxTransitionsPerDrain ?? 256
    this.#onError = options.onError ?? (() => undefined)
    this.#nextWakeAt = options.nextWakeAt ?? (() => undefined)
    this.#now = options.now ?? Date.now
    this.#setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
    this.#clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.#abortActive = options.abortActive ?? (() => undefined)
    if (!Number.isSafeInteger(this.#maxTransitionsPerDrain) || this.#maxTransitionsPerDrain < 1) {
      throw new TypeError('Invalid v2 pipeline drain limit')
    }
    if (new Set(this.#stages).size !== this.#stages.length) {
      throw new TypeError('Duplicate v2 pipeline stage')
    }
    if (this.#recoveryOrder.some(worker => !this.#stages.includes(worker))) {
      throw new TypeError('V2 recovery worker is not a pipeline stage')
    }
  }

  async start(): Promise<void> {
    if (this.#disposed) throw new Error('Run2Skill v2 pipeline is disposed')
    if (this.#started) return await this.settle()
    if (this.#startAttempt !== undefined) return await this.#startAttempt
    const attempt = this.#enqueue(async () => {
      for (const worker of this.#recoveryOrder) await worker.recover?.()
      await this.#batchScheduler.start()
      await this.#drain()
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
    if (!this.#started) await this.start()
    this.#assertOpen()
    return await this.#enqueue(async () => {
      await this.#batchScheduler.prepareSessionWindow(sessionLifecycleKey)
    })
  }

  async observe(observation: TurnObservationV2): Promise<void> {
    if (!this.#started) await this.start()
    this.#assertOpen()
    return await this.#enqueue(async () => {
      await this.#batchScheduler.observe(observation)
      await this.#drain()
    })
  }

  async requestSynthesis(sessionLifecycleKey: string): Promise<{
    readonly changed: boolean
    readonly disposition: 'EMPTY' | 'PROCESSING' | 'QUEUED'
  }> {
    if (!this.#started) await this.start()
    this.#assertOpen()
    if (this.#batchScheduler.requestSynthesis === undefined) {
      throw new Error('Run2Skill synthesis requests are unavailable')
    }
    return await this.#batchScheduler.requestSynthesis(sessionLifecycleKey)
  }

  wake(): void {
    if (!this.#started || this.#disposed) return
    this.#batchScheduler.wake()
    void this.#enqueue(async () => {
      await this.#batchScheduler.settle()
      await this.#drain()
    }).catch(() => undefined)
  }

  settle(): Promise<void> {
    return this.#tail
  }

  async dispose(): Promise<void> {
    if (this.#disposeAttempt !== undefined) return await this.#disposeAttempt
    const attempt = (async () => {
      this.#disposed = true
      this.#cancelTimer()
      try {
        this.#abortActive()
      } catch (error) {
        this.#reportError(error)
      }
      const results = await Promise.allSettled([
        this.settle(),
        this.#batchScheduler.dispose(),
      ])
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failure !== undefined) throw failure.reason
    })()
    this.#disposeAttempt = attempt
    return await attempt
  }

  async #drain(): Promise<void> {
    for (let transition = 0; transition < this.#maxTransitionsPerDrain; transition += 1) {
      if (this.#disposed) return
      let processed = false
      for (const worker of this.#stages) {
        if (this.#disposed) return
        const outcome = await worker.runOnce()
        if (this.#disposed) return
        if (outcome === 'PROCESSED') {
          processed = true
          break
        }
      }
      if (!processed) return
    }
    throw new Error('Run2Skill v2 pipeline drain limit reached')
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#tail.catch(() => undefined).then(operation)
    this.#tail = result.then(
      () => { this.#schedule() },
      (error: unknown) => {
        this.#reportError(error)
        this.#schedule()
      },
    )
    return result
  }

  #schedule(): void {
    this.#cancelTimer()
    if (!this.#started || this.#disposed) return
    let deadline: number | undefined
    try {
      deadline = this.#nextWakeAt()
    } catch (error) {
      this.#reportError(error)
      return
    }
    if (deadline === undefined || !Number.isFinite(deadline)) return
    const now = this.#now()
    // A due intent was already attempted by the preceding drain. Retrying it
    // immediately would spin when the external activity observation is incomplete.
    if (deadline <= now) return
    const delay = Math.min(MAX_TIMER_DELAY_MS, deadline - now)
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

  #reportError(error: unknown): void {
    try {
      this.#onError(error)
    } catch {
      // A diagnostic callback cannot poison the durable execution tail.
    }
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error('Run2Skill v2 pipeline is disposed')
  }
}
