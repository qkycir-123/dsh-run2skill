import { describe, expect, it } from 'vitest'
import { classifyLegacyWorkItem, materializeLegacyItemV2 } from '../src/adapters/dsh-storage/legacy-v1-adapter.js'
import { CaptureWorkItemV1Schema } from '../src/domain/observe/schemas.js'
import { ProposalReviewStore } from '../src/adapters/dsh-storage/proposal-review-store.js'
import { proposalRefOf } from '../src/domain/review/index.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import {
  makeCreateProposalSnapshot,
  makeDiscardProposalSnapshot,
  makeLearnedWorkItem,
} from './support/review-fixture.js'
import { makeWorkItem } from './support/work-item-fixture.js'
import { deriveLegacyPendingProposalCatalogV2 } from '../src/domain/v2/index.js'

describe('v1 legacy adapter', () => {
  it('maps the proposal-free states without replaying them', () => {
    const captured = makeWorkItem()
    const analyzing = CaptureWorkItemV1Schema.parse({
      ...captured,
      processingState: 'ANALYZING',
      learning: {
        policyVersion: 'learning-v1',
        attempt: 1,
        requestBudgetUsed: 0,
        claimedAt: '2026-08-20T00:00:00.000Z',
        calls: [],
      },
    })
    const noSignal = CaptureWorkItemV1Schema.parse({
      ...captured,
      captureReason: 'SCAN_INCOMPLETE',
      scanStatus: 'COMPLETE',
      triggerHits: [],
      evidenceRefs: [],
      processingState: 'RESOLVED_NO_SIGNAL',
    })

    expect(classifyLegacyWorkItem(noSignal)).toBe('AUDIT_ONLY_NO_SIGNAL')
    expect(classifyLegacyWorkItem(captured)).toBe('LEGACY_NEEDS_ATTENTION')
    expect(classifyLegacyWorkItem(analyzing)).toBe('LEGACY_CALL_OUTCOME_UNKNOWN')
  })

  it('keeps every legacy proposal-bearing state active for future catalog deduplication', () => {
    const learned = makeLearnedWorkItem()
    expect(classifyLegacyWorkItem(learned)).toBe('ACTIVE_LEGACY_PROPOSAL')

    const envelope = materializeLegacyItemV2(learned, '2026-08-22T00:00:00.000Z')
    expect(envelope.disposition).toBe('ACTIVE_LEGACY_PROPOSAL')
    expect(envelope.sourceWorkItem).toEqual(learned)
    expect(envelope.sourceDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(envelope.legacyItemId).toMatch(/^legacy_[a-f0-9]{64}$/)
    const catalog = deriveLegacyPendingProposalCatalogV2([envelope])
    expect(catalog.complete).toBe(true)
    expect(catalog.entries).toHaveLength(1)
    expect(catalog.entries[0]).toMatchObject({
      candidateKey: envelope.legacyItemId,
      sourceWorkItemId: learned.workItemId,
      capability: 'FULL_BODY',
      exactSkillBytes: learned.learning!.proposal!.content,
    })
  })

  it('exhaustively maps review, publication, attention, and terminal sub-shapes', async () => {
    const domain = createMemoryRun2skillDomain()
    const learned = makeLearnedWorkItem()
    domain.workItems.set(learned.workItemId, learned)
    const reviews = new ProposalReviewStore(domain, () => '2026-08-22T00:00:00.000Z')
    const ready = (await reviews.stage(
      learned.workItemId,
      learned.revision,
      makeCreateProposalSnapshot(learned),
    )).item
    const publishing = (await reviews.approve(
      ready.workItemId,
      ready.revision,
      proposalRefOf(ready.review!.proposal),
    )).item
    const published = CaptureWorkItemV1Schema.parse({
      ...publishing,
      processingState: 'TERMINAL',
      review: { ...publishing.review!, publicationOutcome: 'PUBLISHED' },
    })

    const distinct = makeLearnedWorkItem({
      signalKey: {
        ...learned.signalKey,
        turn: 4,
        turnEndSeq: 30,
        turnInstanceDigest: 'f'.repeat(64),
      },
    })
    domain.workItems.set(distinct.workItemId, distinct)
    const discardReady = (await reviews.stage(
      distinct.workItemId,
      distinct.revision,
      makeDiscardProposalSnapshot(distinct),
    )).item
    const reviewAttention = (await reviews.requestCoverageRetry(
      discardReady.workItemId,
      discardReady.revision,
      proposalRefOf(discardReady.review!.proposal),
    )).item

    const terminalSource = makeLearnedWorkItem({
      signalKey: {
        ...learned.signalKey,
        turn: 5,
        turnEndSeq: 40,
        turnInstanceDigest: '9'.repeat(64),
      },
    })
    domain.workItems.set(terminalSource.workItemId, terminalSource)
    const terminalReady = (await reviews.stage(
      terminalSource.workItemId,
      terminalSource.revision,
      makeCreateProposalSnapshot(terminalSource),
    )).item
    const discarded = (await reviews.reject(
      terminalReady.workItemId,
      terminalReady.revision,
      proposalRefOf(terminalReady.review!.proposal),
    )).item

    const captured = makeWorkItem()
    const learningAttention = CaptureWorkItemV1Schema.parse({
      ...captured,
      processingState: 'NEEDS_ATTENTION',
      learning: {
        policyVersion: 'learning-v1',
        attempt: 1,
        requestBudgetUsed: 0,
        calls: [],
        failure: {
          code: 'LEARNING_GUARD_REJECTED',
          retryable: false,
          occurredAt: '2026-08-22T00:00:00.000Z',
        },
        publicationOutcome: 'NEEDS_ATTENTION',
      },
    })

    expect(classifyLegacyWorkItem(ready)).toBe('ACTIVE_LEGACY_PROPOSAL')
    expect(classifyLegacyWorkItem(publishing)).toBe('ACTIVE_LEGACY_PUBLICATION')
    expect(classifyLegacyWorkItem(reviewAttention)).toBe('ACTIVE_LEGACY_PROPOSAL')
    expect(classifyLegacyWorkItem(learningAttention)).toBe('LEGACY_NEEDS_ATTENTION')
    expect(classifyLegacyWorkItem(discarded)).toBe('AUDIT_ONLY_DISCARDED')
    expect(classifyLegacyWorkItem(published)).toBe('AUDIT_ONLY_PUBLISHED')
  })

  it('fails closed instead of classifying an invalid v1 combination', () => {
    const invalid = { ...makeWorkItem(), processingState: 'TERMINAL' as const }
    expect(() => materializeLegacyItemV2(invalid, '2026-08-22T00:00:00.000Z'))
      .toThrow(/LEGACY_SCHEMA_INVALID/)
  })
})
