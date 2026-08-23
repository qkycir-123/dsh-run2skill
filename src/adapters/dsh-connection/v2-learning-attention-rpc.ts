import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Run2skillTable } from '../dsh-storage/types.js'
import { Run2skillV2GlobalStore } from '../dsh-storage/v2-global-store.js'
import type { Run2skillV2Domain } from '../dsh-storage/v2-types.js'
import {
  ExperienceIntentV2Schema,
  SessionBatchV2Schema,
  deriveProposalCatalogMutationAnchorV2,
  deriveProposalCatalogMutationIdV2,
  type ExperienceIntentV2,
  type SessionBatchV2,
} from '../../domain/v2/index.js'
import { deriveProjectScopeIdentityDigest } from '../../domain/purge/index.js'
import {
  AttentionActionIdentityV1Schema,
  AuthoritativeActionCursorError,
  AuthoritativeActionCursorV1Schema,
  CurrentScopeAuthorizationError,
  CurrentScopeV1Schema,
  pageAuthoritativeActions,
  type CurrentScopeV1,
  type CurrentWorkspaceResolver,
  type ProjectedAttentionAction,
} from './current-scope-authorizer.js'
import type { ObserveRpcResult, ObserveSummaryRpcHandler } from './observe-summary-rpc.js'

export const V2_LEARNING_ISSUES_LIST_ENDPOINT = 'learning/issues/list'
export const V2_LEARNING_ISSUES_RETRY_ENDPOINT = 'learning/issues/retry'
export const V2_LEARNING_ISSUES_DISMISS_ENDPOINT = 'learning/issues/dismiss'

const PAGE_SIZE = 20
const requestBytes = 8 * 1024
const positive = z.number().int().safe().positive()
const listRequest = z.object({
  apiVersion: z.literal(1),
  currentScope: CurrentScopeV1Schema,
  cursor: AuthoritativeActionCursorV1Schema.optional(),
  limit: z.number().int().positive().max(PAGE_SIZE).optional(),
}).strict()
const dismissRequest = z.object({
  apiVersion: z.literal(1),
  workItemId: z.string().regex(/^wi_[a-f0-9]{64}$/),
  workItemRevision: positive,
  currentScope: CurrentScopeV1Schema,
  action: AttentionActionIdentityV1Schema,
  confirm: z.literal(true),
}).strict()

type Subject =
  | { readonly kind: 'BATCH'; readonly batch: SessionBatchV2 }
  | { readonly kind: 'INTENT'; readonly intent: ExperienceIntentV2 }

function hash(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex')
}

function subjectId(kind: Subject['kind'], id: string): `wi_${string}` {
  return `wi_${hash(['run2skill-v2-learning-subject', kind, id])}`
}

function failure(value: Subject): string {
  if (value.kind === 'BATCH') return value.batch.detector.failureCode ?? value.batch.routeSnapshot.failureCode ?? 'BATCH_NEEDS_ATTENTION'
  const intent = value.intent
  return intent.ownership.state === 'NEEDS_CONFIRMATION'
    ? intent.ownership.reasonCode ?? 'OWNERSHIP_NEEDS_CONFIRMATION'
    : intent.recall.state === 'INCOMPLETE'
      ? intent.recall.incompleteReason ?? 'RECALL_INCOMPLETE'
      : intent.coverage.state === 'NEEDS_ATTENTION'
        ? intent.coverage.reasonCode ?? 'COVERAGE_NEEDS_ATTENTION'
        : intent.generation.state === 'NEEDS_ATTENTION'
          ? intent.generation.reasonCode ?? 'GENERATION_NEEDS_ATTENTION'
          : intent.status === 'COVERED_NEEDS_CONFIRMATION'
            ? 'COVERED_NEEDS_CONFIRMATION'
            : 'INTENT_NEEDS_ATTENTION'
}

function action(value: Subject, scope: 'PROJECT' | 'USER'): ProjectedAttentionAction {
  const revision = value.kind === 'BATCH' ? value.batch.revision : value.intent.revision
  const id = value.kind === 'BATCH' ? value.batch.batchId : value.intent.intentId
  const reasonCode = failure(value)
  const subject = subjectId(value.kind, id)
  return {
    actionKey: `act_${hash(['run2skill-v2-learning-action', subject, String(revision), reasonCode])}`,
    subjectId: subject,
    kind: 'DISMISS_LEARNING',
    reasonCode,
    scope,
    availableActions: ['DISMISS'],
    createdAt: value.kind === 'BATCH' ? value.batch.createdAt : value.intent.createdAt,
    updatedAt: value.kind === 'BATCH' ? value.batch.updatedAt : value.intent.updatedAt,
  }
}

function fits(payload: unknown): boolean {
  try { return Buffer.byteLength(JSON.stringify(payload), 'utf8') <= requestBytes } catch { return false }
}

function error(code: 'bad-request' | 'cancelled' | 'internal' | 'conflict' | 'invalid-state'): ObserveRpcResult<never> {
  return { ok: false, error: { code, message: `v2 learning attention ${code}`, details: {} } }
}

export class V2LearningAttentionService {
  readonly #global: Run2skillV2GlobalStore
  readonly #batches: Run2skillTable<string, SessionBatchV2>
  readonly #intents: Run2skillTable<string, ExperienceIntentV2>

  constructor(
    private readonly domain: Run2skillV2Domain,
    private readonly resolveWorkspace: CurrentWorkspaceResolver,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.#global = Run2skillV2GlobalStore.for(domain)
    this.#batches = domain.table('session_batches')
    this.#intents = domain.table('experience_intents')
  }

  async project(currentScope: CurrentScopeV1): Promise<readonly ProjectedAttentionAction[]> {
    const workspace = currentScope.kind === 'WORKSPACE'
      ? await this.resolveWorkspace(currentScope.workspaceId).catch(() => undefined)
      : undefined
    if (currentScope.kind === 'WORKSPACE' && workspace === undefined) {
      throw new CurrentScopeAuthorizationError('SCOPE_UNAVAILABLE')
    }
    const visibleProject = (observationIds: readonly string[]) => workspace !== undefined
      && observationIds.length > 0
      && observationIds.every(id => {
        const observation = this.domain.table('turn_observations').get(id)
        return observation?.scopeBinding.status === 'PROJECT'
          && observation.scopeBinding.workspaceId === workspace.workspaceId
          && observation.scopeBinding.scopeIdentityDigest === deriveProjectScopeIdentityDigest(workspace.canonicalPath)
      })
    const actions: ProjectedAttentionAction[] = []
    for (const [, raw] of this.#batches.entries()) {
      const parsed = SessionBatchV2Schema.safeParse(raw)
      if (!parsed.success || parsed.data.state !== 'NEEDS_ATTENTION') continue
      if (visibleProject(parsed.data.observationManifest.map(item => item.observationId))) {
        actions.push(action({ kind: 'BATCH', batch: parsed.data }, 'PROJECT'))
      }
    }
    for (const [, raw] of this.#intents.entries()) {
      const parsed = ExperienceIntentV2Schema.safeParse(raw)
      if (!parsed.success || ![
        'NEEDS_CONFIRMATION', 'COVERED_NEEDS_CONFIRMATION', 'NEEDS_ATTENTION',
      ].includes(parsed.data.status)) continue
      const scope = parsed.data.persistenceScope
      if (scope === 'PROJECT' && !visibleProject(parsed.data.evidenceRefs.map(item => item.observationId))) continue
      actions.push(action({ kind: 'INTENT', intent: parsed.data }, scope))
    }
    return actions.sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt) || left.actionKey.localeCompare(right.actionKey)
    ))
  }

  handler(fallback?: ObserveSummaryRpcHandler): ObserveSummaryRpcHandler {
    return async (endpoint, payload, signal) => {
      if (![V2_LEARNING_ISSUES_LIST_ENDPOINT, V2_LEARNING_ISSUES_DISMISS_ENDPOINT, V2_LEARNING_ISSUES_RETRY_ENDPOINT].includes(endpoint)) {
        return fallback === undefined ? error('bad-request') : await fallback(endpoint, payload, signal)
      }
      if (!fits(payload) || signal.aborted) return signal.aborted ? error('cancelled') : error('bad-request')
      if (endpoint === V2_LEARNING_ISSUES_RETRY_ENDPOINT) return error('invalid-state')
      if (endpoint === V2_LEARNING_ISSUES_LIST_ENDPOINT) return await this.#list(payload)
      return await this.#dismiss(payload)
    }
  }

  async recover(): Promise<void> {
    const journal = this.#global.get().proposalCatalogMutationJournal
    if (journal?.kind !== 'USER_ACTION') return
    const intent = ExperienceIntentV2Schema.safeParse(this.#intents.get(journal.ownerId))
    if (intent.success && intent.data.status === 'DISCARDED') await this.#finalizeIntentDismiss(intent.data)
    else await this.#global.runExclusive(async current => {
      if (current.proposalCatalogMutationJournal?.kind !== 'USER_ACTION') return { value: undefined }
      const { proposalCatalogMutationJournal: _journal, ...stable } = current
      return { value: undefined, global: stable }
    })
  }

  async #list(payload: unknown): Promise<ObserveRpcResult<unknown>> {
    const request = listRequest.safeParse(payload)
    if (!request.success) return error('bad-request')
    try {
      const queue = await this.project(request.data.currentScope)
      const page = pageAuthoritativeActions(
        'LEARNING', request.data.currentScope, queue, request.data.cursor, request.data.limit ?? PAGE_SIZE,
      )
      const items = page.page.map(projected => {
        const subject = this.#find(projected.subjectId)
        if (subject === undefined) throw new CurrentScopeAuthorizationError('ACTION_STALE')
        const calls = subject.kind === 'BATCH'
          ? subject.batch.detector.calls.map(call => ({
              requestOrdinal: 1,
              kind: 'DETECTION',
              outcome: call.outcome,
            }))
          : subject.intent.stageCalls.slice(-2).map((call, index) => ({
              requestOrdinal: index + 1,
              kind: call.stage,
              outcome: call.outcome,
            }))
        const route = subject.kind === 'BATCH'
          ? subject.batch.routeSnapshot
          : subject.intent.stageCalls.at(-1)
        return {
          workItemId: projected.subjectId,
          workItemRevision: subject.kind === 'BATCH' ? subject.batch.revision : subject.intent.revision,
          createdAt: projected.createdAt,
          updatedAt: projected.updatedAt,
          failureCode: projected.reasonCode,
          retryable: false,
          attempt: Math.min(3, calls.length),
          requestBudgetUsed: Math.min(2, calls.length),
          ...(route === undefined ? {} : { modelRoute: { provider: route.provider, model: route.model } }),
          calls,
        }
      })
      return { ok: true, value: {
        apiVersion: 1,
        items,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      } }
    } catch (caught) {
      return caught instanceof AuthoritativeActionCursorError ? error('bad-request') : error('conflict')
    }
  }

  async #dismiss(payload: unknown): Promise<ObserveRpcResult<unknown>> {
    const request = dismissRequest.safeParse(payload)
    if (!request.success) return error('bad-request')
    try {
      const projected = (await this.project(request.data.currentScope)).find(candidate => (
        candidate.actionKey === request.data.action.actionKey
        && candidate.subjectId === request.data.action.subjectId
        && candidate.kind === request.data.action.kind
      ))
      if (projected === undefined || !projected.availableActions.includes('DISMISS')) {
        throw new CurrentScopeAuthorizationError('ACTION_STALE')
      }
      const subject = this.#find(projected.subjectId)
      if (subject === undefined) throw new CurrentScopeAuthorizationError('ACTION_STALE')
      const revision = subject.kind === 'BATCH' ? subject.batch.revision : subject.intent.revision
      if (revision !== request.data.workItemRevision || projected.subjectId !== request.data.workItemId) {
        throw new CurrentScopeAuthorizationError('ACTION_STALE')
      }
      if (subject.kind === 'BATCH') {
        if (this.#global.get().purgeJournal !== undefined) throw new CurrentScopeAuthorizationError('ACTION_STALE')
        const current = this.#batches.get(subject.batch.batchId)
        if (current?.revision !== revision || current.state !== 'NEEDS_ATTENTION') {
          throw new CurrentScopeAuthorizationError('ACTION_STALE')
        }
        await this.#batches.delete(subject.batch.batchId)
        return { ok: true, value: {
          apiVersion: 1, workItemId: projected.subjectId, workItemRevision: revision,
          changed: true, processingState: 'TERMINAL', disposition: 'IGNORED',
        } }
      }
      await this.#dismissIntent(subject.intent)
      return { ok: true, value: {
        apiVersion: 1, workItemId: projected.subjectId, workItemRevision: revision + 1,
        changed: true, processingState: 'TERMINAL', disposition: 'IGNORED',
      } }
    } catch {
      return error('conflict')
    }
  }

  async #dismissIntent(expected: ExperienceIntentV2): Promise<void> {
    await this.#global.runExclusive(async current => {
      const journal = current.proposalCatalogMutationJournal
      if (journal !== undefined) {
        if (journal.kind === 'USER_ACTION' && journal.ownerId === expected.intentId) return { value: undefined }
        throw new CurrentScopeAuthorizationError('ACTION_STALE')
      }
      if (current.purgeJournal !== undefined) throw new CurrentScopeAuthorizationError('ACTION_STALE')
      if (current.proposalGenerationLease !== undefined && current.proposalGenerationLease.ownerIntentId !== expected.intentId) {
        throw new CurrentScopeAuthorizationError('ACTION_STALE')
      }
      const mutationId = deriveProposalCatalogMutationIdV2({
        ownerId: expected.intentId,
        kind: 'USER_ACTION',
        inputCatalogEpoch: current.proposalCatalogEpoch,
      })
      return { value: undefined, global: {
        ...current,
        proposalCatalogMutationJournal: {
          schemaVersion: 1,
          mutationId,
          ownerId: expected.intentId,
          kind: 'USER_ACTION',
          phase: 'PREPARED',
          preparedAt: this.now(),
        },
      } }
    })
    try {
      const updated = await this.#intents.update(expected.intentId, raw => {
        const current = ExperienceIntentV2Schema.parse(raw)
        if (current.revision !== expected.revision || ![
          'NEEDS_CONFIRMATION', 'COVERED_NEEDS_CONFIRMATION', 'NEEDS_ATTENTION',
        ].includes(current.status)) throw new CurrentScopeAuthorizationError('ACTION_STALE')
        const revision = current.revision + 1
        const { lineageId: _lineageId, duplicateBarrier: _barrier, ...stable } = current
        return ExperienceIntentV2Schema.parse({
          ...stable,
          revision,
          status: 'DISCARDED',
          generation: {
            state: 'NOT_STARTED',
            userRetryUsed: current.generation.userRetryUsed,
            staleRefreshUsed: current.generation.staleRefreshUsed,
            receipts: [],
          },
          reasonReceipts: [...current.reasonReceipts, {
            revision,
            reasonCode: current.generation.state === 'NEEDS_ATTENTION' ? 'DISMISS_GENERATION' : 'CONFIRM_DISCARD',
            recordedAt: this.now(),
          }],
          updatedAt: this.now(),
        })
      })
      await this.#finalizeIntentDismiss(updated)
    } catch (caught) {
      await this.recover()
      throw caught
    }
  }

  async #finalizeIntentDismiss(intent: ExperienceIntentV2): Promise<void> {
    await this.#global.runExclusive(async current => {
      const journal = current.proposalCatalogMutationJournal
      if (journal?.kind !== 'USER_ACTION' || journal.ownerId !== intent.intentId) return { value: undefined }
      const key = Object.entries(current.behaviorSignatureIndex).find(([, entry]) => entry.ownerIntentId === intent.intentId)?.[0]
      const behaviorSignatureIndex = key === undefined
        ? current.behaviorSignatureIndex
        : Object.fromEntries(Object.entries(current.behaviorSignatureIndex).filter(([candidate]) => candidate !== key))
      if (
        current.proposalGenerationLease !== undefined
        && current.proposalGenerationLease.ownerIntentId !== intent.intentId
      ) throw new CurrentScopeAuthorizationError('ACTION_STALE')
      const {
        proposalCatalogMutationJournal: _journal,
        proposalGenerationLease: _lease,
        ...stable
      } = current
      return { value: undefined, global: {
        ...stable,
        behaviorSignatureIndex,
        proposalCatalogEpoch: current.proposalCatalogEpoch + 1,
        proposalCatalogLastMutation: deriveProposalCatalogMutationAnchorV2({
          ownerId: intent.intentId,
          kind: 'USER_ACTION',
          inputCatalogEpoch: current.proposalCatalogEpoch,
        }),
      } }
    })
  }

  #find(id: string): Subject | undefined {
    for (const [, raw] of this.#batches.entries()) {
      const parsed = SessionBatchV2Schema.safeParse(raw)
      if (parsed.success && subjectId('BATCH', parsed.data.batchId) === id) return { kind: 'BATCH', batch: parsed.data }
    }
    for (const [, raw] of this.#intents.entries()) {
      const parsed = ExperienceIntentV2Schema.safeParse(raw)
      if (parsed.success && subjectId('INTENT', parsed.data.intentId) === id) return { kind: 'INTENT', intent: parsed.data }
    }
    return undefined
  }
}
