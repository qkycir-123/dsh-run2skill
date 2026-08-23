import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import { preprocessPersistentText } from '../../domain/observe/redaction.js'
import { analyzeCheapTriggerV1 } from '../../domain/observe/trigger.js'
import { deriveProjectScopeIdentityDigest } from '../../domain/purge/index.js'
import {
  RUN2SKILL_V2_LIMITS,
  TurnObservationV2Schema,
  deriveTurnObservationContentDigestV2,
  deriveTurnObservationIdV2,
  type TurnObservationV2,
} from '../../domain/v2/index.js'
import type { WorkspaceBindingPort } from '../../application/capture/turn-capture-processor.js'
import { buildTurnObservation } from './observation.js'
import type { DshSessionEvent, DshSessionHeader } from './types.js'

const MAX_ASSISTANT_SUMMARY_BYTES = 4 * 1024
const MAX_EVIDENCE_BYTES = 512
const MAX_TOOL_SUMMARIES = 32
const TRUNCATION_MARKER = '\n…\n'
const SUPPORTED_TURN_EVENT_TYPES = new Set([
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'agent/inbox/spliced',
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/chunk',
  'assistant/message',
  'tool/call',
  'tool/result',
  'todo/write',
  'request/header',
  'request/context',
  'session/title',
  'session/title-llm-request',
  'session/end-seed',
])

export type DshTurnObservationV2Result =
  | { readonly status: 'OBSERVED'; readonly observation: TurnObservationV2 }
  | { readonly status: 'CHILD' }
  | {
    readonly status: 'UNAVAILABLE'
    readonly healthCode:
      | 'ROOT_IDENTITY_UNAVAILABLE'
      | 'TURN_BOUNDARY_INCOMPLETE'
      | 'OBSERVATION_PROJECTION_UNAVAILABLE'
    readonly sessionId?: string
    readonly turnEndSeq?: number
  }

interface ProjectionPart<T> {
  readonly value: T
  readonly complete: boolean
}

interface ToolCallFact {
  readonly seq: number
  readonly step: number
  readonly callId: string
  readonly name: string
}

interface ToolResultFact {
  readonly seq: number
  readonly step: number
  readonly callId: string
  readonly failed: boolean
  readonly contentDigest: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSafeCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256
}

function isCoordinateIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1_024
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  let result = ''
  for (const character of value) {
    if (Buffer.byteLength(result + character, 'utf8') > maxBytes) break
    result += character
  }
  return result
}

function takeUtf8Suffix(value: string, maxBytes: number): string {
  let result = ''
  for (const character of [...value].reverse()) {
    if (Buffer.byteLength(character + result, 'utf8') > maxBytes) break
    result = character + result
  }
  return result
}

function boundUtf8(value: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false }
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8')
  const available = Math.max(0, maxBytes - markerBytes)
  const headBytes = Math.ceil(available / 2)
  const tailBytes = Math.floor(available / 2)
  return {
    text: `${takeUtf8Prefix(value, headBytes)}${TRUNCATION_MARKER}${takeUtf8Suffix(value, tailBytes)}`,
    truncated: true,
  }
}

function textContent(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: string[] = []
  for (const block of value) {
    if (!isRecord(block) || typeof block['type'] !== 'string') return undefined
    if (block['type'] === 'text') {
      if (typeof block['text'] !== 'string') return undefined
      result.push(block['text'])
    }
  }
  return result
}

function projectDirectEvidence(
  messages: readonly { readonly messageSeq: number; readonly textBlocks: readonly string[] }[],
  textOnly: boolean,
): ProjectionPart<{
  readonly evidence: TurnObservationV2['directUserEvidence']
  readonly explicitSaveRequested: boolean
}> {
  const candidates = messages.map(item => ({
    messageSeq: item.messageSeq,
    sourceKind: 'user' as const,
    text: item.textBlocks.join('\n'),
  }))
  const analysis = analyzeCheapTriggerV1(candidates)
  if (
    analysis.status === 'INCOMPLETE'
    || candidates.length > RUN2SKILL_V2_LIMITS.maxObservationEvidence
    || !textOnly
  ) return { value: { evidence: [], explicitSaveRequested: false }, complete: false }

  try {
    const evidence = candidates.map(candidate => {
      const processed = preprocessPersistentText(candidate.text)
      const bounded = boundUtf8(processed.text, MAX_EVIDENCE_BYTES)
      return {
        source: 'USER_DIRECT' as const,
        messageSeq: candidate.messageSeq,
        excerpt: bounded.text,
        excerptDigest: sha256Utf8(bounded.text),
        redactionKinds: processed.redactionKinds,
        truncated: bounded.truncated,
      }
    })
    return {
      value: {
        evidence,
        explicitSaveRequested: analysis.triggerHits.some(hit => hit.kind === 'EXPLICIT_SAVE'),
      },
      complete: true,
    }
  } catch {
    return { value: { evidence: [], explicitSaveRequested: false }, complete: false }
  }
}

function projectAssistantSummary(
  events: readonly DshSessionEvent[],
  turn: number,
): ProjectionPart<string> {
  let latest = ''
  let complete = true
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    if (!isRecord(event.data) || event.data['turn'] !== turn) {
      complete = false
      continue
    }
    const message = event.data['message']
    if (
      !isRecord(message)
      || message['role'] !== 'assistant'
      || !isRecord(message['source'])
    ) {
      complete = false
      continue
    }
    const texts = textContent(message['content'])
    if (texts === undefined) {
      complete = false
      continue
    }
    try {
      latest = boundUtf8(
        preprocessPersistentText(texts.join('\n')).text,
        MAX_ASSISTANT_SUMMARY_BYTES,
      ).text
    } catch {
      complete = false
      latest = ''
    }
  }
  return { value: latest, complete }
}

function directUserContentIsTextOnly(events: readonly DshSessionEvent[]): boolean {
  for (const event of events) {
    if (event.type !== 'user/message' || !isRecord(event.data)) continue
    const source = event.data['source']
    if (!isRecord(source) || source['kind'] !== 'user') continue
    const content = event.data['content']
    if (!Array.isArray(content)) return false
    for (const block of content) {
      if (!isRecord(block) || block['type'] !== 'text' || typeof block['text'] !== 'string') return false
    }
  }
  return true
}

function hasUnsupportedRequiredEvent(events: readonly DshSessionEvent[]): boolean {
  return events.some(event => (
    !SUPPORTED_TURN_EVENT_TYPES.has(event.type) && event.ignorable !== true
  ))
}

function parseToolCall(event: DshSessionEvent, turn: number): ToolCallFact | undefined {
  if (!isRecord(event.data) || event.data['turn'] !== turn || !isSafeCoordinate(event.data['step'])) return undefined
  const callId = event.data['callId']
  const name = event.data['name']
  if (!isCoordinateIdentity(callId) || !isIdentity(name) || typeof event.data['arguments'] !== 'string') return undefined
  return { seq: event.seq, step: event.data['step'], callId, name }
}

function parseToolResult(event: DshSessionEvent, turn: number): ToolResultFact | undefined {
  if (!isRecord(event.data) || event.data['turn'] !== turn || !isSafeCoordinate(event.data['step'])) return undefined
  const message = event.data['message']
  if (
    !isRecord(message)
    || message['role'] !== 'user'
    || !isRecord(message['source'])
    || message['source']['kind'] !== 'tool'
  ) return undefined
  const callId = message['source']['callId']
  const content = message['content']
  if (!isCoordinateIdentity(callId) || !Array.isArray(content) || content.length !== 1 || !isRecord(content[0])) return undefined
  const block = content[0]
  if (
    block['type'] !== 'tool-result'
    || block['toolCallId'] !== callId
    || !Array.isArray(block['content'])
    || (block['isError'] !== undefined && typeof block['isError'] !== 'boolean')
  ) return undefined
  const error = event.data['error']
  if (
    error !== undefined
    && (!isRecord(error) || !isIdentity(error['name']) || !isIdentity(error['code']))
  ) return undefined
  try {
    return {
      seq: event.seq,
      step: event.data['step'],
      callId,
      failed: block['isError'] === true || error !== undefined,
      contentDigest: sha256Utf8(canonicalJson({
        content: block['content'],
        isError: block['isError'] === true,
        error: error ?? null,
      })),
    }
  } catch {
    return undefined
  }
}

function projectToolSummaries(
  events: readonly DshSessionEvent[],
  turn: number,
): ProjectionPart<TurnObservationV2['toolOutcomeSummary']> {
  const calls = new Map<string, ToolCallFact>()
  const results = new Map<string, ToolResultFact>()
  let complete = true
  for (const event of events) {
    if (event.type === 'tool/call') {
      const call = parseToolCall(event, turn)
      if (call === undefined || calls.has(call.callId)) complete = false
      else calls.set(call.callId, call)
    } else if (event.type === 'tool/result') {
      const result = parseToolResult(event, turn)
      if (result === undefined || results.has(result.callId)) complete = false
      else results.set(result.callId, result)
    }
  }
  if (calls.size > MAX_TOOL_SUMMARIES) complete = false
  for (const [callId, result] of results) {
    const call = calls.get(callId)
    if (call === undefined || result.seq <= call.seq || result.step !== call.step) complete = false
  }
  const summaries = [...calls.values()]
    .sort((left, right) => left.seq - right.seq || left.callId.localeCompare(right.callId))
    .slice(0, MAX_TOOL_SUMMARIES)
    .map(call => {
      const result = results.get(call.callId)
      const matched = result !== undefined && result.seq > call.seq && result.step === call.step
        ? result
        : undefined
      return {
        toolName: call.name,
        outcome: matched === undefined ? 'OUTCOME_UNKNOWN' : matched.failed ? 'FAILED' : 'SUCCEEDED',
        contentDigest: matched?.contentDigest ?? sha256Utf8(canonicalJson({ callId: call.callId, result: 'MISSING' })),
      }
    })
  if (summaries.some(summary => summary.outcome === 'OUTCOME_UNKNOWN')) complete = false
  return { value: summaries, complete }
}

function projectRoute(
  events: readonly DshSessionEvent[],
  turnEndSeq: number,
): ProjectionPart<TurnObservationV2['routeObservation']> {
  const latest = events
    .filter(event => event.type === 'request/header' && event.seq <= turnEndSeq)
    .sort((left, right) => right.seq - left.seq)[0]
  if (latest === undefined || !isRecord(latest.data)) return { value: { complete: false }, complete: false }
  const header = latest.data['header']
  const config = isRecord(header) ? header['config'] : undefined
  const provider = isRecord(config) ? config['provider'] : undefined
  const model = isRecord(config) ? config['model'] : undefined
  if (!isIdentity(provider) || !isIdentity(model)) return { value: { complete: false }, complete: false }
  return { value: { provider, model, complete: true }, complete: true }
}

async function projectScope(
  cwd: string | undefined,
  workspace: WorkspaceBindingPort,
): Promise<TurnObservationV2['scopeBinding']> {
  if (cwd === undefined) return { status: 'UNRESOLVED', reason: 'NO_CWD' }
  try {
    const resolution = await workspace.resolve(cwd)
    if (resolution.status !== 'BOUND') {
      return {
        status: 'UNRESOLVED',
        reason: resolution.status === 'UNREGISTERED' ? 'UNREGISTERED' : 'UNAVAILABLE',
      }
    }
    if (!isIdentity(resolution.workspaceId)) return { status: 'UNRESOLVED', reason: 'UNAVAILABLE' }
    return {
      status: 'PROJECT',
      workspaceId: resolution.workspaceId,
      scopeIdentityDigest: deriveProjectScopeIdentityDigest(resolution.canonicalPath),
    }
  } catch {
    return { status: 'UNRESOLVED', reason: 'UNAVAILABLE' }
  }
}

function unavailable(
  header: DshSessionHeader,
  turnEndSeq: number,
): Extract<DshTurnObservationV2Result, { status: 'UNAVAILABLE' }> {
  return {
    status: 'UNAVAILABLE',
    healthCode: 'OBSERVATION_PROJECTION_UNAVAILABLE',
    ...(typeof header.id === 'string' && header.id.length > 0 ? { sessionId: header.id } : {}),
    ...(isSafeCoordinate(turnEndSeq) ? { turnEndSeq } : {}),
  }
}

/**
 * Projects one durable DSH root Turn into the bounded v2 observation record.
 * This adapter is deterministic and model-free; it never reads a Skill Catalog.
 */
export async function projectDshTurnObservationV2(
  header: DshSessionHeader,
  sessionEvents: readonly DshSessionEvent[],
  turnEndSeq: number,
  workspace: WorkspaceBindingPort,
  recovery?: { readonly headerRevision: string; readonly observedLogPrefixDigest: string },
): Promise<DshTurnObservationV2Result> {
  const base = buildTurnObservation(header, sessionEvents, turnEndSeq)
  if (base.status !== 'OBSERVED') return base
  const observed = base.observation
  const observedAt = new Date(observed.turnEndTime)
  if (!Number.isFinite(observedAt.getTime())) return unavailable(header, turnEndSeq)
  const observedPrefix = sessionEvents.filter(event => event.seq <= observed.turnEndSeq)
  if (hasUnsupportedRequiredEvent(observedPrefix)) return unavailable(header, turnEndSeq)
  const turnEvents = observedPrefix.filter(event => (
    event.seq >= observed.turnStartSeq && event.seq <= observed.turnEndSeq
  ))
  const direct = projectDirectEvidence(
    observed.directUserMessages,
    directUserContentIsTextOnly(turnEvents),
  )
  const assistant = projectAssistantSummary(turnEvents, observed.turn)
  const tools = projectToolSummaries(turnEvents, observed.turn)
  const route = projectRoute(sessionEvents, observed.turnEndSeq)
  const scopeBinding = await projectScope(header.cwd, workspace)
  const complete = direct.complete && assistant.complete && tools.complete && route.complete
  const directUserEvidence = complete ? direct.value.evidence : []
  const evidenceDigest = sha256Utf8(canonicalJson(directUserEvidence))
  const contentFacts = {
    outcomeKind: observed.turnOutcomeKind,
    assistantOutcomeSummary: assistant.value,
    toolOutcomeSummary: tools.value,
    routeObservation: route.value,
    completeness: complete ? 'COMPLETE' as const : 'INCOMPLETE' as const,
    explicitSaveRequested: complete && direct.value.explicitSaveRequested,
    scopeBinding,
    evidenceDigest,
  }
  try {
    return {
      status: 'OBSERVED',
      observation: TurnObservationV2Schema.parse({
        schemaVersion: 1,
        revision: 1,
        observationId: deriveTurnObservationIdV2(observed),
        sessionLifecycleKey: observed.sessionLifecycleKey,
        turn: observed.turn,
        turnEndSeq: observed.turnEndSeq,
        turnInstanceDigest: observed.turnInstanceDigest,
        observedAt: observedAt.toISOString(),
        ...contentFacts,
        directUserEvidence,
        contentDigest: deriveTurnObservationContentDigestV2(contentFacts),
        ...(recovery === undefined ? {} : { sessionRecovery: recovery }),
      }),
    }
  } catch {
    return unavailable(header, turnEndSeq)
  }
}
