import {
  deriveSessionCwdDigest,
  deriveSessionLifecycleKey,
  deriveTurnInstanceDigest,
} from '../../domain/observe/signal-key.js'
import type {
  DirectUserMessageObservation,
  DshSessionEvent,
  DshSessionHeader,
  SessionRootClassification,
  TurnObservationResult,
} from './types.js'

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unavailableBoundary(header: DshSessionHeader, turnEndSeq: number): TurnObservationResult {
  return {
    status: 'UNAVAILABLE',
    healthCode: 'TURN_BOUNDARY_INCOMPLETE',
    ...(isNonEmptyString(header.id) ? { sessionId: header.id } : {}),
    ...(isNonNegativeSafeInteger(turnEndSeq) ? { turnEndSeq } : {}),
  }
}

export function classifySessionRoot(header: DshSessionHeader): SessionRootClassification {
  if (
    !isNonEmptyString(header.id)
    || !isNonNegativeSafeInteger(header.createdAt)
    || (header.cwd !== undefined && typeof header.cwd !== 'string')
    || (header.parentSession !== undefined && !isNonEmptyString(header.parentSession))
    || (header.origin !== undefined && header.origin !== 'subagent')
    || (header.delegationDepth !== undefined && !isNonNegativeSafeInteger(header.delegationDepth))
  ) {
    return { status: 'UNAVAILABLE', healthCode: 'ROOT_IDENTITY_UNAVAILABLE' }
  }
  if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) {
    return { status: 'CHILD' }
  }
  return {
    status: 'ROOT',
    ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
  }
}

function findTurnEnd(
  events: readonly DshSessionEvent[],
  turnEndSeq: number,
): DshSessionEvent | undefined {
  return events.find((event) => event.seq === turnEndSeq && event.type === 'turn/end')
}

function findMatchingTurnStart(
  events: readonly DshSessionEvent[],
  turn: number,
  turnEndSeq: number,
): DshSessionEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = events[index]
    if (candidate === undefined || candidate.seq >= turnEndSeq) continue
    if (
      candidate.type === 'turn/start'
      && isRecord(candidate.data)
      && candidate.data['turn'] === turn
    ) return candidate
  }
  return undefined
}

function isContiguousTurnSlice(
  events: readonly DshSessionEvent[],
  turn: number,
  startSeq: number,
  endSeq: number,
): boolean {
  if (events.length !== endSeq - startSeq + 1) return false
  return events.every((event, index) => {
    if (event.seq !== startSeq + index || !isNonNegativeSafeInteger(event.time)) return false
    if (event.type !== 'turn/start' && event.type !== 'turn/end') return true
    return isRecord(event.data) && event.data['turn'] === turn
  })
}

function directUserMessage(event: DshSessionEvent): DirectUserMessageObservation | undefined {
  if (event.type !== 'user/message' || !isRecord(event.data)) return undefined
  const source = event.data['source']
  if (!isRecord(source) || source['kind'] !== 'user') return undefined
  const messageId = event.data['id']
  const content = event.data['content']
  if (!isNonEmptyString(messageId) || !Array.isArray(content)) return undefined
  const textBlocks: string[] = []
  for (const block of content) {
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
      textBlocks.push(block['text'])
    }
  }
  return { messageSeq: event.seq, messageId, textBlocks }
}

function isDirectUserEvent(event: DshSessionEvent): boolean {
  if (event.type !== 'user/message' || !isRecord(event.data)) return false
  const source = event.data['source']
  return isRecord(source) && source['kind'] === 'user'
}

export function buildTurnObservation(
  header: DshSessionHeader,
  sessionEvents: readonly DshSessionEvent[],
  turnEndSeq: number,
): TurnObservationResult {
  const root = classifySessionRoot(header)
  if (root.status === 'CHILD') return { status: 'CHILD' }
  if (root.status === 'UNAVAILABLE') {
    return {
      status: 'UNAVAILABLE',
      healthCode: root.healthCode,
      ...(isNonEmptyString(header.id) ? { sessionId: header.id } : {}),
      ...(isNonNegativeSafeInteger(turnEndSeq) ? { turnEndSeq } : {}),
    }
  }
  if (!isNonNegativeSafeInteger(turnEndSeq)) return unavailableBoundary(header, turnEndSeq)

  const turnEnd = findTurnEnd(sessionEvents, turnEndSeq)
  const turnEndData = turnEnd === undefined || !isRecord(turnEnd.data) ? undefined : turnEnd.data
  const turn = turnEndData?.['turn']
  const reason = turnEndData?.['reason']
  if (
    turnEnd === undefined
    || !isNonNegativeSafeInteger(turn)
    || !isRecord(reason)
    || !isNonEmptyString(reason['kind'])
  ) {
    return unavailableBoundary(header, turnEndSeq)
  }
  const turnStart = findMatchingTurnStart(sessionEvents, turn, turnEndSeq)
  if (turnStart === undefined || !isNonNegativeSafeInteger(turnStart.seq)) {
    return unavailableBoundary(header, turnEndSeq)
  }
  const turnEvents = sessionEvents
    .filter((event) => event.seq >= turnStart.seq && event.seq <= turnEndSeq)
  if (!isContiguousTurnSlice(turnEvents, turn, turnStart.seq, turnEndSeq)) {
    return unavailableBoundary(header, turnEndSeq)
  }

  const directUserMessages: DirectUserMessageObservation[] = []
  for (const candidate of turnEvents) {
    const message = directUserMessage(candidate)
    if (message !== undefined) {
      directUserMessages.push(message)
    } else if (isDirectUserEvent(candidate)) {
      return unavailableBoundary(header, turnEndSeq)
    }
  }
  let sessionCwdDigest: string
  let sessionLifecycleKey: string
  try {
    sessionCwdDigest = deriveSessionCwdDigest(header.cwd)
    sessionLifecycleKey = deriveSessionLifecycleKey({
      rootSessionId: header.id,
      sessionCreatedAt: header.createdAt,
      sessionCwdDigest,
    })
  } catch {
    return {
      status: 'UNAVAILABLE',
      healthCode: 'ROOT_IDENTITY_UNAVAILABLE',
      sessionId: header.id,
      turnEndSeq,
    }
  }
  let turnInstanceDigest: string
  try {
    turnInstanceDigest = deriveTurnInstanceDigest({
      turnStartSeq: turnStart.seq,
      turnStartTime: turnStart.time,
      turnEndSeq: turnEnd.seq,
      turnEndTime: turnEnd.time,
      directUserMessageIds: directUserMessages.map((message) => message.messageId),
    })
  } catch {
    return unavailableBoundary(header, turnEndSeq)
  }

  return {
    status: 'OBSERVED',
    observation: {
      rootSessionId: header.id,
      sessionCreatedAt: header.createdAt,
      sessionCwdDigest,
      sessionLifecycleKey,
      ...(root.parentSessionId === undefined ? {} : { parentSessionId: root.parentSessionId }),
      turn,
      turnStartSeq: turnStart.seq,
      turnEndSeq,
      turnOutcomeKind: reason['kind'],
      turnInstanceDigest,
      directUserMessages,
    },
  }
}
