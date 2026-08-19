import { describe, expect, it } from 'vitest'
import {
  ExperienceRecordV1Schema,
  LearningProposalV1Schema,
  deriveExperienceId,
  deriveLearningProposalId,
} from '../src/domain/learn/index.js'
import { CaptureWorkItemV1Schema } from '../src/domain/observe/schemas.js'
import { makeWorkItem } from './support/work-item-fixture.js'

function experience() {
  const facts = {
    type: 'CONSTRAINT' as const,
    lesson: 'Always keep generated files out of source control.',
    persistenceScope: 'PROJECT' as const,
    evidenceStrength: 'HIGH' as const,
    supportingEvidence: [{ messageSeq: 11, excerptDigest: makeWorkItem().evidenceRefs[0]!.excerptDigest }],
  }
  return { experienceId: deriveExperienceId(makeWorkItem().workItemId, facts), ...facts }
}

function proposal() {
  const exp = experience()
  const facts = {
    policyVersion: 'learning-v1' as const,
    name: 'generated-file-hygiene',
    description: 'Keep generated files out of source control.',
    whenToUse: 'Use when generating build or codegen outputs.',
    content: '# Generated file hygiene\n\nDo not commit generated output.',
    invocation: { modelInvocable: true as const, userInvocable: false as const },
    persistenceScope: 'PROJECT' as const,
    supportingExperienceIds: [exp.experienceId],
    curation: { decision: 'CREATE' as const, rationale: 'No matching Skill was recalled.' },
    catalogObservationDigest: 'c'.repeat(64),
    shortlistDigests: [],
  }
  return { learningProposalId: deriveLearningProposalId(makeWorkItem().workItemId, facts), ...facts }
}

describe('Slice B durable learning schemas', () => {
  it('accepts old Slice A work items without learning fields', () => {
    expect(CaptureWorkItemV1Schema.parse(makeWorkItem())).toEqual(makeWorkItem())
  })

  it('derives stable ids and accepts a learned WorkItem', () => {
    const exp = experience()
    const draft = proposal()
    expect(ExperienceRecordV1Schema.parse(exp)).toEqual(exp)
    expect(LearningProposalV1Schema.parse(draft)).toEqual(draft)
    expect(CaptureWorkItemV1Schema.parse(makeWorkItem({
      processingState: 'LEARNED',
      learning: {
        policyVersion: 'learning-v1',
        attempt: 1,
        requestBudgetUsed: 1,
        calls: [{ requestOrdinal: 1, kind: 'PRIMARY', outcome: 'SUCCEEDED', inputTokens: 10, outputTokens: 5 }],
        experiences: [exp],
        proposal: draft,
      },
    })).processingState).toBe('LEARNED')
  })

  it('derives the same id regardless of object property insertion order', () => {
    const exp = experience()
    const forward = {
      type: exp.type,
      lesson: exp.lesson,
      persistenceScope: exp.persistenceScope,
      evidenceStrength: exp.evidenceStrength,
      supportingEvidence: exp.supportingEvidence,
    }
    const reordered = {
      supportingEvidence: exp.supportingEvidence,
      evidenceStrength: exp.evidenceStrength,
      persistenceScope: exp.persistenceScope,
      lesson: exp.lesson,
      type: exp.type,
    }
    expect(deriveExperienceId(makeWorkItem().workItemId, forward))
      .toBe(deriveExperienceId(makeWorkItem().workItemId, reordered))
  })

  it('rejects invented evidence, authorizable fields, and inconsistent curation targets', () => {
    const exp = experience()
    expect(ExperienceRecordV1Schema.safeParse({
      ...exp,
      experienceId: deriveExperienceId(makeWorkItem().workItemId, { ...exp, lesson: 'changed' }),
      supportingEvidence: [{ messageSeq: 999, excerptDigest: 'd'.repeat(64) }],
    }).success).toBe(true)
    expect(LearningProposalV1Schema.safeParse({ ...proposal(), exactTargetPath: '/tmp/skill' }).success).toBe(false)
    expect(LearningProposalV1Schema.safeParse({
      ...proposal(),
      curation: { decision: 'MERGE', rationale: 'merge without a target' },
    }).success).toBe(false)
    expect(CaptureWorkItemV1Schema.safeParse(makeWorkItem({
      processingState: 'LEARNED',
      learning: {
        policyVersion: 'learning-v1', attempt: 1, requestBudgetUsed: 0, calls: [],
        experiences: [{ ...exp, supportingEvidence: [{ messageSeq: 999, excerptDigest: 'd'.repeat(64) }] }],
        proposal: proposal(),
      },
    })).success).toBe(false)
  })

  it('requires honest terminal learning states', () => {
    expect(CaptureWorkItemV1Schema.safeParse(makeWorkItem({
      processingState: 'NEEDS_ATTENTION',
      learning: { policyVersion: 'learning-v1', attempt: 1, requestBudgetUsed: 2, calls: [] },
    })).success).toBe(false)
    expect(CaptureWorkItemV1Schema.safeParse(makeWorkItem({
      processingState: 'RESOLVED_NO_SIGNAL',
      learning: { policyVersion: 'learning-v1', attempt: 0, requestBudgetUsed: 0, calls: [] },
    })).success).toBe(false)
  })

  it('rejects committed or active result facts while an item is captured', () => {
    const result = { experiences: [experience()], proposal: proposal() }
    expect(CaptureWorkItemV1Schema.safeParse(makeWorkItem({
      learning: {
        policyVersion: 'learning-v1', attempt: 1, requestBudgetUsed: 1, calls: [],
        ...result,
      },
    })).success).toBe(false)
    expect(CaptureWorkItemV1Schema.safeParse(makeWorkItem({
      learning: {
        policyVersion: 'learning-v1', attempt: 1, requestBudgetUsed: 0, calls: [],
        claimedAt: '2026-08-20T00:00:00.000Z',
      },
    })).success).toBe(false)
  })

  it('requires the latest reserved call to succeed for a learned item', () => {
    const result = { experiences: [experience()], proposal: proposal() }
    expect(CaptureWorkItemV1Schema.safeParse(makeWorkItem({
      processingState: 'LEARNED',
      learning: {
        policyVersion: 'learning-v1', attempt: 1, requestBudgetUsed: 2,
        calls: [
          { requestOrdinal: 1, kind: 'PRIMARY', outcome: 'SUCCEEDED' },
          { requestOrdinal: 2, kind: 'FORMAT_REPAIR', outcome: 'FAILED' },
        ],
        ...result,
      },
    })).success).toBe(false)
  })
})
