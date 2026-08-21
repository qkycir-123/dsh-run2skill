const HEALTH_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/

export interface RuntimeNoticeInput {
  readonly healthCode: string
  readonly sessionId: string
  readonly turnEndSeq?: number
  readonly signalClass?: 'EXPLICIT_SAVE' | 'OTHER_HIGH'
}

export type RuntimeNoticeKind = 'HEALTH' | 'UNSAVED_SIGNAL'

export interface RuntimeNotice extends RuntimeNoticeInput {
  readonly kind: RuntimeNoticeKind
  readonly count: number
  readonly firstObservedAt: number
  readonly lastObservedAt: number
  readonly requiresAttention: boolean
}

export class RuntimeNotices {
  readonly #now
  readonly #limit
  readonly #aggregationWindowMs
  readonly #notices = new Map<string, RuntimeNotice>()
  #unsavedComplete = true

  constructor(options: {
    now?: () => number
    limit?: number
    aggregationWindowMs?: number
  } = {}) {
    this.#now = options.now ?? Date.now
    this.#limit = options.limit ?? 256
    this.#aggregationWindowMs = options.aggregationWindowMs ?? 30_000
  }

  record(input: RuntimeNoticeInput): void {
    this.#record(input, 'HEALTH')
  }

  recordUnsaved(input: RuntimeNoticeInput): void {
    this.#record(input, 'UNSAVED_SIGNAL')
  }

  unsavedCompletenessKnown(): boolean {
    return this.#unsavedComplete
  }

  #record(input: RuntimeNoticeInput, kind: RuntimeNoticeKind): void {
    if (!HEALTH_CODE_PATTERN.test(input.healthCode)) throw new TypeError('Invalid health code')
    if (input.sessionId.length === 0) throw new TypeError('Session ID is required')
    if (input.turnEndSeq !== undefined && (!Number.isSafeInteger(input.turnEndSeq) || input.turnEndSeq < 0)) {
      throw new TypeError('Invalid Turn end sequence')
    }
    const key = this.#key(input)
    const now = this.#now()
    const existing = this.#notices.get(key)
    const canAggregate = existing !== undefined
      && now - existing.lastObservedAt <= this.#aggregationWindowMs
    const retainedKind = existing?.kind === 'UNSAVED_SIGNAL' || kind === 'UNSAVED_SIGNAL'
      ? 'UNSAVED_SIGNAL'
      : 'HEALTH'
    this.#notices.delete(key)
    this.#notices.set(key, !canAggregate
      ? {
          kind: retainedKind,
          healthCode: input.healthCode,
          sessionId: input.sessionId,
          ...(input.turnEndSeq === undefined ? {} : { turnEndSeq: input.turnEndSeq }),
          ...(input.signalClass === undefined ? {} : { signalClass: input.signalClass }),
          count: 1,
          firstObservedAt: now,
          lastObservedAt: now,
          requiresAttention: false,
        }
      : {
          ...existing,
          kind: retainedKind,
          ...(input.signalClass === undefined ? {} : { signalClass: input.signalClass }),
          count: existing.count + 1,
          lastObservedAt: now,
        })
    while (this.#notices.size > this.#limit) {
      const oldest = this.#notices.keys().next().value as string | undefined
      if (oldest === undefined) break
      if (this.#notices.get(oldest)?.kind === 'UNSAVED_SIGNAL') this.#unsavedComplete = false
      this.#notices.delete(oldest)
    }
  }

  clearSignal(sessionId: string, turnEndSeq: number): void {
    for (const [key, notice] of this.#notices) {
      if (notice.sessionId === sessionId && notice.turnEndSeq === turnEndSeq) {
        this.#notices.delete(key)
      }
    }
  }

  markUnsavedAttention(sessionId: string, turnEndSeq: number): void {
    for (const [key, notice] of this.#notices) {
      if (
        notice.kind === 'UNSAVED_SIGNAL'
        && notice.sessionId === sessionId
        && notice.turnEndSeq === turnEndSeq
      ) this.#notices.set(key, { ...notice, requiresAttention: true })
    }
  }

  list(): readonly RuntimeNotice[] {
    return [...this.#notices.values()]
  }

  #key(input: RuntimeNoticeInput): string {
    return `${input.healthCode}\u0000${input.sessionId}\u0000${input.turnEndSeq ?? ''}`
  }
}
