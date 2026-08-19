import { z } from 'zod'
import { ProposalReviewStore, ProposalReviewStoreError } from '../dsh-storage/proposal-review-store.js'
import type { Run2skillDomain } from '../dsh-storage/types.js'
import { ExperienceRecordV1Schema } from '../../domain/learn/index.js'
import { EvidenceRefSchema } from '../../domain/observe/schemas.js'
import {
  ProposalRefV1Schema,
  ProposalSnapshotV1Schema,
  proposalRefOf,
} from '../../domain/review/index.js'
import type { ObserveRpcResult, ObserveSummaryRpcHandler } from './observe-summary-rpc.js'

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

const listRequestSchema = z.object({
  apiVersion: z.literal(1),
  workspaceId: identity,
  cursor: z.string().regex(/^c_[0-9]+$/).max(32).optional(),
}).strict()
const summaryRequestSchema = z.object({ apiVersion: z.literal(1), workspaceId: identity }).strict()

const getRequestSchema = z.object({ apiVersion: z.literal(1), proposalId }).strict()

const mutationRequestShape = {
  apiVersion: z.literal(1),
  workItemId,
  workItemRevision: positiveSafeInteger,
  proposalRef: ProposalRefV1Schema,
}
const mutationRequestSchema = z.object(mutationRequestShape).strict()
const rejectRequestSchema = z.object({ ...mutationRequestShape, confirm: z.literal(true) }).strict()

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

const listResponseSchema = z.object({
  apiVersion: z.literal(1),
  items: z.array(listItemSchema).max(PAGE_SIZE),
  nextCursor: z.string().regex(/^c_[0-9]+$/).optional(),
}).strict()
const summaryResponseSchema = z.object({
  apiVersion: z.literal(1),
  pendingReview: z.number().int().nonnegative(),
  publishing: z.number().int().nonnegative(),
  needsAttention: z.number().int().nonnegative(),
}).strict()

const detailResponseSchema = z.object({
  apiVersion: z.literal(1),
  workItemId,
  workItemRevision: positiveSafeInteger,
  processingState: z.enum(['READY_FOR_REVIEW', 'PUBLISHING', 'NEEDS_ATTENTION', 'TERMINAL']),
  reviewDecision: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
  publicationOutcome: z.enum([
    'PENDING_REVIEW', 'DISCARDED', 'NEEDS_ATTENTION', 'NEEDS_REFRESH', 'PUBLISHED', 'PUBLISH_FAILED',
  ]),
  proposal: ProposalSnapshotV1Schema,
  evidenceRefs: z.array(EvidenceRefSchema),
  experiences: z.array(ExperienceRecordV1Schema),
}).strict()

const receiptSchema = z.object({
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

function offsetOf(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return 0
  const value = Number(cursor.slice(2))
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function mutationReceipt(result: Awaited<ReturnType<ProposalReviewStore['approve']>>) {
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
  if (!(value instanceof ProposalReviewStoreError)) return error('internal')
  switch (value.code) {
    case 'REVIEW_WORK_ITEM_NOT_FOUND': return error('not-found')
    case 'REVIEW_REVISION_CONFLICT':
    case 'STALE_PROPOSAL_REF': return error('conflict')
    case 'INVALID_PROPOSAL_SNAPSHOT':
    case 'INVALID_REVIEW_STATE': return error('invalid-state')
  }
}

export function createProposalReviewRpcHandler(
  getDomain: () => Run2skillDomain | undefined,
): ObserveSummaryRpcHandler {
  const stores = new WeakMap<Run2skillDomain, ProposalReviewStore>()
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
    const domain = getDomain()
    if (domain === undefined) return error('internal')

    if (endpoint === PROPOSAL_SUMMARY_ENDPOINT) {
      const request = summaryRequestSchema.parse(payload)
      const items = [...domain.table('work_items').entries()].map(([, item]) => item).filter(item => (
        item.review !== undefined
        && item.processingState !== 'TERMINAL'
        && (
          item.review.proposal.persistenceScope === 'USER'
          || item.review.proposal.workspaceBinding?.workspaceId === request.workspaceId
        )
      ))
      return { ok: true, value: summaryResponseSchema.parse({
        apiVersion: 1,
        pendingReview: items.filter(item => item.processingState === 'READY_FOR_REVIEW').length,
        publishing: items.filter(item => item.processingState === 'PUBLISHING').length,
        needsAttention: items.filter(item => item.processingState === 'NEEDS_ATTENTION').length,
      }) }
    }

    if (endpoint === PROPOSALS_LIST_ENDPOINT) {
      const request = listRequestSchema.parse(payload)
      const offset = offsetOf(request.cursor)
      if (offset === undefined) return error('bad-request')
      const eligible = [...domain.table('work_items').entries()].flatMap(([id, item]) => {
        const review = item.review
        if (
          review === undefined
          || item.processingState === 'TERMINAL'
          || (
            review.proposal.persistenceScope === 'PROJECT'
            && review.proposal.workspaceBinding?.workspaceId !== request.workspaceId
          )
        ) return []
        return [{ id, item, review }]
      }).sort((left, right) => (
        right.review.proposal.createdAt.localeCompare(left.review.proposal.createdAt)
        || left.review.proposal.proposalId.localeCompare(right.review.proposal.proposalId)
      ))
      const page = eligible.slice(offset, offset + PAGE_SIZE)
      return { ok: true, value: listResponseSchema.parse({
        apiVersion: 1,
        items: page.map(({ id, item, review }) => ({
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
        ...(offset + page.length < eligible.length ? { nextCursor: `c_${offset + page.length}` } : {}),
      }) }
    }

    if (endpoint === PROPOSALS_GET_ENDPOINT) {
      const request = getRequestSchema.parse(payload)
      const item = [...domain.table('work_items').entries()]
        .map(([, candidate]) => candidate)
        .find(candidate => candidate.review?.proposal.proposalId === request.proposalId)
      if (item?.review === undefined) return error('not-found')
      return { ok: true, value: detailResponseSchema.parse({
        apiVersion: 1,
        workItemId: item.workItemId,
        workItemRevision: item.revision,
        processingState: item.processingState,
        reviewDecision: item.review.reviewDecision,
        publicationOutcome: item.review.publicationOutcome,
        proposal: item.review.proposal,
        evidenceRefs: item.evidenceRefs,
        experiences: item.learning?.experiences ?? [],
      }) }
    }

    const request = endpoint === PROPOSALS_REJECT_ENDPOINT
      ? rejectRequestSchema.parse(payload)
      : mutationRequestSchema.parse(payload)
    let store = stores.get(domain)
    if (store === undefined) {
      store = new ProposalReviewStore(domain)
      stores.set(domain, store)
    }
    try {
      const result = endpoint === PROPOSALS_APPROVE_ENDPOINT
        ? await store.approve(request.workItemId, request.workItemRevision, request.proposalRef)
        : endpoint === PROPOSALS_REJECT_ENDPOINT
          ? await store.reject(request.workItemId, request.workItemRevision, request.proposalRef)
          : endpoint === PROPOSALS_RETRY_ENDPOINT
            ? await store.requestCoverageRetry(request.workItemId, request.workItemRevision, request.proposalRef)
            : await store.confirmCoverage(request.workItemId, request.workItemRevision, request.proposalRef)
      return { ok: true, value: mutationReceipt(result) }
    } catch (caught) {
      return mappedStoreError(caught)
    }
  }
}
