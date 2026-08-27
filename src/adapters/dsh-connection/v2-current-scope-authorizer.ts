import { createHash } from 'node:crypto'
import type { Run2skillV2Domain } from '../dsh-storage/v2-types.js'
import { deriveProjectScopeIdentityDigest } from '../../domain/purge/index.js'
import { ProposalLineageV2Schema, type ProposalLineageV2 } from '../../domain/v2/index.js'
import { deriveV2ProposalRef, type V2ProposalRef } from '../../application/review/index.js'
import {
  CurrentScopeAuthorizationError,
  type CurrentScopeV1,
  type CurrentWorkspaceResolver,
} from './current-scope-authorizer.js'

type NativeLineage = Extract<ProposalLineageV2, { readonly origin: 'RUN2SKILL_V2' }>

export interface ProjectedV2AttentionAction {
  readonly actionKey: string
  readonly subjectId: string
  readonly kind: 'REVIEW_PROPOSAL' | 'REFRESH_PROPOSAL' | 'RETRY_PUBLICATION'
  readonly proposalRef: V2ProposalRef
  readonly reasonCode: string
  readonly scope: 'PROJECT' | 'USER'
  readonly availableActions: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

export type V2AttentionActionIdentity = Pick<
  ProjectedV2AttentionAction,
  'actionKey' | 'subjectId' | 'kind' | 'proposalRef'
>

export function deriveV2ActionSubjectId(lineageId: string): `wi_${string}` {
  return `wi_${createHash('sha256').update(`run2skill-v2-action\0${lineageId}`, 'utf8').digest('hex')}`
}

function actionKey(lineage: NativeLineage, kind: ProjectedV2AttentionAction['kind'], reasonCode: string): string {
  const ref = deriveV2ProposalRef(lineage)
  return `act_${createHash('sha256').update([
    'run2skill-action-v2', lineage.lineageId, String(lineage.revision), kind, reasonCode,
    ref.proposalId, String(ref.revision), ref.digest,
  ].join('\0'), 'utf8').digest('hex')}`
}

function sameRef(left: V2ProposalRef, right: V2ProposalRef): boolean {
  return left.proposalId === right.proposalId
    && left.revision === right.revision
    && left.digest === right.digest
}

function sameAction(left: ProjectedV2AttentionAction, right: V2AttentionActionIdentity): boolean {
  return left.actionKey === right.actionKey
    && left.subjectId === right.subjectId
    && left.kind === right.kind
    && sameRef(left.proposalRef, right.proposalRef)
}

function projectLineage(lineage: NativeLineage): ProjectedV2AttentionAction | undefined {
  if (lineage.state !== 'ACTIVE_PROPOSAL') return undefined
  const proposal = lineage.proposalRevisions.at(-1)
  if (proposal === undefined) return undefined
  const ref = deriveV2ProposalRef(lineage)
  const common = {
    subjectId: deriveV2ActionSubjectId(lineage.lineageId),
    proposalRef: ref,
    scope: lineage.persistenceScope,
    createdAt: proposal.createdAt,
    updatedAt: lineage.updatedAt,
  }
  const revisionPending = lineage.revisionActions.at(-1)?.state === 'CALL_RESERVED'
  if (proposal.reviewDecision === undefined) {
    const reasonCode = proposal.reviewFailureCode ?? 'PROPOSAL_READY'
    if (proposal.reviewFailureCode === 'CATALOG_CHANGED') {
      if (lineage.currentProposalRevision > 1) return undefined
      return {
        ...common,
        actionKey: actionKey(lineage, 'REFRESH_PROPOSAL', reasonCode),
        kind: 'REFRESH_PROPOSAL',
        reasonCode,
        availableActions: ['REFRESH'],
      }
    }
    return {
      ...common,
      actionKey: actionKey(lineage, 'REVIEW_PROPOSAL', reasonCode),
      kind: 'REVIEW_PROPOSAL',
      reasonCode,
      availableActions: revisionPending ? [] : ['APPROVE', 'REJECT', 'REVISE'],
    }
  }
  const failure = proposal.publicationFailureCode
  if (failure === 'CATALOG_CHANGED' || failure === 'PUBLICATION_CONFLICT') {
    if (lineage.currentProposalRevision > 1) return undefined
    return {
      ...common,
      actionKey: actionKey(lineage, 'REFRESH_PROPOSAL', failure),
      kind: 'REFRESH_PROPOSAL',
      reasonCode: failure,
      availableActions: ['REFRESH'],
    }
  }
  if (
    failure === undefined
    || failure === 'CATALOG_UNAVAILABLE'
    || failure === 'PUBLICATION_UNAVAILABLE'
  ) {
    const reasonCode = failure ?? 'PUBLICATION_PENDING'
    return {
      ...common,
      actionKey: actionKey(lineage, 'RETRY_PUBLICATION', reasonCode),
      kind: 'RETRY_PUBLICATION',
      reasonCode,
      availableActions: revisionPending ? [] : ['RETRY', 'REVISE'],
    }
  }
  return undefined
}

export class V2CurrentScopeAuthorizer {
  constructor(private readonly resolveWorkspace: CurrentWorkspaceResolver) {}

  async project(
    domain: Run2skillV2Domain,
    currentScope: CurrentScopeV1,
  ): Promise<readonly ProjectedV2AttentionAction[]> {
    const lineages = await this.visibleLineages(domain, currentScope)
    return lineages.flatMap(lineage => {
      const action = projectLineage(lineage)
      return action === undefined ? [] : [action]
    }).sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt) || left.actionKey.localeCompare(right.actionKey)
    ))
  }

  async visibleLineages(
    domain: Run2skillV2Domain,
    currentScope: CurrentScopeV1,
  ): Promise<readonly NativeLineage[]> {
    const workspace = currentScope.kind === 'USER_ONLY'
      ? undefined
      : await this.resolveWorkspace(currentScope.workspaceId).catch(() => undefined)
    if (currentScope.kind === 'WORKSPACE' && workspace === undefined) {
      throw new CurrentScopeAuthorizationError('SCOPE_UNAVAILABLE')
    }
    return [...domain.table('proposal_lineages').entries()].flatMap(([, raw]) => {
      const parsed = ProposalLineageV2Schema.safeParse(raw)
      if (!parsed.success || parsed.data.origin !== 'RUN2SKILL_V2') return []
      const lineage = parsed.data
      const proposal = lineage.proposalRevisions.at(-1)
      if (lineage.persistenceScope === 'PROJECT' && (
        workspace === undefined
        || proposal?.projectScopeBinding?.workspaceId !== workspace.workspaceId
        || proposal.projectScopeBinding.scopeIdentityDigest
          !== deriveProjectScopeIdentityDigest(workspace.canonicalPath)
      )) return []
      return [lineage]
    }).sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt) || left.lineageId.localeCompare(right.lineageId)
    ))
  }

  async authorize(
    domain: Run2skillV2Domain,
    currentScope: CurrentScopeV1,
    requested: V2AttentionActionIdentity,
    requiredAction?: string,
  ): Promise<{ readonly lineage: NativeLineage; readonly action: ProjectedV2AttentionAction }> {
    const actions = await this.project(domain, currentScope)
    const action = actions.find(candidate => sameAction(candidate, requested))
    if (action === undefined || (requiredAction !== undefined && !action.availableActions.includes(requiredAction))) {
      throw new CurrentScopeAuthorizationError('ACTION_STALE')
    }
    const matches = [...domain.table('proposal_lineages').entries()].flatMap(([, raw]) => {
      const parsed = ProposalLineageV2Schema.safeParse(raw)
      if (!parsed.success || parsed.data.origin !== 'RUN2SKILL_V2') return []
      return deriveV2ActionSubjectId(parsed.data.lineageId) === action.subjectId ? [parsed.data] : []
    })
    if (matches.length !== 1) throw new CurrentScopeAuthorizationError('ACTION_STALE')
    return { lineage: matches[0]!, action }
  }
}
