import { describe, expect, it } from 'vitest'
import {
  CaptureWorkItemV1Schema,
  GlobalV1Schema,
  SignalKeySchema,
} from '../src/domain/observe/schemas.js'
import { deriveSessionLifecycleKey } from '../src/domain/observe/signal-key.js'
import { makeWorkItem } from './support/work-item-fixture.js'

describe('versioned domain schemas', () => {
  it('accepts valid SignalKey and CaptureWorkItemV1 values', () => {
    const item = makeWorkItem()

    expect(SignalKeySchema.parse(item.signalKey)).toEqual(item.signalKey)
    expect(CaptureWorkItemV1Schema.parse(item)).toEqual(item)
  })

  it('rejects unsafe numeric coordinates and invalid state combinations', () => {
    expect(() => SignalKeySchema.parse({ ...makeWorkItem().signalKey, sessionCreatedAt: -1 })).toThrow()
    expect(() => CaptureWorkItemV1Schema.parse({
      ...makeWorkItem(),
      scanStatus: 'COMPLETE',
      captureBlockers: ['TEXT_LIMIT_EXCEEDED'],
    })).toThrow()
    expect(() => CaptureWorkItemV1Schema.parse({
      ...makeWorkItem(),
      captureReason: 'SCAN_INCOMPLETE',
      triggerHits: [],
      evidenceRefs: [],
    })).toThrow()
  })

  it('rejects shape-valid IDs and digests that do not match their source facts', () => {
    const item = makeWorkItem()

    expect(() => CaptureWorkItemV1Schema.parse({
      ...item,
      workItemId: `wi_${'f'.repeat(64)}`,
    })).toThrow()
    expect(() => CaptureWorkItemV1Schema.parse({
      ...item,
      evidenceRefs: [{ ...item.evidenceRefs[0]!, excerptDigest: 'f'.repeat(64) }],
    })).toThrow()
  })

  it('bounds identity and repeated fields at the schema boundary', () => {
    const item = makeWorkItem()
    const trigger = item.triggerHits[0]!
    const evidence = item.evidenceRefs[0]!

    expect(() => SignalKeySchema.parse({
      ...item.signalKey,
      rootSessionId: 's'.repeat(1025),
    })).toThrow()
    expect(() => CaptureWorkItemV1Schema.parse({
      ...item,
      triggerHits: Array.from({ length: 4097 }, () => trigger),
    })).toThrow()
    expect(() => CaptureWorkItemV1Schema.parse({
      ...item,
      evidenceRefs: [{
        ...evidence,
        redactionKinds: ['API_KEY', 'API_KEY'],
      }],
    })).toThrow()
  })

  it('keeps hit and evidence coordinates within the Turn end boundary', () => {
    const item = makeWorkItem()
    const atBoundary = {
      ...item,
      triggerHits: item.triggerHits.map((hit) => ({
        ...hit,
        messageSeq: item.signalKey.turnEndSeq,
      })),
      evidenceRefs: item.evidenceRefs.map((evidence) => ({
        ...evidence,
        messageSeq: item.signalKey.turnEndSeq,
      })),
    }

    expect(CaptureWorkItemV1Schema.parse(atBoundary)).toEqual(atBoundary)
    expect(() => CaptureWorkItemV1Schema.parse({
      ...atBoundary,
      triggerHits: [{
        ...atBoundary.triggerHits[0]!,
        messageSeq: item.signalKey.turnEndSeq + 1,
      }],
    })).toThrow()
    expect(() => CaptureWorkItemV1Schema.parse({
      ...atBoundary,
      evidenceRefs: [{
        ...atBoundary.evidenceRefs[0]!,
        messageSeq: item.signalKey.turnEndSeq + 1,
      }],
    })).toThrow()
  })

  it('rejects non-canonical repeated-field ordering', () => {
    const item = makeWorkItem()
    const constraintHit = {
      kind: 'CONSTRAINT' as const,
      messageSeq: item.triggerHits[0]!.messageSeq,
      ruleId: 'ctv1.constraint.persistent-operator',
      confidence: 'HIGH' as const,
    }

    expect(() => CaptureWorkItemV1Schema.parse({
      ...item,
      triggerHits: [constraintHit, item.triggerHits[0]],
    })).toThrow()
    expect(() => CaptureWorkItemV1Schema.parse({
      ...item,
      triggerHits: [{
        ...item.triggerHits[0]!,
        ruleId: 'ctv1.rul\u00e9',
      }],
    })).toThrow()
    expect(() => CaptureWorkItemV1Schema.parse({
      ...item,
      evidenceRefs: [{
        ...item.evidenceRefs[0]!,
        redactionKinds: ['API_KEY', 'PRIVATE_KEY'],
      }],
    })).toThrow()
    expect(() => CaptureWorkItemV1Schema.parse({
      ...item,
      captureReason: 'SCAN_INCOMPLETE',
      scanStatus: 'INCOMPLETE',
      triggerHits: [],
      evidenceRefs: [],
      captureBlockers: ['TEXT_LIMIT_EXCEEDED', 'TURN_BOUNDARY_INCOMPLETE'],
    })).toThrow()
  })

  it('accepts GlobalV1 without storing raw paths or text', () => {
    const lifecycle = {
      rootSessionId: 'session-1',
      sessionCreatedAt: 100,
      sessionCwdDigest: 'a'.repeat(64),
    }
    const lifecycleKey = deriveSessionLifecycleKey(lifecycle)
    const global = {
      schemaVersion: 1,
      activeTriggerPolicyVersion: 'cheap-trigger-v1',
      sessions: {
        [lifecycleKey]: {
          ...lifecycle,
          triggerPolicyVersion: 'cheap-trigger-v1',
          activationFenceSeq: 10,
          durableNextSeq: 10,
          observedTailSeq: 12,
          headerRevision: 'rev-1',
          headerDigest: 'b'.repeat(64),
        },
      },
      health: { counts: { INGRESS_SATURATED: 1 }, lastCode: 'INGRESS_SATURATED' },
      recovery: { recoveryLag: true, cursor: { lifecycleKey, nextSeq: 10 } },
      checkpoint: { dirty: true, pendingSessionCount: 1 },
    }

    expect(GlobalV1Schema.parse(global)).toEqual(global)
    expect(GlobalV1Schema.parse({
      ...global,
      sessions: {
        [lifecycleKey]: {
          ...global.sessions[lifecycleKey],
          durableNextSeq: 13,
        },
      },
    })).toBeDefined()
    expect(() => GlobalV1Schema.parse({
      ...global,
      health: { counts: { 'D:\\private\\path': 1 } },
    })).toThrow()
    expect(() => GlobalV1Schema.parse({
      ...global,
      sessions: { [`sl_${'e'.repeat(64)}`]: global.sessions[lifecycleKey] },
    })).toThrow()
    expect(() => GlobalV1Schema.parse({
      ...global,
      sessions: {
        [lifecycleKey]: {
          ...global.sessions[lifecycleKey],
          durableNextSeq: 100,
          observedTailSeq: 12,
        },
      },
    })).toThrow()
  })

  it('rejects contradictory recovery and checkpoint state', () => {
    const lifecycle = {
      rootSessionId: 'session-1',
      sessionCreatedAt: 100,
      sessionCwdDigest: 'a'.repeat(64),
    }
    const lifecycleKey = deriveSessionLifecycleKey(lifecycle)
    const session = {
      ...lifecycle,
      triggerPolicyVersion: 'cheap-trigger-v1' as const,
      activationFenceSeq: 10,
      durableNextSeq: 10,
      observedTailSeq: 12,
    }
    const base = {
      schemaVersion: 1 as const,
      activeTriggerPolicyVersion: 'cheap-trigger-v1' as const,
      sessions: { [lifecycleKey]: session },
      health: { counts: {} },
      recovery: { recoveryLag: false },
      checkpoint: { dirty: false, pendingSessionCount: 0 },
    }

    expect(GlobalV1Schema.parse(base)).toEqual(base)
    expect(() => GlobalV1Schema.parse({
      ...base,
      recovery: {
        recoveryLag: false,
        cursor: { lifecycleKey, nextSeq: 10 },
      },
    })).toThrow()
    expect(() => GlobalV1Schema.parse({
      ...base,
      recovery: {
        recoveryLag: true,
        cursor: { lifecycleKey: `sl_${'f'.repeat(64)}`, nextSeq: 10 },
      },
    })).toThrow()
    expect(() => GlobalV1Schema.parse({
      ...base,
      checkpoint: { dirty: false, pendingSessionCount: 1 },
    })).toThrow()
  })
})
