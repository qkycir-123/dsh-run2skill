import { describe, expect, it } from 'vitest'
import { createAttentionRpcHandler } from '../src/adapters/dsh-connection/attention-rpc.js'
import { ProposalReviewStore } from '../src/adapters/dsh-storage/proposal-review-store.js'
import { PublicationSagaStore } from '../src/adapters/dsh-storage/publication-saga-store.js'
import { RuntimeNotices } from '../src/application/capture/runtime-notices.js'
import { proposalRefOf } from '../src/domain/review/index.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { makeCreateProposalSnapshot, makeLearnedWorkItem } from './support/review-fixture.js'

describe('Attention projection RPC', () => {
  const workspace = async (workspaceId: string) => workspaceId === 'workspace-fixture'
    ? { workspaceId, canonicalPath: 'D:\\workspace' }
    : undefined

  it('projects only actionable current-project and USER proposals with stable non-sensitive keys', async () => {
    const domain = createMemoryRun2skillDomain()
    const project = makeLearnedWorkItem()
    domain.workItems.set(project.workItemId, project)
    const staged = await new ProposalReviewStore(domain).stage(
      project.workItemId,
      project.revision,
      makeCreateProposalSnapshot(project),
    )
    const host = createAttentionRpcHandler(() => domain, new RuntimeNotices(), workspace)

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
          proposalRef: proposalRefOf(staged.item.review!.proposal),
          availableActions: ['APPROVE', 'REJECT'],
        }],
        runtimeWarnings: [],
      },
    })
    const action = (first as { ok: true; value: { actions: Array<Record<string, unknown>> } }).value.actions[0]!
    expect(action.actionKey).toMatch(/^act_[a-f0-9]{64}$/)
    expect(JSON.stringify(action)).not.toMatch(/D:\\|SKILL\.md|session-fixture/)
  })

  it('fails a stale or unregistered PROJECT scope closed instead of returning a KNOWN empty queue', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeLearnedWorkItem()
    domain.workItems.set(item.workItemId, item)
    await new ProposalReviewStore(domain).stage(
      item.workItemId,
      item.revision,
      makeCreateProposalSnapshot(item),
    )
    const host = createAttentionRpcHandler(
      () => domain,
      new RuntimeNotices(),
      async () => undefined,
    )

    const result = await host('attention', {
      apiVersion: 1,
      workspaceId: 'workspace-fixture',
    }, new AbortController().signal)

    expect(result).toMatchObject({
      ok: true,
      value: { projectCompleteness: 'UNKNOWN', actions: [] },
    })
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
    const host = createAttentionRpcHandler(() => domain, new RuntimeNotices(), workspace)

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

  it('projects a real terminal learning failure with retry and dismiss actions from its durable calls', async () => {
    const domain = createMemoryRun2skillDomain()
    const base = makeLearnedWorkItem()
    domain.workItems.set(base.workItemId, {
      ...base,
      processingState: 'NEEDS_ATTENTION',
      learning: {
        policyVersion: 'learning-v1',
        attempt: 1,
        requestBudgetUsed: 2,
        calls: [
          { requestOrdinal: 1, kind: 'PRIMARY', outcome: 'FAILED' },
          { requestOrdinal: 2, kind: 'FORMAT_REPAIR', outcome: 'FAILED' },
        ],
        failure: {
          code: 'MODEL_TERMINAL_FAILURE',
          retryable: true,
          occurredAt: '2026-08-20T00:00:10.000Z',
        },
        publicationOutcome: 'NEEDS_ATTENTION',
      },
    })
    const host = createAttentionRpcHandler(() => domain, new RuntimeNotices(), workspace)

    const result = await host('attention', {
      apiVersion: 1,
      workspaceId: 'workspace-fixture',
    }, new AbortController().signal)

    expect(result).toMatchObject({
      ok: true,
      value: {
        actions: [{
          subjectId: base.workItemId,
          kind: 'RETRY_LEARNING',
          reasonCode: 'MODEL_TERMINAL_FAILURE',
          availableActions: ['RETRY', 'DISMISS'],
        }],
      },
    })
    expect(JSON.stringify(result)).not.toContain('D:\\workspace')
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
