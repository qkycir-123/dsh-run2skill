import { z } from 'zod'
import { PurgeVisibility } from '../../application/purge/index.js'
import { LearningCallV1Schema, LearningFailureCodeSchema } from '../../domain/learn/index.js'
import { LearningStoreError, LearningWorkItemStore } from '../dsh-storage/learning-work-item-store.js'
import type { Run2skillDomain } from '../dsh-storage/types.js'
import type { ObserveRpcResult, ObserveSummaryRpcHandler } from './observe-summary-rpc.js'

export const LEARNING_ISSUES_LIST_ENDPOINT = 'learning/issues/list'
export const LEARNING_ISSUES_RETRY_ENDPOINT = 'learning/issues/retry'
export const LEARNING_ISSUES_DISMISS_ENDPOINT = 'learning/issues/dismiss'

const MAX_REQUEST_BYTES = 8 * 1024
const PAGE_SIZE = 20
const identity = z.string().min(1).max(256)
const workItemId = z.string().regex(/^wi_[a-f0-9]{64}$/)
const positiveSafeInteger = z.number().refine(value => Number.isSafeInteger(value) && value >= 1)

const listRequestSchema = z.object({
  apiVersion: z.literal(1),
  workspaceId: identity,
}).strict()
const mutationRequestShape = {
  apiVersion: z.literal(1),
  workItemId,
  workItemRevision: positiveSafeInteger,
}
const retryRequestSchema = z.object(mutationRequestShape).strict()
const dismissRequestSchema = z.object({ ...mutationRequestShape, confirm: z.literal(true) }).strict()

const listItemSchema = z.object({
  workItemId,
  workItemRevision: positiveSafeInteger,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  failureCode: LearningFailureCodeSchema,
  retryable: z.boolean(),
  attempt: z.number().int().nonnegative().max(3),
  requestBudgetUsed: z.number().int().nonnegative().max(2),
  manualRecoveryCount: z.union([z.literal(0), z.literal(1)]),
  modelRoute: z.object({ provider: identity, model: identity }).strict().optional(),
  calls: z.array(LearningCallV1Schema).max(2),
}).strict()
const listResponseSchema = z.object({
  apiVersion: z.literal(1),
  items: z.array(listItemSchema).max(PAGE_SIZE),
}).strict()
const receiptSchema = z.object({
  apiVersion: z.literal(1),
  workItemId,
  workItemRevision: positiveSafeInteger,
  changed: z.boolean(),
  processingState: z.enum([
    'CAPTURED',
    'ANALYZING',
    'LEARNED',
    'READY_FOR_REVIEW',
    'PUBLISHING',
    'TERMINAL',
    'NEEDS_ATTENTION',
    'RESOLVED_NO_SIGNAL',
    'DISMISSED',
  ]),
}).strict()

function error(code: 'bad-request' | 'cancelled' | 'internal' | 'not-found' | 'conflict' | 'invalid-state'): ObserveRpcResult<never> {
  return { ok: false, error: { code, message: `learning attention ${code}`, details: {} } }
}

function requestFits(payload: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8') <= MAX_REQUEST_BYTES
  } catch {
    return false
  }
}

function mappedStoreError(value: unknown): ObserveRpcResult<never> {
  if (!(value instanceof LearningStoreError)) return error('internal')
  switch (value.code) {
    case 'LEARNING_WORK_ITEM_NOT_FOUND': return error('not-found')
    case 'LEARNING_REVISION_CONFLICT': return error('conflict')
    case 'INVALID_LEARNING_STATE':
    case 'LEARNING_REQUEST_BUDGET_EXHAUSTED': return error('invalid-state')
  }
}

export interface LearningAttentionRpcOptions {
  readonly onRetry?: (workItemId: string) => void
  readonly visibility?: (domain: Run2skillDomain) => PurgeVisibility
  readonly runMutation?: <T>(operation: () => Promise<T>) => Promise<T>
}

export function createLearningAttentionRpcHandler(
  getDomain: () => Run2skillDomain | undefined,
  fallback?: ObserveSummaryRpcHandler,
  options: LearningAttentionRpcOptions = {},
): ObserveSummaryRpcHandler {
  const stores = new WeakMap<Run2skillDomain, LearningWorkItemStore>()
  const visibilities = new WeakMap<Run2skillDomain, PurgeVisibility>()
  const visibilityOf = (domain: Run2skillDomain) => {
    let visibility = visibilities.get(domain)
    if (visibility === undefined) {
      visibility = options.visibility?.(domain) ?? new PurgeVisibility(domain)
      visibilities.set(domain, visibility)
    }
    return visibility
  }
  const storeOf = (domain: Run2skillDomain) => {
    let store = stores.get(domain)
    if (store === undefined) {
      store = new LearningWorkItemStore(domain, undefined, visibilityOf(domain))
      stores.set(domain, store)
    }
    return store
  }
  const runMutation = options.runMutation ?? (async <T>(operation: () => Promise<T>) => await operation())

  return async (endpoint, payload, signal) => {
    const schema = endpoint === LEARNING_ISSUES_LIST_ENDPOINT
      ? listRequestSchema
      : endpoint === LEARNING_ISSUES_RETRY_ENDPOINT
        ? retryRequestSchema
        : endpoint === LEARNING_ISSUES_DISMISS_ENDPOINT
          ? dismissRequestSchema
          : undefined
    if (schema === undefined) {
      return fallback === undefined ? error('bad-request') : await fallback(endpoint, payload, signal)
    }
    if (!requestFits(payload) || !schema.safeParse(payload).success) return error('bad-request')
    if (signal.aborted) return error('cancelled')
    const domain = getDomain()
    if (domain === undefined) return error('internal')

    if (endpoint === LEARNING_ISSUES_LIST_ENDPOINT) {
      const request = listRequestSchema.parse(payload)
      const items = [...domain.table('work_items').entries()].flatMap(([, item]) => {
        const learning = item.learning
        if (
          !visibilityOf(domain).workItemVisible(item)
          || item.processingState !== 'NEEDS_ATTENTION'
          || item.review !== undefined
          || learning?.failure === undefined
          || item.workspaceBinding.status !== 'BOUND'
          || item.workspaceBinding.workspaceId !== request.workspaceId
        ) return []
        return [{
          workItemId: item.workItemId,
          workItemRevision: item.revision,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          failureCode: learning.failure.code,
          retryable: learning.failure.retryable && (learning.manualRecoveryCount ?? 0) < 1,
          attempt: learning.attempt,
          requestBudgetUsed: learning.requestBudgetUsed,
          manualRecoveryCount: learning.manualRecoveryCount ?? 0,
          ...(learning.modelRoute === undefined ? {} : { modelRoute: learning.modelRoute }),
          calls: learning.calls,
        }]
      }).sort((left, right) => (
        right.updatedAt.localeCompare(left.updatedAt)
        || left.workItemId.localeCompare(right.workItemId)
      )).slice(0, PAGE_SIZE)
      return { ok: true, value: listResponseSchema.parse({ apiVersion: 1, items }) }
    }

    const request = endpoint === LEARNING_ISSUES_RETRY_ENDPOINT
      ? retryRequestSchema.parse(payload)
      : dismissRequestSchema.parse(payload)
    try {
      const result = await runMutation(async () => endpoint === LEARNING_ISSUES_RETRY_ENDPOINT
        ? await storeOf(domain).retryFailed(request.workItemId, request.workItemRevision)
        : await storeOf(domain).dismissFailed(request.workItemId, request.workItemRevision))
      if (endpoint === LEARNING_ISSUES_RETRY_ENDPOINT && result.changed) {
        try {
          options.onRetry?.(result.item.workItemId)
        } catch {
          // The durable recovery is authoritative; a failed wake is recovered on restart.
        }
      }
      return { ok: true, value: receiptSchema.parse({
        apiVersion: 1,
        workItemId: result.item.workItemId,
        workItemRevision: result.item.revision,
        changed: result.changed,
        processingState: result.item.processingState,
      }) }
    } catch (caught) {
      return mappedStoreError(caught)
    }
  }
}
