import {
  type LearningWindowBlock,
  type LearningWindowProjection,
} from '../../domain/learn/envelope.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import { preprocessSensitiveText } from '../../domain/observe/redaction.js'
import type { CaptureWorkItemV1 } from '../../domain/observe/schemas.js'
import { buildTurnObservation } from './observation.js'
import type { DshSessionEvent, DshSessionHeader } from './types.js'

const MAX_HISTORY_TURNS = 4
const MAX_TOOL_SUMMARIES = 2
const MAX_TOOL_BYTES = 2 * 1024

interface TurnSpan {
  readonly turn: number
  readonly startSeq: number
  readonly endSeq: number
}

export type LearningWindowProjectionResult =
  | { readonly status: 'AVAILABLE'; readonly projection: LearningWindowProjection }
  | {
    readonly status: 'UNAVAILABLE'
    readonly failureCode: 'SESSION_LOG_UNAVAILABLE' | 'MODEL_ROUTE_UNAVAILABLE' | 'ENVELOPE_UNBUILDABLE'
  }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSafeCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function eventTurn(event: DshSessionEvent): number | undefined {
  return isRecord(event.data) && isSafeCoordinate(event.data['turn'])
    ? event.data['turn']
    : undefined
}

function collectTurnSpans(events: readonly DshSessionEvent[]): TurnSpan[] | undefined {
  const spans: TurnSpan[] = []
  let open: { turn: number; startSeq: number } | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      const turn = eventTurn(event)
      if (turn === undefined || open !== undefined) return undefined
      open = { turn, startSeq: event.seq }
    } else if (event.type === 'turn/end') {
      const turn = eventTurn(event)
      if (turn === undefined || open === undefined || open.turn !== turn) return undefined
      spans.push({ turn, startSeq: open.startSeq, endSeq: event.seq })
      open = undefined
    }
  }
  return open === undefined ? spans : undefined
}

function textBlocks(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const texts: string[] = []
  for (const block of value) {
    if (!isRecord(block) || typeof block['type'] !== 'string') return undefined
    if (block['type'] === 'text') {
      if (typeof block['text'] !== 'string') return undefined
      texts.push(block['text'])
    }
  }
  return texts
}

function message(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !Array.isArray(value['content']) || !isRecord(value['source'])) {
    return undefined
  }
  return value
}

function redactBlock(
  source: LearningWindowBlock['source'],
  sessionId: string,
  turn: number,
  eventSeq: number,
  input: string,
  retention: LearningWindowBlock['retention'],
  maxBytes?: number,
): LearningWindowBlock | undefined {
  const processed = preprocessSensitiveText(input)
  if (processed.text.length === 0) return undefined
  const bounded = maxBytes === undefined
    ? { text: processed.text, truncated: false }
    : truncateUtf8(processed.text, maxBytes)
  if (bounded.text.length === 0) return undefined
  return {
    source,
    sessionId,
    turn,
    eventSeq,
    text: bounded.text,
    digest: sha256Utf8(bounded.text),
    truncated: bounded.truncated,
    retention,
  }
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false }
  let text = ''
  for (const character of value) {
    if (Buffer.byteLength(text + character, 'utf8') > maxBytes) break
    text += character
  }
  return { text, truncated: true }
}

function routeFrom(event: DshSessionEvent | undefined): LearningWindowProjection['route'] | undefined {
  if (event === undefined || event.type !== 'request/header' || !isRecord(event.data)) return undefined
  const header = event.data['header']
  const config = isRecord(header) ? header['config'] : undefined
  if (!isRecord(config)) return undefined
  const provider = config['provider']
  const model = config['model']
  if (
    typeof provider !== 'string'
    || provider.trim().length === 0
    || provider.length > 256
    || typeof model !== 'string'
    || model.trim().length === 0
    || model.length > 256
  ) return undefined
  return { provider, model }
}

function resolveRoute(
  events: readonly DshSessionEvent[],
  trigger: TurnSpan,
): LearningWindowProjection['route'] | undefined {
  let triggerHeader: DshSessionEvent | undefined
  let earlierHeader: DshSessionEvent | undefined
  for (const event of events) {
    if (event.type !== 'request/header') continue
    if (event.seq >= trigger.startSeq && event.seq <= trigger.endSeq) triggerHeader = event
    else if (event.seq < trigger.startSeq) earlierHeader = event
  }
  return routeFrom(triggerHeader ?? earlierHeader)
}

function tokens(value: string): Set<string> {
  const normalized = value.normalize('NFKC').toLowerCase()
  const result = new Set<string>()
  for (const match of normalized.matchAll(/[a-z0-9]+|[\p{Script=Han}]/gu)) {
    if (match[0].length > 1 || /[\p{Script=Han}]/u.test(match[0])) result.add(match[0])
  }
  return result
}

function overlapsTrigger(value: string, triggerTokens: ReadonlySet<string>): boolean {
  for (const token of tokens(value)) if (triggerTokens.has(token)) return true
  return false
}

function directOrExternalBlock(
  event: DshSessionEvent,
  sessionId: string,
  span: TurnSpan,
  target: TurnSpan,
  evidenceBySeq: ReadonlyMap<number, readonly CaptureWorkItemV1['evidenceRefs'][number][]>,
): LearningWindowBlock[] | undefined {
  const value = message(event.data)
  if (value === undefined) return undefined
  const source = value['source']
  if (!isRecord(source)) return undefined
  const extracted = textBlocks(value['content'])
  if (extracted === undefined) return undefined
  const joined = extracted.join('\n')
  const evidence = evidenceBySeq.get(event.seq)
  if (evidence !== undefined) {
    const sourceText = preprocessSensitiveText(joined).text
    const blocks: LearningWindowBlock[] = []
    for (const item of evidence) {
      if (!sourceText.includes(item.excerpt)) return undefined
      const block = redactBlock(
        'USER_EVIDENCE', sessionId, target.turn, event.seq, item.excerpt,
        { kind: 'TRIGGER_EVIDENCE' },
      )
      if (block === undefined || block.digest !== item.excerptDigest) return undefined
      blocks.push(block)
    }
    return blocks
  }
  if (source['kind'] === 'user') {
    const block = redactBlock(
      'USER_EVIDENCE', sessionId, span.turn, event.seq, joined,
      { kind: 'HISTORY', distance: span.endSeq < target.startSeq ? target.turn - span.turn : 0 },
    )
    return block === undefined ? [] : [block]
  }
  const block = redactBlock(
    'EXTERNAL_UNTRUSTED', sessionId, span.turn, event.seq, joined, { kind: 'EXTERNAL' },
  )
  return block === undefined ? [] : [block]
}

function assistantBlock(
  event: DshSessionEvent,
  sessionId: string,
  span: TurnSpan,
  target: TurnSpan,
): LearningWindowBlock[] | undefined {
  if (!isRecord(event.data) || eventTurn(event) !== span.turn) return undefined
  const value = message(event.data['message'])
  if (value === undefined) return undefined
  const extracted = textBlocks(value['content'])
  if (extracted === undefined) return undefined
  const block = redactBlock(
    'ASSISTANT_CONTEXT', sessionId, span.turn, event.seq, extracted.join('\n'),
    span.endSeq < target.startSeq
      ? { kind: 'HISTORY', distance: target.turn - span.turn }
      : { kind: 'ASSISTANT' },
  )
  return block === undefined ? [] : [block]
}

function toolBlock(
  event: DshSessionEvent,
  sessionId: string,
  span: TurnSpan,
  target: TurnSpan,
  triggerTokens: ReadonlySet<string>,
): LearningWindowBlock[] | undefined {
  if (!isRecord(event.data) || eventTurn(event) !== span.turn) return undefined
  const value = message(event.data['message'])
  if (value === undefined) return undefined
  const content = value['content']
  if (!Array.isArray(content) || content.length !== 1 || !isRecord(content[0])) return undefined
  const toolResult = content[0]
  if (toolResult['type'] !== 'tool-result') return undefined
  const extracted = textBlocks(toolResult['content'])
  if (extracted === undefined) return undefined
  const joined = extracted.join('\n')
  if (!overlapsTrigger(joined, triggerTokens)) return []
  const block = redactBlock(
    'TOOL_EVIDENCE', sessionId, span.turn, event.seq, joined,
    span.endSeq < target.startSeq
      ? { kind: 'HISTORY', distance: target.turn - span.turn }
      : { kind: 'TOOL' },
    MAX_TOOL_BYTES,
  )
  return block === undefined ? [] : [block]
}

export function projectLearningWindow(
  header: DshSessionHeader,
  sessionEvents: readonly DshSessionEvent[],
  item: CaptureWorkItemV1,
): LearningWindowProjectionResult {
  if (
    item.captureReason !== 'CHEAP_TRIGGER'
    || item.scanStatus !== 'COMPLETE'
    || item.evidenceRefs.length === 0
  ) return { status: 'UNAVAILABLE', failureCode: 'SESSION_LOG_UNAVAILABLE' }
  const endSeq = item.signalKey.turnEndSeq
  if (sessionEvents.length <= endSeq) {
    return { status: 'UNAVAILABLE', failureCode: 'SESSION_LOG_UNAVAILABLE' }
  }
  const events = sessionEvents.slice(0, endSeq + 1)
  if (events.some((event, index) => event.seq !== index || !isSafeCoordinate(event.time))) {
    return { status: 'UNAVAILABLE', failureCode: 'SESSION_LOG_UNAVAILABLE' }
  }
  const observed = buildTurnObservation(header, events, endSeq)
  if (
    observed.status !== 'OBSERVED'
    || observed.observation.rootSessionId !== item.signalKey.rootSessionId
    || observed.observation.sessionCreatedAt !== item.signalKey.sessionCreatedAt
    || observed.observation.sessionCwdDigest !== item.signalKey.sessionCwdDigest
    || observed.observation.turn !== item.signalKey.turn
    || observed.observation.turnInstanceDigest !== item.signalKey.turnInstanceDigest
    || observed.observation.turnOutcomeKind !== item.turnOutcomeKind
  ) return { status: 'UNAVAILABLE', failureCode: 'SESSION_LOG_UNAVAILABLE' }

  const spans = collectTurnSpans(events)
  const target = spans?.find(span => span.endSeq === endSeq && span.turn === item.signalKey.turn)
  if (spans === undefined || target === undefined) {
    return { status: 'UNAVAILABLE', failureCode: 'SESSION_LOG_UNAVAILABLE' }
  }
  const route = resolveRoute(events, target)
  if (route === undefined) return { status: 'UNAVAILABLE', failureCode: 'MODEL_ROUTE_UNAVAILABLE' }

  const directCoordinates = new Set(observed.observation.directUserMessages.map(message => message.messageSeq))
  if (item.evidenceRefs.some(evidence => !directCoordinates.has(evidence.messageSeq))) {
    return { status: 'UNAVAILABLE', failureCode: 'SESSION_LOG_UNAVAILABLE' }
  }
  const evidenceBySeq = new Map<number, CaptureWorkItemV1['evidenceRefs'][number][]>()
  for (const evidence of item.evidenceRefs) {
    const current = evidenceBySeq.get(evidence.messageSeq) ?? []
    current.push(evidence)
    evidenceBySeq.set(evidence.messageSeq, current)
  }
  const history = spans.filter(span => span.endSeq < target.startSeq).slice(-MAX_HISTORY_TURNS)
  const selected = [...history, target]
  const triggerTokens = tokens(item.evidenceRefs.map(evidence => evidence.excerpt).join(' '))
  const blocks: LearningWindowBlock[] = []
  const toolBlocks: LearningWindowBlock[] = []
  try {
    for (const span of selected) {
      for (const event of events.slice(span.startSeq, span.endSeq + 1)) {
        let extracted: LearningWindowBlock[] | undefined = []
        if (event.type === 'user/message') {
          extracted = directOrExternalBlock(event, header.id, span, target, evidenceBySeq)
        } else if (event.type === 'assistant/message') {
          extracted = assistantBlock(event, header.id, span, target)
        } else if (event.type === 'tool/result') {
          extracted = toolBlock(event, header.id, span, target, triggerTokens)
          if (extracted !== undefined) toolBlocks.push(...extracted)
          continue
        }
        if (extracted === undefined) {
          return { status: 'UNAVAILABLE', failureCode: 'SESSION_LOG_UNAVAILABLE' }
        }
        blocks.push(...extracted)
      }
    }
  } catch {
    return { status: 'UNAVAILABLE', failureCode: 'ENVELOPE_UNBUILDABLE' }
  }
  blocks.push(...toolBlocks.slice(-MAX_TOOL_SUMMARIES))
  blocks.sort((left, right) => left.eventSeq - right.eventSeq || left.digest.localeCompare(right.digest))
  return { status: 'AVAILABLE', projection: { route, blocks } }
}
