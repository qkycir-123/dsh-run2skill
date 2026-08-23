import { describe, expect, it } from 'vitest'
import { V2CompatibleProposalPresenter } from '../src/adapters/dsh-connection/v2-proposal-presenter.js'
import { deriveV2ProposalRef } from '../src/application/review/index.js'
import { ProposalLineageV2Schema, SessionBatchV2Schema } from '../src/domain/v2/index.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

function input() {
  const fixture = createMinimalV2Fixtures()
  const lineage = ProposalLineageV2Schema.parse(fixture.nativeActiveProposalLineage)
  if (lineage.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
  return {
    lineage,
    proposal: lineage.proposalRevisions[0]!,
    proposalRef: deriveV2ProposalRef(lineage),
    intent: fixture.proposalReadyIntent,
    batch: SessionBatchV2Schema.parse(fixture.sessionBatch),
  }
}

describe('v2 compatible Proposal presenter', () => {
  it('projects a path-free CREATE detail through the existing UI schema', async () => {
    const value = input()
    const presenter = new V2CompatibleProposalPresenter({
      bindings: {
        resolve: async () => ({
          status: 'READY',
          view: {},
          rootBinding: {
            state: 'ABSENT',
            scope: 'PROJECT',
            expectedProvider: 'filesystem',
            expectedSource: 'project-dsh',
            resolverVersion: 'stock-root-resolver-v2',
            rootContractVersion: 'stock-dsh-web-default-roots-v1',
            resolutionContractDigest: 'a'.repeat(64),
            declaredRootPath: 'D:\\repo\\.dsh\\skills',
            canonicalExistingAncestorPath: 'D:\\repo',
            ancestorIdentityDigest: 'b'.repeat(64),
            missingSegments: ['.dsh', 'skills'],
          },
        }),
      },
      sessionCoordinate: () => ({
        rootSessionId: 'session-v2', sessionCreatedAt: 100, turn: 2, turnEndSeq: 8,
      }),
    })

    const presented = await presenter.present(value)

    expect(presented).toMatchObject({
      proposal: {
        proposalId: value.proposal.proposalId,
        name: value.proposal.body.name,
        exactSkillBytes: value.proposal.body.exactSkillBytes,
        actionBinding: {
          kind: 'CREATE',
          rootBinding: { state: 'ABSENT', scope: 'PROJECT' },
        },
      },
      sessionCoordinate: { rootSessionId: 'session-v2', turnEndSeq: 8 },
      evidenceRefs: [],
      experiences: [],
    })
    expect(JSON.stringify(presented)).not.toMatch(/declaredRootPath|canonicalExistingAncestorPath|D:\\\\repo/u)
  })
})
