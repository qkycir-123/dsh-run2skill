import { describe, expect, it } from 'vitest'
import { createRecentSkillActivityRpcHandler } from '../src/adapters/dsh-connection/recent-skill-activity-rpc.js'
import { ProposalReviewStore } from '../src/adapters/dsh-storage/proposal-review-store.js'
import { PublicationSagaStore } from '../src/adapters/dsh-storage/publication-saga-store.js'
import { MAX_RECENT_SKILL_ACTIVITIES } from '../src/domain/activity/index.js'
import { materializeLineage } from '../src/domain/publication/index.js'
import { proposalRefOf } from '../src/domain/review/index.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import {
  makeCreateProposalSnapshot,
  makeLearnedWorkItem,
  makeMergeProposalSnapshot,
} from './support/review-fixture.js'

const DAY = 24 * 60 * 60 * 1_000
const NOW = '2026-08-22T12:00:00.000Z'

async function publish(options: {
  readonly turn: number
  readonly occurredAt: string
  readonly kind?: 'CREATE' | 'MERGE'
  readonly workspaceId?: string
  readonly domain?: ReturnType<typeof createMemoryRun2skillDomain>
  readonly failCompleteWorkItemWrites?: number
  readonly failActivityGlobalWrites?: number
}) {
  const domain = options.domain ?? createMemoryRun2skillDomain()
  // Activity ordering is independent of Lineage evolution; isolate each
  // synthetic publication while keeping the shared durable activity index.
  domain.lineages.clear()
  const turnEndSeq = 20 + options.turn
  const item = makeLearnedWorkItem({
    signalKey: {
      rootSessionId: 'session-activity',
      sessionCreatedAt: 100,
      sessionCwdDigest: 'a'.repeat(64),
      turn: options.turn,
      turnEndSeq,
      turnInstanceDigest: options.turn.toString(16).padStart(64, '0'),
      triggerPolicyVersion: 'cheap-trigger-v1',
    },
    workspaceBinding: {
      status: 'BOUND',
      workspaceId: options.workspaceId ?? 'workspace-fixture',
      canonicalPath: 'D:\\workspace',
      observedAt: '2026-08-20T00:00:00.000Z',
    },
  })
  domain.workItems.set(item.workItemId, item)
  const now = () => options.occurredAt
  const reviews = new ProposalReviewStore(domain, now)
  const proposal = options.kind === 'MERGE'
    ? makeMergeProposalSnapshot(item)
    : makeCreateProposalSnapshot(item)
  const staged = await reviews.stage(item.workItemId, item.revision, proposal)
  const approved = await reviews.approve(
    item.workItemId,
    staged.item.revision,
    proposalRefOf(staged.item.review!.proposal),
  )
  const store = new PublicationSagaStore(domain, now)
  await store.appendEvent(item.workItemId, 'FACTS_REVALIDATED')
  await store.appendEvent(item.workItemId, 'READBACK_CONFIRMED', {
    expectedHash: proposal.skillBytesDigest,
    observedHash: proposal.skillBytesDigest,
  })
  const revisions = proposal.kind === 'MERGE' && proposal.actionBinding.kind === 'MERGE'
    ? [{
        revision: 1,
        origin: 'ADOPTED_BASE' as const,
        exactSkillBytes: proposal.actionBinding.baseBinding.exactBytes,
        skillBytesDigest: proposal.actionBinding.baseBinding.bytesDigest,
        committedAt: options.occurredAt,
      }]
    : []
  revisions.push({
    revision: revisions.length + 1,
    origin: 'RUN2SKILL',
    proposalId: proposal.proposalId,
    exactSkillBytes: proposal.exactSkillBytes,
    skillBytesDigest: proposal.skillBytesDigest,
    committedAt: options.occurredAt,
  } as never)
  const binding = proposal.actionBinding
  if (binding.kind === 'DISCARD') throw new Error('unexpected discard')
  await store.stageLineage(item.workItemId, materializeLineage({
    scope: proposal.persistenceScope,
    provider: binding.rootBinding.expectedProvider,
    source: binding.rootBinding.expectedSource,
    skillName: proposal.name,
    canonicalTargetPath: binding.targetBinding.skillFilePath,
    targetIdentityDigest: approved.item.publication!.targetIdentityDigest,
    revisions,
  }))
  await store.commitLineage(item.workItemId)
  if (options.failActivityGlobalWrites !== undefined) {
    domain.failNextGlobalWrites(options.failActivityGlobalWrites)
  }
  if (options.failCompleteWorkItemWrites !== undefined) {
    domain.failNextWorkItemWrites(options.failCompleteWorkItemWrites)
  }
  return { domain, store, item: await store.complete(item.workItemId) }
}

function call(
  domain: ReturnType<typeof createMemoryRun2skillDomain>,
  workspaceId: string | undefined = 'workspace-fixture',
  now = NOW,
  expectedVisibilityRevision?: string,
) {
  const handler = createRecentSkillActivityRpcHandler(
    () => domain,
    async id => id === 'workspace-fixture'
      ? { workspaceId: id, canonicalPath: 'D:\\workspace' }
      : id === 'workspace-other'
        ? { workspaceId: id, canonicalPath: 'D:\\other' }
      : undefined,
    undefined,
    () => now,
  )
  return handler('recent-activity/list', {
    apiVersion: 1,
    ...(expectedVisibilityRevision === undefined ? {} : { expectedVisibilityRevision }),
    currentScope: workspaceId === undefined
      ? { kind: 'USER_ONLY', generation: 1 }
      : { kind: 'WORKSPACE', generation: 1, workspaceId },
  }, new AbortController().signal)
}

describe('recent Skill activity', () => {
  it('enforces the Host visibility revision as a read barrier', async () => {
    const domain = createMemoryRun2skillDomain()
    const initial = await call(domain)
    expect(initial).toMatchObject({ ok: true, value: { visibilityRevision: expect.any(String) } })
    expect(await call(domain, 'workspace-fixture', NOW, `visibility_${'f'.repeat(64)}`)).toMatchObject({
      ok: false,
      error: { code: 'visibility-stale' },
    })
  })

  it('records successful creates and updates durably and returns newest first', async () => {
    const domain = createMemoryRun2skillDomain()
    await publish({ domain, turn: 1, kind: 'CREATE', occurredAt: '2026-08-22T10:00:00.000Z' })
    await publish({ domain, turn: 2, kind: 'MERGE', occurredAt: '2026-08-22T11:00:00.000Z' })

    const result = await call(domain)
    expect(result).toMatchObject({ ok: true, value: { apiVersion: 1, items: [
      { skillName: 'generated-file-hygiene', operation: 'UPDATED', occurredAt: '2026-08-22T11:00:00.000Z' },
      { skillName: 'generated-file-hygiene', operation: 'CREATED', occurredAt: '2026-08-22T10:00:00.000Z' },
    ] } })
    const durable = JSON.stringify(domain.global.get().recentSkillActivity)
    expect(durable).not.toContain('Generated file hygiene')
    expect(durable).not.toContain('D:\\workspace')
    expect(durable).not.toContain('session-activity')
  })

  it('includes the exact seven-day boundary and excludes older records', async () => {
    const domain = createMemoryRun2skillDomain()
    const boundary = new Date(Date.parse(NOW) - 7 * DAY).toISOString()
    await publish({ domain, turn: 3, occurredAt: boundary })
    await publish({ domain, turn: 4, occurredAt: new Date(Date.parse(boundary) - 1).toISOString() })

    const result = await call(domain)
    expect(result).toMatchObject({ ok: true, value: { items: [{ occurredAt: boundary }] } })
  })

  it('does not expose failed, pending, other-project, or purged publication records', async () => {
    const domain = createMemoryRun2skillDomain()
    const published = await publish({ domain, turn: 5, occurredAt: '2026-08-22T11:00:00.000Z' })
    const pending = makeLearnedWorkItem({
      signalKey: {
        ...makeLearnedWorkItem().signalKey,
        rootSessionId: 'pending-session',
        turn: 50,
        turnEndSeq: 70,
        turnInstanceDigest: 'f'.repeat(64),
      },
    })
    domain.workItems.set(pending.workItemId, pending)
    await new ProposalReviewStore(domain, () => '2026-08-22T11:05:00.000Z').stage(
      pending.workItemId,
      pending.revision,
      makeCreateProposalSnapshot(pending),
    )
    expect(domain.global.get().recentSkillActivity?.items).toHaveLength(1)
    const activity = domain.global.get().recentSkillActivity!.items[0]!
    domain.workItems.set(published.item.workItemId, {
      ...published.item,
      processingState: 'NEEDS_ATTENTION',
      review: {
        ...published.item.review!,
        publicationOutcome: 'PUBLISH_FAILED',
        failure: { code: 'FILESYSTEM_WRITE_FAILED', retryable: true, occurredAt: activity.occurredAt },
      },
    })
    expect(await call(domain)).toMatchObject({ ok: true, value: { items: [] } })

    domain.workItems.set(published.item.workItemId, published.item)
    expect(await call(domain, 'workspace-other')).toMatchObject({ ok: true, value: { items: [] } })
    domain.workItems.delete(published.item.workItemId)
    expect(await call(domain)).toMatchObject({ ok: true, value: { items: [] } })
  })

  it('keeps a staged activity hidden until publication commits and reuses it after restart', async () => {
    const domain = createMemoryRun2skillDomain()
    await expect(publish({
      domain,
      turn: 6,
      occurredAt: '2026-08-22T11:30:00.000Z',
      failCompleteWorkItemWrites: 1,
    })).rejects.toThrow('synthetic work item failure')
    expect(domain.global.get().recentSkillActivity?.items).toHaveLength(1)
    expect(await call(domain)).toMatchObject({ ok: true, value: { items: [] } })

    const [workItemId] = [...domain.workItems.keys()]
    const restarted = new PublicationSagaStore(domain, () => '2026-08-22T11:45:00.000Z')
    await restarted.complete(workItemId!)
    expect(domain.global.get().recentSkillActivity?.items).toHaveLength(1)
    expect(await call(domain)).toMatchObject({
      ok: true,
      value: { items: [{ occurredAt: '2026-08-22T11:30:00.000Z' }] },
    })
  })

  it('commits publication and repairs a transiently failed activity index after restart', async () => {
    const { domain, item } = await publish({
      turn: 8,
      occurredAt: '2026-08-22T11:50:00.000Z',
      failActivityGlobalWrites: 2,
    })

    expect(item).toMatchObject({
      processingState: 'TERMINAL',
      review: { publicationOutcome: 'PUBLISHED' },
    })
    expect(domain.global.get().recentSkillActivity?.items).toEqual([])
    // The first restarted reader consumes the remaining synthetic outage without hiding publication success.
    expect(await call(domain)).toMatchObject({ ok: true, value: { items: [] } })
    expect(await call(domain)).toMatchObject({
      ok: true,
      value: { items: [{ skillName: 'generated-file-hygiene', occurredAt: '2026-08-22T11:50:00.000Z' }] },
    })
    expect(domain.global.get().recentSkillActivity?.items).toHaveLength(1)
  })

  it('uses a fresh activity time for a new retry attempt while preserving same-attempt recovery', async () => {
    const domain = createMemoryRun2skillDomain()
    await expect(publish({
      domain,
      turn: 7,
      occurredAt: '2026-08-14T11:30:00.000Z',
      failCompleteWorkItemWrites: 1,
    })).rejects.toThrow('synthetic work item failure')
    const firstActivity = domain.global.get().recentSkillActivity?.items[0]
    expect(firstActivity?.occurredAt).toBe('2026-08-14T11:30:00.000Z')

    const [workItemId] = [...domain.workItems.keys()]
    const retryAt = '2026-08-22T11:45:00.000Z'
    const restarted = new PublicationSagaStore(domain, () => retryAt)
    const failed = await restarted.fail(workItemId!, 'PUBLISH_FAILED', 'WORK_ITEM_COMMIT_FAILED', true)
    const retried = await restarted.retry(
      workItemId!,
      failed.revision,
      proposalRefOf(failed.review!.proposal),
    )
    const proposal = retried.review!.proposal
    await restarted.appendEvent(workItemId!, 'FACTS_REVALIDATED')
    await restarted.appendEvent(workItemId!, 'READBACK_CONFIRMED', {
      expectedHash: proposal.skillBytesDigest,
      observedHash: proposal.skillBytesDigest,
    })
    const lineage = [...domain.lineages.values()][0]
    await restarted.stageLineage(workItemId!, lineage!)
    await restarted.commitLineage(workItemId!)
    await restarted.complete(workItemId!)

    const activities = domain.global.get().recentSkillActivity?.items ?? []
    expect(activities).toHaveLength(1)
    expect(activities[0]).toMatchObject({ occurredAt: retryAt })
    expect(activities[0]?.activityId).not.toBe(firstActivity?.activityId)
    expect(await call(domain, 'workspace-fixture', '2026-08-22T12:00:00.000Z')).toMatchObject({
      ok: true,
      value: { items: [{ occurredAt: retryAt }] },
    })
  })

  it('keeps authoritative successes ahead of more than 256 staged publications that later fail', async () => {
    const domain = createMemoryRun2skillDomain()
    await publish({
      domain,
      turn: 20,
      occurredAt: '2026-08-22T10:00:00.000Z',
    })
    for (let index = 0; index <= MAX_RECENT_SKILL_ACTIVITIES; index += 1) {
      const turn = 1_000 + index
      const occurredAt = new Date(Date.parse('2026-08-22T11:00:00.000Z') + index).toISOString()
      await expect(publish({
        domain,
        turn,
        occurredAt,
        failCompleteWorkItemWrites: 1,
      })).rejects.toThrow('synthetic work item failure')
      const staged = [...domain.workItems.values()].find(item => item.signalKey.turn === turn)!
      await new PublicationSagaStore(domain, () => occurredAt).fail(
        staged.workItemId,
        'PUBLISH_FAILED',
        'WORK_ITEM_COMMIT_FAILED',
        true,
      )
    }

    expect(domain.global.get().recentSkillActivity?.items).toHaveLength(2)
    expect(await call(domain)).toMatchObject({
      ok: true,
      value: { items: [{ skillName: 'generated-file-hygiene', occurredAt: '2026-08-22T10:00:00.000Z' }] },
    })
    expect(domain.global.get().recentSkillActivity?.items).toHaveLength(1)
  })

  it('recovers the same attempt time when 256 authoritative successes leave no staged-index slot', async () => {
    const domain = createMemoryRun2skillDomain()
    for (let index = 0; index < MAX_RECENT_SKILL_ACTIVITIES; index += 1) {
      await publish({
        domain,
        turn: 2_000 + index,
        occurredAt: new Date(Date.parse('2026-08-22T09:00:00.000Z') + index * 1_000).toISOString(),
      })
    }
    expect(domain.global.get().recentSkillActivity?.items).toHaveLength(MAX_RECENT_SKILL_ACTIVITIES)

    const turn = 3_000
    const stagedAt = '2026-08-22T12:00:00.000Z'
    await expect(publish({
      domain,
      turn,
      occurredAt: stagedAt,
      failCompleteWorkItemWrites: 1,
    })).rejects.toThrow('synthetic work item failure')
    const staged = [...domain.workItems.values()].find(item => item.signalKey.turn === turn)!
    expect(domain.global.get().recentSkillActivity?.items).toHaveLength(MAX_RECENT_SKILL_ACTIVITIES)
    expect(domain.global.get().recentSkillActivity?.items.some(item => item.workItemId === staged.workItemId)).toBe(false)

    const recovered = await new PublicationSagaStore(domain, () => '2026-08-22T12:30:00.000Z')
      .complete(staged.workItemId)
    expect(recovered.publication?.journal.find(event => (
      event.attemptId === recovered.publication?.activeAttemptId && event.stage === 'OUTCOME_COMMITTED'
    ))?.occurredAt).toBe(stagedAt)
    expect(await call(domain, 'workspace-fixture', '2026-08-22T13:00:00.000Z')).toMatchObject({
      ok: true,
      value: { items: expect.arrayContaining([expect.objectContaining({ occurredAt: stagedAt })]) },
    })
  }, 30_000)
})
