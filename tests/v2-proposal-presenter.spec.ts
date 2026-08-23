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
    observation: fixture.turnObservation,
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
      observation: observationId => observationId === value.observation.observationId
        ? value.observation
        : undefined,
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
      evidenceRefs: value.observation.directUserEvidence,
      experiences: [{
        experienceId: expect.stringMatching(/^exp_[a-f0-9]{64}$/),
        type: value.intent.experienceType,
        lesson: value.intent.applicabilitySummary,
        persistenceScope: value.intent.persistenceScope,
        evidenceStrength: 'HIGH',
        supportingEvidence: value.observation.directUserEvidence.map(evidence => ({
          messageSeq: evidence.messageSeq,
          excerptDigest: evidence.excerptDigest,
        })),
      }],
    })
    expect(JSON.stringify(presented)).not.toMatch(/declaredRootPath|canonicalExistingAncestorPath|D:\\\\repo/u)
  })

  it('keeps durable evidence readable when a stale Proposal no longer has a live Session or root binding', async () => {
    const value = input()
    const presenter = new V2CompatibleProposalPresenter({
      bindings: { resolve: async () => ({ status: 'UNAVAILABLE' }) },
      sessionCoordinate: () => undefined,
      observation: observationId => observationId === value.observation.observationId
        ? value.observation
        : undefined,
    })

    const presented = await presenter.present({ ...value, allowUnresolvedBinding: true })

    expect(presented).toMatchObject({
      sessionCoordinate: {
        rootSessionId: value.intent.sessionLifecycleKey,
        sessionCreatedAt: 0,
        turn: value.observation.turn,
        turnEndSeq: value.observation.turnEndSeq,
      },
      evidenceRefs: value.observation.directUserEvidence,
      experiences: [{ lesson: value.intent.applicabilitySummary }],
    })
    expect(presented.proposal).not.toHaveProperty('actionBinding')
  })
})
