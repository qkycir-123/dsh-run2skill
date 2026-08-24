// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createProposalReviewRpcHandler } from '../src/adapters/dsh-connection/proposal-review-rpc.js'
import { ProposalReviewStore } from '../src/adapters/dsh-storage/proposal-review-store.js'
import { ProposalInboxHeaderAction } from '../src/client/proposal-inbox-view.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { makeLearnedWorkItem, makeMergeProposalSnapshot } from './support/review-fixture.js'
import { CurrentScopeAuthorizer } from '../src/adapters/dsh-connection/current-scope-authorizer.js'
import { PurgeVisibility } from '../src/application/purge/index.js'

afterEach(() => { cleanup() })

describe('Proposal Inbox browser accessibility', () => {
  it('supports names, initial focus, nested Escape restoration, live publishing, and outer focus restoration', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeLearnedWorkItem()
    domain.workItems.set(item.workItemId, item)
    const staged = await new ProposalReviewStore(domain).stage(
      item.workItemId,
      item.revision,
      makeMergeProposalSnapshot(item),
    )
    const currentScope = { kind: 'WORKSPACE' as const, generation: 1, workspaceId: 'workspace-fixture' }
    const authorizer = new CurrentScopeAuthorizer(async workspaceId => ({
      workspaceId, canonicalPath: 'D:\\workspace',
    }))
    const actions = (await authorizer.project(domain, currentScope, new PurgeVisibility(domain))).flatMap(action => (
      action.proposalRef === undefined ? [] : [{
        actionKey: action.actionKey, subjectId: action.subjectId,
        kind: action.kind as 'REVIEW_PROPOSAL', proposalRef: action.proposalRef,
      }]
    ))
    const host = createProposalReviewRpcHandler(() => domain, undefined, { authorizer })
    render(createElement(ProposalInboxHeaderAction, {
      workspaceId: 'workspace-fixture',
      callReview: async (endpoint, payload, signal) => await host(endpoint, payload, signal),
      scopeAccess: () => ({ currentScope, actions }),
    }))

    const trigger = await screen.findByRole('button', { name: '1 份技能草稿待处理：1 份待审核' })
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '技能草稿' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const close = screen.getByRole('button', { name: '关闭' })
    await waitFor(() => { expect(document.activeElement).toBe(close) })

    const proposalButton = await screen.findByRole('button', {
      name: new RegExp(`更新已有技能 .* 仅当前项目可用 .* 待审核`),
    })
    fireEvent.click(proposalButton)
    expect(await screen.findByText(`更新已有技能：${staged.item.review!.proposal.name}`)).toBeTruthy()
    expect(screen.getByText('仅当前项目可用')).toBeTruthy()
    expect(screen.getByText('为什么建议保存')).toBeTruthy()
    expect(screen.getByText('参考的对话内容')).toBeTruthy()
    expect(screen.getByText('确认要保存的技能说明')).toBeTruthy()
    expect(screen.getByText('现有技能内容')).toBeTruthy()
    expect(screen.getByText('将发生的内容变化')).toBeTruthy()
    expect(proposalButton.textContent).not.toMatch(/MERGE|PROJECT|USER/)
    const technicalSummary = screen.getByText('技术信息（排查问题时使用）')
    const technicalDetails = technicalSummary.closest('details')
    expect(technicalDetails?.hasAttribute('open')).toBe(false)
    expect(technicalDetails?.textContent).toContain(staged.item.review!.proposal.digest)
    expect(dialog.textContent).not.toMatch(/Workspace|DSH Home|message seq|Evidence|MERGE Base/)
    const reject = screen.getByRole('button', { name: '放弃草稿' })
    reject.focus()
    fireEvent.click(reject)
    const confirmation = screen.getByRole('alertdialog', { name: '确认放弃这份技能草稿？' })
    expect(confirmation.getAttribute('aria-describedby')).toBe('run2skill-reject-description')
    const cancel = screen.getByRole('button', { name: '取消' })
    expect(document.activeElement).toBe(cancel)
    fireEvent.keyDown(cancel, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('alertdialog')).toBeNull() })
    expect(document.activeElement).toBe(reject)

    fireEvent.click(screen.getByRole('button', { name: '确认并保存' }))
    await waitFor(() => { expect(screen.getAllByText('已确认，正在保存')).toHaveLength(2) })
    const live = dialog.querySelector('[aria-live="polite"][aria-atomic="true"]')
    expect(live?.textContent).toContain('已确认，正在保存')

    close.focus()
    fireEvent.keyDown(close, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(document.activeElement).toBe(trigger)
  })
})
