import { describe, expect, it } from 'vitest'
import {
  V2CurrentScopeAuthorizer,
  deriveV2ActionSubjectId,
} from '../src/adapters/dsh-connection/v2-current-scope-authorizer.js'
import { ProposalLineageV2Schema } from '../src/domain/v2/index.js'
import { deriveProjectScopeIdentityDigest } from '../src/domain/purge/index.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

async function seed() {
  const domain = createMemoryRun2skillV2Domain()
  const fixture = createMinimalV2Fixtures()
  const lineage = ProposalLineageV2Schema.parse({
    ...fixture.nativeActiveProposalLineage,
    proposalRevisions: fixture.nativeActiveProposalLineage.proposalRevisions.map(proposal => ({
      ...proposal,
      projectScopeBinding: {
        workspaceId: 'workspace-v2',
        scopeIdentityDigest: deriveProjectScopeIdentityDigest('D:\\repo'),
      },
    })),
  })
  await domain.table('proposal_lineages').put(
    lineage.lineageId,
    lineage,
  )
  return { domain, fixture: { ...fixture, nativeActiveProposalLineage: lineage } }
}

describe('v2 current-scope Action Queue authorization', () => {
  it('projects one PROJECT Proposal with a stable legacy-compatible subject id', async () => {
    const { domain, fixture } = await seed()
    const authorizer = new V2CurrentScopeAuthorizer(async workspaceId => (
      workspaceId === 'workspace-v2'
        ? { workspaceId, canonicalPath: 'D:\\repo' }
        : undefined
    ))

    const actions = await authorizer.project(domain, {
      kind: 'WORKSPACE', generation: 1, workspaceId: 'workspace-v2',
    })

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      subjectId: deriveV2ActionSubjectId(fixture.nativeActiveProposalLineage.lineageId),
      kind: 'REVIEW_PROPOSAL',
      reasonCode: 'PROPOSAL_READY',
      scope: 'PROJECT',
      availableActions: ['APPROVE', 'REJECT'],
    })
    expect(actions[0]?.proposalRef).toMatchObject({ proposalId: `prop_${'3'.repeat(64)}` })
    expect(await authorizer.authorize(domain, {
      kind: 'WORKSPACE', generation: 1, workspaceId: 'workspace-v2',
    }, actions[0]!, 'APPROVE')).toMatchObject({
      lineage: { lineageId: fixture.nativeActiveProposalLineage.lineageId },
    })
  })

  it('never leaks a PROJECT Proposal into USER_ONLY or another workspace', async () => {
    const { domain } = await seed()
    const authorizer = new V2CurrentScopeAuthorizer(async workspaceId => ({
      workspaceId, canonicalPath: `D:\\${workspaceId}`,
    }))

    await expect(authorizer.project(domain, { kind: 'USER_ONLY', generation: 1 })).resolves.toEqual([])
    await expect(authorizer.project(domain, {
      kind: 'WORKSPACE', generation: 1, workspaceId: 'workspace-other',
    })).resolves.toEqual([])
  })

  it('projects only retryable publication failures as RETRY_PUBLICATION', async () => {
    const { domain, fixture } = await seed()
    const active = ProposalLineageV2Schema.parse(fixture.nativeActiveProposalLineage)
    if (active.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
    const latest = active.proposalRevisions.at(-1)!
    const approved = ProposalLineageV2Schema.parse({
      ...active,
      revision: active.revision + 1,
      proposalRevisions: [{
        ...latest,
        reviewDecision: 'APPROVED',
        reviewedAt: '2026-08-23T00:00:00.000Z',
        reviewReceiptDigest: 'a'.repeat(64),
        reviewCatalog: {
          status: 'CURRENT', runtimeCatalogDigest: 'b'.repeat(64), pendingCatalogDigest: 'c'.repeat(64),
          catalogEpoch: 2, catalogMutationReceiptDigest: 'd'.repeat(64),
        },
        publicationFailureCode: 'PUBLICATION_UNAVAILABLE',
        publicationAttemptedAt: '2026-08-23T00:01:00.000Z',
      }],
      updatedAt: '2026-08-23T00:01:00.000Z',
    })
    if (approved.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
    await domain.table('proposal_lineages').put(approved.lineageId, approved)
    const authorizer = new V2CurrentScopeAuthorizer(async workspaceId => ({
      workspaceId, canonicalPath: 'D:\\repo',
    }))

    const actions = await authorizer.project(domain, {
      kind: 'WORKSPACE', generation: 1, workspaceId: 'workspace-v2',
    })
    expect(actions).toMatchObject([{
      kind: 'RETRY_PUBLICATION', reasonCode: 'PUBLICATION_UNAVAILABLE', availableActions: ['RETRY'],
    }])

    const nonRetryable = ProposalLineageV2Schema.parse({
      ...approved,
      revision: approved.revision + 1,
      proposalRevisions: [{ ...approved.proposalRevisions[0]!, publicationFailureCode: 'PUBLICATION_CONFLICT' }],
    })
    await domain.table('proposal_lineages').put(nonRetryable.lineageId, nonRetryable)
    const refresh = await authorizer.project(domain, {
      kind: 'WORKSPACE', generation: 1, workspaceId: 'workspace-v2',
    })
    expect(refresh).toMatchObject([{
      kind: 'REFRESH_PROPOSAL', reasonCode: 'PUBLICATION_CONFLICT', availableActions: ['REFRESH'],
    }])
  })

  it('keeps an approved Proposal recoverable before its publication journal exists', async () => {
    const { domain, fixture } = await seed()
    const active = ProposalLineageV2Schema.parse(fixture.nativeActiveProposalLineage)
    if (active.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
    const latest = active.proposalRevisions.at(-1)!
    await domain.table('proposal_lineages').put(active.lineageId, ProposalLineageV2Schema.parse({
      ...active,
      revision: active.revision + 1,
      proposalRevisions: [{
        ...latest,
        reviewDecision: 'APPROVED',
        reviewedAt: '2026-08-23T00:00:00.000Z',
        reviewReceiptDigest: 'a'.repeat(64),
        reviewCatalog: {
          status: 'CURRENT', runtimeCatalogDigest: 'b'.repeat(64), pendingCatalogDigest: 'c'.repeat(64),
          catalogEpoch: 2, catalogMutationReceiptDigest: 'd'.repeat(64),
        },
      }],
    }))
    const authorizer = new V2CurrentScopeAuthorizer(async workspaceId => ({
      workspaceId, canonicalPath: 'D:\\repo',
    }))

    await expect(authorizer.project(domain, {
      kind: 'WORKSPACE', generation: 1, workspaceId: 'workspace-v2',
    })).resolves.toMatchObject([{
      kind: 'RETRY_PUBLICATION', reasonCode: 'PUBLICATION_PENDING', availableActions: ['RETRY'],
    }])
  })

  it('rejects a stale action identity after the lineage revision changes', async () => {
    const { domain, fixture } = await seed()
    const authorizer = new V2CurrentScopeAuthorizer(async workspaceId => ({
      workspaceId, canonicalPath: 'D:\\repo',
    }))
    const scope = { kind: 'WORKSPACE' as const, generation: 1, workspaceId: 'workspace-v2' }
    const [action] = await authorizer.project(domain, scope)
    const lineage = ProposalLineageV2Schema.parse(fixture.nativeActiveProposalLineage)
    await domain.table('proposal_lineages').put(lineage.lineageId, ProposalLineageV2Schema.parse({
      ...lineage,
      revision: lineage.revision + 1,
      updatedAt: '2026-08-23T00:02:00.000Z',
    }))

    await expect(authorizer.authorize(domain, scope, action!, 'APPROVE')).rejects.toMatchObject({
      code: 'ACTION_STALE',
    })
  })
})
