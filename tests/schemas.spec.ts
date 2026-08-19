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
    expect(() => GlobalV1Schema.parse({
      ...global,
      health: { counts: { 'D:\\private\\path': 1 } },
    })).toThrow()
    expect(() => GlobalV1Schema.parse({
      ...global,
      sessions: { [`sl_${'e'.repeat(64)}`]: global.sessions[lifecycleKey] },
    })).toThrow()
  })
})
