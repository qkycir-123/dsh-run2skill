import { describe, expect, it } from 'vitest'
import { CaptureWorkItemV1Schema } from '../src/domain/observe/schemas.js'
import {
  ProposalSnapshotV1Schema,
  deriveProposalDigest,
  materializeProposalSnapshot,
} from '../src/domain/review/index.js'
import {
  makeCreateProposalSnapshot,
  makeLearnedWorkItem,
} from './support/review-fixture.js'

describe('Slice C1 immutable Proposal schemas', () => {
  it('materializes stable identities independent of property insertion order', () => {
    const item = makeLearnedWorkItem()
    const snapshot = makeCreateProposalSnapshot(item)
    const { proposalId: _proposalId, digest: _digest, ...facts } = snapshot
    const reordered = Object.fromEntries(Object.entries(facts).reverse()) as typeof facts

    expect(materializeProposalSnapshot(item.workItemId, reordered)).toEqual(snapshot)
    expect(deriveProposalDigest(reordered)).toBe(snapshot.digest)
  })

  it('binds absent-root ancestor facts and rejects changed immutable bytes', () => {
    const snapshot = makeCreateProposalSnapshot()
    if (snapshot.actionBinding.kind !== 'CREATE') throw new Error('fixture must be CREATE')
    const createBinding = snapshot.actionBinding
    if (createBinding.rootBinding.state !== 'ABSENT') throw new Error('fixture root must be ABSENT')
    expect(ProposalSnapshotV1Schema.parse(snapshot).actionBinding).toMatchObject({
      kind: 'CREATE',
      rootBinding: {
        state: 'ABSENT',
        canonicalExistingAncestorPath: 'D:\\workspace',
        missingSegments: ['.dsh', 'skills'],
      },
    })
    expect(ProposalSnapshotV1Schema.safeParse({
      ...snapshot,
      exactSkillBytes: `${snapshot.exactSkillBytes}\nchanged`,
    }).success).toBe(false)
    const { proposalId: _proposalId, digest: _digest, ...facts } = snapshot
    expect(materializeProposalSnapshot(makeLearnedWorkItem().workItemId, {
      ...facts,
      actionBinding: {
        ...createBinding,
        rootBinding: {
          ...createBinding.rootBinding,
          canonicalExistingAncestorPath: 'D:\\workspace\\.dsh',
          missingSegments: ['skills'],
        },
      },
    }).actionBinding).toMatchObject({ rootBinding: { missingSegments: ['skills'] } })
  })

  it('requires action-specific bindings and a PROJECT workspace', () => {
    const snapshot = makeCreateProposalSnapshot()
    expect(ProposalSnapshotV1Schema.safeParse({
      ...snapshot,
      actionBinding: { kind: 'DISCARD', expectedAbsence: snapshot.actionBinding },
    }).success).toBe(false)
    expect(ProposalSnapshotV1Schema.safeParse({ ...snapshot, workspaceBinding: undefined }).success)
      .toBe(false)
    expect(ProposalSnapshotV1Schema.safeParse({
      ...snapshot,
      actionBinding: { ...snapshot.actionBinding, kind: 'MERGE' },
    }).success).toBe(false)
  })

  it('accepts a READY_FOR_REVIEW WorkItem and rejects incoherent review states', () => {
    const item = makeLearnedWorkItem()
    const snapshot = makeCreateProposalSnapshot(item)
    const ready = {
      ...item,
      processingState: 'READY_FOR_REVIEW',
      review: {
        policyVersion: 'review-v1',
        proposal: snapshot,
        reviewDecision: 'PENDING',
        publicationOutcome: 'PENDING_REVIEW',
        coverageRetryCount: 0,
      },
    }
    expect(CaptureWorkItemV1Schema.parse(ready).processingState).toBe('READY_FOR_REVIEW')
    expect(CaptureWorkItemV1Schema.safeParse({
      ...ready,
      review: {
        ...ready.review,
        proposal: { ...snapshot, proposalId: `prop_${'f'.repeat(64)}` },
      },
    }).success).toBe(false)
    expect(CaptureWorkItemV1Schema.safeParse({
      ...ready,
      review: { ...ready.review, reviewDecision: 'APPROVED' },
    }).success).toBe(false)
    expect(CaptureWorkItemV1Schema.safeParse({
      ...ready,
      processingState: 'TERMINAL',
      review: { ...ready.review, publicationOutcome: 'PUBLISHED' },
    }).success).toBe(false)
    expect(CaptureWorkItemV1Schema.safeParse({
      ...ready,
      processingState: 'NEEDS_ATTENTION',
      review: {
        ...ready.review,
        publicationOutcome: 'NEEDS_ATTENTION',
        failure: {
          code: 'UNRELATED_FAILURE',
          retryable: true,
          occurredAt: '2026-08-20T00:00:00.000Z',
        },
      },
    }).success).toBe(false)
  })

  it('requires a MERGE Base from the same complete catalog observation', () => {
    const item = makeLearnedWorkItem()
    const create = makeCreateProposalSnapshot(item)
    if (create.actionBinding.kind !== 'CREATE') throw new Error('fixture must be CREATE')
    const createBinding = create.actionBinding
    const { proposalId: _proposalId, digest: _digest, ...facts } = create
    expect(() => materializeProposalSnapshot(item.workItemId, {
      ...facts,
      kind: 'MERGE',
      actionBinding: {
        kind: 'MERGE',
        rootBinding: createBinding.rootBinding,
        targetBinding: createBinding.targetBinding,
        baseBinding: {
          candidateKey: `cand_${'d'.repeat(64)}`,
          provider: 'filesystem',
          source: 'project-dsh',
          path: 'D:\\workspace\\.dsh\\skills\\generated-file-hygiene\\SKILL.md',
          exactBytes: create.exactSkillBytes,
          bytesDigest: create.skillBytesDigest,
          catalogObservationDigest: 'f'.repeat(64),
          observedAt: '2026-08-20T00:00:00.000Z',
        },
      },
    })).toThrow()
  })
})
