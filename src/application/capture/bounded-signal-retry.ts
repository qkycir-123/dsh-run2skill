export const SIGNAL_RETRY_DELAYS_MS = [250, 1_000, 4_000] as const

export type SignalRetryResult<T> =
  | { readonly status: 'SUCCEEDED'; readonly attempts: number; readonly value: T }
  | { readonly status: 'EXHAUSTED'; readonly attempts: number }
  | { readonly status: 'CANCELLED'; readonly attempts: number }

type RetrySleep = (delayMs: number, signal: AbortSignal) => Promise<void>

function sleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('aborted'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class BoundedSignalRetry {
  readonly #delays: readonly number[]
  readonly #sleep: RetrySleep
  readonly #active = new Map<string, Promise<SignalRetryResult<unknown>>>()
  readonly #abortController = new AbortController()
  #disposed = false

  constructor(options: {
    delaysMs?: readonly number[]
    sleep?: RetrySleep
  } = {}) {
    this.#delays = options.delaysMs ?? SIGNAL_RETRY_DELAYS_MS
    if (this.#delays.some((delay) => !Number.isSafeInteger(delay) || delay < 0)) {
      throw new TypeError('Retry delays must be non-negative safe integers')
    }
    this.#sleep = options.sleep ?? sleep
  }

  run<T>(key: string, operation: (attempt: number) => Promise<T>): Promise<SignalRetryResult<T>> {
    if (key.length === 0) throw new TypeError('Signal retry key is required')
    const existing = this.#active.get(key)
    if (existing !== undefined) return existing as Promise<SignalRetryResult<T>>
    if (this.#disposed) return Promise.resolve({ status: 'CANCELLED', attempts: 0 })

    const pending = this.#run(operation)
    this.#active.set(key, pending)
    void pending.finally(() => {
      if (this.#active.get(key) === pending) this.#active.delete(key)
    })
    return pending
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#abortController.abort()
  }

  get activeCount(): number {
    return this.#active.size
  }

  async #run<T>(operation: (attempt: number) => Promise<T>): Promise<SignalRetryResult<T>> {
    let attempts = 0
    for (let attempt = 0; attempt <= this.#delays.length; attempt += 1) {
      if (this.#disposed) return { status: 'CANCELLED', attempts }
      attempts += 1
      try {
        return { status: 'SUCCEEDED', attempts, value: await operation(attempt) }
      } catch {
        const delay = this.#delays[attempt]
        if (delay === undefined) return { status: 'EXHAUSTED', attempts }
        try {
          await this.#sleep(delay, this.#abortController.signal)
        } catch {
          return { status: 'CANCELLED', attempts }
        }
      }
    }
    return { status: 'EXHAUSTED', attempts }
  }
}
