import { z } from 'zod'
import { PurgeVisibility } from '../../application/purge/index.js'
import {
  isIgnoredLearningFailure,
  LearningCallV1Schema,
  LearningFailureCodeSchema,
  LearningTerminalDetailV1Schema,
} from '../../domain/learn/index.js'
import type { CaptureWorkItemV1 } from '../../domain/observe/schemas.js'
import { LearningStoreError, LearningWorkItemStore } from '../dsh-storage/learning-work-item-store.js'
import type { LearningDiagnosticStore } from '../dsh-storage/learning-diagnostic-store.js'
import type { Run2skillDomain } from '../dsh-storage/types.js'
import type { ObserveRpcResult, ObserveSummaryRpcHandler } from './observe-summary-rpc.js'
import {
  AttentionActionIdentityV1Schema,
  CurrentScopeAuthorizer,
  CurrentScopeAuthorizationError,
  CurrentScopeV1Schema,
} from './current-scope-authorizer.js'

export const LEARNING_ISSUES_LIST_ENDPOINT = 'learning/issues/list'
export const LEARNING_ISSUES_RETRY_ENDPOINT = 'learning/issues/retry'
export const LEARNING_ISSUES_DISMISS_ENDPOINT = 'learning/issues/dismiss'

const MAX_REQUEST_BYTES = 8 * 1024
const PAGE_SIZE = 20
const identity = z.string().min(1).max(256)
const workItemId = z.string().regex(/^wi_[a-f0-9]{64}$/)
const positiveSafeInteger = z.number().refine(value => Number.isSafeInteger(value) && value >= 1)
const cursor = z.string().regex(/^c_[1-9][0-9]*$/).max(32)

const listRequestSchema = z.object({
  apiVersion: z.literal(1),
  currentScope: CurrentScopeV1Schema,
  actions: z.array(AttentionActionIdentityV1Schema).max(64),
  cursor: cursor.optional(),
}).strict()
const mutationRequestShape = {
  apiVersion: z.literal(1),
  workItemId,
  workItemRevision: positiveSafeInteger,
  currentScope: CurrentScopeV1Schema,
  action: AttentionActionIdentityV1Schema,
}
const retryRequestSchema = z.object(mutationRequestShape).strict()
const dismissRequestSchema = z.object({ ...mutationRequestShape, confirm: z.literal(true) }).strict()

const listItemSchema = z.object({
  workItemId,
  workItemRevision: positiveSafeInteger,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  failureCode: LearningFailureCodeSchema,
  failureDetail: LearningTerminalDetailV1Schema.optional(),
  retryable: z.boolean(),
  attempt: z.number().int().nonnegative().max(3),
  requestBudgetUsed: z.number().int().nonnegative().max(2),
  modelRoute: z.object({ provider: identity, model: identity }).strict().optional(),
  calls: z.array(LearningCallV1Schema).max(2),
}).strict()
const listResponseSchema = z.object({
  apiVersion: z.literal(1),
  items: z.array(listItemSchema).max(PAGE_SIZE),
  nextCursor: cursor.optional(),
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
  ]),
  disposition: z.enum(['ACTIVE', 'IGNORED']),
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

function offsetOf(value: string | undefined): number | undefined {
  if (value === undefined) return 0
  const offset = Number(value.slice(2))
  return Number.isSafeInteger(offset) && offset > 0 ? offset : undefined
}

function canRetry(item: CaptureWorkItemV1): boolean {
  return item.processingState === 'NEEDS_ATTENTION'
    && item.review === undefined
    && item.learning?.failure?.retryable === true
    && item.learning.attempt < 3
    && !isIgnoredLearningFailure(item)
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
  readonly authorizer?: CurrentScopeAuthorizer
  readonly onRetry?: (workItemId: string) => void
  readonly visibility?: (domain: Run2skillDomain) => PurgeVisibility
  readonly runMutation?: <T>(operation: () => Promise<T>) => Promise<T>
  readonly diagnostics?: () => LearningDiagnosticStore | undefined
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
      if (options.authorizer === undefined) return error('internal')
      const offset = offsetOf(request.cursor)
      if (offset === undefined) return error('bad-request')
      const authorizedItems: CaptureWorkItemV1[] = []
      try {
        for (const action of request.actions) {
          if (!['RETRY_LEARNING', 'DISMISS_LEARNING'].includes(action.kind)) continue
          authorizedItems.push((await options.authorizer.authorize(
            domain, request.currentScope, action, visibilityOf(domain),
          )).item)
        }
      } catch (caught) {
        return caught instanceof CurrentScopeAuthorizationError ? error('conflict') : error('internal')
      }
      const eligible = authorizedItems.flatMap(item => {
        const learning = item.learning
        if (
          !visibilityOf(domain).workItemVisible(item)
          || item.processingState !== 'NEEDS_ATTENTION'
          || item.review !== undefined
          || learning?.failure === undefined
          || isIgnoredLearningFailure(item)
        ) return []
        const failureDetail = options.diagnostics?.()?.detailFor(item)
        return [{
          workItemId: item.workItemId,
          workItemRevision: item.revision,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          failureCode: learning.failure.code,
          ...(failureDetail === undefined ? {} : { failureDetail }),
          retryable: canRetry(item),
          attempt: learning.attempt,
          requestBudgetUsed: learning.requestBudgetUsed,
          ...(learning.modelRoute === undefined ? {} : { modelRoute: learning.modelRoute }),
          calls: learning.calls,
        }]
      }).sort((left, right) => (
        right.updatedAt.localeCompare(left.updatedAt)
        || left.workItemId.localeCompare(right.workItemId)
      ))
      if (request.cursor !== undefined && offset >= eligible.length) return error('bad-request')
      const page = eligible.slice(offset, offset + PAGE_SIZE)
      return { ok: true, value: listResponseSchema.parse({
        apiVersion: 1,
        items: page,
        ...(offset + page.length < eligible.length ? { nextCursor: `c_${offset + page.length}` } : {}),
      }) }
    }

    const request = endpoint === LEARNING_ISSUES_RETRY_ENDPOINT
      ? retryRequestSchema.parse(payload)
      : dismissRequestSchema.parse(payload)
    try {
      const result = await runMutation(async () => {
        if (options.authorizer === undefined) throw new CurrentScopeAuthorizationError('SCOPE_UNAVAILABLE')
        const requiredAction = endpoint === LEARNING_ISSUES_RETRY_ENDPOINT ? 'RETRY' : 'DISMISS'
        const authorized = await options.authorizer.authorize(
          domain, request.currentScope, request.action, visibilityOf(domain), requiredAction,
        )
        if (authorized.item.workItemId !== request.workItemId) {
          throw new CurrentScopeAuthorizationError('ACTION_STALE')
        }
        return endpoint === LEARNING_ISSUES_RETRY_ENDPOINT
          ? await storeOf(domain).retryFailed(request.workItemId, request.workItemRevision)
          : await storeOf(domain).dismissFailed(request.workItemId, request.workItemRevision)
      })
      if (endpoint === LEARNING_ISSUES_RETRY_ENDPOINT && result.changed) {
        try {
          options.onRetry?.(result.item.workItemId)
        } catch {
          // The durable authorization is authoritative; restart recovery can wake it again.
        }
      }
      return { ok: true, value: receiptSchema.parse({
        apiVersion: 1,
        workItemId: result.item.workItemId,
        workItemRevision: result.item.revision,
        changed: result.changed,
        processingState: result.item.processingState,
        disposition: isIgnoredLearningFailure(result.item) ? 'IGNORED' : 'ACTIVE',
      }) }
    } catch (caught) {
      if (caught instanceof CurrentScopeAuthorizationError) return error('conflict')
      return mappedStoreError(caught)
    }
  }
}
