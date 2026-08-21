import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProposalReviewRpcHandler } from '../src/adapters/dsh-connection/proposal-review-rpc.js'
import { CurrentScopeAuthorizer } from '../src/adapters/dsh-connection/current-scope-authorizer.js'
import { PurgeVisibility } from '../src/application/purge/index.js'
import { LearningWorkItemStore } from '../src/adapters/dsh-storage/learning-work-item-store.js'
import { ProposalReviewStore } from '../src/adapters/dsh-storage/proposal-review-store.js'
import { PublicationSagaStore } from '../src/adapters/dsh-storage/publication-saga-store.js'
import { RuntimeNotices } from '../src/application/capture/runtime-notices.js'
import { createObserveSummary } from '../src/application/observe-summary.js'
import { proposalRefOf } from '../src/domain/review/index.js'
import {
  deriveProjectPurgeScopeIdentityDigest,
  type ProjectPurgeScopeBindingV1,
} from '../src/domain/purge/index.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { makeCreateProposalSnapshot, makeLearnedWorkItem } from './support/review-fixture.js'
import { makeWorkItem } from './support/work-item-fixture.js'

const NOW = '2026-08-21T00:00:00.000Z'
const PROJECT = join(process.cwd(), '.probe-work', 'purge-visible-project')
const binding: ProjectPurgeScopeBindingV1 = {
  scope: 'PROJECT',
  workspaceId: 'workspace-visible',
  canonicalWorkspacePath: PROJECT,
  workspaceObservedAt: NOW,
  canonicalRootPath: join(PROJECT, '.dsh', 'skills'),
  rootContractVersion: 'stock-dsh-web-default-roots-v1',
  resolverVersion: 'stock-root-resolver-v2',
  resolutionContractDigest: 'a'.repeat(64),
}
const currentScope = { kind: 'WORKSPACE' as const, generation: 1, workspaceId: binding.workspaceId }
const authorizer = new CurrentScopeAuthorizer(async workspaceId => workspaceId === binding.workspaceId
  ? { workspaceId, canonicalPath: PROJECT }
  : undefined)

async function hideProject(domain: ReturnType<typeof createMemoryRun2skillDomain>) {
  await domain.global.set({
    ...domain.global.get(),
    purgeJournal: {
      schemaVersion: 1,
      purgeId: `purge_${'1'.repeat(64)}`,
      scopeBinding: binding,
      hideBefore: NOW,
      candidateDigest: '2'.repeat(64),
      startedAt: NOW,
      phase: 'DELETING_WORK_ITEMS',
      deletedWorkItems: 0,
      deletedLineages: 0,
    },
  })
}

describe('unified Purge visibility predicate', () => {
  it('hides proposal summary/list/detail and rejects review mutations', async () => {
    const domain = createMemoryRun2skillDomain()
    const learned = makeLearnedWorkItem({
      createdAt: '2026-08-20T00:00:00.000Z',
      workspaceBinding: {
        status: 'BOUND', workspaceId: binding.workspaceId, canonicalPath: PROJECT, observedAt: NOW,
      },
    })
    domain.workItems.set(learned.workItemId, learned)
    const staged = await new ProposalReviewStore(domain, () => NOW).stage(
      learned.workItemId,
      learned.revision,
      makeCreateProposalSnapshot(learned),
    )
    const projected = (await authorizer.project(domain, currentScope, new PurgeVisibility(domain)))[0]!
    const action = {
      actionKey: projected.actionKey, subjectId: projected.subjectId,
      kind: projected.kind, proposalRef: projected.proposalRef,
    }
    await hideProject(domain)
    const handler = createProposalReviewRpcHandler(() => domain, undefined, { authorizer })
    const signal = new AbortController().signal

    await expect(handler('summary', { apiVersion: 1, workspaceId: binding.workspaceId }, signal))
      .resolves.toMatchObject({ ok: true, value: { queue: { pendingReview: 0 } } })
    await expect(handler('proposals/list', { apiVersion: 1, currentScope, actions: [] }, signal))
      .resolves.toMatchObject({ ok: true, value: { items: [] } })
    await expect(handler('proposals/get', {
      apiVersion: 1, currentScope, action, proposalId: staged.item.review!.proposal.proposalId,
    }, signal)).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } })
    await expect(handler('proposals/approve', {
      apiVersion: 1,
      currentScope,
      action,
      workItemId: staged.item.workItemId,
      workItemRevision: staged.item.revision,
      proposalRef: proposalRefOf(staged.item.review!.proposal),
    }, signal)).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } })
  })

  it('removes hidden records from learning/publication claims and aggregate summary', async () => {
    const domain = createMemoryRun2skillDomain()
    const captured = makeWorkItem({
      workspaceBinding: {
        status: 'BOUND', workspaceId: binding.workspaceId, canonicalPath: PROJECT, observedAt: NOW,
      },
    })
    domain.workItems.set(captured.workItemId, captured)
    await hideProject(domain)

    const learning = new LearningWorkItemStore(domain, () => NOW)
    expect(learning.listEligible(NOW)).toEqual([])
    await expect(learning.claim(captured.workItemId, captured.revision))
      .rejects.toMatchObject({ code: 'INVALID_LEARNING_STATE' })
    expect(new PublicationSagaStore(domain).listRecoverable()).toEqual([])
    expect(createObserveSummary({
      domain,
      lifecycle: {
        status: 'READY', queueDepth: 0, maxQueueDepth: 0, catchupNeeded: false,
        recoveryLag: false, maxReadFromLatencyMs: 0, peakHeapBytes: 0,
      },
      notices: new RuntimeNotices(),
      compatibility: 'COMPATIBLE',
    }).capturedCount).toBe(0)
  })

  it('reconstructs the same query, mutation, and claim boundary from a completed fence', async () => {
    const domain = createMemoryRun2skillDomain()
    const learned = makeLearnedWorkItem({
      createdAt: '2026-08-20T00:00:00.000Z',
      workspaceBinding: {
        status: 'BOUND', workspaceId: binding.workspaceId, canonicalPath: PROJECT, observedAt: NOW,
      },
    })
    domain.workItems.set(learned.workItemId, learned)
    const staged = await new ProposalReviewStore(domain, () => NOW).stage(
      learned.workItemId,
      learned.revision,
      makeCreateProposalSnapshot(learned),
    )
    const projected = (await authorizer.project(domain, currentScope, new PurgeVisibility(domain)))[0]!
    const action = {
      actionKey: projected.actionKey, subjectId: projected.subjectId,
      kind: projected.kind, proposalRef: projected.proposalRef,
    }
    const scopeIdentityDigest = deriveProjectPurgeScopeIdentityDigest(binding)
    await domain.global.set({
      ...domain.global.get(),
      completedPurgeFences: {
        schemaVersion: 1,
        projects: {
          [scopeIdentityDigest]: {
            schemaVersion: 1,
            scope: 'PROJECT',
            purgeId: `purge_${'1'.repeat(64)}`,
            completedAt: NOW,
            hideBefore: NOW,
            scopeIdentityDigest,
          },
        },
      },
    })
    const handler = createProposalReviewRpcHandler(() => domain, undefined, { authorizer })
    const signal = new AbortController().signal

    await expect(handler('proposals/list', {
      apiVersion: 1, currentScope, actions: [],
    }, signal)).resolves.toMatchObject({ ok: true, value: { items: [] } })
    await expect(handler('proposals/approve', {
      apiVersion: 1,
      currentScope,
      action,
      workItemId: staged.item.workItemId,
      workItemRevision: staged.item.revision,
      proposalRef: proposalRefOf(staged.item.review!.proposal),
    }, signal)).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } })
    expect(new LearningWorkItemStore(domain, () => NOW).listEligible(NOW)).toEqual([])
    expect(new PublicationSagaStore(domain).get(staged.item.workItemId)).toBeUndefined()
  })
})
