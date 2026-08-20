// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createProposalReviewRpcHandler } from '../src/adapters/dsh-connection/proposal-review-rpc.js'
import { ProposalReviewStore } from '../src/adapters/dsh-storage/proposal-review-store.js'
import { ProposalInboxHeaderAction } from '../src/client/proposal-inbox-view.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { makeCreateProposalSnapshot, makeLearnedWorkItem } from './support/review-fixture.js'

afterEach(() => { cleanup() })

describe('Proposal Inbox browser accessibility', () => {
  it('supports names, initial focus, nested Escape restoration, live publishing, and outer focus restoration', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeLearnedWorkItem()
    domain.workItems.set(item.workItemId, item)
    const staged = await new ProposalReviewStore(domain).stage(
      item.workItemId,
      item.revision,
      makeCreateProposalSnapshot(item),
    )
    const host = createProposalReviewRpcHandler(() => domain)
    render(createElement(ProposalInboxHeaderAction, {
      workspaceId: 'workspace-fixture',
      callReview: async (endpoint, payload, signal) => await host(endpoint, payload, signal),
    }))

    const trigger = await screen.findByRole('button', { name: '1 条 Skill 提案待处理：1 条待审核' })
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Skill Proposal Inbox' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const close = screen.getByRole('button', { name: '关闭' })
    await waitFor(() => { expect(document.activeElement).toBe(close) })

    const proposalButton = await screen.findByRole('button', {
      name: new RegExp(`CREATE .* PROJECT .* 待审核`),
    })
    fireEvent.click(proposalButton)
    await screen.findByText(staged.item.review!.proposal.digest)
    const reject = screen.getByRole('button', { name: '拒绝 Proposal' })
    reject.focus()
    fireEvent.click(reject)
    const confirmation = screen.getByRole('alertdialog', { name: '确认拒绝 Proposal？' })
    expect(confirmation.getAttribute('aria-describedby')).toBe('run2skill-reject-description')
    const cancel = screen.getByRole('button', { name: '取消' })
    expect(document.activeElement).toBe(cancel)
    fireEvent.keyDown(cancel, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('alertdialog')).toBeNull() })
    expect(document.activeElement).toBe(reject)

    fireEvent.click(screen.getByRole('button', { name: '批准并发布' }))
    await waitFor(() => { expect(screen.getAllByText('已批准，正在发布')).toHaveLength(1) })
    const live = dialog.querySelector('[aria-live="polite"][aria-atomic="true"]')
    expect(live?.textContent).toContain('已批准，正在发布')

    close.focus()
    fireEvent.keyDown(close, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(document.activeElement).toBe(trigger)
  })
})
