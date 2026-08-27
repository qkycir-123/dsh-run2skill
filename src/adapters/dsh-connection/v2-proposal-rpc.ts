import { z } from 'zod'
import type { Run2skillV2Domain } from '../dsh-storage/v2-types.js'
import {
  ExperienceIntentV2Schema,
  GlobalV2Schema,
  ProposalLineageV2Schema,
  SessionBatchV2Schema,
  type ProposalLineageV2,
} from '../../domain/v2/index.js'
import {
  deriveV2ProposalRef,
  V2ProposalRefreshError,
  V2ProposalRevisionError,
  V2ProposalReviewError,
  type V2ProposalRef,
  type V2ProposalRefreshCoordinator,
  type V2ProposalRevisionCoordinator,
  type V2ProposalReviewCoordinator,
} from '../../application/review/index.js'
import {
  V2ProposalPublicationError,
  type V2ProposalPublicationCoordinator,
} from '../../application/publication/index.js'
import type { ObserveRpcResult, ObserveSummaryRpcHandler } from './observe-summary-rpc.js'
import { ATTENTION_ENDPOINT, attentionRequestSchema } from './attention-rpc.js'
import {
  COVERAGE_CONFIRM_DISCARD_ENDPOINT,
  PROPOSALS_APPROVE_ENDPOINT,
  PROPOSALS_GET_ENDPOINT,
  PROPOSALS_LIST_ENDPOINT,
  PROPOSALS_REJECT_ENDPOINT,
  PROPOSALS_REVISE_ENDPOINT,
  PROPOSALS_REFRESH_ENDPOINT,
  PROPOSALS_RETRY_ENDPOINT,
  PROPOSAL_SUMMARY_ENDPOINT,
  detailResponseSchema,
  getRequestSchema,
  listRequestSchema,
  listResponseSchema,
  mutationRequestSchema,
  receiptSchema,
  rejectRequestSchema,
  reviseRequestSchema,
  safeProposalSchema,
  summaryRequestSchema,
  summaryResponseSchema,
} from './proposal-review-rpc.js'
import {
  CurrentScopeAuthorizationError,
  CurrentScopeV1Schema,
  pageAuthoritativeActions,
  type ProjectedAttentionAction,
} from './current-scope-authorizer.js'
import {
  V2CurrentScopeAuthorizer,
  deriveV2ActionSubjectId,
  type ProjectedV2AttentionAction,
  type V2AttentionActionIdentity,
} from './v2-current-scope-authorizer.js'
import { V2ProposalPresentationError } from './v2-proposal-presenter.js'

type NativeLineage = Extract<ProposalLineageV2, { readonly origin: 'RUN2SKILL_V2' }>
type NativeProposal = NativeLineage['proposalRevisions'][number]

const MAX_REQUEST_BYTES = 8 * 1024
const PAGE_SIZE = 20
const supported = new Set([
  ATTENTION_ENDPOINT,
  PROPOSAL_SUMMARY_ENDPOINT,
  PROPOSALS_LIST_ENDPOINT,
  PROPOSALS_GET_ENDPOINT,
  PROPOSALS_APPROVE_ENDPOINT,
  PROPOSALS_REJECT_ENDPOINT,
  PROPOSALS_REFRESH_ENDPOINT,
  PROPOSALS_RETRY_ENDPOINT,
  PROPOSALS_REVISE_ENDPOINT,
])

export interface V2CompatibleProposalPresentation {
  readonly proposal: z.input<typeof safeProposalSchema>
  readonly sessionCoordinate: z.input<typeof detailResponseSchema>['sessionCoordinate']
  readonly evidenceRefs: z.input<typeof detailResponseSchema>['evidenceRefs']
  readonly experiences: z.input<typeof detailResponseSchema>['experiences']
}

export interface V2ProposalRpcOptions {
  readonly authorizer: V2CurrentScopeAuthorizer
  readonly reviews: (domain: Run2skillV2Domain) => V2ProposalReviewCoordinator | undefined
  readonly present: (input: {
    readonly lineage: NativeLineage
    readonly proposal: NativeProposal
    readonly proposalRef: V2ProposalRef
    readonly intent: z.infer<typeof ExperienceIntentV2Schema>
    readonly batch: z.infer<typeof SessionBatchV2Schema>
    readonly allowUnresolvedBinding?: boolean
  }) => Promise<V2CompatibleProposalPresentation>
  readonly publications: (domain: Run2skillV2Domain) => V2ProposalPublicationCoordinator | undefined
  readonly refreshes: (domain: Run2skillV2Domain) => V2ProposalRefreshCoordinator | undefined
  readonly revisions?: (domain: Run2skillV2Domain) => V2ProposalRevisionCoordinator | undefined
  readonly readHealth?: () => {
    readonly status: 'READY' | 'RECOVERING' | 'DEGRADED' | 'INCOMPATIBLE'
    readonly recoveryLag: boolean
    readonly lastHealthCode?: string | undefined
  }
  readonly runtimeAttention?: (sessionId?: string) => {
    readonly runtimeCompleteness: 'KNOWN' | 'UNKNOWN'
    readonly runtimeWarnings: readonly unknown[]
  }
  readonly learningActions?: (currentScope: z.infer<typeof CurrentScopeV1Schema>) => Promise<readonly ProjectedAttentionAction[]>
}

function error(code: 'bad-request' | 'cancelled' | 'internal' | 'not-found' | 'conflict' | 'invalid-state'): ObserveRpcResult<never> {
  return { ok: false, error: { code, message: `v2 proposal review ${code}`, details: {} } }
}

function requestFits(payload: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8') <= MAX_REQUEST_BYTES
  } catch {
    return false
  }
}

function activeDomain(getDomain: () => Run2skillV2Domain | undefined): Run2skillV2Domain | undefined {
  const domain = getDomain()
  if (domain === undefined) return undefined
  const global = GlobalV2Schema.safeParse(domain.global.get())
  return global.success && global.data.migration.phase === 'COMMITTED' && global.data.activation !== undefined
    ? domain
    : undefined
}

function stateOf(lineage: NativeLineage) {
  const proposal = lineage.proposalRevisions.at(-1)
  if (proposal === undefined) return undefined
  if (lineage.revisionActions.at(-1)?.state === 'CALL_RESERVED') {
    return { processingState: 'REVISING' as const, reviewDecision: 'PENDING' as const, publicationOutcome: 'PENDING_REVIEW' as const }
  }
  if (lineage.state === 'REFRESHING') {
    return {
      processingState: 'PUBLISHING' as const,
      reviewDecision: proposal.reviewDecision === 'APPROVED' ? 'APPROVED' as const : 'PENDING' as const,
      publicationOutcome: 'PENDING_REVIEW' as const,
    }
  }
  if (lineage.state === 'PUBLISHED') {
    return { processingState: 'TERMINAL' as const, reviewDecision: 'APPROVED' as const, publicationOutcome: 'PUBLISHED' as const }
  }
  if (lineage.state === 'TERMINAL') {
    return { processingState: 'TERMINAL' as const, reviewDecision: 'REJECTED' as const, publicationOutcome: 'DISCARDED' as const }
  }
  if (proposal.reviewDecision === undefined) {
    return proposal.reviewFailureCode === undefined
      ? { processingState: 'READY_FOR_REVIEW' as const, reviewDecision: 'PENDING' as const, publicationOutcome: 'PENDING_REVIEW' as const }
      : proposal.reviewFailureCode === 'CATALOG_CHANGED'
        ? { processingState: 'NEEDS_ATTENTION' as const, reviewDecision: 'PENDING' as const, publicationOutcome: 'NEEDS_REFRESH' as const }
        : { processingState: 'NEEDS_ATTENTION' as const, reviewDecision: 'PENDING' as const, publicationOutcome: 'NEEDS_ATTENTION' as const }
  }
  if (proposal.publicationFailureCode === undefined) {
    return { processingState: 'PUBLISHING' as const, reviewDecision: 'APPROVED' as const, publicationOutcome: 'PENDING_REVIEW' as const }
  }
  return proposal.publicationFailureCode === 'CATALOG_CHANGED'
    || proposal.publicationFailureCode === 'PUBLICATION_CONFLICT'
    ? { processingState: 'NEEDS_ATTENTION' as const, reviewDecision: 'APPROVED' as const, publicationOutcome: 'NEEDS_REFRESH' as const }
    : { processingState: 'NEEDS_ATTENTION' as const, reviewDecision: 'APPROVED' as const, publicationOutcome: 'PUBLISH_FAILED' as const }
}

function asV1Action(action: ProjectedV2AttentionAction): ProjectedAttentionAction {
  return {
    actionKey: action.actionKey,
    subjectId: action.subjectId,
    kind: action.kind,
    proposalRef: action.proposalRef,
    reasonCode: action.reasonCode,
    scope: action.scope,
    availableActions: action.availableActions,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  }
}

function asActionIdentity(action: ProjectedV2AttentionAction): V2AttentionActionIdentity {
  return {
    actionKey: action.actionKey,
    subjectId: action.subjectId,
    kind: action.kind,
    proposalRef: action.proposalRef,
  }
}

function findBySubject(domain: Run2skillV2Domain, subjectId: string): NativeLineage | undefined {
  const matches = [...domain.table('proposal_lineages').entries()].flatMap(([, raw]) => {
    const parsed = ProposalLineageV2Schema.safeParse(raw)
    if (!parsed.success || parsed.data.origin !== 'RUN2SKILL_V2') return []
    return deriveV2ActionSubjectId(parsed.data.lineageId) === subjectId ? [parsed.data] : []
  })
  return matches.length === 1 ? matches[0] : undefined
}

function mappedError(value: unknown): ObserveRpcResult<never> {
  if (value instanceof CurrentScopeAuthorizationError) return error('conflict')
  if (value instanceof V2ProposalPresentationError) {
    return value.code === 'STALE' ? error('conflict') : error('internal')
  }
  if (value instanceof V2ProposalPublicationError) {
    switch (value.code) {
      case 'PUBLICATION_LINEAGE_NOT_FOUND': return error('not-found')
      case 'PUBLICATION_REVISION_CONFLICT':
      case 'STALE_PROPOSAL_REF': return error('conflict')
      case 'INVALID_PUBLICATION_STATE': return error('invalid-state')
      default: return error('internal')
    }
  }
  if (value instanceof V2ProposalRefreshError) {
    switch (value.code) {
      case 'REFRESH_LINEAGE_NOT_FOUND': return error('not-found')
      case 'REFRESH_REVISION_CONFLICT':
      case 'STALE_PROPOSAL_REF': return error('conflict')
      case 'INVALID_REFRESH_STATE': return error('invalid-state')
      default: return error('internal')
    }
  }
  if (value instanceof V2ProposalRevisionError) {
    switch (value.code) {
      case 'REVISION_LINEAGE_NOT_FOUND': return error('not-found')
      case 'REVISION_REVISION_CONFLICT':
      case 'STALE_PROPOSAL_REF':
      case 'REVISION_BUSY': return error('conflict')
      case 'INVALID_REVISION_STATE': return error('invalid-state')
      case 'REVISION_INPUT_INVALID': return error('bad-request')
      default: return error('internal')
    }
  }
  if (!(value instanceof V2ProposalReviewError)) return error('internal')
  switch (value.code) {
    case 'REVIEW_LINEAGE_NOT_FOUND': return error('not-found')
    case 'REVIEW_REVISION_CONFLICT':
    case 'STALE_PROPOSAL_REF': return error('conflict')
    case 'INVALID_REVIEW_STATE': return error('invalid-state')
    default: return error('internal')
  }
}

export function createV2ProposalRpcHandler(
  getDomain: () => Run2skillV2Domain | undefined,
  options: V2ProposalRpcOptions,
  fallback?: ObserveSummaryRpcHandler,
): ObserveSummaryRpcHandler {
  return async (endpoint, payload, signal) => {
    if (!supported.has(endpoint)) {
      return fallback === undefined ? error('bad-request') : await fallback(endpoint, payload, signal)
    }
    const domain = activeDomain(getDomain)
    if (domain === undefined) {
      return fallback === undefined ? error('internal') : await fallback(endpoint, payload, signal)
    }
    if (!requestFits(payload)) return error('bad-request')
    if (signal.aborted) return error('cancelled')
    const global = GlobalV2Schema.safeParse(domain.global.get())
    if (!global.success) return error('internal')

    if (endpoint === ATTENTION_ENDPOINT) {
      const request = attentionRequestSchema.safeParse(payload)
      if (!request.success) return error('bad-request')
      if (global.data.purgeJournal !== undefined) {
        return { ok: true, value: {
          apiVersion: 1, userCompleteness: 'UNKNOWN', projectCompleteness: 'UNKNOWN',
          actions: [], runtimeCompleteness: 'UNKNOWN', runtimeWarnings: [],
        } }
      }
      try {
        const actions = [
          ...await options.authorizer.project(domain, request.data.currentScope),
          ...await (options.learningActions?.(request.data.currentScope) ?? Promise.resolve([])),
        ]
        const runtime = options.runtimeAttention?.(request.data.sessionId) ?? {
          runtimeCompleteness: 'KNOWN' as const,
          runtimeWarnings: [],
        }
        return { ok: true, value: {
          apiVersion: 1,
          userCompleteness: 'KNOWN',
          projectCompleteness: request.data.currentScope.kind === 'USER_ONLY' ? 'UNAVAILABLE' : 'KNOWN',
          actions,
          ...runtime,
        } }
      } catch (caught) {
        return caught instanceof CurrentScopeAuthorizationError ? error('conflict') : error('internal')
      }
    }

    if (endpoint === PROPOSAL_SUMMARY_ENDPOINT) {
      const request = summaryRequestSchema.safeParse(payload)
      if (!request.success) return error('bad-request')
      const health = options.readHealth?.() ?? { status: 'READY' as const, recoveryLag: false }
      if (global.data.purgeJournal !== undefined) {
        return { ok: true, value: summaryResponseSchema.parse({ apiVersion: 1, ...health, queue: { completeness: 'UNKNOWN' } }) }
      }
      try {
        const lineages = await options.authorizer.visibleLineages(domain, {
          kind: 'WORKSPACE', generation: 1, workspaceId: request.data.workspaceId,
        })
        const states = lineages.map(stateOf).filter(item => item !== undefined && item.processingState !== 'TERMINAL')
        return { ok: true, value: summaryResponseSchema.parse({
          apiVersion: 1,
          ...health,
          queue: {
            completeness: 'KNOWN',
            pendingReview: states.filter(item => item.processingState === 'READY_FOR_REVIEW').length,
            publishing: states.filter(item => item.processingState === 'PUBLISHING').length,
            needsAttention: states.filter(item => item.processingState === 'NEEDS_ATTENTION').length,
          },
        }) }
      } catch (caught) {
        return caught instanceof CurrentScopeAuthorizationError ? error('conflict') : error('internal')
      }
    }

    if (global.data.purgeJournal !== undefined) return error('conflict')

    if (endpoint === PROPOSALS_LIST_ENDPOINT) {
      const request = listRequestSchema.safeParse(payload)
      if (!request.success) return error('bad-request')
      try {
        const projected = await options.authorizer.project(domain, request.data.currentScope)
        const queue = projected.map(asV1Action)
        const page = pageAuthoritativeActions(
          'PROPOSAL', request.data.currentScope, queue, request.data.cursor, request.data.limit ?? PAGE_SIZE,
        )
        const items = page.page.map(action => {
          const lineage = findBySubject(domain, action.subjectId)
          const proposal = lineage?.proposalRevisions.at(-1)
          const state = lineage === undefined ? undefined : stateOf(lineage)
          if (lineage === undefined || proposal === undefined || state === undefined || state.processingState === 'TERMINAL') {
            throw new CurrentScopeAuthorizationError('ACTION_STALE')
          }
          return {
            workItemId: action.subjectId,
            workItemRevision: lineage.revision,
            proposalRef: deriveV2ProposalRef(lineage),
            kind: proposal.action,
            name: proposal.body.name,
            description: proposal.body.description,
            persistenceScope: lineage.persistenceScope,
            createdAt: proposal.createdAt,
            processingState: state.processingState,
            publicationOutcome: state.publicationOutcome,
          }
        })
        return { ok: true, value: listResponseSchema.parse({
          apiVersion: 1, items, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        }) }
      } catch (caught) {
        return caught instanceof CurrentScopeAuthorizationError ? error('conflict') : error('internal')
      }
    }

    if (endpoint === PROPOSALS_GET_ENDPOINT) {
      const request = getRequestSchema.safeParse(payload)
      if (!request.success) return error('bad-request')
      try {
        const authorized = await options.authorizer.authorize(
          domain, request.data.currentScope, request.data.action as V2AttentionActionIdentity,
        )
        let lineage = authorized.lineage
        let proposal = lineage.proposalRevisions.at(-1)!
        if (proposal.proposalId !== request.data.proposalId) return error('conflict')
        if (proposal.reviewDecision === undefined && lineage.revisionActions.at(-1)?.state !== 'CALL_RESERVED') {
          const reviews = options.reviews(domain)
          if (reviews === undefined) return error('internal')
          const inspected = await reviews.inspect({
            lineageId: lineage.lineageId,
            expectedLineageRevision: lineage.revision,
            proposalRef: deriveV2ProposalRef(lineage),
          })
          lineage = inspected.lineage
          proposal = lineage.proposalRevisions.at(-1)!
        }
        const intent = ExperienceIntentV2Schema.safeParse(domain.table('experience_intents').get(lineage.ownerIntentId))
        const batch = intent.success
          ? SessionBatchV2Schema.safeParse(domain.table('session_batches').get(intent.data.batchId))
          : undefined
        if (!intent?.success || !batch?.success) return error('internal')
        const state = stateOf(lineage)!
        const presentation = await options.present({
          lineage, proposal, proposalRef: deriveV2ProposalRef(lineage), intent: intent.data, batch: batch.data,
          allowUnresolvedBinding: state.processingState === 'NEEDS_ATTENTION',
        })
        const currentAction = (await options.authorizer.project(domain, request.data.currentScope))
          .find(candidate => candidate.subjectId === authorized.action.subjectId)
        if (currentAction === undefined) throw new CurrentScopeAuthorizationError('ACTION_STALE')
        return { ok: true, value: detailResponseSchema.parse({
          apiVersion: 1,
          workItemId: authorized.action.subjectId,
          workItemRevision: lineage.revision,
          ...state,
          ...presentation,
          action: asActionIdentity(currentAction),
        }) }
      } catch (caught) {
        return mappedError(caught)
      }
    }

    if (endpoint === COVERAGE_CONFIRM_DISCARD_ENDPOINT) return error('invalid-state')
    const parsed = endpoint === PROPOSALS_REJECT_ENDPOINT
      ? rejectRequestSchema.safeParse(payload)
      : endpoint === PROPOSALS_REVISE_ENDPOINT
        ? reviseRequestSchema.safeParse(payload)
      : mutationRequestSchema.safeParse(payload)
    if (!parsed.success) return error('bad-request')
    const revisionData = endpoint === PROPOSALS_REVISE_ENDPOINT
      ? reviseRequestSchema.parse(payload)
      : undefined
    try {
      const required = endpoint === PROPOSALS_APPROVE_ENDPOINT
        ? 'APPROVE'
        : endpoint === PROPOSALS_REJECT_ENDPOINT
          ? 'REJECT'
          : endpoint === PROPOSALS_REVISE_ENDPOINT
            ? 'REVISE'
          : endpoint === PROPOSALS_REFRESH_ENDPOINT
            ? 'REFRESH'
            : 'RETRY'
      let authorized
      try {
        authorized = await options.authorizer.authorize(
          domain, parsed.data.currentScope, parsed.data.action as V2AttentionActionIdentity, required,
        )
      } catch (caught) {
        if (revisionData === undefined) throw caught
        const visible = await options.authorizer.visibleLineages(domain, parsed.data.currentScope)
        const duplicate = visible.find(candidate => (
          deriveV2ActionSubjectId(candidate.lineageId) === parsed.data.workItemId
          && candidate.revisionActions.some(action => (
            action.actionId === revisionData.actionId
            && action.parentProposalId === parsed.data.proposalRef.proposalId
            && action.parentProposalRevision === parsed.data.proposalRef.revision
            && action.parentProposalDigest === parsed.data.proposalRef.digest
          ))
        ))
        if (duplicate === undefined) throw caught
        const revisions = options.revisions?.(domain)
        if (revisions === undefined) return error('internal')
        const result = await revisions.revise({
          lineageId: duplicate.lineageId,
          expectedLineageRevision: parsed.data.workItemRevision,
          proposalRef: parsed.data.proposalRef,
          actionId: revisionData.actionId,
          feedback: revisionData.feedback,
        })
        const state = stateOf(result.lineage)!
        return { ok: true, value: receiptSchema.parse({
          apiVersion: 1,
          workItemId: parsed.data.workItemId,
          workItemRevision: result.lineage.revision,
          proposalRef: result.proposalRef,
          changed: result.changed,
          ...state,
        }) }
      }
      if (
        authorized.action.subjectId !== parsed.data.workItemId
        || authorized.lineage.revision !== parsed.data.workItemRevision
        || !sameRef(deriveV2ProposalRef(authorized.lineage), parsed.data.proposalRef)
      ) return error('conflict')
      let lineage = authorized.lineage
      let changed = false
      if (revisionData !== undefined) {
        const revisions = options.revisions?.(domain)
        if (revisions === undefined) return error('internal')
        const result = await revisions.revise({
          lineageId: lineage.lineageId,
          expectedLineageRevision: lineage.revision,
          proposalRef: deriveV2ProposalRef(lineage),
          actionId: revisionData.actionId,
          feedback: revisionData.feedback,
        })
        lineage = result.lineage
        changed = result.changed
      }
      if (endpoint === PROPOSALS_REFRESH_ENDPOINT) {
        const refreshes = options.refreshes(domain)
        if (refreshes === undefined) return error('internal')
        const result = await refreshes.refresh({
          lineageId: lineage.lineageId,
          expectedLineageRevision: lineage.revision,
          proposalRef: deriveV2ProposalRef(lineage),
        })
        lineage = result.lineage
        changed = result.changed
      }
      if (endpoint === PROPOSALS_APPROVE_ENDPOINT || endpoint === PROPOSALS_REJECT_ENDPOINT) {
        const reviews = options.reviews(domain)
        if (reviews === undefined) return error('internal')
        const result = endpoint === PROPOSALS_APPROVE_ENDPOINT
          ? await reviews.approve({
              lineageId: lineage.lineageId,
              expectedLineageRevision: lineage.revision,
              proposalRef: deriveV2ProposalRef(lineage),
            })
          : await reviews.reject({
              lineageId: lineage.lineageId,
              expectedLineageRevision: lineage.revision,
              proposalRef: deriveV2ProposalRef(lineage),
            })
        lineage = result.lineage
        changed = result.changed
      }
      const ref = deriveV2ProposalRef(lineage)
      if (endpoint === PROPOSALS_APPROVE_ENDPOINT || endpoint === PROPOSALS_RETRY_ENDPOINT) {
        const publications = options.publications(domain)
        if (publications === undefined) return error('internal')
        const request = {
          lineageId: lineage.lineageId,
          expectedLineageRevision: lineage.revision,
          proposalRef: ref,
        }
        if (endpoint === PROPOSALS_RETRY_ENDPOINT) {
          const journal = GlobalV2Schema.parse(domain.global.get()).proposalCatalogMutationJournal
          const ownsRetainedAttempt = journal?.kind === 'PUBLICATION'
            && journal.ownerId === ref.proposalId
          if (!ownsRetainedAttempt) {
            const published = await publications.publish(request)
            lineage = published.lineage
            changed = changed || published.changed
          } else {
            await publications.recover()
            const recoveredLineage = findBySubject(domain, authorized.action.subjectId)
            if (recoveredLineage === undefined) return error('internal')
            changed = changed || recoveredLineage.revision !== lineage.revision
            lineage = recoveredLineage
          }
        } else {
          const published = await publications.publish(request)
          lineage = published.lineage
          changed = changed || published.changed
        }
      }
      const finalRef = deriveV2ProposalRef(lineage)
      const state = stateOf(lineage)!
      return { ok: true, value: receiptSchema.parse({
        apiVersion: 1,
        workItemId: authorized.action.subjectId,
        workItemRevision: lineage.revision,
        proposalRef: finalRef,
        changed,
        ...state,
      }) }
    } catch (caught) {
      return mappedError(caught)
    }
  }
}

function sameRef(left: V2ProposalRef, right: V2ProposalRef): boolean {
  return left.proposalId === right.proposalId
    && left.revision === right.revision
    && left.digest === right.digest
}
