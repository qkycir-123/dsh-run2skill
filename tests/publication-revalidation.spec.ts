import { describe, expect, it } from 'vitest'
import { ApprovedProposalRevalidator } from '../src/application/publication/index.js'
import { makeLearnedWorkItem } from './support/review-fixture.js'

describe('ApprovedProposalRevalidator', () => {
  it('maps mutable facts to refresh and missing authority to attention without widening approval', async () => {
    const item = makeLearnedWorkItem()
    const changedBuilder = {
      async revalidateApproved() {
        return { status: 'UNAVAILABLE' as const, failureCode: 'TARGET_ALREADY_EXISTS' as const }
      },
    }
    const unavailableBuilder = {
      async revalidateApproved() {
        return { status: 'UNAVAILABLE' as const, failureCode: 'ROOT_OBSERVATION_UNAVAILABLE' as const }
      },
    }

    await expect(new ApprovedProposalRevalidator(
      changedBuilder,
      () => ({}),
    ).revalidate(item)).resolves.toEqual({ status: 'NEEDS_REFRESH', code: 'TARGET_ALREADY_EXISTS' })
    await expect(new ApprovedProposalRevalidator(
      unavailableBuilder,
      () => ({}),
    ).revalidate(item)).resolves.toEqual({
      status: 'NEEDS_ATTENTION', code: 'ROOT_OBSERVATION_UNAVAILABLE',
    })
    await expect(new ApprovedProposalRevalidator(
      changedBuilder,
      () => undefined,
    ).revalidate(item)).resolves.toEqual({
      status: 'PUBLISH_FAILED', code: 'AGENT_SCOPE_UNAVAILABLE', retryable: true,
    })
  })
})
