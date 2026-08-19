import { buildTurnObservation } from '../../src/adapters/dsh-session/observation.js'
import type {
  DshSessionEvent,
  DshSessionHeader,
} from '../../src/adapters/dsh-session/types.js'
import { deriveWorkItemId } from '../../src/domain/observe/signal-key.js'
import { sha256Utf8 } from '../../src/domain/observe/hashing.js'
import type { CaptureWorkItemV1 } from '../../src/domain/observe/schemas.js'
import { makeWorkItem } from './work-item-fixture.js'

function textMessage(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  source: Record<string, unknown>,
) {
  return { id, role, content: [{ type: 'text', text }], source }
}

export interface LearningSessionFixture {
  readonly header: DshSessionHeader
  readonly events: readonly DshSessionEvent[]
  readonly item: CaptureWorkItemV1
}

export function makeLearningWorkItem(
  header: DshSessionHeader,
  events: readonly DshSessionEvent[],
  turnEndSeq: number,
  evidenceSeq: number,
  excerpt = '把这个流程保存成 skill',
): CaptureWorkItemV1 {
  const observed = buildTurnObservation(header, events, turnEndSeq)
  if (observed.status !== 'OBSERVED') throw new Error('invalid learning Session fixture')
  const signalKey = {
    rootSessionId: observed.observation.rootSessionId,
    sessionCreatedAt: observed.observation.sessionCreatedAt,
    sessionCwdDigest: observed.observation.sessionCwdDigest,
    turn: observed.observation.turn,
    turnEndSeq: observed.observation.turnEndSeq,
    turnInstanceDigest: observed.observation.turnInstanceDigest,
    triggerPolicyVersion: 'cheap-trigger-v1' as const,
  }
  return makeWorkItem({
    signalKey,
    workItemId: deriveWorkItemId(signalKey),
    turnOutcomeKind: observed.observation.turnOutcomeKind,
    triggerHits: [{
      kind: 'EXPLICIT_SAVE',
      messageSeq: evidenceSeq,
      ruleId: 'ctv1.explicit-save.fixture',
      confidence: 'HIGH',
    }],
    evidenceRefs: [{
      source: 'USER_DIRECT',
      messageSeq: evidenceSeq,
      excerpt,
      excerptDigest: sha256Utf8(excerpt),
      redactionKinds: [],
      truncated: false,
    }],
  })
}

export function makeLearningSessionFixture(): LearningSessionFixture {
  const header: DshSessionHeader = {
    version: 0,
    id: 'session-learning',
    createdAt: 100,
    cwd: 'D:\\workspace\\project',
  }
  const events: DshSessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 1001, data: textMessage('history-user', 'user', 'Earlier project constraint.', { kind: 'user' }) },
    { type: 'request/header', seq: 2, time: 1002, data: { header: { config: { provider: 'history-provider', model: 'history-model' } }, reason: 'initial' } },
    { type: 'assistant/message', seq: 3, time: 1003, data: { turn: 1, step: 1, message: textMessage('history-assistant', 'assistant', 'Earlier assistant context.', { kind: 'model', provider: 'history-provider', model: 'history-model' }) } },
    { type: 'turn/end', seq: 4, time: 1004, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'session/end-seed', seq: 5, time: 1005, data: {} },
    { type: 'todo/write', seq: 6, time: 1006, data: { todos: [] } },
    { type: 'turn/start', seq: 7, time: 1007, data: { turn: 2 } },
    { type: 'user/message', seq: 8, time: 1008, data: textMessage('external', 'user', 'pass' + 'word=synthetic-envelope-value', { kind: 'plugin', plugin: 'fixture' }) },
    { type: 'step/start', seq: 9, time: 1009, data: { turn: 2, step: 1 } },
    { type: 'request/header', seq: 10, time: 1010, data: { header: { config: { provider: 'target-provider', model: 'target-model-old' } }, reason: 'change' } },
    { type: 'user/message', seq: 11, time: 1011, data: textMessage('trigger-user', 'user', '把这个流程保存成 skill', { kind: 'user' }) },
    { type: 'assistant/message', seq: 12, time: 1012, data: { turn: 2, step: 1, message: textMessage('target-assistant', 'assistant', 'I will preserve this skill workflow. Authori' + 'zation: Token synthetic-value', { kind: 'model', provider: 'target-provider', model: 'target-model-old' }) } },
    { type: 'tool/result', seq: 13, time: 1013, data: { turn: 2, step: 1, message: { id: 'tool-related', role: 'user', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'skill output pass' + 'word=synthetic-tool-value' }] }] } } },
    { type: 'tool/result', seq: 14, time: 1014, data: { turn: 2, step: 1, message: { id: 'tool-unrelated', role: 'user', source: { kind: 'tool', callId: 'call-2' }, content: [{ type: 'tool-result', toolCallId: 'call-2', content: [{ type: 'text', text: 'weather output' }] }] } } },
    { type: 'step/end', seq: 15, time: 1015, data: { turn: 2, step: 1 } },
    { type: 'step/start', seq: 16, time: 1016, data: { turn: 2, step: 2 } },
    { type: 'request/header', seq: 17, time: 1017, data: { header: { config: { provider: 'target-provider', model: 'target-model-last' } }, reason: 'change' } },
    { type: 'assistant/message', seq: 18, time: 1018, data: { turn: 2, step: 2, message: textMessage('target-assistant-final', 'assistant', 'Final skill response.', { kind: 'model', provider: 'target-provider', model: 'target-model-last' }) } },
    { type: 'step/end', seq: 19, time: 1019, data: { turn: 2, step: 2 } },
    { type: 'turn/end', seq: 20, time: 1020, data: { turn: 2, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 21, time: 1021, data: { turn: 3 } },
    { type: 'user/message', seq: 22, time: 1022, data: textMessage('future-secret', 'user', 'pass' + 'word=must-not-be-read', { kind: 'plugin', plugin: 'fixture' }) },
    { type: 'step/start', seq: 23, time: 1023, data: { turn: 3, step: 1 } },
    { type: 'request/header', seq: 24, time: 1024, data: { header: { config: { provider: 'future-provider', model: 'future-model' } }, reason: 'change' } },
    { type: 'assistant/message', seq: 25, time: 1025, data: { turn: 3, step: 1, message: textMessage('future-assistant', 'assistant', 'Future response.', { kind: 'model', provider: 'future-provider', model: 'future-model' }) } },
    { type: 'step/end', seq: 26, time: 1026, data: { turn: 3, step: 1 } },
    { type: 'turn/end', seq: 27, time: 1027, data: { turn: 3, reason: { kind: 'completed' } } },
  ]
  const item = makeLearningWorkItem(header, events, 20, 11)
  return { header, events, item }
}
