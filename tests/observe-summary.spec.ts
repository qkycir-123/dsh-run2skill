import { describe, expect, it } from 'vitest'
import { createObserveSummary } from '../src/application/observe-summary.js'
import { RuntimeNotices } from '../src/application/capture/runtime-notices.js'
import type { RecoveryLifecycleSnapshot } from '../src/application/capture/recovery-lifecycle.js'
import { deriveSessionLifecycleKeyFromFacts } from '../src/domain/observe/identity.js'
import type { CaptureWorkItemV1, SessionCheckpointV1 } from '../src/domain/observe/schemas.js'
import { makeLearningResult } from './support/learning-fixture.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { makeWorkItem } from './support/work-item-fixture.js'

function lifecycle(
  status: RecoveryLifecycleSnapshot['status'],
  recoveryLag = status !== 'READY',
): RecoveryLifecycleSnapshot {
  return {
    status,
    queueDepth: 0,
    maxQueueDepth: 0,
    catchupNeeded: false,
    recoveryLag,
    maxReadFromLatencyMs: 0,
    peakHeapBytes: 0,
  }
}

function itemAt(
  turn: number,
  overrides: Partial<CaptureWorkItemV1> = {},
): CaptureWorkItemV1 {
  return makeWorkItem({
    signalKey: {
      rootSessionId: 'session-summary',
      sessionCreatedAt: 100,
      sessionCwdDigest: 'a'.repeat(64),
      turn,
      turnEndSeq: turn * 10,
      turnInstanceDigest: turn.toString(16).padStart(64, '0'),
      triggerPolicyVersion: 'cheap-trigger-v1',
    },
    ...overrides,
  })
}

describe('ObserveSummaryV1', () => {
  it('counts complete captures, blocked captures, and unique unsaved signals without exposing records', () => {
    const domain = createMemoryRun2skillDomain()
    const complete = itemAt(1)
    const blocked = itemAt(2, {
      captureReason: 'SCAN_INCOMPLETE',
      scanStatus: 'INCOMPLETE',
      triggerHits: [],
      evidenceRefs: [],
      captureBlockers: ['TURN_BOUNDARY_INCOMPLETE'],
    })
    const resolved = itemAt(3, {
      captureReason: 'SCAN_INCOMPLETE',
      scanStatus: 'COMPLETE',
      triggerHits: [],
      evidenceRefs: [],
      captureBlockers: [],
      processingState: 'RESOLVED_NO_SIGNAL',
    })
    for (const item of [complete, blocked, resolved]) domain.workItems.set(item.workItemId, item)
    const notices = new RuntimeNotices({ now: () => 1_000 })
    notices.recordUnsaved({ healthCode: 'WORK_ITEM_WRITE_FAILED', sessionId: 'session-a', turnEndSeq: 11 })
    notices.recordUnsaved({ healthCode: 'REDACTION_UNAVAILABLE', sessionId: 'session-a', turnEndSeq: 11 })
    notices.recordUnsaved({ healthCode: 'WORK_ITEM_WRITE_FAILED', sessionId: 'session-b', turnEndSeq: 12 })

    const summary = createObserveSummary({
      domain,
      lifecycle: lifecycle('READY'),
      notices,
      compatibility: 'COMPATIBLE',
    })

    expect(summary).toEqual({
      apiVersion: 1,
      status: 'READY',
      capturedCount: 1,
      blockedCaptureCount: 1,
      learning: { captured: 1, analyzing: 0, learned: 0, needsAttention: 0 },
      unsaved: { completeness: 'KNOWN', knownCount: 2 },
      recoveryLag: false,
      lastHealthCode: 'WORK_ITEM_WRITE_FAILED',
    })
    expect(JSON.stringify(summary)).not.toContain('session-')
    expect(JSON.stringify(summary)).not.toContain('把这个流程')
  })

  it('does not present generic health coordinates as confirmed unsaved signals', () => {
    const domain = createMemoryRun2skillDomain()
    const notices = new RuntimeNotices()
    notices.record({ healthCode: 'INGRESS_SATURATED', sessionId: 'session-a', turnEndSeq: 11 })

    expect(createObserveSummary({
      domain,
      lifecycle: lifecycle('READY'),
      notices,
      compatibility: 'COMPATIBLE',
    }).unsaved).toEqual({ completeness: 'KNOWN', knownCount: 0 })
  })

  it('reports learning state counts without exposing learned content', () => {
    const domain = createMemoryRun2skillDomain()
    const states = ['CAPTURED', 'ANALYZING', 'LEARNED', 'NEEDS_ATTENTION'] as const
    for (const [index, processingState] of states.entries()) {
      const base = itemAt(index + 10)
      const item = itemAt(index + 10, processingState === 'CAPTURED' ? {} : {
        processingState,
        learning: processingState === 'ANALYZING'
          ? { policyVersion: 'learning-v1', attempt: 1, requestBudgetUsed: 0, calls: [], claimedAt: '2026-08-20T00:00:00.000Z' }
          : processingState === 'LEARNED'
            ? {
                policyVersion: 'learning-v1', attempt: 1, requestBudgetUsed: 1, calls: [],
                ...makeLearningResult(base),
              }
            : {
                policyVersion: 'learning-v1', attempt: 1, requestBudgetUsed: 0, calls: [],
                failure: { code: 'MODEL_ROUTE_UNAVAILABLE', retryable: false, occurredAt: '2026-08-20T00:00:00.000Z' },
                publicationOutcome: 'NEEDS_ATTENTION',
              },
      })
      domain.workItems.set(item.workItemId, item)
    }
    const summary = createObserveSummary({
      domain, lifecycle: lifecycle('READY'), notices: new RuntimeNotices(), compatibility: 'COMPATIBLE',
    })
    expect(summary.learning).toEqual({ captured: 1, analyzing: 1, learned: 1, needsAttention: 1 })
    expect(JSON.stringify(summary)).not.toContain('MODEL_ROUTE_UNAVAILABLE')
  })

  it('marks the count unknown after a confirmed unsaved signal is evicted', () => {
    const domain = createMemoryRun2skillDomain()
    const notices = new RuntimeNotices({ limit: 1 })
    notices.recordUnsaved({
      healthCode: 'WORK_ITEM_WRITE_FAILED', sessionId: 'session-a', turnEndSeq: 11,
    })
    notices.record({ healthCode: 'SESSION_LOG_UNAVAILABLE', sessionId: 'session-b' })

    expect(createObserveSummary({
      domain,
      lifecycle: lifecycle('READY'),
      notices,
      compatibility: 'COMPATIBLE',
    }).unsaved).toEqual({ completeness: 'UNKNOWN', knownCount: 0 })
  })

  it('uses fixed status priority and keeps unsaved completeness unknown during recovery', () => {
    const domain = createMemoryRun2skillDomain()
    const notices = new RuntimeNotices()

    expect(createObserveSummary({
      domain,
      lifecycle: lifecycle('DEGRADED'),
      notices,
      compatibility: 'INCOMPATIBLE',
    })).toMatchObject({
      status: 'INCOMPATIBLE',
      unsaved: { completeness: 'UNKNOWN', knownCount: 0 },
      lastHealthCode: 'DSH_VERSION_INCOMPATIBLE',
    })
    expect(createObserveSummary({
      domain,
      lifecycle: lifecycle('DEGRADED'),
      notices,
      compatibility: 'COMPATIBLE',
    }).status).toBe('DEGRADED')
    expect(createObserveSummary({
      domain,
      lifecycle: lifecycle('READY', true),
      notices,
      compatibility: 'COMPATIBLE',
    }).status).toBe('RECOVERING')
  })

  it('reports only the latest bounded recovery and health facts', async () => {
    const domain = createMemoryRun2skillDomain()
    const older: SessionCheckpointV1 = {
      rootSessionId: 'session-old',
      sessionCreatedAt: 1,
      sessionCwdDigest: 'a'.repeat(64),
      triggerPolicyVersion: 'cheap-trigger-v1',
      activationFenceSeq: 0,
      durableNextSeq: 1,
      observedTailSeq: 0,
      lastScannedAt: '2026-08-19T00:00:00.000Z',
    }
    const newer: SessionCheckpointV1 = {
      ...older,
      rootSessionId: 'session-new',
      sessionCreatedAt: 2,
      sessionCwdDigest: 'b'.repeat(64),
      lastScannedAt: '2026-08-19T00:01:00.000Z',
    }
    const global = domain.global.get()
    await domain.global.set({
      ...global,
      sessions: {
        [deriveSessionLifecycleKeyFromFacts(older)]: older,
        [deriveSessionLifecycleKeyFromFacts(newer)]: newer,
      },
      health: { counts: { SESSION_LOG_ROLLBACK: 1 }, lastCode: 'SESSION_LOG_ROLLBACK' },
    })

    const summary = createObserveSummary({
      domain,
      lifecycle: lifecycle('RECOVERING'),
      notices: new RuntimeNotices(),
      compatibility: 'COMPATIBLE',
    })

    expect(summary.lastRecoveryProgressAt).toBe('2026-08-19T00:01:00.000Z')
    expect(summary.lastHealthCode).toBe('SESSION_LOG_ROLLBACK')
    expect(Object.keys(summary).sort()).toEqual([
      'apiVersion',
      'blockedCaptureCount',
      'capturedCount',
      'lastHealthCode',
      'lastRecoveryProgressAt',
      'learning',
      'recoveryLag',
      'status',
      'unsaved',
    ])

    const ready = createObserveSummary({
      domain,
      lifecycle: lifecycle('READY'),
      notices: new RuntimeNotices(),
      compatibility: 'COMPATIBLE',
    })
    expect(ready.lastRecoveryProgressAt).toBeUndefined()
  })
})
