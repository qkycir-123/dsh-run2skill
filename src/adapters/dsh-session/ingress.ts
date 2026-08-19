import type {
  DirectUserCoordinate,
  DshSessionEvent,
  DshSessionHeader,
  SessionIngressHealth,
  TurnIngressCandidate,
} from './types.js'

interface TurnBuffer {
  readonly header: DshSessionHeader
  readonly turnStartSeq: number
  readonly directUserMessages: DirectUserCoordinate[]
  incomplete: boolean
}

type CandidateHandler = (candidate: TurnIngressCandidate) => unknown
type HealthHandler = (health: SessionIngressHealth) => unknown

export interface SessionCoordinateIngressOptions {
  readonly maxCoordinates?: number
}

const DEFAULT_MAX_COORDINATES = 1024

function copyHeader(header: DshSessionHeader): DshSessionHeader {
  return {
    version: header.version,
    id: header.id,
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    ...(header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth }),
  }
}

function sessionBufferKey(header: DshSessionHeader): string {
  return JSON.stringify([header.id, header.createdAt, header.cwd ?? null])
}

function isCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function directUserCoordinate(event: DshSessionEvent): DirectUserCoordinate | undefined {
  if (
    event.type !== 'user/message'
    || event.data === null
    || typeof event.data !== 'object'
    || Array.isArray(event.data)
  ) return undefined
  const data = event.data as Record<string, unknown>
  const source = data['source']
  const messageId = data['id']
  if (
    source === null
    || typeof source !== 'object'
    || Array.isArray(source)
    || (source as Record<string, unknown>)['kind'] !== 'user'
    || typeof messageId !== 'string'
    || messageId.length === 0
    || !isCoordinate(event.seq)
  ) {
    return undefined
  }
  return { messageSeq: event.seq, messageId }
}

export class SessionCoordinateIngress {
  readonly #buffers = new Map<string, TurnBuffer>()
  readonly #maxCoordinates: number
  readonly #pendingHealthCodes = new Set<SessionIngressHealth['code']>()
  #coordinateCount = 0
  #saturationReported = false

  constructor(
    private readonly onCandidate: CandidateHandler,
    private readonly onHealth?: HealthHandler,
    options: SessionCoordinateIngressOptions = {},
  ) {
    const requestedMaximum = options.maxCoordinates ?? DEFAULT_MAX_COORDINATES
    this.#maxCoordinates = Number.isSafeInteger(requestedMaximum) && requestedMaximum > 0
      ? requestedMaximum
      : DEFAULT_MAX_COORDINATES
  }

  observe(header: DshSessionHeader, event: DshSessionEvent): void {
    try {
      this.observeCoordinate(header, event)
    } catch {
      this.reportDownstreamFailure()
    }
  }

  private observeCoordinate(header: DshSessionHeader, event: DshSessionEvent): void {
    if (event.type === 'turn/start') {
      if (event.data === null || typeof event.data !== 'object' || Array.isArray(event.data)) return
      const turn = (event.data as Record<string, unknown>)['turn']
      if (!isCoordinate(turn) || !isCoordinate(event.seq)) return
      const key = sessionBufferKey(header)
      this.releaseBuffer(key)
      if (!this.reserveCoordinate()) return
      this.#buffers.set(key, {
        header: copyHeader(header),
        turnStartSeq: event.seq,
        directUserMessages: [],
        incomplete: false,
      })
      return
    }

    const direct = directUserCoordinate(event)
    if (direct !== undefined) {
      const key = sessionBufferKey(header)
      const buffer = this.#buffers.get(key)
      if (buffer !== undefined) {
        if (this.reserveCoordinate()) {
          buffer.directUserMessages.push(direct)
        } else {
          buffer.incomplete = true
        }
      }
      return
    }
    if (event.type !== 'turn/end') return

    if (event.data === null || typeof event.data !== 'object' || Array.isArray(event.data)) return
    const turn = (event.data as Record<string, unknown>)['turn']
    if (!isCoordinate(turn) || !isCoordinate(event.seq)) return
    const key = sessionBufferKey(header)
    const buffered = this.#buffers.get(key)
    const complete = buffered !== undefined && !buffered.incomplete
    this.releaseBuffer(key)
    const candidate: TurnIngressCandidate = {
      header: buffered?.header ?? copyHeader(header),
      turn,
      ...(complete ? { turnStartSeq: buffered.turnStartSeq } : {}),
      turnEndSeq: event.seq,
      directUserMessages: complete ? buffered.directUserMessages : [],
    }
    queueMicrotask(() => {
      try {
        void Promise.resolve(this.onCandidate(candidate)).catch(() => {
          this.reportHealth('SESSION_OBSERVER_DOWNSTREAM_FAILED')
        })
      } catch {
        this.reportHealth('SESSION_OBSERVER_DOWNSTREAM_FAILED')
      }
    })
  }

  private reserveCoordinate(): boolean {
    if (this.#coordinateCount >= this.#maxCoordinates) {
      if (!this.#saturationReported) {
        this.#saturationReported = true
        this.reportHealth('INGRESS_SATURATED')
      }
      return false
    }
    this.#coordinateCount += 1
    return true
  }

  private releaseBuffer(key: string): void {
    const buffer = this.#buffers.get(key)
    if (buffer === undefined) return
    this.#coordinateCount -= 1 + buffer.directUserMessages.length
    this.#buffers.delete(key)
    if (this.#coordinateCount < this.#maxCoordinates) this.#saturationReported = false
  }

  private reportDownstreamFailure(): void {
    this.reportHealth('SESSION_OBSERVER_DOWNSTREAM_FAILED')
  }

  private reportHealth(code: SessionIngressHealth['code']): void {
    if (this.onHealth === undefined || this.#pendingHealthCodes.has(code)) return
    this.#pendingHealthCodes.add(code)
    queueMicrotask(() => {
      this.#pendingHealthCodes.delete(code)
      try {
        void Promise.resolve(this.onHealth?.({ code })).catch(() => undefined)
      } catch {
        // Health reporting is also fail-open and never exposes the original error.
      }
    })
  }
}
