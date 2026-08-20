import { describe, expect, it, vi } from 'vitest'
import { ProposalReviewStore } from '../src/adapters/dsh-storage/proposal-review-store.js'
import { PublicationSagaStore } from '../src/adapters/dsh-storage/publication-saga-store.js'
import { PublicationScheduler } from '../src/application/publication/index.js'
import { proposalRefOf } from '../src/domain/review/index.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { makeCreateProposalSnapshot, makeLearnedWorkItem } from './support/review-fixture.js'

describe('PublicationScheduler', () => {
  it('recovers only eligible durable PUBLISHING items and coalesces wakes', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeLearnedWorkItem()
    domain.workItems.set(item.workItemId, item)
    const reviews = new ProposalReviewStore(domain)
    const staged = await reviews.stage(item.workItemId, item.revision, makeCreateProposalSnapshot(item))
    await reviews.approve(item.workItemId, staged.item.revision, proposalRefOf(staged.item.review!.proposal))
    const store = new PublicationSagaStore(domain)
    let eligible = false
    const run = vi.fn(async (workItemId: string) => {
      await store.fail(workItemId, 'NEEDS_ATTENTION', 'SYNTHETIC_STOP', false)
    })
    const scheduler = new PublicationScheduler({
      store,
      worker: { run },
      eligible: () => eligible,
    })

    await scheduler.start()
    expect(run).not.toHaveBeenCalled()
    eligible = true
    scheduler.wake()
    scheduler.wake()
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    await scheduler.dispose()
  })
})
