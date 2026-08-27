import { describe, expect, it } from 'vitest'
import { V2CompatibleProposalPresenter } from '../src/adapters/dsh-connection/v2-proposal-presenter.js'
import { detailResponseSchema } from '../src/adapters/dsh-connection/proposal-review-rpc.js'
import { deriveV2ProposalRef } from '../src/application/review/index.js'
import { canonicalJson } from '../src/domain/learn/identity.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import {
  ProposalLineageV2Schema,
  SessionBatchV2Schema,
  deriveTurnObservationContentDigestV2,
} from '../src/domain/v2/index.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

function input(excerpt?: string) {
  const fixture = createMinimalV2Fixtures()
  const lineage = ProposalLineageV2Schema.parse(fixture.nativeActiveProposalLineage)
  if (lineage.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
  const evidence = excerpt === undefined
    ? fixture.turnObservation.directUserEvidence
    : fixture.turnObservation.directUserEvidence.map(item => ({
      ...item,
      excerpt,
      excerptDigest: sha256Utf8(excerpt),
      truncated: false,
    }))
  const observationBase = {
    ...fixture.turnObservation,
    directUserEvidence: evidence,
    evidenceDigest: sha256Utf8(canonicalJson(evidence)),
  }
  const observation = {
    ...observationBase,
    contentDigest: deriveTurnObservationContentDigestV2(observationBase),
  }
  return {
    lineage,
    proposal: lineage.proposalRevisions[0]!,
    proposalRef: deriveV2ProposalRef(lineage),
    intent: {
      ...fixture.proposalReadyIntent,
      evidenceRefs: fixture.proposalReadyIntent.evidenceRefs.map(reference => ({
        ...reference,
        evidenceDigest: observation.evidenceDigest,
      })),
    },
    batch: SessionBatchV2Schema.parse(fixture.sessionBatch),
    observation,
  }
}

function presenterFor(value: ReturnType<typeof input>) {
  return new V2CompatibleProposalPresenter({
    bindings: {
      resolve: async () => ({
        status: 'READY' as const,
        view: {},
        rootBinding: {
          state: 'ABSENT' as const,
          scope: 'PROJECT' as const,
          expectedProvider: 'filesystem' as const,
          expectedSource: 'project-dsh' as const,
          resolverVersion: 'stock-root-resolver-v2' as const,
          rootContractVersion: 'stock-dsh-web-default-roots-v1' as const,
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
}

describe('v2 compatible Proposal presenter', () => {
  it('projects oversized durable v2 evidence through the bounded legacy detail contract', async () => {
    const head = '请把下面这条已经验证过的流程沉淀为一个可复用 Skill。'
    const tail = '不要直接操作 Skill 目录。请只简洁复述你理解的流程。'
    const base = `${head}${tail}`
    const remainingChars = 237 - [...base].length
    const remainingBytes = 537 - Buffer.byteLength(base, 'utf8')
    const chineseFillerChars = (remainingBytes - remainingChars) / 2
    const asciiFillerChars = remainingChars - chineseFillerChars
    const excerpt = `${head}${'中'.repeat(chineseFillerChars)}${'x'.repeat(asciiFillerChars)}${tail}`
    expect([...excerpt]).toHaveLength(237)
    expect(Buffer.byteLength(excerpt, 'utf8')).toBe(537)
    const value = input(excerpt)

    const presented = await presenterFor(value).present(value)
    const detail = detailResponseSchema.parse({
      apiVersion: 1,
      workItemId: `wi_${'d'.repeat(64)}`,
      workItemRevision: 1,
      processingState: 'READY_FOR_REVIEW',
      reviewDecision: 'PENDING',
      publicationOutcome: 'PENDING_REVIEW',
      ...presented,
    })

    expect(Buffer.byteLength(detail.evidenceRefs[0]!.excerpt, 'utf8')).toBeLessThanOrEqual(512)
    expect(detail.evidenceRefs[0]!.excerpt).toMatch(/^请把下面这条已经验证过的流程/u)
    expect(detail.evidenceRefs[0]!.excerpt).toMatch(/不要直接操作 Skill 目录。请只简洁复述你理解的流程。$/u)
    expect(detail.evidenceRefs[0]).toMatchObject({
      excerptDigest: sha256Utf8(detail.evidenceRefs[0]!.excerpt),
      truncated: true,
    })
    expect(value.observation.directUserEvidence[0]!.excerpt).toBe(excerpt)
  })

  it('keeps short and exact-limit Chinese evidence unchanged', async () => {
    const excerpts = ['保存这个流程。', `${'界'.repeat(170)}ab`]
    expect(Buffer.byteLength(excerpts[1]!, 'utf8')).toBe(512)

    for (const excerpt of excerpts) {
      const value = input(excerpt)
      const presented = await presenterFor(value).present(value)
      expect(presented.evidenceRefs[0]).toEqual(value.observation.directUserEvidence[0])
    }
  })

  it('projects a path-free CREATE detail through the existing UI schema', async () => {
    const value = input()
    const presented = await presenterFor(value).present(value)

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
