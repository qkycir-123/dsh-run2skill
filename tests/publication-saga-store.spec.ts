import { describe, expect, it } from 'vitest'
import { ProposalReviewStore } from '../src/adapters/dsh-storage/proposal-review-store.js'
import { PublicationSagaStore } from '../src/adapters/dsh-storage/publication-saga-store.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import { materializeLineage } from '../src/domain/publication/index.js'
import { proposalRefOf } from '../src/domain/review/index.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { makeCreateProposalSnapshot, makeLearnedWorkItem } from './support/review-fixture.js'

const times = [
  '2026-08-20T00:00:01.000Z',
  '2026-08-20T00:00:02.000Z',
  '2026-08-20T00:00:03.000Z',
  '2026-08-20T00:00:04.000Z',
  '2026-08-20T00:00:05.000Z',
]

async function approvedFixture(options: { failLineageWrites?: number } = {}) {
  const domain = createMemoryRun2skillDomain(options)
  const item = makeLearnedWorkItem()
  domain.workItems.set(item.workItemId, item)
  let tick = 0
  const now = () => times[Math.min(tick++, times.length - 1)]!
  const reviews = new ProposalReviewStore(domain, now)
  const staged = await reviews.stage(item.workItemId, item.revision, makeCreateProposalSnapshot(item))
  const approved = await reviews.approve(
    item.workItemId,
    staged.item.revision,
    proposalRefOf(staged.item.review!.proposal),
  )
  return { domain, approved: approved.item, now }
}

describe('PublicationSagaStore', () => {
  it('commits pending Lineage before the terminal outcome and resumes a partial cross-table commit', async () => {
    const { domain, approved, now } = await approvedFixture()
    const store = new PublicationSagaStore(domain, now)
    const proposal = approved.review!.proposal
    const publication = approved.publication!
    const lineage = materializeLineage({
      scope: proposal.persistenceScope,
      provider: proposal.actionBinding.kind === 'DISCARD' ? 'invalid' : proposal.actionBinding.rootBinding.expectedProvider,
      source: 'project-dsh',
      skillName: proposal.name,
      canonicalTargetPath: proposal.actionBinding.kind === 'DISCARD'
        ? 'invalid'
        : proposal.actionBinding.targetBinding.skillFilePath,
      targetIdentityDigest: publication.targetIdentityDigest,
      revisions: [{
        revision: 1,
        origin: 'RUN2SKILL',
        proposalId: proposal.proposalId,
        exactSkillBytes: proposal.exactSkillBytes,
        skillBytesDigest: proposal.skillBytesDigest,
        committedAt: times[2]!,
      }],
    })

    await store.appendEvent(approved.workItemId, 'FACTS_REVALIDATED', {
      expectedHash: proposal.skillBytesDigest,
    })
    await store.appendEvent(approved.workItemId, 'READBACK_CONFIRMED', {
      expectedHash: proposal.skillBytesDigest,
      observedHash: proposal.skillBytesDigest,
    })
    await store.stageLineage(approved.workItemId, lineage)
    domain.failNextWorkItemWrites(1)
    await expect(store.commitLineage(approved.workItemId)).rejects.toThrow('synthetic work item failure')
    expect(domain.lineages.get(lineage.lineageId)).toEqual(lineage)
    expect(domain.workItems.get(approved.workItemId)?.publication?.pendingLineage).toEqual(lineage)

    domain.writeLog.length = 0
    await store.commitLineage(approved.workItemId)
    const completed = await store.complete(approved.workItemId)
    expect(domain.writeLog).toEqual(['work_items', 'global', 'work_items'])
    expect(completed).toMatchObject({
      processingState: 'TERMINAL',
      review: { reviewDecision: 'APPROVED', publicationOutcome: 'PUBLISHED' },
    })
    expect(domain.lineages.get(lineage.lineageId)).toEqual(lineage)
    expect(domain.global.get().recentSkillActivity?.items).toEqual([
      expect.objectContaining({
        skillName: proposal.name,
        operation: 'CREATED',
        scope: 'PROJECT',
      }),
    ])
  })

  it('opens a bounded new attempt only for retryable PUBLISH_FAILED with the same immutable ref', async () => {
    const { domain, approved, now } = await approvedFixture()
    const store = new PublicationSagaStore(domain, now)
    const failed = await store.fail(approved.workItemId, 'PUBLISH_FAILED', 'READBACK_TIMEOUT', true)
    const ref = proposalRefOf(failed.review!.proposal)

    const retried = await store.retry(failed.workItemId, failed.revision, ref)
    expect(retried).toMatchObject({
      processingState: 'PUBLISHING',
      review: { reviewDecision: 'APPROVED', publicationOutcome: 'PENDING_REVIEW' },
      publication: { attemptCount: 2 },
    })
    expect(retried.publication?.journal.at(-1)?.stage).toBe('APPROVAL_COMMITTED')
    await expect(store.retry(retried.workItemId, failed.revision, ref))
      .rejects.toMatchObject({ code: 'PUBLICATION_REVISION_CONFLICT' })
  })

  it('stops after three attempts without changing the approved ProposalRef', async () => {
    const { domain, approved, now } = await approvedFixture()
    const store = new PublicationSagaStore(domain, now)
    const ref = proposalRefOf(approved.review!.proposal)
    let current = approved
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const failed = await store.fail(current.workItemId, 'PUBLISH_FAILED', 'READBACK_TIMEOUT', true)
      expect(proposalRefOf(failed.review!.proposal)).toEqual(ref)
      if (attempt < 3) {
        current = await store.retry(failed.workItemId, failed.revision, ref)
      } else {
        await expect(store.retry(failed.workItemId, failed.revision, ref))
          .rejects.toMatchObject({ code: 'PUBLICATION_RETRY_LIMIT' })
      }
    }
  })

  it('lists only durable in-progress approvals for restart recovery', async () => {
    const { domain, approved, now } = await approvedFixture()
    const store = new PublicationSagaStore(domain, now)
    expect(store.listRecoverable().map(item => item.workItemId)).toEqual([approved.workItemId])

    await store.fail(approved.workItemId, 'NEEDS_REFRESH', 'BASE_CHANGED', false)
    expect(store.listRecoverable()).toEqual([])
    expect(sha256Utf8(approved.review!.proposal.exactSkillBytes)).toBe(approved.review!.proposal.skillBytesDigest)
  })
})
