import { describe, expect, it, vi } from 'vitest'
import {
  COVERAGE_CONFIRM_DISCARD_ENDPOINT,
  PROPOSALS_APPROVE_ENDPOINT,
  PROPOSALS_GET_ENDPOINT,
  PROPOSALS_LIST_ENDPOINT,
  PROPOSALS_REJECT_ENDPOINT,
  PROPOSALS_RETRY_ENDPOINT,
  PROPOSAL_SUMMARY_ENDPOINT,
  createProposalReviewRpcHandler,
} from '../src/adapters/dsh-connection/proposal-review-rpc.js'
import { ProposalReviewStore } from '../src/adapters/dsh-storage/proposal-review-store.js'
import { PublicationSagaStore } from '../src/adapters/dsh-storage/publication-saga-store.js'
import { CurrentScopeAuthorizer } from '../src/adapters/dsh-connection/current-scope-authorizer.js'
import { PurgeVisibility } from '../src/application/purge/index.js'
import { deriveExperienceId, deriveLearningProposalId } from '../src/domain/learn/index.js'
import { CaptureWorkItemV1Schema, type CaptureWorkItemV1 } from '../src/domain/observe/schemas.js'
import { materializeProposalSnapshot, proposalRefOf } from '../src/domain/review/index.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import {
  makeCreateProposalSnapshot,
  makeDiscardProposalSnapshot,
  makeLearnedWorkItem,
} from './support/review-fixture.js'

function nextItem(turn: number, marker: string, workspaceId = 'workspace-fixture') {
  const base = makeLearnedWorkItem()
  return makeLearnedWorkItem({
    signalKey: {
      ...base.signalKey,
      turn,
      turnEndSeq: 10 + turn,
      turnInstanceDigest: marker.repeat(64),
    },
    workspaceBinding: {
      status: 'BOUND',
      workspaceId,
      canonicalPath: workspaceId === 'workspace-fixture' ? 'D:\\workspace' : 'D:\\other-workspace',
      observedAt: '2026-08-20T00:00:00.000Z',
    },
  })
}

function asUserItem(item: CaptureWorkItemV1): CaptureWorkItemV1 {
  const experiences = item.learning!.experiences!.map((experience) => {
    const facts = {
      type: experience.type,
      lesson: experience.lesson,
      persistenceScope: 'USER' as const,
      evidenceStrength: experience.evidenceStrength,
      supportingEvidence: experience.supportingEvidence,
      ...(experience.contextSummary === undefined ? {} : { contextSummary: experience.contextSummary }),
    }
    return { experienceId: deriveExperienceId(item.workItemId, facts), ...facts }
  })
  const previous = item.learning!.proposal!
  const facts = {
    policyVersion: previous.policyVersion,
    name: previous.name,
    description: previous.description,
    whenToUse: previous.whenToUse,
    content: previous.content,
    invocation: previous.invocation,
    persistenceScope: 'USER' as const,
    supportingExperienceIds: experiences.map(experience => experience.experienceId),
    curation: previous.curation,
    catalogObservationDigest: previous.catalogObservationDigest,
    shortlistDigests: previous.shortlistDigests,
  }
  return CaptureWorkItemV1Schema.parse({
    ...item,
    learning: {
      ...item.learning!,
      experiences,
      proposal: { learningProposalId: deriveLearningProposalId(item.workItemId, facts), ...facts },
    },
  })
}

function userDiscardSnapshot(item: CaptureWorkItemV1) {
  const project = makeDiscardProposalSnapshot(item)
  const { proposalId: _proposalId, digest: _digest, workspaceBinding: _workspace, ...facts } = project
  return materializeProposalSnapshot(item.workItemId, {
    ...facts,
    persistenceScope: 'USER',
  })
}

const currentScope = { kind: 'WORKSPACE' as const, generation: 1, workspaceId: 'workspace-fixture' }
const authorizer = new CurrentScopeAuthorizer(async workspaceId => ({
  workspaceId,
  canonicalPath: workspaceId === 'workspace-fixture' ? 'D:\\workspace' : 'D:\\other-workspace',
}))
async function actionsFor(domain: ReturnType<typeof createMemoryRun2skillDomain>) {
  return (await authorizer.project(domain, currentScope, new PurgeVisibility(domain))).map(
    ({ actionKey, subjectId, kind, proposalRef }) => ({
      actionKey, subjectId, kind, ...(proposalRef === undefined ? {} : { proposalRef }),
    }),
  )
}
function securedHandler(
  domain: ReturnType<typeof createMemoryRun2skillDomain>,
  options: Parameters<typeof createProposalReviewRpcHandler>[2] = {},
) {
  return createProposalReviewRpcHandler(() => domain, undefined, { authorizer, ...options })
}

describe('Proposal Review RPC', () => {
  it('lists only the current PROJECT queue and returns immutable detail lazily', async () => {
    const domain = createMemoryRun2skillDomain()
    const current = nextItem(2, 'd')
    const other = nextItem(3, 'e', 'other-workspace')
    const user = asUserItem(nextItem(4, 'f'))
    domain.workItems.set(current.workItemId, current)
    domain.workItems.set(other.workItemId, other)
    domain.workItems.set(user.workItemId, user)
    const store = new ProposalReviewStore(domain)
    const currentProposal = makeCreateProposalSnapshot(current)
    const otherProposal = makeCreateProposalSnapshot(other)
    await store.stage(current.workItemId, current.revision, currentProposal)
    await store.stage(other.workItemId, other.revision, otherProposal)
    const userProposal = userDiscardSnapshot(user)
    await store.stage(user.workItemId, user.revision, userProposal)
    const handler = securedHandler(domain)
    const actions = await actionsFor(domain)

    const listed = await handler(PROPOSALS_LIST_ENDPOINT, {
      apiVersion: 1, currentScope,
    }, new AbortController().signal)
    expect(listed).toMatchObject({
      ok: true,
      value: { apiVersion: 1 },
    })
    const listedItems = (listed as {
      value?: { items?: Array<{ proposalRef: { proposalId: string } }> }
    }).value?.items ?? []
    expect(listedItems.map(item => item.proposalRef.proposalId).sort()).toEqual([
      currentProposal.proposalId, userProposal.proposalId,
    ].sort())
    await expect(handler(PROPOSAL_SUMMARY_ENDPOINT, {
      apiVersion: 1, workspaceId: 'workspace-fixture',
    }, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: {
        apiVersion: 1,
        status: 'READY',
        recoveryLag: false,
        queue: { completeness: 'KNOWN', pendingReview: 2, publishing: 0, needsAttention: 0 },
      },
    })
    const degradedHandler = createProposalReviewRpcHandler(
      () => domain,
      () => ({ status: 'DEGRADED', recoveryLag: true, lastHealthCode: 'STORAGE_UNAVAILABLE' }),
    )
    await expect(degradedHandler(PROPOSAL_SUMMARY_ENDPOINT, {
      apiVersion: 1, workspaceId: 'workspace-fixture',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: { status: 'DEGRADED', recoveryLag: true, lastHealthCode: 'STORAGE_UNAVAILABLE' },
    })
    expect(JSON.stringify(listed)).not.toContain('exactSkillBytes')

    const detail = await handler(PROPOSALS_GET_ENDPOINT, {
      apiVersion: 1, currentScope,
      action: actions.find(action => action.subjectId === current.workItemId),
      proposalId: currentProposal.proposalId,
    }, new AbortController().signal)
    expect(detail).toMatchObject({
      ok: true,
      value: {
        workItemId: current.workItemId,
        sessionCoordinate: {
          rootSessionId: current.signalKey.rootSessionId,
          sessionCreatedAt: current.signalKey.sessionCreatedAt,
          turn: current.signalKey.turn,
          turnEndSeq: current.signalKey.turnEndSeq,
        },
        proposal: { proposalId: currentProposal.proposalId, exactSkillBytes: currentProposal.exactSkillBytes },
      },
    })
    expect(JSON.stringify(detail)).not.toMatch(/canonicalPath|declaredRootPath|bundlePath|skillFilePath|"path"/)

    const otherScope = { kind: 'WORKSPACE' as const, generation: 2, workspaceId: 'other-workspace' }
    const otherAction = (await authorizer.project(
      domain, otherScope, new PurgeVisibility(domain),
    )).map(({ actionKey, subjectId, kind, proposalRef }) => ({
      actionKey, subjectId, kind, ...(proposalRef === undefined ? {} : { proposalRef }),
    }))[0]!
    await expect(handler(PROPOSALS_GET_ENDPOINT, {
      apiVersion: 1,
      currentScope,
      action: otherAction,
      proposalId: otherProposal.proposalId,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false, error: { code: 'conflict' },
    })
    await expect(handler(PROPOSALS_GET_ENDPOINT, {
      apiVersion: 1,
      currentScope: { kind: 'USER_ONLY', generation: 3 },
      action: actions.find(action => action.subjectId === current.workItemId),
      proposalId: currentProposal.proposalId,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false, error: { code: 'conflict' },
    })
  })

  it('paginates 22 authoritative Proposal actions without returning the Attention queue in the request', async () => {
    const domain = createMemoryRun2skillDomain()
    for (let index = 1; index <= 22; index += 1) {
      const item = nextItem(100 + index, (index % 16).toString(16))
      domain.workItems.set(item.workItemId, item)
      await new ProposalReviewStore(domain).stage(
        item.workItemId, item.revision, makeCreateProposalSnapshot(item),
      )
    }
    const handler = securedHandler(domain)
    const firstRequest = { apiVersion: 1 as const, currentScope, limit: 20 }
    expect(Buffer.byteLength(JSON.stringify(firstRequest), 'utf8')).toBeLessThan(8 * 1024)
    const first = await handler(PROPOSALS_LIST_ENDPOINT, firstRequest, new AbortController().signal)
    expect(first).toMatchObject({ ok: true, value: { items: { length: 20 } } })
    if (!first.ok) throw new Error('expected first Proposal page')
    const firstValue = first.value as { items: Array<{ workItemId: string }>; nextCursor: string }
    expect(firstValue.nextCursor).toMatch(/^c_20_1_[a-f0-9]{64}$/)
    const second = await handler(PROPOSALS_LIST_ENDPOINT, {
      ...firstRequest, cursor: firstValue.nextCursor,
    }, new AbortController().signal)
    expect(second).toMatchObject({ ok: true, value: { items: { length: 2 } } })
    if (!second.ok) throw new Error('expected second Proposal page')
    const secondValue = second.value as { items: Array<{ workItemId: string }> }
    expect(new Set([...firstValue.items, ...secondValue.items].map(item => item.workItemId)).size).toBe(22)

    await expect(handler(PROPOSALS_LIST_ENDPOINT, {
      ...firstRequest,
      currentScope: { ...currentScope, generation: 2 },
      cursor: firstValue.nextCursor,
    }, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } })
    await expect(handler(PROPOSALS_LIST_ENDPOINT, {
      ...firstRequest,
      currentScope: { ...currentScope, workspaceId: 'other-workspace' },
      cursor: firstValue.nextCursor,
    }, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } })

    const added = nextItem(200, 'f')
    domain.workItems.set(added.workItemId, added)
    await new ProposalReviewStore(domain).stage(
      added.workItemId, added.revision, makeCreateProposalSnapshot(added),
    )
    await expect(handler(PROPOSALS_LIST_ENDPOINT, {
      ...firstRequest, cursor: firstValue.nextCursor,
    }, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } })
  })

  it('returns Host health with explicitly unknown queue counts while durable state is unavailable', async () => {
    const getDomain = vi.fn(() => undefined)
    const readHealth = vi.fn(() => ({
      status: 'RECOVERING' as const,
      recoveryLag: true,
      lastHealthCode: 'STORAGE_RECOVERING',
    }))
    const handler = createProposalReviewRpcHandler(getDomain, readHealth)

    await expect(handler(PROPOSAL_SUMMARY_ENDPOINT, {
      apiVersion: 1, workspaceId: 'workspace-fixture',
    }, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: {
        apiVersion: 1,
        status: 'RECOVERING',
        recoveryLag: true,
        lastHealthCode: 'STORAGE_RECOVERING',
        queue: { completeness: 'UNKNOWN' },
      },
    })
    expect(readHealth).toHaveBeenCalledTimes(1)
    expect(getDomain).toHaveBeenCalledTimes(1)
  })

  it('applies approve idempotently and rejects stale or malformed mutations', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeLearnedWorkItem()
    domain.workItems.set(item.workItemId, item)
    const staged = await new ProposalReviewStore(domain).stage(
      item.workItemId, item.revision, makeCreateProposalSnapshot(item),
    )
    const ref = proposalRefOf(staged.item.review!.proposal)
    const action = (await actionsFor(domain))[0]!
    const request = {
      apiVersion: 1 as const,
      currentScope,
      action,
      workItemId: item.workItemId,
      workItemRevision: staged.item.revision,
      proposalRef: ref,
    }
    const onPublicationRequested = vi.fn()
    const handler = createProposalReviewRpcHandler(
      () => domain,
      undefined,
      { authorizer, onPublicationRequested },
    )

    const approved = await handler(PROPOSALS_APPROVE_ENDPOINT, request, new AbortController().signal)
    expect(approved).toMatchObject({
      ok: true,
      value: { changed: true, processingState: 'PUBLISHING', reviewDecision: 'APPROVED' },
    })
    expect(onPublicationRequested).toHaveBeenCalledWith(item.workItemId)
    await expect(handler(PROPOSALS_APPROVE_ENDPOINT, request, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'conflict' } })

    for (const payload of [
      { ...request, unknown: true },
      { ...request, proposalRef: { ...ref, digest: 'f'.repeat(64) } },
      { ...request, workItemId: 'not-an-id' },
    ]) {
      await expect(handler(PROPOSALS_APPROVE_ENDPOINT, payload, new AbortController().signal))
        .resolves.toMatchObject({ ok: false, error: { code: expect.stringMatching(/bad-request|conflict/) } })
    }
  })

  it('retries only a retryable failed publication and wakes the durable saga', async () => {
    const domain = createMemoryRun2skillDomain()
    const item = makeLearnedWorkItem()
    domain.workItems.set(item.workItemId, item)
    const reviews = new ProposalReviewStore(domain)
    const staged = await reviews.stage(item.workItemId, item.revision, makeCreateProposalSnapshot(item))
    const approved = await reviews.approve(
      item.workItemId,
      staged.item.revision,
      proposalRefOf(staged.item.review!.proposal),
    )
    const publication = new PublicationSagaStore(domain)
    const failed = await publication.fail(
      item.workItemId,
      'PUBLISH_FAILED',
      'READBACK_TIMEOUT',
      true,
    )
    const wake = vi.fn()
    const handler = createProposalReviewRpcHandler(() => domain, undefined, {
      authorizer,
      onPublicationRequested: wake,
    })
    const action = (await actionsFor(domain))[0]!

    const retryRequest = {
      apiVersion: 1,
      currentScope,
      action,
      workItemId: failed.workItemId,
      workItemRevision: failed.revision,
      proposalRef: proposalRefOf(failed.review!.proposal),
    }
    await expect(handler(PROPOSALS_RETRY_ENDPOINT, retryRequest, new AbortController().signal))
      .resolves.toMatchObject({
      ok: true,
      value: { changed: true, processingState: 'PUBLISHING', publicationOutcome: 'PENDING_REVIEW' },
    })
    await expect(handler(PROPOSALS_RETRY_ENDPOINT, retryRequest, new AbortController().signal))
      .resolves.toMatchObject({
        ok: false, error: { code: 'conflict' },
      })
    expect(wake).toHaveBeenCalledWith(item.workItemId)
    expect(wake).toHaveBeenCalledTimes(1)
    expect(domain.workItems.get(item.workItemId)?.publication?.attemptCount).toBe(2)
    expect(approved.item.review?.reviewDecision).toBe('APPROVED')
  })

  it('requires reject confirmation and supports DISCARD confirm or one retry', async () => {
    const domain = createMemoryRun2skillDomain()
    const rejectItem = nextItem(4, 'a')
    const discardItem = nextItem(5, 'b')
    domain.workItems.set(rejectItem.workItemId, rejectItem)
    domain.workItems.set(discardItem.workItemId, discardItem)
    const store = new ProposalReviewStore(domain)
    const rejectStaged = await store.stage(
      rejectItem.workItemId, rejectItem.revision, makeCreateProposalSnapshot(rejectItem),
    )
    const discardStaged = await store.stage(
      discardItem.workItemId, discardItem.revision, makeDiscardProposalSnapshot(discardItem),
    )
    const handler = securedHandler(domain)
    const actions = await actionsFor(domain)
    const mutation = (item: typeof rejectStaged.item) => ({
      apiVersion: 1 as const,
      currentScope,
      action: actions.find(action => action.subjectId === item.workItemId),
      workItemId: item.workItemId,
      workItemRevision: item.revision,
      proposalRef: proposalRefOf(item.review!.proposal),
    })

    await expect(handler(PROPOSALS_REJECT_ENDPOINT, {
      ...mutation(rejectStaged.item), confirm: false,
    }, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
    await expect(handler(PROPOSALS_REJECT_ENDPOINT, {
      ...mutation(rejectStaged.item), confirm: true,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: true, value: { publicationOutcome: 'DISCARDED', reviewDecision: 'REJECTED' },
    })

    await expect(handler(COVERAGE_CONFIRM_DISCARD_ENDPOINT, mutation(discardStaged.item), new AbortController().signal))
      .resolves.toMatchObject({ ok: true, value: { publicationOutcome: 'DISCARDED' } })

    const retryDomain = createMemoryRun2skillDomain()
    retryDomain.workItems.set(discardItem.workItemId, discardItem)
    const retryStaged = await new ProposalReviewStore(retryDomain).stage(
      discardItem.workItemId, discardItem.revision, makeDiscardProposalSnapshot(discardItem),
    )
    const retryActions = await actionsFor(retryDomain)
    await expect(securedHandler(retryDomain)(
      PROPOSALS_RETRY_ENDPOINT,
      {
        ...mutation(retryStaged.item),
        action: retryActions.find(action => action.subjectId === retryStaged.item.workItemId),
      },
      new AbortController().signal,
    )).resolves.toMatchObject({
      ok: true, value: { changed: true, processingState: 'NEEDS_ATTENTION' },
    })
  })

  it('rejects invalid cursors, oversized payloads and cancellation before reading durable state', async () => {
    const getDomain = vi.fn(() => createMemoryRun2skillDomain())
    const handler = createProposalReviewRpcHandler(getDomain, undefined, { authorizer })
    await expect(handler(PROPOSALS_LIST_ENDPOINT, {
      apiVersion: 1, currentScope, cursor: 'invalid',
    }, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
    await expect(handler(PROPOSALS_LIST_ENDPOINT, {
      apiVersion: 1, currentScope: { kind: 'WORKSPACE', generation: 1, workspaceId: 'x'.repeat(9_000) },
    }, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
    const aborted = new AbortController()
    aborted.abort()
    await expect(handler(PROPOSALS_LIST_ENDPOINT, {
      apiVersion: 1, currentScope,
    }, aborted.signal)).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(getDomain).not.toHaveBeenCalled()
  })
})
