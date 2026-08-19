import { describe, expect, it } from 'vitest'
import { DurableCaptureStore } from '../src/adapters/dsh-storage/durable-capture-store.js'
import { ProposalReviewStore } from '../src/adapters/dsh-storage/proposal-review-store.js'
import { CaptureWorkItemV1Schema } from '../src/domain/observe/schemas.js'
import { proposalRefOf } from '../src/domain/review/index.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import {
  makeCreateProposalSnapshot,
  makeDiscardProposalSnapshot,
  makeLearnedWorkItem,
} from './support/review-fixture.js'

describe('ProposalReviewStore', () => {
  it('stages identical facts once and rejects a conflicting WorkItem revision', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeLearnedWorkItem()
    domain.workItems.set(item.workItemId, item)
    const store = new ProposalReviewStore(domain, () => '2026-08-20T00:00:01.000Z')
    const snapshot = makeCreateProposalSnapshot(item)

    const staged = await store.stage(item.workItemId, item.revision, snapshot)
    expect(staged).toMatchObject({ changed: true, item: { revision: 2, processingState: 'READY_FOR_REVIEW' } })
    await expect(store.stage(item.workItemId, item.revision, snapshot)).resolves.toEqual({
      changed: false,
      item: staged.item,
    })
    await expect(store.stage(item.workItemId, item.revision, {
      ...snapshot,
      digest: 'e'.repeat(64),
    })).rejects.toMatchObject({ code: 'INVALID_PROPOSAL_SNAPSHOT' })
    await expect(store.stage(item.workItemId, staged.item.revision, {
      ...snapshot,
      proposalId: `prop_${'e'.repeat(64)}`,
    })).rejects.toMatchObject({ code: 'INVALID_REVIEW_STATE' })
  })

  it('approves only CREATE/MERGE by immutable ref and makes duplicate approval idempotent', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeLearnedWorkItem()
    domain.workItems.set(item.workItemId, item)
    const store = new ProposalReviewStore(domain, () => '2026-08-20T00:00:01.000Z')
    const staged = await store.stage(item.workItemId, item.revision, makeCreateProposalSnapshot(item))
    const ref = proposalRefOf(staged.item.review!.proposal)

    const approved = await store.approve(item.workItemId, staged.item.revision, ref)
    expect(approved).toMatchObject({
      changed: true,
      item: {
        processingState: 'PUBLISHING',
        review: { reviewDecision: 'APPROVED', publicationOutcome: 'PENDING_REVIEW' },
      },
    })
    await expect(store.approve(item.workItemId, staged.item.revision, ref)).resolves.toEqual({
      changed: false,
      item: approved.item,
    })
    await expect(store.reject(item.workItemId, approved.item.revision, ref))
      .rejects.toMatchObject({ code: 'INVALID_REVIEW_STATE' })
  })

  it('rejects a proposal without publishing and confirms DISCARD coverage exactly once', async () => {
    const domain = createMemoryRun2skillDomain()
    const first = makeLearnedWorkItem()
    const distinct = makeLearnedWorkItem({
      signalKey: {
        ...first.signalKey,
        turn: 3,
        turnEndSeq: 20,
        turnInstanceDigest: 'e'.repeat(64),
      },
    })
    domain.workItems.set(first.workItemId, first)
    domain.workItems.set(distinct.workItemId, distinct)
    const store = new ProposalReviewStore(domain, () => '2026-08-20T00:00:01.000Z')

    const create = await store.stage(first.workItemId, first.revision, makeCreateProposalSnapshot(first))
    const rejected = await store.reject(
      first.workItemId,
      create.item.revision,
      proposalRefOf(create.item.review!.proposal),
    )
    expect(rejected.item).toMatchObject({
      processingState: 'TERMINAL',
      review: { reviewDecision: 'REJECTED', publicationOutcome: 'DISCARDED', decisionReason: 'USER_REJECTED' },
    })

    const discardSnapshot = makeDiscardProposalSnapshot(distinct)
    const discard = await store.stage(distinct.workItemId, distinct.revision, discardSnapshot)
    const ref = proposalRefOf(discard.item.review!.proposal)
    const confirmed = await store.confirmCoverage(distinct.workItemId, discard.item.revision, ref)
    expect(confirmed.item).toMatchObject({
      processingState: 'TERMINAL',
      review: { reviewDecision: 'REJECTED', publicationOutcome: 'DISCARDED', decisionReason: 'COVERAGE_CONFIRMED' },
    })
    await expect(store.confirmCoverage(distinct.workItemId, discard.item.revision, ref))
      .resolves.toEqual({ changed: false, item: confirmed.item })
  })

  it('opens at most one durable reanalysis request for a declined DISCARD', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeLearnedWorkItem()
    domain.workItems.set(item.workItemId, item)
    const store = new ProposalReviewStore(domain, () => '2026-08-20T00:00:01.000Z')
    const staged = await store.stage(item.workItemId, item.revision, makeDiscardProposalSnapshot(item))
    const ref = proposalRefOf(staged.item.review!.proposal)

    const retry = await store.requestCoverageRetry(item.workItemId, staged.item.revision, ref)
    expect(retry.item).toMatchObject({
      processingState: 'NEEDS_ATTENTION',
      review: {
        reviewDecision: 'PENDING',
        publicationOutcome: 'NEEDS_ATTENTION',
        coverageRetryCount: 1,
        failure: { code: 'COVERAGE_REANALYSIS_REQUESTED', retryable: true },
      },
    })
    await expect(store.requestCoverageRetry(item.workItemId, staged.item.revision, ref))
      .resolves.toEqual({ changed: false, item: retry.item })
  })

  it('preserves a staged review when Slice A replays the same capture', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeLearnedWorkItem()
    domain.workItems.set(item.workItemId, item)
    const reviews = new ProposalReviewStore(domain)
    const capture = new DurableCaptureStore(domain)
    const staged = await reviews.stage(item.workItemId, item.revision, makeCreateProposalSnapshot(item))

    const replay = await capture.persist(item)
    expect(replay).toEqual({ changed: false, item: staged.item })
  })

  it('round-trips immutable review facts across a storage restart boundary', async () => {
    const firstDomain = createMemoryRun2skillDomain()
    const item = makeLearnedWorkItem()
    firstDomain.workItems.set(item.workItemId, item)
    const firstStore = new ProposalReviewStore(firstDomain)
    const staged = await firstStore.stage(item.workItemId, item.revision, makeCreateProposalSnapshot(item))
    const restored = CaptureWorkItemV1Schema.parse(JSON.parse(JSON.stringify(staged.item)))

    const reopenedDomain = createMemoryRun2skillDomain()
    reopenedDomain.workItems.set(item.workItemId, restored)
    const reopenedStore = new ProposalReviewStore(reopenedDomain)
    const approved = await reopenedStore.approve(
      item.workItemId,
      restored.revision,
      proposalRefOf(restored.review!.proposal),
    )

    expect(approved.item.review?.proposal).toEqual(staged.item.review?.proposal)
    expect(approved.item.review?.reviewDecision).toBe('APPROVED')
  })
})
