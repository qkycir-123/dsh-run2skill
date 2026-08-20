import type { PublicationSagaStore } from '../../adapters/dsh-storage/publication-saga-store.js'
import type { CaptureWorkItemV1 } from '../../domain/observe/schemas.js'

export interface PublicationWorkerPort {
  run(workItemId: string): Promise<unknown>
}

export interface PublicationSchedulerOptions {
  readonly store: PublicationSagaStore
  readonly worker: PublicationWorkerPort
  readonly eligible?: (item: CaptureWorkItemV1) => boolean
  readonly onError?: (workItemId: string) => void
}

export class PublicationScheduler {
  readonly #store
  readonly #worker
  readonly #eligible
  readonly #onError
  #running: Promise<void> | undefined
  #queued = false
  #disposed = false

  constructor(options: PublicationSchedulerOptions) {
    this.#store = options.store
    this.#worker = options.worker
    this.#eligible = options.eligible ?? (() => true)
    this.#onError = options.onError ?? (() => {})
  }

  async start(): Promise<void> {
    if (this.#disposed) return
    this.#queued = true
    this.#ensureDrain()
    await this.#running
  }

  wake(): void {
    if (this.#disposed) return
    this.#queued = true
    this.#ensureDrain()
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    this.#queued = false
    await this.#running
  }

  #ensureDrain(): void {
    if (this.#running !== undefined) return
    this.#running = Promise.resolve().then(async () => {
      while (this.#queued && !this.#disposed) {
        this.#queued = false
        const items = this.#store.listRecoverable().filter(this.#eligible)
        for (const item of items) {
          if (this.#disposed) return
          try {
            await this.#worker.run(item.workItemId)
          } catch {
            this.#onError(item.workItemId)
          }
        }
      }
    }).finally(() => {
      this.#running = undefined
      if (this.#queued && !this.#disposed) this.#ensureDrain()
    })
  }
}
