import type { TurnObservationV2 } from '../../domain/v2/index.js'

export interface V2PipelineBatchScheduler {
  start(): Promise<void>
  prepareSessionWindow(sessionLifecycleKey: string): Promise<void>
  observe(observation: TurnObservationV2): Promise<void>
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
  #tail: Promise<void> = Promise.resolve()
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
      await this.settle()
      await this.#batchScheduler.dispose()
    })()
    this.#disposeAttempt = attempt
    return await attempt
  }

  async #drain(): Promise<void> {
    for (let transition = 0; transition < this.#maxTransitionsPerDrain; transition += 1) {
      let processed = false
      for (const worker of this.#stages) {
        if (await worker.runOnce() === 'PROCESSED') {
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
    this.#tail = result.catch((error: unknown) => {
      try {
        this.#onError(error)
      } catch {
        // A diagnostic callback cannot poison the durable execution tail.
      }
    })
    return result
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error('Run2Skill v2 pipeline is disposed')
  }
}
