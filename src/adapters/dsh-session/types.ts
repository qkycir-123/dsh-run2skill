export interface DshSessionHeader {
  readonly version: number
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSession?: string
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
}

export interface DshSessionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly ignorable?: true
}

export interface DirectUserCoordinate {
  readonly messageSeq: number
  readonly messageId: string
}

export interface TurnIngressCandidate {
  readonly header: DshSessionHeader
  readonly turn: number
  readonly turnStartSeq?: number
  readonly turnEndSeq: number
  readonly directUserMessages: readonly DirectUserCoordinate[]
}

export interface DirectUserMessageObservation extends DirectUserCoordinate {
  readonly textBlocks: readonly string[]
}

export interface TurnObservation {
  readonly rootSessionId: string
  readonly sessionCreatedAt: number
  readonly sessionCwdDigest: string
  readonly sessionLifecycleKey: string
  readonly parentSessionId?: string
  readonly turn: number
  readonly turnStartSeq: number
  readonly turnEndSeq: number
  readonly turnEndTime: number
  readonly turnOutcomeKind: string
  readonly turnInstanceDigest: string
  readonly directUserMessages: readonly DirectUserMessageObservation[]
}

export type SessionRootClassification =
  | { readonly status: 'ROOT'; readonly parentSessionId?: string }
  | { readonly status: 'CHILD' }
  | { readonly status: 'UNAVAILABLE'; readonly healthCode: 'ROOT_IDENTITY_UNAVAILABLE' }

export type TurnObservationResult =
  | { readonly status: 'OBSERVED'; readonly observation: TurnObservation }
  | { readonly status: 'CHILD' }
  | {
    readonly status: 'UNAVAILABLE'
    readonly healthCode: 'ROOT_IDENTITY_UNAVAILABLE' | 'TURN_BOUNDARY_INCOMPLETE'
    readonly sessionId?: string
    readonly turnEndSeq?: number
  }

export interface SessionPersistenceSnapshot {
  readonly header: DshSessionHeader
  readonly revision: string
}

export interface SessionPersistencePort {
  listSnapshots(signal?: AbortSignal): Promise<readonly SessionPersistenceSnapshot[]>
  readFrom(
    sessionId: string,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ readonly meta: DshSessionHeader; readonly events: readonly DshSessionEvent[] }>
}

export interface SessionIngressHealth {
  readonly code: 'INGRESS_SATURATED' | 'SESSION_OBSERVER_DOWNSTREAM_FAILED'
}

export type SnapshotReadResult =
  | { readonly status: 'AVAILABLE'; readonly snapshots: readonly SessionPersistenceSnapshot[] }
  | { readonly status: 'UNAVAILABLE'; readonly healthCode: 'SESSION_SNAPSHOTS_UNAVAILABLE' }

export type SessionLogReadResult =
  | {
    readonly status: 'AVAILABLE'
    readonly header: DshSessionHeader
    readonly events: readonly DshSessionEvent[]
  }
  | {
    readonly status: 'UNAVAILABLE'
    readonly healthCode: 'SESSION_LOG_UNAVAILABLE'
    readonly sessionId: string
    readonly fromSeq: number
  }
