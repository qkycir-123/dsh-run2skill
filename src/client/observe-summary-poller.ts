import {
  ObserveSummaryV1Schema,
  type ObserveSummaryV1,
} from '../domain/observe/observe-summary.js'

export const OBSERVE_SUMMARY_POLL_INTERVAL_MS = 10_000

export type ObserveSummaryClientState =
  | { readonly phase: 'LOADING' }
  | { readonly phase: 'UNAVAILABLE' }
  | { readonly phase: 'READY'; readonly summary: ObserveSummaryV1 }
  | { readonly phase: 'STALE'; readonly summary: ObserveSummaryV1 }

export interface ObservePollEnvironment {
  isVisible(): boolean
  setInterval(callback: () => void, delayMs: number): unknown
  clearInterval(handle: unknown): void
  onFocus(listener: () => void): () => void
  onVisibilityChange(listener: () => void): () => void
}

export type ObserveSummaryCall = (
  payload: { readonly apiVersion: 1 },
  signal: AbortSignal,
) => Promise<unknown>

function browserEnvironment(): ObservePollEnvironment {
  return {
    isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
    setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
    clearInterval: handle => { globalThis.clearInterval(handle as ReturnType<typeof setInterval>) },
    onFocus: listener => {
      if (typeof window === 'undefined') return () => undefined
      window.addEventListener('focus', listener)
      return () => { window.removeEventListener('focus', listener) }
    },
    onVisibilityChange: listener => {
      if (typeof document === 'undefined') return () => undefined
      document.addEventListener('visibilitychange', listener)
      return () => { document.removeEventListener('visibilitychange', listener) }
    },
  }
}

function parsedSummary(result: unknown): ObserveSummaryV1 | undefined {
  if (result === null || typeof result !== 'object' || !('ok' in result) || result.ok !== true) {
    return undefined
  }
  const parsed = ObserveSummaryV1Schema.safeParse(
    'value' in result ? result.value : undefined,
  )
  return parsed.success ? parsed.data : undefined
}

export class ObserveSummaryPoller {
  readonly #listeners = new Set<() => void>()
  #state: ObserveSummaryClientState = { phase: 'LOADING' }
  #started = false
  #disposed = false
  #timer: unknown
  #pending: Promise<void> | undefined
  #abort: AbortController | undefined
  #removeFocus: (() => void) | undefined
  #removeVisibility: (() => void) | undefined

  constructor(
    private readonly call: ObserveSummaryCall,
    private readonly environment: ObservePollEnvironment = browserEnvironment(),
  ) {}

  snapshot = (): ObserveSummaryClientState => this.#state

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  start(): void {
    if (this.#started || this.#disposed) return
    this.#started = true
    this.#removeFocus = this.environment.onFocus(() => {
      if (this.environment.isVisible()) void this.#refresh()
    })
    this.#removeVisibility = this.environment.onVisibilityChange(() => {
      if (this.environment.isVisible()) {
        this.#schedule()
        void this.#refresh()
      } else {
        this.#unschedule()
      }
    })
    if (this.environment.isVisible()) {
      this.#schedule()
      void this.#refresh()
    }
  }

  whenIdle(): Promise<void> {
    return this.#pending ?? Promise.resolve()
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#unschedule()
    this.#removeFocus?.()
    this.#removeVisibility?.()
    this.#removeFocus = undefined
    this.#removeVisibility = undefined
    this.#abort?.abort()
    this.#listeners.clear()
  }

  #schedule(): void {
    if (this.#timer !== undefined || this.#disposed) return
    this.#timer = this.environment.setInterval(() => { void this.#refresh() }, OBSERVE_SUMMARY_POLL_INTERVAL_MS)
  }

  #unschedule(): void {
    if (this.#timer === undefined) return
    this.environment.clearInterval(this.#timer)
    this.#timer = undefined
  }

  #refresh(): Promise<void> {
    if (this.#disposed || this.#pending !== undefined || !this.environment.isVisible()) {
      return this.#pending ?? Promise.resolve()
    }
    const abort = new AbortController()
    this.#abort = abort
    const pending = (async () => {
      try {
        const summary = parsedSummary(await this.call({ apiVersion: 1 }, abort.signal))
        if (this.#disposed) return
        if (summary === undefined) this.#markUnavailable()
        else this.#publish({ phase: 'READY', summary })
      } catch {
        if (!this.#disposed && !abort.signal.aborted) this.#markUnavailable()
      }
    })()
    this.#pending = pending
    void pending.finally(() => {
      if (this.#pending === pending) this.#pending = undefined
      if (this.#abort === abort) this.#abort = undefined
    })
    return pending
  }

  #markUnavailable(): void {
    this.#publish('summary' in this.#state
      ? { phase: 'STALE', summary: this.#state.summary }
      : { phase: 'UNAVAILABLE' })
  }

  #publish(state: ObserveSummaryClientState): void {
    this.#state = state
    for (const listener of this.#listeners) listener()
  }
}
