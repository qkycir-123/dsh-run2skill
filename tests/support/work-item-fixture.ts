import type { CaptureWorkItemV1 } from '../../src/domain/observe/schemas.js'
import { sha256Utf8 } from '../../src/domain/observe/hashing.js'
import { deriveWorkItemId } from '../../src/domain/observe/signal-key.js'

export function makeWorkItem(
  overrides: Partial<CaptureWorkItemV1> = {},
): CaptureWorkItemV1 {
  const signalKey = overrides.signalKey ?? {
    rootSessionId: 'session-1',
    sessionCreatedAt: 100,
    sessionCwdDigest: 'a'.repeat(64),
    turn: 2,
    turnEndSeq: 13,
    turnInstanceDigest: 'b'.repeat(64),
    triggerPolicyVersion: 'cheap-trigger-v1' as const,
  }
  const excerpt = '把这个流程保存成 skill'
  return {
    schemaVersion: 1,
    revision: 1,
    workItemId: overrides.workItemId ?? deriveWorkItemId(signalKey),
    signalKey,
    captureReason: 'CHEAP_TRIGGER',
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    turnOutcomeKind: 'completed',
    rootIdentity: { status: 'ROOT' },
    workspaceBinding: { status: 'NO_CWD', observedAt: '2026-08-19T00:00:00.000Z' },
    scanStatus: 'COMPLETE',
    triggerHits: [{
      kind: 'EXPLICIT_SAVE',
      messageSeq: 11,
      ruleId: 'ctv1.explicit-save.zh.save-target',
      confidence: 'HIGH',
    }],
    evidenceRefs: [{
      source: 'USER_DIRECT',
      messageSeq: 11,
      excerpt,
      excerptDigest: sha256Utf8(excerpt),
      redactionKinds: [],
      truncated: false,
    }],
    captureBlockers: [],
    processingState: 'CAPTURED',
    ...overrides,
  }
}
