import type { TurnIngressCandidate } from '../../adapters/dsh-session/types.js'
import type { GapScanResult } from './bounded-gap-scanner.js'
import { BoundedSignalRetry } from './bounded-signal-retry.js'
import type { RuntimeNotices } from './runtime-notices.js'

export const CAPTURE_QUEUE_LIMIT = 1_024
export const BACKEND_HEALTH_PROBE_INTERVAL_MS = 30_000
export const CAPTURE_DISPOSE_DRAIN_MS = 2_000

export type RecoveryLifecycleStatus = 'RECOVERING' | 'READY' | 'DEGRADED' | 'DISPOSED'

export interface RecoveryScannerPort {
  ensureActivated(signal?: AbortSignal): Promise<GapScanResult>
  scanBatch(signal?: AbortSignal): Promise<GapScanResult>
}

export interface RecoveryRuntime<Candidate = TurnIngressCandidate> {
  readonly scanner: RecoveryScannerPort
  processCandidate(candidate: Candidate): Promise<void>
  close(): Promise<void>
}

export interface RecoveryRuntimeFactory<Candidate = TurnIngressCandidate> {
  open(): Promise<RecoveryRuntime<Candidate>>
}

export interface RecoveryLifecycleSnapshot {
  readonly status: RecoveryLifecycleStatus
  readonly queueDepth: number
  readonly maxQueueDepth: number
  readonly catchupNeeded: boolean
  readonly recoveryLag: boolean
  readonly maxReadFromLatencyMs: number
  readonly peakHeapBytes: number
  readonly lastCatchupDurationMs?: number
}

interface CandidateCoordinate {
  readonly sessionId: string
  readonly turnEndSeq?: number
}

type ScheduledHandle = unknown

function defaultSchedule(callback: () => void, delayMs: number): ScheduledHandle {
  return setTimeout(callback, delayMs)
}

function defaultCancelScheduled(handle: ScheduledHandle): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>)
}

function defaultWaitFor(pending: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(false)
    }, timeoutMs)
    void pending.then(
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(true)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(true)
      },
    )
  })
}

function defaultCoordinate(value: unknown): CandidateCoordinate {
  if (
    value !== null
    && typeof value === 'object'
    && 'header' in value
    && 'turnEndSeq' in value
  ) {
    const candidate = value as Partial<TurnIngressCandidate>
    const sessionId = candidate.header?.id
    const turnEndSeq = candidate.turnEndSeq
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      return {
        sessionId,
        ...(typeof turnEndSeq === 'number' ? { turnEndSeq } : {}),
      }
    }
  }
  return { sessionId: 'global' }
}

export class RecoveryLifecycle<Candidate = TurnIngressCandidate> {
  readonly #queue: Array<{ readonly key: string; readonly candidate: Candidate }> = []
  readonly #candidateKeys = new Set<string>()
  readonly #failedKeys = new Set<string>()
  readonly #maxQueuedCandidates
  readonly #lowWatermark
  readonly #retry
  readonly #schedule
  readonly #cancelScheduled
  readonly #waitFor
  readonly #yieldNow
  readonly #now
  readonly #coordinate
  #status: RecoveryLifecycleStatus = 'RECOVERING'
  #started = false
  #disposed = false
  #catchupNeeded = false
  #recoveryLag = true
  #maxQueueDepth = 0
  #maxReadFromLatencyMs = 0
  #peakHeapBytes = 0
  #lastCatchupDurationMs: number | undefined
  #runtime: RecoveryRuntime<Candidate> | undefined
  #recoverPromise: Promise<void> | undefined
  #drainPromise: Promise<void> | undefined
  #probeTimer: ScheduledHandle | undefined
  #scanAbort = new AbortController()

  constructor(
    private readonly factory: RecoveryRuntimeFactory<Candidate>,
    private readonly candidateKey: (candidate: Candidate) => string,
    private readonly notices: RuntimeNotices,
    options: {
      maxQueuedCandidates?: number
      lowWatermark?: number
      retrySleep?: (delayMs: number, signal: AbortSignal) => Promise<void>
      schedule?: (callback: () => void, delayMs: number) => ScheduledHandle
      cancelScheduled?: (handle: ScheduledHandle) => void
      waitFor?: (pending: Promise<unknown>, timeoutMs: number) => Promise<boolean>
      yieldNow?: () => Promise<void>
      now?: () => number
      coordinate?: (candidate: Candidate) => CandidateCoordinate
    } = {},
  ) {
    this.#maxQueuedCandidates = options.maxQueuedCandidates ?? CAPTURE_QUEUE_LIMIT
    this.#lowWatermark = options.lowWatermark ?? Math.floor(this.#maxQueuedCandidates / 2)
    if (
      !Number.isSafeInteger(this.#maxQueuedCandidates)
      || this.#maxQueuedCandidates < 1
      || !Number.isSafeInteger(this.#lowWatermark)
      || this.#lowWatermark < 0
      || this.#lowWatermark >= this.#maxQueuedCandidates
    ) {
      throw new TypeError('Invalid capture queue bounds')
    }
    this.#retry = new BoundedSignalRetry(
      options.retrySleep === undefined ? {} : { sleep: options.retrySleep },
    )
    this.#schedule = options.schedule ?? defaultSchedule
    this.#cancelScheduled = options.cancelScheduled ?? defaultCancelScheduled
    this.#waitFor = options.waitFor ?? defaultWaitFor
    this.#yieldNow = options.yieldNow ?? (() => new Promise((resolve) => setTimeout(resolve, 0)))
    this.#now = options.now ?? Date.now
    this.#coordinate = options.coordinate ?? defaultCoordinate
  }

  get status(): RecoveryLifecycleStatus {
    return this.#status
  }

  start(): Promise<void> {
    if (this.#disposed) return Promise.resolve()
    if (!this.#started) {
      this.#started = true
      this.#status = 'RECOVERING'
      this.#beginRecovery()
    }
    return this.#recoverPromise ?? Promise.resolve()
  }

  accept(candidate: Candidate): boolean {
    if (this.#disposed) return false
    const key = this.candidateKey(candidate)
    if (key.length === 0) throw new TypeError('Capture candidate key is required')
    if (this.#candidateKeys.has(key)) return true
    if (this.#queue.length >= this.#maxQueuedCandidates) {
      this.#catchupNeeded = true
      const coordinate = this.#coordinate(candidate)
      this.notices.record({
        healthCode: 'INGRESS_SATURATED',
        sessionId: coordinate.sessionId,
        ...(coordinate.turnEndSeq === undefined ? {} : { turnEndSeq: coordinate.turnEndSeq }),
      })
      return false
    }
    this.#candidateKeys.add(key)
    this.#queue.push({ key, candidate })
    this.#maxQueueDepth = Math.max(this.#maxQueueDepth, this.#queue.length)
    if (this.#status === 'READY') this.#beginDrain()
    return true
  }

  async whenIdle(): Promise<void> {
    while (true) {
      const pending = [this.#recoverPromise, this.#drainPromise]
        .filter((value): value is Promise<void> => value !== undefined)
      if (pending.length === 0) return
      await Promise.allSettled(pending)
    }
  }

  snapshot(): RecoveryLifecycleSnapshot {
    return {
      status: this.#status,
      queueDepth: this.#queue.length,
      maxQueueDepth: this.#maxQueueDepth,
      catchupNeeded: this.#catchupNeeded,
      recoveryLag: this.#recoveryLag,
      maxReadFromLatencyMs: this.#maxReadFromLatencyMs,
      peakHeapBytes: this.#peakHeapBytes,
      ...(this.#lastCatchupDurationMs === undefined
        ? {}
        : { lastCatchupDurationMs: this.#lastCatchupDurationMs }),
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#status = 'DISPOSED'
    if (this.#probeTimer !== undefined) {
      this.#cancelScheduled(this.#probeTimer)
      this.#probeTimer = undefined
    }
    this.#scanAbort.abort()
    this.#retry.dispose()
    const drain = this.#drainPromise
    if (drain !== undefined) await this.#waitFor(drain, CAPTURE_DISPOSE_DRAIN_MS)
    this.#queue.length = 0
    this.#candidateKeys.clear()
    this.#failedKeys.clear()
    const runtime = this.#runtime
    this.#runtime = undefined
    if (runtime !== undefined) await runtime.close()
  }

  #beginRecovery(): void {
    if (this.#disposed || this.#recoverPromise !== undefined) return
    const pending = this.#recover()
    this.#recoverPromise = pending
    void pending.finally(() => {
      if (this.#recoverPromise === pending) this.#recoverPromise = undefined
    })
  }

  async #recover(): Promise<void> {
    this.#status = 'RECOVERING'
    this.#recoveryLag = true
    try {
      const previous = this.#runtime
      this.#runtime = undefined
      if (previous !== undefined) await previous.close()
      if (this.#disposed) return
      this.#scanAbort = new AbortController()
      const runtime = await this.factory.open()
      if (this.#disposed) {
        await runtime.close()
        return
      }
      this.#runtime = runtime
      await this.#scanUntilComplete(runtime, true)
      for (const key of this.#failedKeys) this.#candidateKeys.delete(key)
      this.#failedKeys.clear()
      await this.#beginDrain(true)
      if (this.#disposed || this.#isDegraded()) return
      this.#status = 'READY'
      this.#recoveryLag = false
      if (this.#queue.length > 0) this.#beginDrain()
    } catch {
      if (!this.#disposed) this.#degrade('RECOVERY_BACKEND_UNAVAILABLE', { sessionId: 'global' })
    }
  }

  #beginDrain(force = false): Promise<void> {
    if (this.#drainPromise !== undefined) return this.#drainPromise
    if (
      this.#runtime === undefined
      || this.#disposed
      || (!force && this.#status !== 'READY')
    ) return Promise.resolve()
    const pending = this.#drain()
    this.#drainPromise = pending
    void pending.finally(() => {
      if (this.#drainPromise === pending) this.#drainPromise = undefined
    })
    return pending
  }

  async #drain(): Promise<void> {
    while (!this.#disposed && this.#runtime !== undefined && this.#queue.length > 0) {
      const entry = this.#queue.shift()
      if (entry === undefined) break
      const runtime = this.#runtime
      if (runtime === undefined) {
        this.#queue.unshift(entry)
        return
      }
      const coordinate = this.#coordinate(entry.candidate)
      const result = await this.#retry.run(entry.key, async () => {
        try {
          await runtime.processCandidate(entry.candidate)
        } catch {
          this.notices.record({
            healthCode: 'WORK_ITEM_WRITE_FAILED',
            sessionId: coordinate.sessionId,
            ...(coordinate.turnEndSeq === undefined ? {} : { turnEndSeq: coordinate.turnEndSeq }),
          })
          throw new Error('capture persistence failed')
        }
      })
      if (result.status === 'SUCCEEDED') {
        this.#candidateKeys.delete(entry.key)
      } else if (result.status === 'EXHAUSTED') {
        this.#failedKeys.add(entry.key)
        if (coordinate.turnEndSeq !== undefined) {
          this.notices.markUnsavedAttention(coordinate.sessionId, coordinate.turnEndSeq)
        }
        this.#degrade('WORK_ITEM_WRITE_FAILED', coordinate, false)
        return
      } else {
        return
      }

      if (this.#catchupNeeded && this.#queue.length <= this.#lowWatermark) {
        try {
          const runtime = this.#runtime
          if (runtime === undefined) return
          await this.#scanUntilComplete(runtime, false)
          this.#catchupNeeded = false
        } catch {
          this.#degrade('RECOVERY_BACKEND_UNAVAILABLE', coordinate)
          return
        }
      }
    }
  }

  async #scanUntilComplete(runtime: RecoveryRuntime<Candidate>, includeActivation: boolean): Promise<void> {
    const startedAt = this.#now()
    if (includeActivation) {
      const activation = await runtime.scanner.ensureActivated(this.#scanAbort.signal)
      this.#observeScan(activation)
      if (activation.status === 'UNAVAILABLE') throw new Error('activation unavailable')
    }
    while (!this.#disposed) {
      const result = await runtime.scanner.scanBatch(this.#scanAbort.signal)
      this.#observeScan(result)
      if (result.status === 'UNAVAILABLE') throw new Error('gap scan unavailable')
      if (result.status === 'COMPLETE') {
        this.#recoveryLag = false
        this.#lastCatchupDurationMs = this.#now() - startedAt
        return
      }
      this.#recoveryLag = true
      await this.#yieldNow()
    }
  }

  #observeScan(result: GapScanResult): void {
    this.#maxReadFromLatencyMs = Math.max(
      this.#maxReadFromLatencyMs,
      result.maxReadFromLatencyMs,
    )
    this.#peakHeapBytes = Math.max(this.#peakHeapBytes, result.peakHeapBytes)
  }

  #isDegraded(): boolean {
    return this.#status === 'DEGRADED'
  }

  #degrade(healthCode: string, coordinate: CandidateCoordinate, record = true): void {
    if (this.#disposed) return
    this.#status = 'DEGRADED'
    this.#recoveryLag = true
    if (record) {
      this.notices.record({
        healthCode,
        sessionId: coordinate.sessionId,
        ...(coordinate.turnEndSeq === undefined ? {} : { turnEndSeq: coordinate.turnEndSeq }),
      })
    }
    if (this.#probeTimer !== undefined) return
    this.#probeTimer = this.#schedule(() => {
      this.#probeTimer = undefined
      this.#beginRecovery()
    }, BACKEND_HEALTH_PROBE_INTERVAL_MS)
  }
}
