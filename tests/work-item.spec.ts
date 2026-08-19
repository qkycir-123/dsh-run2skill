import { describe, expect, it } from 'vitest'
import { DomainError } from '../src/domain/observe/errors.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import { mergeCaptureWorkItems } from '../src/domain/observe/work-item.js'
import { makeWorkItem } from './support/work-item-fixture.js'

describe('CaptureWorkItemV1 monotonic merge', () => {
  it('is idempotent for duplicate delivery', () => {
    const item = makeWorkItem()

    expect(mergeCaptureWorkItems(item, structuredClone(item))).toEqual(item)
  })

  it('converges for replay in either order', () => {
    const base = makeWorkItem({
      captureReason: 'SCAN_INCOMPLETE',
      scanStatus: 'INCOMPLETE',
      triggerHits: [],
      evidenceRefs: [],
      captureBlockers: ['TEXT_LIMIT_EXCEEDED'],
    })
    const triggerObservation = makeWorkItem({
      revision: 1,
      captureReason: 'CHEAP_TRIGGER',
      scanStatus: 'COMPLETE',
      captureBlockers: [],
    })

    const forward = mergeCaptureWorkItems(base, triggerObservation)
    const reverse = mergeCaptureWorkItems(triggerObservation, base)

    expect(forward).toEqual(reverse)
    expect(forward.revision).toBe(1)
    expect(forward).toMatchObject({
      captureReason: 'CHEAP_TRIGGER',
      scanStatus: 'COMPLETE',
      captureBlockers: [],
      processingState: 'CAPTURED',
    })
  })

  it('closes a formerly blocked no-signal item and never reopens it', () => {
    const blocked = makeWorkItem({
      captureReason: 'SCAN_INCOMPLETE',
      scanStatus: 'INCOMPLETE',
      triggerHits: [],
      evidenceRefs: [],
      captureBlockers: ['TURN_BOUNDARY_INCOMPLETE'],
    })
    const resolved = makeWorkItem({
      revision: 2,
      captureReason: 'SCAN_INCOMPLETE',
      scanStatus: 'COMPLETE',
      triggerHits: [],
      evidenceRefs: [],
      captureBlockers: [],
      processingState: 'RESOLVED_NO_SIGNAL',
    })

    const closed = mergeCaptureWorkItems(blocked, resolved)
    expect(closed.processingState).toBe('RESOLVED_NO_SIGNAL')
    expect(mergeCaptureWorkItems(closed, blocked)).toEqual(closed)
  })

  it('rejects resolved no-signal snapshots that conflict with triggered facts', () => {
    const triggered = makeWorkItem()
    const resolved = makeWorkItem({
      revision: 2,
      captureReason: 'SCAN_INCOMPLETE',
      scanStatus: 'COMPLETE',
      triggerHits: [],
      evidenceRefs: [],
      captureBlockers: [],
      processingState: 'RESOLVED_NO_SIGNAL',
    })

    for (const [left, right] of [[resolved, triggered], [triggered, resolved]] as const) {
      expect(() => mergeCaptureWorkItems(left, right)).toThrowError(
        expect.objectContaining({ code: 'IMMUTABLE_FIELD_CONFLICT' }),
      )
    }
  })

  it('advances revision when a lower-revision terminal snapshot closes newer metadata', () => {
    const blocked = makeWorkItem({
      revision: 8,
      updatedAt: '2026-08-19T00:00:08.000Z',
      captureReason: 'SCAN_INCOMPLETE',
      scanStatus: 'INCOMPLETE',
      triggerHits: [],
      evidenceRefs: [],
      captureBlockers: ['TURN_BOUNDARY_INCOMPLETE'],
    })
    const resolved = makeWorkItem({
      revision: 2,
      updatedAt: '2026-08-19T00:00:02.000Z',
      captureReason: 'SCAN_INCOMPLETE',
      scanStatus: 'COMPLETE',
      triggerHits: [],
      evidenceRefs: [],
      captureBlockers: [],
      processingState: 'RESOLVED_NO_SIGNAL',
    })

    const forward = mergeCaptureWorkItems(blocked, resolved)
    const reverse = mergeCaptureWorkItems(resolved, blocked)

    expect(forward).toEqual(reverse)
    expect(forward.revision).toBe(8)
    expect(forward.updatedAt).toBe(blocked.updatedAt)
    expect(forward.processingState).toBe('RESOLVED_NO_SIGNAL')
    expect(mergeCaptureWorkItems(forward, blocked)).toEqual(forward)
  })

  it('advances revision when lower-revision triggered facts dominate newer metadata', () => {
    const blocked = makeWorkItem({
      revision: 8,
      updatedAt: '2026-08-19T00:00:08.000Z',
      captureReason: 'SCAN_INCOMPLETE',
      scanStatus: 'INCOMPLETE',
      triggerHits: [],
      evidenceRefs: [],
      captureBlockers: ['TEXT_LIMIT_EXCEEDED'],
    })
    const triggered = makeWorkItem({ revision: 2 })

    const forward = mergeCaptureWorkItems(blocked, triggered)
    const reverse = mergeCaptureWorkItems(triggered, blocked)

    expect(forward).toEqual(reverse)
    expect(forward.revision).toBe(8)
    expect(forward.updatedAt).toBe(blocked.updatedAt)
    expect(forward.captureReason).toBe('CHEAP_TRIGGER')
  })

  it('advances revision when lower-revision workspace facts dominate', () => {
    const unavailable = makeWorkItem({
      revision: 8,
      updatedAt: '2026-08-19T00:00:08.000Z',
      workspaceBinding: { status: 'UNAVAILABLE', observedAt: '2026-08-19T00:00:08.000Z' },
    })
    const bound = makeWorkItem({
      revision: 2,
      workspaceBinding: {
        status: 'BOUND',
        workspaceId: 'workspace-1',
        canonicalPath: 'D:\\workspace',
        observedAt: '2026-08-19T00:00:02.000Z',
      },
    })

    const forward = mergeCaptureWorkItems(unavailable, bound)
    const reverse = mergeCaptureWorkItems(bound, unavailable)

    expect(forward).toEqual(reverse)
    expect(forward.revision).toBe(8)
    expect(forward.workspaceBinding).toEqual(bound.workspaceBinding)
  })

  it('rejects duplicate delivery with non-canonical repeated fields', () => {
    const item = makeWorkItem()
    const nonCanonical = makeWorkItem({
      triggerHits: [{
        kind: 'CONSTRAINT',
        messageSeq: 11,
        ruleId: 'ctv1.constraint.persistent-operator',
        confidence: 'HIGH',
      }, item.triggerHits[0]!],
    })

    expect(() => mergeCaptureWorkItems(nonCanonical, structuredClone(nonCanonical))).toThrowError(
      expect.objectContaining({ code: 'INVALID_WORK_ITEM' }),
    )
  })

  it('joins pre-aggregated facts associatively without manufacturing revisions', () => {
    const explicit = makeWorkItem({ revision: 1 })
    const constraintHit = {
      kind: 'CONSTRAINT' as const,
      messageSeq: 12,
      ruleId: 'ctv1.constraint.persistent-operator',
      confidence: 'HIGH' as const,
    }
    const constraint = makeWorkItem({ revision: 1, triggerHits: [constraintHit] })
    const union = makeWorkItem({
      revision: 1,
      triggerHits: [...explicit.triggerHits, constraintHit],
    })

    const leftGrouped = mergeCaptureWorkItems(
      mergeCaptureWorkItems(explicit, constraint),
      union,
    )
    const rightGrouped = mergeCaptureWorkItems(
      explicit,
      mergeCaptureWorkItems(constraint, union),
    )
    expect(leftGrouped).toEqual(rightGrouped)
    expect(leftGrouped.revision).toBe(1)

    const highRevisionExplicit = { ...explicit, revision: 10 }
    const highLeft = mergeCaptureWorkItems(
      mergeCaptureWorkItems(highRevisionExplicit, constraint),
      union,
    )
    const highRight = mergeCaptureWorkItems(
      highRevisionExplicit,
      mergeCaptureWorkItems(constraint, union),
    )
    expect(highLeft).toEqual(highRight)
    expect(highLeft.revision).toBe(10)
  })

  it('rejects mutually inconsistent incomplete blocker observations in either order', () => {
    const turnBoundary = makeWorkItem({
      captureReason: 'SCAN_INCOMPLETE',
      scanStatus: 'INCOMPLETE',
      triggerHits: [],
      evidenceRefs: [],
      captureBlockers: ['TURN_BOUNDARY_INCOMPLETE'],
    })
    const textLimit = makeWorkItem({
      captureReason: 'SCAN_INCOMPLETE',
      scanStatus: 'INCOMPLETE',
      triggerHits: [],
      evidenceRefs: [],
      captureBlockers: ['TEXT_LIMIT_EXCEEDED'],
    })

    expect(() => mergeCaptureWorkItems(turnBoundary, textLimit)).toThrowError(
      expect.objectContaining({ code: 'INVALID_WORK_ITEM' }),
    )
    expect(() => mergeCaptureWorkItems(textLimit, turnBoundary)).toThrowError(
      expect.objectContaining({ code: 'INVALID_WORK_ITEM' }),
    )
  })

  it('rejects an ID collision with a different SignalKey without leaking values', () => {
    const existing = makeWorkItem()
    const conflicting = makeWorkItem({
      signalKey: { ...existing.signalKey, sessionCreatedAt: existing.signalKey.sessionCreatedAt + 1 },
    })

    expect(() => mergeCaptureWorkItems(existing, conflicting)).toThrowError(DomainError)
    try {
      mergeCaptureWorkItems(existing, conflicting)
    } catch (error) {
      expect(error).toMatchObject({ code: 'SIGNAL_KEY_CONFLICT' })
      expect(String(error)).not.toContain(existing.signalKey.rootSessionId)
    }
  })

  it('unions unique facts while completeness and blockers move only forward', () => {
    const first = makeWorkItem({
      captureReason: 'SCAN_INCOMPLETE',
      scanStatus: 'INCOMPLETE',
      triggerHits: [],
      evidenceRefs: [],
      captureBlockers: ['TURN_BOUNDARY_INCOMPLETE', 'TEXT_LIMIT_EXCEEDED'],
    })
    const second = makeWorkItem({
      captureReason: 'SCAN_INCOMPLETE',
      scanStatus: 'INCOMPLETE',
      triggerHits: [],
      evidenceRefs: [],
      captureBlockers: ['TEXT_LIMIT_EXCEEDED'],
    })

    const merged = mergeCaptureWorkItems(first, second)
    expect(merged.captureBlockers).toEqual(['TEXT_LIMIT_EXCEEDED'])
    expect(mergeCaptureWorkItems(merged, first)).toEqual(merged)
  })

  it('forms a deterministic de-duplicated union of trigger and evidence facts', () => {
    const first = makeWorkItem()
    const second = makeWorkItem({
      triggerHits: [{
        kind: 'CONSTRAINT',
        messageSeq: 12,
        ruleId: 'ctv1.constraint.persistent-operator',
        confidence: 'HIGH',
      }],
      evidenceRefs: [{
        source: 'USER_DIRECT',
        messageSeq: 12,
        excerpt: '这个项目以后只能使用中文文档',
        excerptDigest: sha256Utf8('这个项目以后只能使用中文文档'),
        redactionKinds: [],
        truncated: false,
      }],
    })

    const forward = mergeCaptureWorkItems(first, second)
    const reverse = mergeCaptureWorkItems(second, first)

    expect(forward).toEqual(reverse)
    expect(forward.revision).toBe(1)
    expect(forward.triggerHits.map((hit) => hit.kind)).toEqual(['EXPLICIT_SAVE', 'CONSTRAINT'])
    expect(forward.evidenceRefs.map((evidence) => evidence.messageSeq)).toEqual([11, 12])
  })

  it('prefers the highest revision for an identical replay regardless of order', () => {
    const older = makeWorkItem({ revision: 2, updatedAt: '2026-08-19T00:00:01.000Z' })
    const newer = makeWorkItem({ revision: 3, updatedAt: '2026-08-19T00:00:02.000Z' })

    expect(mergeCaptureWorkItems(older, newer)).toEqual(newer)
    expect(mergeCaptureWorkItems(newer, older)).toEqual(newer)
  })

  it('keeps the newest observation time for an otherwise identical workspace binding', () => {
    const older = makeWorkItem({
      workspaceBinding: { status: 'NO_CWD', observedAt: '2026-08-19T00:00:00.000Z' },
    })
    const newer = makeWorkItem({
      workspaceBinding: { status: 'NO_CWD', observedAt: '2026-08-19T00:00:02.000Z' },
    })

    expect(mergeCaptureWorkItems(older, newer).workspaceBinding).toEqual(newer.workspaceBinding)
    expect(mergeCaptureWorkItems(newer, older).workspaceBinding).toEqual(newer.workspaceBinding)
  })

  it('merges resolved snapshots independently of replay order', () => {
    const unavailable = makeWorkItem({
      captureReason: 'SCAN_INCOMPLETE',
      scanStatus: 'COMPLETE',
      triggerHits: [],
      evidenceRefs: [],
      captureBlockers: [],
      processingState: 'RESOLVED_NO_SIGNAL',
      workspaceBinding: { status: 'UNAVAILABLE', observedAt: '2026-08-19T00:00:00.000Z' },
    })
    const bound = makeWorkItem({
      captureReason: 'SCAN_INCOMPLETE',
      scanStatus: 'COMPLETE',
      triggerHits: [],
      evidenceRefs: [],
      captureBlockers: [],
      processingState: 'RESOLVED_NO_SIGNAL',
      workspaceBinding: {
        status: 'BOUND',
        workspaceId: 'workspace-1',
        canonicalPath: 'D:\\workspace',
        observedAt: '2026-08-19T00:00:00.000Z',
      },
    })

    expect(mergeCaptureWorkItems(unavailable, bound)).toEqual(bound)
    expect(mergeCaptureWorkItems(bound, unavailable)).toEqual(bound)
  })

  it('compares accepted offset timestamps by instant', () => {
    const older = makeWorkItem({
      workspaceBinding: { status: 'NO_CWD', observedAt: '2026-08-19T00:00:00+14:00' },
    })
    const newer = makeWorkItem({
      workspaceBinding: { status: 'NO_CWD', observedAt: '2026-08-18T23:00:00-12:00' },
    })

    expect(mergeCaptureWorkItems(older, newer).workspaceBinding).toEqual(newer.workspaceBinding)
    expect(mergeCaptureWorkItems(newer, older).workspaceBinding).toEqual(newer.workspaceBinding)
  })

  it('uses timestamp instants when otherwise identical snapshots tie on revision', () => {
    const older = makeWorkItem({ updatedAt: '2026-08-19T00:00:00+14:00' })
    const newer = makeWorkItem({ updatedAt: '2026-08-18T23:00:00-12:00' })

    expect(mergeCaptureWorkItems(older, newer)).toEqual(newer)
    expect(mergeCaptureWorkItems(newer, older)).toEqual(newer)
  })
})
