import { describe, expect, it } from 'vitest'
import { createAttentionRpcHandler } from '../src/adapters/dsh-connection/attention-rpc.js'
import { ProposalReviewStore } from '../src/adapters/dsh-storage/proposal-review-store.js'
import { PublicationSagaStore } from '../src/adapters/dsh-storage/publication-saga-store.js'
import { RuntimeNotices } from '../src/application/capture/runtime-notices.js'
import { proposalRefOf } from '../src/domain/review/index.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { makeCreateProposalSnapshot, makeLearnedWorkItem } from './support/review-fixture.js'

describe('Attention projection RPC', () => {
  it('projects only actionable current-project and USER proposals with stable non-sensitive keys', async () => {
    const domain = createMemoryRun2skillDomain()
    const project = makeLearnedWorkItem()
    domain.workItems.set(project.workItemId, project)
    const staged = await new ProposalReviewStore(domain).stage(
      project.workItemId,
      project.revision,
      makeCreateProposalSnapshot(project),
    )
    const host = createAttentionRpcHandler(() => domain, new RuntimeNotices())

    const first = await host('attention', {
      apiVersion: 1,
      workspaceId: 'workspace-fixture',
      sessionId: 'session-fixture',
    }, new AbortController().signal)
    const second = await host('attention', {
      apiVersion: 1,
      workspaceId: 'workspace-fixture',
      sessionId: 'session-fixture',
    }, new AbortController().signal)

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      ok: true,
      value: {
        apiVersion: 1,
        userCompleteness: 'KNOWN',
        projectCompleteness: 'KNOWN',
        actions: [{
          subjectId: staged.item.workItemId,
          kind: 'REVIEW_PROPOSAL',
          scope: 'PROJECT',
          availableActions: ['APPROVE', 'REJECT'],
        }],
        runtimeWarnings: [],
      },
    })
    const action = (first as { ok: true; value: { actions: Array<Record<string, unknown>> } }).value.actions[0]!
    expect(action.actionKey).toMatch(/^act_[a-f0-9]{64}$/)
    expect(JSON.stringify(action)).not.toMatch(/D:\\|SKILL\.md|session-fixture/)
  })

  it('does not turn publishing, unavailable project scope, or non-actionable health into actions', async () => {
    const host = createAttentionRpcHandler(() => undefined, new RuntimeNotices())
    const result = await host('attention', { apiVersion: 1 }, new AbortController().signal)
    expect(result).toEqual({
      ok: true,
      value: {
        apiVersion: 1,
        userCompleteness: 'UNKNOWN',
        projectCompleteness: 'UNAVAILABLE',
        actions: [],
        runtimeCompleteness: 'KNOWN',
        runtimeWarnings: [],
      },
    })
  })

  it('projects an existing safely retryable publication failure using its durable attempt generation', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeLearnedWorkItem()
    domain.workItems.set(item.workItemId, item)
    const reviews = new ProposalReviewStore(domain)
    const staged = await reviews.stage(item.workItemId, item.revision, makeCreateProposalSnapshot(item))
    const approved = await reviews.approve(
      staged.item.workItemId,
      staged.item.revision,
      proposalRefOf(staged.item.review!.proposal),
    )
    const failed = await new PublicationSagaStore(domain).fail(
      approved.item.workItemId,
      'PUBLISH_FAILED',
      'READBACK_TIMEOUT',
      true,
    )
    const host = createAttentionRpcHandler(() => domain, new RuntimeNotices())

    const result = await host('attention', {
      apiVersion: 1,
      workspaceId: 'workspace-fixture',
    }, new AbortController().signal)

    expect(result).toMatchObject({
      ok: true,
      value: {
        actions: [{
          subjectId: failed.workItemId,
          kind: 'RETRY_PUBLICATION',
          reasonCode: 'READBACK_TIMEOUT',
          availableActions: ['RETRY'],
        }],
      },
    })
    const action = (result as { ok: true; value: { actions: Array<{ actionKey: string }> } }).value.actions[0]!
    expect(action.actionKey).toMatch(/^act_[a-f0-9]{64}$/)
  })

  it('returns only exhausted unsaved warnings for the current session', async () => {
    let now = 1_000
    const notices = new RuntimeNotices({ now: () => now })
    notices.recordUnsaved({
      healthCode: 'WORK_ITEM_WRITE_FAILED',
      sessionId: 'session-a',
      turnEndSeq: 9,
      signalClass: 'EXPLICIT_SAVE',
    })
    notices.recordUnsaved({
      healthCode: 'WORK_ITEM_WRITE_FAILED',
      sessionId: 'session-b',
      turnEndSeq: 10,
      signalClass: 'OTHER_HIGH',
    })
    notices.markUnsavedAttention('session-a', 9)
    now += 1
    const host = createAttentionRpcHandler(() => undefined, notices)
    const result = await host('attention', {
      apiVersion: 1,
      sessionId: 'session-a',
    }, new AbortController().signal)

    expect(result).toMatchObject({
      ok: true,
      value: {
        runtimeWarnings: [{
          kind: 'UNSAVED_SIGNAL',
          signalClass: 'EXPLICIT_SAVE',
          count: 1,
        }],
      },
    })
    expect(JSON.stringify(result)).not.toContain('session-a')
  })
})
