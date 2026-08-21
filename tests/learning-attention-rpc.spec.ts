import { describe, expect, it, vi } from 'vitest'
import {
  LEARNING_ISSUES_DISMISS_ENDPOINT,
  LEARNING_ISSUES_LIST_ENDPOINT,
  LEARNING_ISSUES_RETRY_ENDPOINT,
  createLearningAttentionRpcHandler,
} from '../src/adapters/dsh-connection/learning-attention-rpc.js'
import { LearningWorkItemStore } from '../src/adapters/dsh-storage/learning-work-item-store.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { makeWorkItem } from './support/work-item-fixture.js'

function failedItem(overrides: Parameters<typeof makeWorkItem>[0] = {}) {
  return makeWorkItem({
    workspaceBinding: {
      status: 'BOUND', workspaceId: 'workspace-1', canonicalPath: 'D:\\workspace',
      observedAt: '2026-08-20T00:00:00.000Z',
    },
    processingState: 'NEEDS_ATTENTION',
    learning: {
      policyVersion: 'learning-v1', attempt: 1, requestBudgetUsed: 2,
      modelRoute: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      calls: [
        { requestOrdinal: 1, kind: 'PRIMARY', inputTokens: 120, outputTokens: 4096, outcome: 'TRUNCATED' },
        { requestOrdinal: 2, kind: 'TRUNCATION_RECOVERY', inputTokens: 90, outputTokens: 4096, outcome: 'TRUNCATED' },
      ],
      failure: { code: 'MODEL_OUTPUT_TRUNCATED', retryable: true, occurredAt: '2026-08-20T00:00:10.000Z' },
      publicationOutcome: 'NEEDS_ATTENTION',
    },
    ...overrides,
  })
}

describe('learning attention RPC', () => {
  it('lists only safe failure diagnostics for the exact workspace', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = failedItem()
    domain.workItems.set(item.workItemId, item)
    const handler = createLearningAttentionRpcHandler(() => domain)

    const result = await handler(LEARNING_ISSUES_LIST_ENDPOINT, {
      apiVersion: 1, workspaceId: 'workspace-1',
    }, new AbortController().signal)

    expect(result).toEqual({ ok: true, value: {
      apiVersion: 1,
      items: [{
        workItemId: item.workItemId,
        workItemRevision: item.revision,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        failureCode: 'MODEL_OUTPUT_TRUNCATED',
        retryable: true,
        attempt: 1,
        requestBudgetUsed: 2,
        manualRecoveryCount: 0,
        modelRoute: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        calls: [
          { requestOrdinal: 1, kind: 'PRIMARY', inputTokens: 120, outputTokens: 4096, outcome: 'TRUNCATED' },
          { requestOrdinal: 2, kind: 'TRUNCATION_RECOVERY', inputTokens: 90, outputTokens: 4096, outcome: 'TRUNCATED' },
        ],
      }],
    } })
    expect(JSON.stringify(result)).not.toContain('canonicalPath')
    expect(JSON.stringify(result)).not.toContain(item.evidenceRefs[0]?.excerpt)
  })

  it('opens one idempotent recovery, wakes learning once, and excludes the recovered item from attention', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = failedItem()
    domain.workItems.set(item.workItemId, item)
    const wake = vi.fn()
    const handler = createLearningAttentionRpcHandler(() => domain, undefined, { onRetry: wake })
    const request = { apiVersion: 1 as const, workItemId: item.workItemId, workItemRevision: item.revision }

    const first = await handler(LEARNING_ISSUES_RETRY_ENDPOINT, request, new AbortController().signal)
    expect(first).toMatchObject({ ok: true, value: { changed: true, processingState: 'CAPTURED' } })
    const recovered = domain.workItems.get(item.workItemId)
    expect(recovered).toBeDefined()
    await new LearningWorkItemStore(domain).claim(item.workItemId, recovered!.revision)

    const duplicate = await handler(LEARNING_ISSUES_RETRY_ENDPOINT, request, new AbortController().signal)
    expect(duplicate).toMatchObject({ ok: true, value: { changed: false, processingState: 'ANALYZING' } })
    expect(wake).toHaveBeenCalledOnce()
    expect(await handler(LEARNING_ISSUES_LIST_ENDPOINT, {
      apiVersion: 1, workspaceId: 'workspace-1',
    }, new AbortController().signal)).toMatchObject({ ok: true, value: { items: [] } })
  })

  it('requires confirmation, dismisses without deletion, and keeps duplicate dismissal idempotent', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = failedItem({
      learning: {
        policyVersion: 'learning-v1', attempt: 1, requestBudgetUsed: 1,
        calls: [{ requestOrdinal: 1, kind: 'PRIMARY', outcome: 'FAILED' }],
        failure: { code: 'MODEL_USAGE_INVALID', retryable: false, occurredAt: '2026-08-20T00:00:10.000Z' },
        publicationOutcome: 'NEEDS_ATTENTION',
      },
    })
    domain.workItems.set(item.workItemId, item)
    const handler = createLearningAttentionRpcHandler(() => domain)

    expect(await handler(LEARNING_ISSUES_DISMISS_ENDPOINT, {
      apiVersion: 1, workItemId: item.workItemId, workItemRevision: item.revision,
    }, new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    const request = {
      apiVersion: 1 as const, workItemId: item.workItemId,
      workItemRevision: item.revision, confirm: true as const,
    }
    expect(await handler(LEARNING_ISSUES_DISMISS_ENDPOINT, request, new AbortController().signal))
      .toMatchObject({ ok: true, value: { changed: true, processingState: 'DISMISSED' } })
    expect(await handler(LEARNING_ISSUES_DISMISS_ENDPOINT, request, new AbortController().signal))
      .toMatchObject({ ok: true, value: { changed: false, processingState: 'DISMISSED' } })
    expect(domain.workItems.has(item.workItemId)).toBe(true)
  })
})
