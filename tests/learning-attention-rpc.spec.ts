import { describe, expect, it, vi } from 'vitest'
import {
  LEARNING_ISSUES_DISMISS_ENDPOINT,
  LEARNING_ISSUES_LIST_ENDPOINT,
  LEARNING_ISSUES_RETRY_ENDPOINT,
  createLearningAttentionRpcHandler,
} from '../src/adapters/dsh-connection/learning-attention-rpc.js'
import { LearningWorkItemStore } from '../src/adapters/dsh-storage/learning-work-item-store.js'
import { LearningDiagnosticStore } from '../src/adapters/dsh-storage/learning-diagnostic-store.js'
import { CurrentScopeAuthorizer } from '../src/adapters/dsh-connection/current-scope-authorizer.js'
import { PurgeVisibility } from '../src/application/purge/index.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { createMemoryLearningDiagnosticDomain } from './support/memory-learning-diagnostic-domain.js'
import { makeWorkItem } from './support/work-item-fixture.js'

function failedItem(index = 1, overrides: Parameters<typeof makeWorkItem>[0] = {}) {
  const messageSeq = 10 + index
  const signalKey = {
    ...makeWorkItem().signalKey,
    turn: index,
    turnEndSeq: messageSeq + 1,
    turnInstanceDigest: index.toString(16).padStart(64, '0'),
  }
  return makeWorkItem({
    signalKey,
    createdAt: new Date(Date.parse('2026-08-20T00:00:00.000Z') + index).toISOString(),
    updatedAt: new Date(Date.parse('2026-08-20T00:00:00.000Z') + index).toISOString(),
    workspaceBinding: {
      status: 'BOUND', workspaceId: 'workspace-1', canonicalPath: 'D:\\workspace',
      observedAt: '2026-08-20T00:00:00.000Z',
    },
    triggerHits: [{
      kind: 'EXPLICIT_SAVE', messageSeq,
      ruleId: 'ctv1.explicit-save.zh.save-target', confidence: 'HIGH',
    }],
    evidenceRefs: [{
      source: 'USER_DIRECT', messageSeq, excerpt: '把这个流程保存成 Skill',
      excerptDigest: sha256Utf8('把这个流程保存成 Skill'), redactionKinds: [], truncated: false,
    }],
    processingState: 'NEEDS_ATTENTION',
    learning: {
      policyVersion: 'learning-v1', attempt: 1, requestBudgetUsed: 2,
      modelRoute: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      calls: [
        { requestOrdinal: 1, kind: 'PRIMARY', inputTokens: 120, outputTokens: 4096, outcome: 'ABORTED' },
        { requestOrdinal: 2, kind: 'FORMAT_REPAIR', inputTokens: 90, outputTokens: 4096, outcome: 'ABORTED' },
      ],
      failure: { code: 'MODEL_OUTPUT_LIMIT_EXCEEDED', retryable: true, occurredAt: '2026-08-20T00:00:10.000Z' },
      publicationOutcome: 'NEEDS_ATTENTION',
    },
    ...overrides,
  })
}

describe('learning attention RPC', () => {
  const currentScope = { kind: 'WORKSPACE' as const, generation: 1, workspaceId: 'workspace-1' }
  const authorizer = new CurrentScopeAuthorizer(async workspaceId => workspaceId === 'workspace-1'
    ? { workspaceId, canonicalPath: 'D:\\workspace' }
    : undefined)
  const actionsFor = async (domain: ReturnType<typeof createMemoryRun2skillDomain>) => (
    await authorizer.project(domain, currentScope, new PurgeVisibility(domain))
  ).map(({ actionKey, subjectId, kind, proposalRef }) => ({
    actionKey, subjectId, kind, ...(proposalRef === undefined ? {} : { proposalRef }),
  }))
  const listRequest = async (domain: ReturnType<typeof createMemoryRun2skillDomain>, cursor?: string) => ({
    apiVersion: 1 as const,
    currentScope,
    ...(cursor === undefined ? {} : { cursor }),
  })
  const handlerFor = (
    domain: ReturnType<typeof createMemoryRun2skillDomain>,
    options: Parameters<typeof createLearningAttentionRpcHandler>[2] = {},
  ) => createLearningAttentionRpcHandler(() => domain, undefined, { authorizer, ...options })

  it('lists only safe failure diagnostics for the exact PROJECT workspace', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = failedItem()
    domain.workItems.set(item.workItemId, item)
    const handler = handlerFor(domain)

    const result = await handler(LEARNING_ISSUES_LIST_ENDPOINT, await listRequest(domain), new AbortController().signal)

    expect(result).toEqual({ ok: true, value: {
      apiVersion: 1,
      items: [{
        workItemId: item.workItemId,
        workItemRevision: item.revision,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        failureCode: 'MODEL_OUTPUT_LIMIT_EXCEEDED',
        retryable: true,
        attempt: 1,
        requestBudgetUsed: 2,
        modelRoute: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        calls: item.learning!.calls,
      }],
    } })
    expect(JSON.stringify(result)).not.toContain('canonicalPath')
    expect(JSON.stringify(result)).not.toContain(item.evidenceRefs[0]?.excerpt)
    const action = (await actionsFor(domain))[0]!
    await expect(handler(LEARNING_ISSUES_RETRY_ENDPOINT, {
      apiVersion: 1,
      currentScope: { kind: 'USER_ONLY', generation: 2 },
      action,
      workItemId: item.workItemId,
      workItemRevision: item.revision,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false, error: { code: 'conflict' },
    })
  })

  it('joins a safe durable terminal detail and omits it when the sidecar is unavailable', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = failedItem(2, {
      learning: {
        policyVersion: 'learning-v1', attempt: 1, requestBudgetUsed: 1,
        calls: [{ requestOrdinal: 1, kind: 'PRIMARY', outcome: 'FAILED' }],
        failure: { code: 'MODEL_TERMINAL_FAILURE', retryable: true, occurredAt: '2026-08-20T00:00:10.000Z' },
        publicationOutcome: 'NEEDS_ATTENTION',
      },
    })
    domain.workItems.set(item.workItemId, item)
    const diagnostics = new LearningDiagnosticStore(domain, createMemoryLearningDiagnosticDomain())
    await diagnostics.attach(item, 1, 'MODEL_USAGE_INVALID')
    const request = await listRequest(domain)

    const joined = await handlerFor(domain, {
      diagnostics: () => diagnostics,
    })(LEARNING_ISSUES_LIST_ENDPOINT, request, new AbortController().signal)
    expect(joined).toMatchObject({ ok: true, value: { items: [{ failureDetail: 'MODEL_USAGE_INVALID' }] } })

    const generic = await handlerFor(domain)(
      LEARNING_ISSUES_LIST_ENDPOINT, request, new AbortController().signal,
    )
    expect(JSON.stringify(generic)).not.toContain('failureDetail')
  })

  it('makes USER failures globally visible for BOUND, UNREGISTERED, and NO_CWD captures', async () => {
    const domain = createMemoryRun2skillDomain()
    const bindings = [
      { status: 'BOUND' as const, workspaceId: 'workspace-other', canonicalPath: 'D:\\other', observedAt: '2026-08-20T00:00:00.000Z' },
      { status: 'UNREGISTERED' as const, observedAt: '2026-08-20T00:00:00.000Z' },
      { status: 'NO_CWD' as const, observedAt: '2026-08-20T00:00:00.000Z' },
    ]
    for (const [offset, workspaceBinding] of bindings.entries()) {
      const item = failedItem(10 + offset, { workspaceBinding })
      const excerpt = '把这个流程保存为所有项目都能使用的 Skill'
      const user = makeWorkItem({
        ...item,
        evidenceRefs: item.evidenceRefs.map(evidence => ({
          ...evidence, excerpt, excerptDigest: sha256Utf8(excerpt),
        })),
      })
      domain.workItems.set(user.workItemId, user)
    }
    const projectOther = failedItem(20, {
      workspaceBinding: {
        status: 'BOUND', workspaceId: 'workspace-other', canonicalPath: 'D:\\other',
        observedAt: '2026-08-20T00:00:00.000Z',
      },
    })
    domain.workItems.set(projectOther.workItemId, projectOther)

    const result = await handlerFor(domain)(LEARNING_ISSUES_LIST_ENDPOINT,
      await listRequest(domain), new AbortController().signal)

    expect(result).toMatchObject({ ok: true, value: { items: expect.any(Array) } })
    if (!result.ok) throw new Error('expected learning issues list')
    const value = result.value as { items: Array<{ workItemId: string }> }
    expect(value.items).toHaveLength(3)
    expect(value.items.map(entry => entry.workItemId))
      .not.toContain(projectOther.workItemId)
  })

  it('paginates every failure with canonical cursors and rejects malformed or out-of-range cursors', async () => {
    const domain = createMemoryRun2skillDomain()
    for (let index = 1; index <= 25; index += 1) {
      const item = failedItem(index)
      domain.workItems.set(item.workItemId, item)
    }
    const handler = handlerFor(domain)
    const signal = new AbortController().signal
    const first = await handler(LEARNING_ISSUES_LIST_ENDPOINT, await listRequest(domain), signal)
    expect(Buffer.byteLength(JSON.stringify(await listRequest(domain)), 'utf8')).toBeLessThan(8 * 1024)
    expect(first).toMatchObject({ ok: true, value: { items: { length: 20 } } })
    if (!first.ok) throw new Error('expected first page')
    const firstValue = first.value as {
      items: Array<{ workItemId: string }>
      nextCursor: string
    }
    expect(firstValue.nextCursor).toMatch(/^c_20_1_[a-f0-9]{64}$/)
    const second = await handler(LEARNING_ISSUES_LIST_ENDPOINT,
      await listRequest(domain, firstValue.nextCursor), signal)
    expect(second).toMatchObject({ ok: true, value: { items: { length: 5 } } })
    if (!second.ok) throw new Error('expected second page')
    const secondValue = second.value as { items: Array<{ workItemId: string }> }
    expect(secondValue).not.toHaveProperty('nextCursor')
    expect(new Set([...firstValue.items, ...secondValue.items].map(entry => entry.workItemId)).size).toBe(25)

    await expect(handler(LEARNING_ISSUES_LIST_ENDPOINT, {
      ...await listRequest(domain, firstValue.nextCursor),
      currentScope: { ...currentScope, generation: 2 },
    }, signal)).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } })
    await expect(handler(LEARNING_ISSUES_LIST_ENDPOINT, {
      ...await listRequest(domain, firstValue.nextCursor),
      currentScope: { ...currentScope, workspaceId: 'other-workspace' },
    }, signal)).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } })

    const changed = failedItem(30)
    domain.workItems.set(changed.workItemId, changed)
    await expect(handler(LEARNING_ISSUES_LIST_ENDPOINT,
      await listRequest(domain, firstValue.nextCursor), signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'conflict' } })

    for (const cursor of ['c_0', 'c_020', 'c_25', 'c_999999999999999999999999999999']) {
      await expect(handler(LEARNING_ISSUES_LIST_ENDPOINT, {
        ...await listRequest(domain), cursor,
      }, signal)).resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
    }
  })

  it('opens one durable manual authorization and wakes learning once', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = failedItem(1, {
      learning: {
        policyVersion: 'learning-v1', attempt: 1, requestBudgetUsed: 2,
        calls: [
          { requestOrdinal: 1, kind: 'PRIMARY', outcome: 'FAILED' },
          { requestOrdinal: 2, kind: 'FORMAT_REPAIR', outcome: 'FAILED' },
        ],
        failure: { code: 'MODEL_TERMINAL_FAILURE', retryable: true, occurredAt: '2026-08-20T00:00:10.000Z' },
        publicationOutcome: 'NEEDS_ATTENTION',
      },
    })
    domain.workItems.set(item.workItemId, item)
    const wake = vi.fn()
    const handler = handlerFor(domain, { onRetry: wake })
    const action = (await actionsFor(domain))[0]!
    const request = {
      apiVersion: 1 as const, currentScope, action,
      workItemId: item.workItemId, workItemRevision: item.revision,
    }

    const first = await handler(LEARNING_ISSUES_RETRY_ENDPOINT, request, new AbortController().signal)
    expect(first).toMatchObject({ ok: true, value: { changed: true, processingState: 'CAPTURED' } })
    expect(domain.workItems.get(item.workItemId)).toMatchObject({
      processingState: 'CAPTURED',
      learning: {
        attempt: 2, requestBudgetUsed: 0, calls: [], failure: item.learning!.failure,
        nextEligibleAt: '1970-01-01T00:00:00.001Z',
      },
    })
    const authorized = domain.workItems.get(item.workItemId)!
    await new LearningWorkItemStore(domain).claim(item.workItemId, authorized.revision)
    const duplicate = await handler(LEARNING_ISSUES_RETRY_ENDPOINT, request, new AbortController().signal)
    expect(duplicate).toMatchObject({ ok: false, error: { code: 'conflict' } })
    expect(wake).toHaveBeenCalledOnce()
  })

  it('requires confirmation and durably hides one ignored failure without deleting it', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = failedItem()
    domain.workItems.set(item.workItemId, item)
    const handler = handlerFor(domain)
    const action = (await actionsFor(domain))[0]!
    expect(await handler(LEARNING_ISSUES_DISMISS_ENDPOINT, {
      apiVersion: 1, currentScope, action, workItemId: item.workItemId, workItemRevision: item.revision,
    }, new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    const request = {
      apiVersion: 1 as const, currentScope, action, workItemId: item.workItemId,
      workItemRevision: item.revision, confirm: true as const,
    }
    expect(await handler(LEARNING_ISSUES_DISMISS_ENDPOINT, request, new AbortController().signal))
      .toMatchObject({ ok: true, value: { changed: true, processingState: 'NEEDS_ATTENTION', disposition: 'IGNORED' } })
    const ignored = domain.workItems.get(item.workItemId)!
    expect(await handler(LEARNING_ISSUES_DISMISS_ENDPOINT, request, new AbortController().signal))
      .toMatchObject({ ok: false, error: { code: 'conflict' } })
    expect(await handler(LEARNING_ISSUES_DISMISS_ENDPOINT, {
      ...request, workItemRevision: ignored.revision,
    }, new AbortController().signal))
      .toMatchObject({ ok: false, error: { code: 'conflict' } })
    expect(await handler(LEARNING_ISSUES_RETRY_ENDPOINT, {
      apiVersion: 1, currentScope, action, workItemId: item.workItemId, workItemRevision: ignored.revision,
    }, new AbortController().signal))
      .toMatchObject({ ok: false, error: { code: 'conflict' } })
    expect(domain.workItems.has(item.workItemId)).toBe(true)
    expect(await handler(LEARNING_ISSUES_LIST_ENDPOINT, {
      apiVersion: 1, currentScope,
    }, new AbortController().signal)).toMatchObject({ ok: true, value: { items: [] } })
  })
})
