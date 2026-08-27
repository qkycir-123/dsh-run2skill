import type { V2ProposalPublicationInput } from '../../application/publication/index.js'
import { deriveV2ProposalRef } from '../../application/review/index.js'
import { ExperienceRecordV1Schema } from '../../domain/learn/index.js'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import type { RootBindingV2 } from '../../domain/review/index.js'
import { TurnObservationV2Schema, type TurnObservationV2 } from '../../domain/v2/index.js'
import type { V2DshPublicationBindingPort } from '../dsh-publication/v2-proposal-filesystem.js'
import { safeProposalSchema } from './proposal-review-rpc.js'
import type { V2CompatibleProposalPresentation } from './v2-proposal-rpc.js'

type SessionCoordinate = V2CompatibleProposalPresentation['sessionCoordinate']

export class V2ProposalPresentationError extends Error {
  constructor(readonly code: 'UNAVAILABLE' | 'STALE') {
    super(code)
    this.name = 'V2ProposalPresentationError'
  }
}

export interface V2CompatibleProposalPresenterOptions<TView extends object> {
  readonly bindings: V2DshPublicationBindingPort<TView>
  readonly sessionCoordinate: (input: V2ProposalPublicationInput) => SessionCoordinate | undefined
  readonly observation: (observationId: string) => TurnObservationV2 | undefined
}

function safeRootBinding(binding: RootBindingV2) {
  return {
    state: binding.state,
    scope: binding.scope,
    expectedProvider: binding.expectedProvider,
    expectedSource: binding.expectedSource,
    resolverVersion: binding.resolverVersion,
    rootContractVersion: binding.rootContractVersion,
    resolutionContractDigest: binding.resolutionContractDigest,
  }
}

function syntheticId(prefix: 'lp' | 'exp', intentId: string): string {
  return `${prefix}_${sha256Utf8(canonicalJson({ contract: 'run2skill-v2-ui-identity-v1', prefix, intentId }))}`
}

/** Produces the path-free v1-shaped detail currently consumed by the DSH UI. */
export class V2CompatibleProposalPresenter<TView extends object> {
  constructor(private readonly options: V2CompatibleProposalPresenterOptions<TView>) {}

  async present(
    input: V2ProposalPublicationInput & { readonly allowUnresolvedBinding?: boolean },
  ): Promise<V2CompatibleProposalPresentation> {
    const observations = input.intent.evidenceRefs.map(reference => {
      const parsed = TurnObservationV2Schema.safeParse(this.options.observation(reference.observationId))
      if (!parsed.success) throw new V2ProposalPresentationError('UNAVAILABLE')
      const observation = parsed.data
      if (
        observation.sessionLifecycleKey !== reference.sessionLifecycleKey
        || observation.turnEndSeq !== reference.turnEndSeq
        || observation.evidenceDigest !== reference.evidenceDigest
        || observation.sessionLifecycleKey !== input.intent.sessionLifecycleKey
      ) throw new V2ProposalPresentationError('STALE')
      if (
        input.intent.persistenceScope === 'PROJECT'
        && (
          observation.scopeBinding.status !== 'PROJECT'
          || input.proposal.projectScopeBinding === undefined
          || observation.scopeBinding.workspaceId !== input.proposal.projectScopeBinding.workspaceId
          || observation.scopeBinding.scopeIdentityDigest !== input.proposal.projectScopeBinding.scopeIdentityDigest
        )
      ) throw new V2ProposalPresentationError('STALE')
      return observation
    })
    const latestObservation = observations.reduce((latest, observation) => (
      observation.turnEndSeq > latest.turnEndSeq ? observation : latest
    ))
    const coordinate = this.options.sessionCoordinate(input) ?? {
      rootSessionId: input.batch.sessionLifecycleKey,
      sessionCreatedAt: 0,
      turn: latestObservation.turn,
      turnEndSeq: latestObservation.turnEndSeq,
    }
    const evidenceRefs = [...new Map(
      observations
        .flatMap(observation => observation.directUserEvidence)
        .map(evidence => [`${String(evidence.messageSeq)}\0${evidence.excerptDigest}`, evidence]),
    ).values()].slice(0, 4)
    if (evidenceRefs.length === 0) throw new V2ProposalPresentationError('UNAVAILABLE')
    let resolved
    try {
      resolved = await this.options.bindings.resolve(input)
    } catch {
      if (input.allowUnresolvedBinding !== true) throw new V2ProposalPresentationError('UNAVAILABLE')
    }
    if (resolved !== undefined && resolved.status !== 'READY' && input.allowUnresolvedBinding !== true) {
      throw new V2ProposalPresentationError(resolved.status === 'STALE' ? 'STALE' : 'UNAVAILABLE')
    }
    const rootBinding = resolved?.status === 'READY' ? safeRootBinding(resolved.rootBinding) : undefined
    let actionBinding
    if (rootBinding === undefined) {
      actionBinding = undefined
    } else if (input.proposal.action === 'CREATE') {
      actionBinding = {
        kind: 'CREATE' as const,
        rootBinding,
        targetBinding: { skillName: input.proposal.body.name },
        expectedAbsence: { observedAt: input.proposal.createdAt },
      }
    } else {
      const candidateKey = input.intent.coverage.targetCandidateId
      if (
        candidateKey === undefined
        || input.proposal.baseSkillBytes === undefined
        || input.proposal.baseSkillBytesDigest === undefined
        || sha256Utf8(input.proposal.baseSkillBytes) !== input.proposal.baseSkillBytesDigest
      ) {
        throw new V2ProposalPresentationError('STALE')
      }
      actionBinding = {
        kind: 'MERGE' as const,
        rootBinding,
        targetBinding: { skillName: input.proposal.body.name },
        baseBinding: {
          candidateKey,
          exactBytes: input.proposal.baseSkillBytes,
          bytesDigest: input.proposal.baseSkillBytesDigest,
          observedAt: input.proposal.createdAt,
        },
      }
    }
    return {
      proposal: safeProposalSchema.parse({
        schemaVersion: 1,
        revision: input.proposal.revision,
        createdAt: input.proposal.createdAt,
        sourceLearningProposalId: syntheticId('lp', input.intent.intentId),
        kind: input.proposal.action,
        name: input.proposal.body.name,
        description: input.proposal.body.description,
        whenToUse: input.proposal.body.whenToUse,
        invocation: { modelInvocable: true, userInvocable: false },
        exactSkillBytes: input.proposal.body.exactSkillBytes,
        skillBytesDigest: input.proposal.body.skillBytesDigest,
        rendererVersion: 'run2skill-v2-renderer-v1',
        persistenceScope: input.lineage.persistenceScope,
        ...(input.proposal.projectScopeBinding === undefined
          ? {}
          : { workspaceBinding: { workspaceId: input.proposal.projectScopeBinding.workspaceId } }),
        supportingExperienceIds: [syntheticId('exp', input.intent.intentId)],
        catalogObservationDigest: input.proposal.runtimeCatalogDigest,
        curationRationale: input.intent.applicabilitySummary,
        ...(input.proposal.revisionSource === undefined
          ? {}
          : (() => {
              const parent = input.lineage.proposalRevisions[input.proposal.revision - 2]
              if (
                parent === undefined
                || parent.proposalId !== input.proposal.revisionSource.parentProposalId
                || parent.revision !== input.proposal.revisionSource.parentProposalRevision
              ) throw new V2ProposalPresentationError('STALE')
              const parentRef = deriveV2ProposalRef({
                ...input.lineage,
                currentProposalRevision: parent.revision,
                proposalRevisions: input.lineage.proposalRevisions.slice(0, input.proposal.revision - 1),
              })
              if (parentRef.digest !== input.proposal.revisionSource.parentProposalDigest) {
                throw new V2ProposalPresentationError('STALE')
              }
              return { revisionParent: {
                proposalId: parent.proposalId,
                revision: parent.revision,
                digest: parentRef.digest,
                exactSkillBytes: parent.body.exactSkillBytes,
              } }
            })()),
        ...(actionBinding === undefined ? {} : { actionBinding }),
        proposalId: input.proposal.proposalId,
        digest: input.proposalRef.digest,
      }),
      sessionCoordinate: coordinate,
      evidenceRefs,
      experiences: [ExperienceRecordV1Schema.parse({
        experienceId: syntheticId('exp', input.intent.intentId),
        type: input.intent.experienceType,
        lesson: input.intent.applicabilitySummary,
        persistenceScope: input.intent.persistenceScope,
        evidenceStrength: 'HIGH',
        supportingEvidence: evidenceRefs.map(evidence => ({
          messageSeq: evidence.messageSeq,
          excerptDigest: evidence.excerptDigest,
        })),
      })],
    }
  }
}
