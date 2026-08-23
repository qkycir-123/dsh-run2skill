import { join } from 'node:path'
import type { V2ProposalPublicationInput } from '../../application/publication/index.js'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import type { RootBindingV2 } from '../../domain/review/index.js'
import { readPublicationText } from '../dsh-publication/filesystem-cas.mjs'
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

  async present(input: V2ProposalPublicationInput): Promise<V2CompatibleProposalPresentation> {
    const coordinate = this.options.sessionCoordinate(input)
    if (coordinate === undefined) throw new V2ProposalPresentationError('UNAVAILABLE')
    let resolved
    try {
      resolved = await this.options.bindings.resolve(input)
    } catch {
      throw new V2ProposalPresentationError('UNAVAILABLE')
    }
    if (resolved.status !== 'READY') {
      throw new V2ProposalPresentationError(resolved.status === 'STALE' ? 'STALE' : 'UNAVAILABLE')
    }
    const rootBinding = safeRootBinding(resolved.rootBinding)
    let actionBinding
    if (input.proposal.action === 'CREATE') {
      actionBinding = {
        kind: 'CREATE' as const,
        rootBinding,
        targetBinding: { skillName: input.proposal.body.name },
        expectedAbsence: { observedAt: input.proposal.createdAt },
      }
    } else {
      const candidateKey = input.intent.coverage.targetCandidateId
      if (candidateKey === undefined || input.proposal.baseSkillBytesDigest === undefined) {
        throw new V2ProposalPresentationError('STALE')
      }
      let base
      try {
        base = await readPublicationText(
          join(resolved.rootBinding.declaredRootPath, input.proposal.body.name, 'SKILL.md'),
          64 * 1024,
        )
      } catch {
        throw new V2ProposalPresentationError('UNAVAILABLE')
      }
      if (
        base.status !== 'AVAILABLE'
        || sha256Utf8(base.text) !== input.proposal.baseSkillBytesDigest
      ) throw new V2ProposalPresentationError('STALE')
      actionBinding = {
        kind: 'MERGE' as const,
        rootBinding,
        targetBinding: { skillName: input.proposal.body.name },
        baseBinding: {
          candidateKey,
          exactBytes: base.text,
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
        actionBinding,
        proposalId: input.proposal.proposalId,
        digest: input.proposalRef.digest,
      }),
      sessionCoordinate: coordinate,
      evidenceRefs: [],
      experiences: [],
    }
  }
}
