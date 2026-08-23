import { z } from 'zod'
import { ProposalReviewStore, ProposalReviewStoreError } from '../dsh-storage/proposal-review-store.js'
import { PublicationSagaStore, PublicationSagaStoreError } from '../dsh-storage/publication-saga-store.js'
import type { Run2skillDomain } from '../dsh-storage/types.js'
import { ExperienceRecordV1Schema } from '../../domain/learn/index.js'
import { EvidenceRefSchema, type CaptureWorkItemV1 } from '../../domain/observe/schemas.js'
import {
  ProposalRefV1Schema,
  proposalRefOf,
} from '../../domain/review/index.js'
import type { ProposalSnapshotV1 } from '../../domain/review/index.js'
import type { ObserveRpcResult, ObserveSummaryRpcHandler } from './observe-summary-rpc.js'
import { PurgeVisibility } from '../../application/purge/index.js'
import {
  AttentionActionIdentityV1Schema,
  AuthoritativeActionCursorError,
  AuthoritativeActionCursorV1Schema,
  CurrentScopeAuthorizer,
  CurrentScopeAuthorizationError,
  CurrentScopeV1Schema,
  pageAuthoritativeActions,
} from './current-scope-authorizer.js'

export const PROPOSALS_LIST_ENDPOINT = 'proposals/list'
export const PROPOSAL_SUMMARY_ENDPOINT = 'summary'
export const PROPOSALS_GET_ENDPOINT = 'proposals/get'
export const PROPOSALS_APPROVE_ENDPOINT = 'proposals/approve'
export const PROPOSALS_REJECT_ENDPOINT = 'proposals/reject'
export const PROPOSALS_RETRY_ENDPOINT = 'proposals/retry'
export const COVERAGE_CONFIRM_DISCARD_ENDPOINT = 'coverage/confirm-discard'

const MAX_REQUEST_BYTES = 8 * 1024
const PAGE_SIZE = 20
const identity = z.string().min(1).max(256)
const workItemId = z.string().regex(/^wi_[a-f0-9]{64}$/)
const proposalId = z.string().regex(/^prop_[a-f0-9]{64}$/)
const positiveSafeInteger = z.number().refine(value => Number.isSafeInteger(value) && value >= 1)
const safeNonNegativeInteger = z.number().refine(value => Number.isSafeInteger(value) && value >= 0)

export const listRequestSchema = z.object({
  apiVersion: z.literal(1),
  currentScope: CurrentScopeV1Schema,
  cursor: AuthoritativeActionCursorV1Schema.optional(),
  limit: z.number().int().positive().max(PAGE_SIZE).optional(),
}).strict()
export const summaryRequestSchema = z.object({ apiVersion: z.literal(1), workspaceId: identity }).strict()

export const getRequestSchema = z.object({
  apiVersion: z.literal(1),
  currentScope: CurrentScopeV1Schema,
  action: AttentionActionIdentityV1Schema,
  proposalId,
}).strict()

const mutationRequestShape = {
  apiVersion: z.literal(1),
  workItemId,
  workItemRevision: positiveSafeInteger,
  proposalRef: ProposalRefV1Schema,
  currentScope: CurrentScopeV1Schema,
  action: AttentionActionIdentityV1Schema,
}
export const mutationRequestSchema = z.object(mutationRequestShape).strict()
export const rejectRequestSchema = z.object({ ...mutationRequestShape, confirm: z.literal(true) }).strict()

const listItemSchema = z.object({
  workItemId,
  workItemRevision: positiveSafeInteger,
  proposalRef: ProposalRefV1Schema,
  kind: z.enum(['CREATE', 'MERGE', 'DISCARD']),
  name: z.string().min(1).max(128),
  description: z.string().min(1),
  persistenceScope: z.enum(['PROJECT', 'USER']),
  createdAt: z.string().datetime({ offset: true }),
  processingState: z.enum(['READY_FOR_REVIEW', 'PUBLISHING', 'NEEDS_ATTENTION']),
  publicationOutcome: z.enum(['PENDING_REVIEW', 'NEEDS_ATTENTION', 'NEEDS_REFRESH', 'PUBLISH_FAILED']),
}).strict()

export const listResponseSchema = z.object({
  apiVersion: z.literal(1),
  items: z.array(listItemSchema).max(PAGE_SIZE),
  nextCursor: AuthoritativeActionCursorV1Schema.optional(),
}).strict()
export const summaryResponseSchema = z.object({
  apiVersion: z.literal(1),
  status: z.enum(['READY', 'RECOVERING', 'DEGRADED', 'INCOMPATIBLE']),
  recoveryLag: z.boolean(),
  lastHealthCode: z.string().regex(/^[A-Z0-9_]+$/).optional(),
  queue: z.discriminatedUnion('completeness', [
    z.object({
      completeness: z.literal('KNOWN'),
      pendingReview: z.number().int().nonnegative(),
      publishing: z.number().int().nonnegative(),
      needsAttention: z.number().int().nonnegative(),
    }).strict(),
    z.object({ completeness: z.literal('UNKNOWN') }).strict(),
  ]),
}).strict()

const safeRootBindingSchema = z.object({
  state: z.enum(['EXISTING', 'ABSENT']),
  scope: z.enum(['PROJECT', 'USER']),
  expectedProvider: identity,
  expectedSource: z.enum(['project-dsh', 'user-dsh']),
  resolverVersion: identity,
  rootContractVersion: identity,
  resolutionContractDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
const safeActionBindingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('CREATE'),
    rootBinding: safeRootBindingSchema,
    targetBinding: z.object({ skillName: identity }).strict(),
    expectedAbsence: z.object({ observedAt: z.string().min(1).max(64) }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('MERGE'),
    rootBinding: safeRootBindingSchema,
    targetBinding: z.object({ skillName: identity }).strict(),
    baseBinding: z.object({
      candidateKey: z.string().regex(/^cand_[a-f0-9]{64}$/),
      exactBytes: z.string().min(1).max(65_536),
      bytesDigest: z.string().regex(/^[a-f0-9]{64}$/),
      observedAt: z.string().min(1).max(64),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('DISCARD'),
    coveringCandidateBinding: z.object({
      candidateKey: z.string().regex(/^cand_[a-f0-9]{64}$/),
      name: z.string().min(1).max(128),
      source: identity,
      content: z.string().min(1).max(65_536),
      contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
      observedAt: z.string().min(1).max(64),
    }).strict(),
  }).strict(),
])
export const safeProposalSchema = z.object({
  schemaVersion: z.literal(1), revision: positiveSafeInteger,
  createdAt: z.string().min(1).max(64),
  sourceLearningProposalId: z.string().regex(/^lp_[a-f0-9]{64}$/),
  kind: z.enum(['CREATE', 'MERGE', 'DISCARD']),
  name: z.string().min(1).max(128), description: z.string().min(1).max(2_048),
  whenToUse: z.string().min(1).max(4_096),
  invocation: z.object({ modelInvocable: z.literal(true), userInvocable: z.literal(false) }).strict(),
  exactSkillBytes: z.string().min(1).max(65_536),
  skillBytesDigest: z.string().regex(/^[a-f0-9]{64}$/), rendererVersion: identity,
  persistenceScope: z.enum(['PROJECT', 'USER']),
  workspaceBinding: z.object({ workspaceId: identity }).strict().optional(),
  dshHomeBinding: z.object({
    resolutionKind: z.enum(['CONFIGURATION', 'ENVIRONMENT', 'DEFAULT']),
    identityDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
  supportingExperienceIds: z.array(z.string().regex(/^exp_[a-f0-9]{64}$/)).min(1).max(3),
  catalogObservationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  curationRationale: z.string().min(1).max(4_096),
  actionBinding: safeActionBindingSchema,
  proposalId, digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export const detailResponseSchema = z.object({
  apiVersion: z.literal(1),
  workItemId,
  workItemRevision: positiveSafeInteger,
  processingState: z.enum(['READY_FOR_REVIEW', 'PUBLISHING', 'NEEDS_ATTENTION', 'TERMINAL']),
  reviewDecision: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
  publicationOutcome: z.enum([
    'PENDING_REVIEW', 'DISCARDED', 'NEEDS_ATTENTION', 'NEEDS_REFRESH', 'PUBLISHED', 'PUBLISH_FAILED',
  ]),
  proposal: safeProposalSchema,
  sessionCoordinate: z.object({
    rootSessionId: identity,
    sessionCreatedAt: safeNonNegativeInteger,
    turn: safeNonNegativeInteger,
    turnEndSeq: safeNonNegativeInteger,
  }).strict(),
  evidenceRefs: z.array(EvidenceRefSchema),
  experiences: z.array(ExperienceRecordV1Schema),
}).strict()

export const receiptSchema = z.object({
  apiVersion: z.literal(1),
  workItemId,
  workItemRevision: positiveSafeInteger,
  proposalRef: ProposalRefV1Schema,
  changed: z.boolean(),
  processingState: z.enum(['READY_FOR_REVIEW', 'PUBLISHING', 'NEEDS_ATTENTION', 'TERMINAL']),
  reviewDecision: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
  publicationOutcome: z.enum([
    'PENDING_REVIEW', 'DISCARDED', 'NEEDS_ATTENTION', 'NEEDS_REFRESH', 'PUBLISHED', 'PUBLISH_FAILED',
  ]),
}).strict()

function error(code: 'bad-request' | 'cancelled' | 'internal' | 'not-found' | 'conflict' | 'invalid-state'): ObserveRpcResult<never> {
  return { ok: false, error: { code, message: `proposal review ${code}`, details: {} } }
}

function requestFits(payload: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8') <= MAX_REQUEST_BYTES
  } catch {
    return false
  }
}

function mutationReceipt(result: { readonly item: CaptureWorkItemV1; readonly changed: boolean }) {
  const review = result.item.review!
  return receiptSchema.parse({
    apiVersion: 1,
    workItemId: result.item.workItemId,
    workItemRevision: result.item.revision,
    proposalRef: proposalRefOf(review.proposal),
    changed: result.changed,
    processingState: result.item.processingState,
    reviewDecision: review.reviewDecision,
    publicationOutcome: review.publicationOutcome,
  })
}

function mappedStoreError(value: unknown): ObserveRpcResult<never> {
  if (value instanceof PublicationSagaStoreError) {
    switch (value.code) {
      case 'PUBLICATION_WORK_ITEM_NOT_FOUND': return error('not-found')
      case 'PUBLICATION_REVISION_CONFLICT':
      case 'STALE_PROPOSAL_REF': return error('conflict')
      case 'INVALID_PUBLICATION_STATE':
      case 'LINEAGE_CONFLICT':
      case 'PUBLICATION_RETRY_LIMIT': return error('invalid-state')
    }
  }
  if (!(value instanceof ProposalReviewStoreError)) return error('internal')
  switch (value.code) {
    case 'REVIEW_WORK_ITEM_NOT_FOUND': return error('not-found')
    case 'REVIEW_REVISION_CONFLICT':
    case 'STALE_PROPOSAL_REF': return error('conflict')
    case 'INVALID_PROPOSAL_SNAPSHOT':
    case 'INVALID_REVIEW_STATE': return error('invalid-state')
  }
}

export interface ProposalReviewRpcOptions {
  readonly authorizer?: CurrentScopeAuthorizer
  readonly onPublicationRequested?: (workItemId: string) => void
  readonly visibility?: (domain: Run2skillDomain) => PurgeVisibility
  readonly runMutation?: <T>(operation: () => Promise<T>) => Promise<T>
}

function safeProposal(proposal: ProposalSnapshotV1): z.infer<typeof safeProposalSchema> {
  const rootBinding = proposal.actionBinding.kind === 'DISCARD' ? undefined : {
    state: proposal.actionBinding.rootBinding.state,
    scope: proposal.actionBinding.rootBinding.scope,
    expectedProvider: proposal.actionBinding.rootBinding.expectedProvider,
    expectedSource: proposal.actionBinding.rootBinding.expectedSource,
    resolverVersion: proposal.actionBinding.rootBinding.resolverVersion,
    rootContractVersion: proposal.actionBinding.rootBinding.rootContractVersion,
    resolutionContractDigest: proposal.actionBinding.rootBinding.resolutionContractDigest,
  }
  const actionBinding = proposal.actionBinding.kind === 'CREATE'
    ? {
        kind: 'CREATE' as const,
        rootBinding: rootBinding!,
        targetBinding: { skillName: proposal.name },
        expectedAbsence: { observedAt: proposal.actionBinding.expectedAbsence.observedAt },
      }
    : proposal.actionBinding.kind === 'MERGE'
      ? {
          kind: 'MERGE' as const,
          rootBinding: rootBinding!,
          targetBinding: { skillName: proposal.name },
          baseBinding: {
            candidateKey: proposal.actionBinding.baseBinding.candidateKey,
            exactBytes: proposal.actionBinding.baseBinding.exactBytes,
            bytesDigest: proposal.actionBinding.baseBinding.bytesDigest,
            observedAt: proposal.actionBinding.baseBinding.observedAt,
          },
        }
      : {
          kind: 'DISCARD' as const,
          coveringCandidateBinding: {
            candidateKey: proposal.actionBinding.coveringCandidateBinding.candidateKey,
            name: proposal.actionBinding.coveringCandidateBinding.name,
            source: proposal.actionBinding.coveringCandidateBinding.source,
            content: proposal.actionBinding.coveringCandidateBinding.content,
            contentDigest: proposal.actionBinding.coveringCandidateBinding.contentDigest,
            observedAt: proposal.actionBinding.coveringCandidateBinding.observedAt,
          },
        }
  return safeProposalSchema.parse({
    schemaVersion: proposal.schemaVersion,
    revision: proposal.revision,
    createdAt: proposal.createdAt,
    sourceLearningProposalId: proposal.sourceLearningProposalId,
    kind: proposal.kind,
    name: proposal.name,
    description: proposal.description,
    whenToUse: proposal.whenToUse,
    invocation: proposal.invocation,
    exactSkillBytes: proposal.exactSkillBytes,
    skillBytesDigest: proposal.skillBytesDigest,
    rendererVersion: proposal.rendererVersion,
    persistenceScope: proposal.persistenceScope,
    ...(proposal.workspaceBinding === undefined ? {} : {
      workspaceBinding: { workspaceId: proposal.workspaceBinding.workspaceId },
    }),
    ...(proposal.dshHomeBinding === undefined ? {} : {
      dshHomeBinding: {
        resolutionKind: proposal.dshHomeBinding.resolutionKind,
        identityDigest: proposal.dshHomeBinding.identityDigest,
      },
    }),
    supportingExperienceIds: proposal.supportingExperienceIds,
    catalogObservationDigest: proposal.catalogObservationDigest,
    curationRationale: proposal.curationRationale,
    actionBinding,
    proposalId: proposal.proposalId,
    digest: proposal.digest,
  })
}

export function createProposalReviewRpcHandler(
  getDomain: () => Run2skillDomain | undefined,
  readHealth: () => {
    readonly status: 'READY' | 'RECOVERING' | 'DEGRADED' | 'INCOMPATIBLE'
    readonly recoveryLag: boolean
    readonly lastHealthCode?: string | undefined
  } = () => ({ status: 'READY', recoveryLag: false }),
  options: ProposalReviewRpcOptions = {},
): ObserveSummaryRpcHandler {
  const stores = new WeakMap<Run2skillDomain, ProposalReviewStore>()
  const publicationStores = new WeakMap<Run2skillDomain, PublicationSagaStore>()
  const visibilities = new WeakMap<Run2skillDomain, PurgeVisibility>()
  const visibilityOf = (domain: Run2skillDomain): PurgeVisibility => {
    let visibility = visibilities.get(domain)
    if (visibility === undefined) {
      visibility = options.visibility?.(domain) ?? new PurgeVisibility(domain)
      visibilities.set(domain, visibility)
    }
    return visibility
  }
  const runMutation = options.runMutation ?? (async <T>(operation: () => Promise<T>) => await operation())
  return async (endpoint, payload, signal) => {
    if (!requestFits(payload)) return error('bad-request')
    const schema = endpoint === PROPOSAL_SUMMARY_ENDPOINT
      ? summaryRequestSchema
      : endpoint === PROPOSALS_LIST_ENDPOINT
      ? listRequestSchema
      : endpoint === PROPOSALS_GET_ENDPOINT
        ? getRequestSchema
        : endpoint === PROPOSALS_REJECT_ENDPOINT
          ? rejectRequestSchema
          : [
              PROPOSALS_APPROVE_ENDPOINT,
              PROPOSALS_RETRY_ENDPOINT,
              COVERAGE_CONFIRM_DISCARD_ENDPOINT,
            ].includes(endpoint)
            ? mutationRequestSchema
            : undefined
    if (schema === undefined) return error('bad-request')
    const parsed = schema.safeParse(payload)
    if (!parsed.success) return error('bad-request')
    if (signal.aborted) return error('cancelled')
    if (endpoint === PROPOSAL_SUMMARY_ENDPOINT) {
      const request = summaryRequestSchema.parse(payload)
      let health: ReturnType<typeof readHealth>
      try {
        health = readHealth()
      } catch {
        return error('internal')
      }
      const domain = getDomain()
      if (domain === undefined) {
        return { ok: true, value: summaryResponseSchema.parse({
          apiVersion: 1,
          ...health,
          queue: { completeness: 'UNKNOWN' },
        }) }
      }
      const items = [...domain.table('work_items').entries()].map(([, item]) => item).filter(item => (
        visibilityOf(domain).workItemVisible(item)
        &&
        item.review !== undefined
        && item.processingState !== 'TERMINAL'
        && (
          item.review.proposal.persistenceScope === 'USER'
          || item.review.proposal.workspaceBinding?.workspaceId === request.workspaceId
        )
      ))
      return { ok: true, value: summaryResponseSchema.parse({
        apiVersion: 1,
        ...health,
        queue: {
          completeness: 'KNOWN',
          pendingReview: items.filter(item => item.processingState === 'READY_FOR_REVIEW').length,
          publishing: items.filter(item => item.processingState === 'PUBLISHING').length,
          needsAttention: items.filter(item => item.processingState === 'NEEDS_ATTENTION').length,
        },
      }) }
    }

    const domain = getDomain()
    if (domain === undefined) return error('internal')

    if (endpoint === PROPOSALS_LIST_ENDPOINT) {
      const request = listRequestSchema.parse(payload)
      if (options.authorizer === undefined) return error('internal')
      let page: ReturnType<typeof pageAuthoritativeActions>
      try {
        const queue = (await options.authorizer.project(
          domain, request.currentScope, visibilityOf(domain),
        )).filter(action => action.kind === 'REVIEW_PROPOSAL' || action.kind === 'RETRY_PUBLICATION')
          .sort((left, right) => (
            right.createdAt.localeCompare(left.createdAt) || left.actionKey.localeCompare(right.actionKey)
          ))
        page = pageAuthoritativeActions(
          'PROPOSAL', request.currentScope, queue, request.cursor, request.limit ?? PAGE_SIZE,
        )
      } catch (caught) {
        if (caught instanceof CurrentScopeAuthorizationError) return error('conflict')
        return caught instanceof AuthoritativeActionCursorError ? error('bad-request') : error('internal')
      }
      const items = [] as Array<{
        id: string
        item: CaptureWorkItemV1
        review: NonNullable<CaptureWorkItemV1['review']>
      }>
      for (const action of page.page) {
        const item = domain.table('work_items').get(action.subjectId)
        if (item?.review === undefined || item.processingState === 'TERMINAL') return error('conflict')
        items.push({ id: item.workItemId, item, review: item.review })
      }
      return { ok: true, value: listResponseSchema.parse({
        apiVersion: 1,
        items: items.map(({ id, item, review }) => ({
          workItemId: id,
          workItemRevision: item.revision,
          proposalRef: proposalRefOf(review.proposal),
          kind: review.proposal.kind,
          name: review.proposal.name,
          description: review.proposal.description,
          persistenceScope: review.proposal.persistenceScope,
          createdAt: review.proposal.createdAt,
          processingState: item.processingState,
          publicationOutcome: review.publicationOutcome,
        })),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      }) }
    }

    if (endpoint === PROPOSALS_GET_ENDPOINT) {
      const request = getRequestSchema.parse(payload)
      if (options.authorizer === undefined) return error('internal')
      let item: CaptureWorkItemV1
      try {
        item = (await options.authorizer.authorize(
          domain, request.currentScope, request.action, visibilityOf(domain),
        )).item
      } catch (caught) {
        return caught instanceof CurrentScopeAuthorizationError ? error('conflict') : error('internal')
      }
      if (item.review?.proposal.proposalId !== request.proposalId) return error('conflict')
      if (item?.review === undefined) return error('not-found')
      return { ok: true, value: detailResponseSchema.parse({
        apiVersion: 1,
        workItemId: item.workItemId,
        workItemRevision: item.revision,
        processingState: item.processingState,
        reviewDecision: item.review.reviewDecision,
        publicationOutcome: item.review.publicationOutcome,
        proposal: safeProposal(item.review.proposal),
        sessionCoordinate: {
          rootSessionId: item.signalKey.rootSessionId,
          sessionCreatedAt: item.signalKey.sessionCreatedAt,
          turn: item.signalKey.turn,
          turnEndSeq: item.signalKey.turnEndSeq,
        },
        evidenceRefs: item.evidenceRefs,
        experiences: item.learning?.experiences ?? [],
      }) }
    }

    const request = endpoint === PROPOSALS_REJECT_ENDPOINT
      ? rejectRequestSchema.parse(payload)
      : mutationRequestSchema.parse(payload)
    try {
      const result = await runMutation(async () => {
        if (options.authorizer === undefined) throw new CurrentScopeAuthorizationError('SCOPE_UNAVAILABLE')
        const requiredAction = endpoint === PROPOSALS_APPROVE_ENDPOINT
          ? 'APPROVE'
          : endpoint === PROPOSALS_REJECT_ENDPOINT
            ? 'REJECT'
            : endpoint === COVERAGE_CONFIRM_DISCARD_ENDPOINT
              ? 'CONFIRM_DISCARD'
              : 'RETRY'
        const authorized = await options.authorizer.authorize(
          domain, request.currentScope, request.action, visibilityOf(domain), requiredAction,
        )
        if (authorized.item.workItemId !== request.workItemId) {
          throw new CurrentScopeAuthorizationError('ACTION_STALE')
        }
        const currentVisible = domain.table('work_items').get(request.workItemId)
        if (currentVisible === undefined || !visibilityOf(domain).workItemVisible(currentVisible)) {
          throw new ProposalReviewStoreError('REVIEW_WORK_ITEM_NOT_FOUND')
        }
        let store = stores.get(domain)
        if (store === undefined) {
          store = new ProposalReviewStore(domain, undefined, visibilityOf(domain))
          stores.set(domain, store)
        }
        let mutationResult: { readonly item: CaptureWorkItemV1; readonly changed: boolean }
        if (endpoint === PROPOSALS_APPROVE_ENDPOINT) {
          mutationResult = await store.approve(request.workItemId, request.workItemRevision, request.proposalRef)
        } else if (endpoint === PROPOSALS_RETRY_ENDPOINT) {
          const current = domain.table('work_items').get(request.workItemId)
          const currentRef = current?.review === undefined
            ? undefined
            : proposalRefOf(current.review.proposal)
          const sameProposal = currentRef !== undefined
            && currentRef.proposalId === request.proposalRef.proposalId
            && currentRef.revision === request.proposalRef.revision
            && currentRef.digest === request.proposalRef.digest
          if (
            current?.review?.reviewDecision === 'APPROVED'
            && current.review.publicationOutcome === 'PUBLISH_FAILED'
          ) {
            let publications = publicationStores.get(domain)
            if (publications === undefined) {
              publications = new PublicationSagaStore(domain, undefined, visibilityOf(domain))
              publicationStores.set(domain, publications)
            }
            mutationResult = {
              item: await publications.retry(
                request.workItemId,
                request.workItemRevision,
                request.proposalRef,
              ),
              changed: true,
            }
          } else if (
            current?.processingState === 'PUBLISHING'
            && current.review?.reviewDecision === 'APPROVED'
            && current.review.publicationOutcome === 'PENDING_REVIEW'
            && (current.publication?.attemptCount ?? 0) > 1
            && sameProposal
          ) {
            mutationResult = { item: current, changed: false }
          } else {
            mutationResult = await store.requestCoverageRetry(
              request.workItemId,
              request.workItemRevision,
              request.proposalRef,
            )
          }
        } else {
          mutationResult = endpoint === PROPOSALS_REJECT_ENDPOINT
            ? await store.reject(request.workItemId, request.workItemRevision, request.proposalRef)
            : await store.confirmCoverage(request.workItemId, request.workItemRevision, request.proposalRef)
        }
        return mutationResult
      })
      if (result.item.processingState === 'PUBLISHING') {
        try {
          options.onPublicationRequested?.(result.item.workItemId)
        } catch {
          // The approval is durable; a failed wake must not rewrite the RPC result.
        }
      }
      return { ok: true, value: mutationReceipt(result) }
    } catch (caught) {
      if (caught instanceof CurrentScopeAuthorizationError) return error('conflict')
      return mappedStoreError(caught)
    }
  }
}
