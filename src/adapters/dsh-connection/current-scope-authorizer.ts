import { createHash } from 'node:crypto'
import { normalize, resolve } from 'node:path'
import { z } from 'zod'
import { PurgeVisibility } from '../../application/purge/index.js'
import { intendedLearningPersistenceScope, isIgnoredLearningFailure } from '../../domain/learn/index.js'
import type { CaptureWorkItemV1 } from '../../domain/observe/schemas.js'
import { PUBLICATION_LIMITS } from '../../domain/publication/index.js'
import { proposalRefOf } from '../../domain/review/index.js'
import type { Run2skillDomain } from '../dsh-storage/types.js'

const identity = z.string().min(1).max(256)
const positiveSafeInteger = z.number().refine(value => Number.isSafeInteger(value) && value >= 1)
const workItemId = z.string().regex(/^wi_[a-f0-9]{64}$/)
const actionKeySchema = z.string().regex(/^act_[a-f0-9]{64}$/)
const proposalRefSchema = z.object({
  proposalId: z.string().regex(/^prop_[a-f0-9]{64}$/),
  revision: positiveSafeInteger,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export const CurrentScopeV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('USER_ONLY'), generation: positiveSafeInteger }).strict(),
  z.object({
    kind: z.literal('WORKSPACE'),
    generation: positiveSafeInteger,
    workspaceId: identity,
  }).strict(),
])

export const AttentionActionIdentityV1Schema = z.object({
  actionKey: actionKeySchema,
  subjectId: workItemId,
  kind: z.enum(['REVIEW_PROPOSAL', 'RETRY_PUBLICATION', 'RETRY_LEARNING', 'DISMISS_LEARNING']),
  proposalRef: proposalRefSchema.optional(),
}).strict()

export const AuthoritativeActionCursorV1Schema = z.string()
  .regex(/^c_[1-9][0-9]*_[1-9][0-9]*_[a-f0-9]{64}$/)
  .max(96)

export type CurrentScopeV1 = z.infer<typeof CurrentScopeV1Schema>
export type AttentionActionIdentityV1 = z.infer<typeof AttentionActionIdentityV1Schema>
export type AuthoritativeActionLane = 'PROPOSAL' | 'LEARNING'

export interface ProjectedAttentionAction extends AttentionActionIdentityV1 {
  readonly reasonCode: string
  readonly scope: 'PROJECT' | 'USER'
  readonly availableActions: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

export type CurrentWorkspaceResolver = (workspaceId: string) => Promise<{
  readonly workspaceId: string
  readonly canonicalPath: string
} | undefined>

export class CurrentScopeAuthorizationError extends Error {
  constructor(readonly code: 'SCOPE_UNAVAILABLE' | 'ACTION_STALE') {
    super(code)
    this.name = 'CurrentScopeAuthorizationError'
  }
}

export class AuthoritativeActionCursorError extends Error {
  constructor(readonly code: 'OUT_OF_RANGE') {
    super(code)
    this.name = 'AuthoritativeActionCursorError'
  }
}

function sameWorkspacePath(left: string, right: string): boolean {
  const a = normalize(resolve(left))
  const b = normalize(resolve(right))
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function actionKey(parts: readonly string[]): string {
  return `act_${createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex')}`
}

function sameProposalRef(
  left: AttentionActionIdentityV1['proposalRef'],
  right: AttentionActionIdentityV1['proposalRef'],
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined
      && left.proposalId === right.proposalId
      && left.revision === right.revision
      && left.digest === right.digest
}

function sameIdentity(left: AttentionActionIdentityV1, right: AttentionActionIdentityV1): boolean {
  return left.actionKey === right.actionKey
    && left.subjectId === right.subjectId
    && left.kind === right.kind
    && sameProposalRef(left.proposalRef, right.proposalRef)
}

function actionQueueDigest(
  lane: AuthoritativeActionLane,
  currentScope: CurrentScopeV1,
  actions: readonly ProjectedAttentionAction[],
): string {
  const hash = createHash('sha256')
  hash.update('run2skill-authoritative-action-page-v1\u0000', 'utf8')
  hash.update(`${lane}\u0000${currentScope.kind}\u0000${currentScope.generation}\u0000`, 'utf8')
  hash.update(currentScope.kind === 'WORKSPACE' ? currentScope.workspaceId : 'USER_ONLY', 'utf8')
  for (const action of actions) {
    const ref = action.proposalRef
    hash.update('\u0000', 'utf8')
    hash.update([
      action.actionKey,
      action.subjectId,
      action.kind,
      ref?.proposalId ?? '',
      ref === undefined ? '' : String(ref.revision),
      ref?.digest ?? '',
    ].join('\u0000'), 'utf8')
  }
  return hash.digest('hex')
}

export function pageAuthoritativeActions(
  lane: AuthoritativeActionLane,
  currentScope: CurrentScopeV1,
  actions: readonly ProjectedAttentionAction[],
  cursor: string | undefined,
  pageSize: number,
): { readonly page: readonly ProjectedAttentionAction[]; readonly nextCursor?: string } {
  const digest = actionQueueDigest(lane, currentScope, actions)
  let offset = 0
  if (cursor !== undefined) {
    const parsed = AuthoritativeActionCursorV1Schema.safeParse(cursor)
    if (!parsed.success) throw new AuthoritativeActionCursorError('OUT_OF_RANGE')
    const match = /^c_([1-9][0-9]*)_([1-9][0-9]*)_([a-f0-9]{64})$/.exec(cursor)!
    offset = Number(match[1])
    const generation = Number(match[2])
    if (generation !== currentScope.generation || match[3] !== digest) {
      throw new CurrentScopeAuthorizationError('ACTION_STALE')
    }
    if (!Number.isSafeInteger(offset) || offset >= actions.length) {
      throw new AuthoritativeActionCursorError('OUT_OF_RANGE')
    }
  }
  const page = actions.slice(offset, offset + pageSize)
  const nextOffset = offset + page.length
  return {
    page,
    ...(nextOffset < actions.length
      ? { nextCursor: `c_${nextOffset}_${currentScope.generation}_${digest}` }
      : {}),
  }
}

export class CurrentScopeAuthorizer {
  constructor(private readonly resolveWorkspace: CurrentWorkspaceResolver) {}

  async project(
    domain: Run2skillDomain,
    currentScope: CurrentScopeV1,
    visibility: PurgeVisibility,
  ): Promise<readonly ProjectedAttentionAction[]> {
    const workspace = currentScope.kind === 'USER_ONLY'
      ? undefined
      : await this.resolveWorkspace(currentScope.workspaceId).catch(() => undefined)
    if (currentScope.kind === 'WORKSPACE' && workspace === undefined) {
      throw new CurrentScopeAuthorizationError('SCOPE_UNAVAILABLE')
    }
    return [...domain.table('work_items').entries()].flatMap<ProjectedAttentionAction>(([, item]) => {
      if (!visibility.workItemVisible(item)) return []
      const review = item.review
      if (review === undefined) {
        const learning = item.learning
        const failure = learning?.failure
        const scope = intendedLearningPersistenceScope(item)
        if (
          item.processingState !== 'NEEDS_ATTENTION'
          || learning === undefined
          || failure === undefined
          || isIgnoredLearningFailure(item)
          || scope === undefined
          || (scope === 'PROJECT' && (
            workspace === undefined
            || item.workspaceBinding.status !== 'BOUND'
            || item.workspaceBinding.workspaceId !== workspace.workspaceId
            || !sameWorkspacePath(item.workspaceBinding.canonicalPath, workspace.canonicalPath)
          ))
        ) return []
        const retryable = failure.retryable && learning.attempt < 3
        const kind = retryable ? 'RETRY_LEARNING' as const : 'DISMISS_LEARNING' as const
        const callsSummary = JSON.stringify([...learning.calls]
          .sort((left, right) => left.requestOrdinal - right.requestOrdinal)
          .map(call => ({
            requestOrdinal: call.requestOrdinal,
            kind: call.kind,
            inputTokens: call.inputTokens ?? null,
            outputTokens: call.outputTokens ?? null,
            outcome: call.outcome,
          })))
        return [{
          actionKey: actionKey([
            'run2skill-action-v1', item.workItemId, kind, failure.code,
            failure.occurredAt, String(learning.attempt), String(learning.requestBudgetUsed), callsSummary,
          ]),
          subjectId: item.workItemId,
          kind,
          reasonCode: failure.code,
          scope,
          availableActions: retryable ? ['RETRY', 'DISMISS'] : ['DISMISS'],
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        }]
      }
      const scope = review.proposal.persistenceScope
      if (scope === 'PROJECT' && (
        workspace === undefined
        || review.proposal.workspaceBinding?.workspaceId !== workspace.workspaceId
        || !sameWorkspacePath(review.proposal.workspaceBinding.canonicalPath, workspace.canonicalPath)
      )) return []
      const ref = proposalRefOf(review.proposal)
      if (
        item.processingState === 'NEEDS_ATTENTION'
        && review.reviewDecision === 'APPROVED'
        && review.publicationOutcome === 'PUBLISH_FAILED'
        && review.failure?.retryable === true
        && item.publication !== undefined
        && item.publication.attemptCount < PUBLICATION_LIMITS.maxAttempts
      ) {
        const journalTail = item.publication.journal.at(-1)
        if (journalTail === undefined) return []
        return [{
          actionKey: actionKey([
            'run2skill-action-v1', item.workItemId, 'RETRY_PUBLICATION', review.failure.code,
            item.publication.activeAttemptId, journalTail.digest, review.failure.occurredAt,
          ]),
          subjectId: item.workItemId,
          kind: 'RETRY_PUBLICATION',
          reasonCode: review.failure.code,
          scope,
          availableActions: ['RETRY'],
          createdAt: review.proposal.createdAt,
          updatedAt: item.updatedAt,
          proposalRef: ref,
        }]
      }
      if (
        item.processingState !== 'READY_FOR_REVIEW'
        || review.reviewDecision !== 'PENDING'
        || review.publicationOutcome !== 'PENDING_REVIEW'
      ) return []
      return [{
        actionKey: actionKey([
          'run2skill-action-v1', item.workItemId, 'REVIEW_PROPOSAL', 'PROPOSAL_READY',
          ref.proposalId, String(ref.revision), ref.digest,
        ]),
        subjectId: item.workItemId,
        kind: 'REVIEW_PROPOSAL',
        reasonCode: 'PROPOSAL_READY',
        scope,
        availableActions: review.proposal.kind === 'DISCARD' ? ['CONFIRM_DISCARD', 'RETRY'] : ['APPROVE', 'REJECT'],
        createdAt: review.proposal.createdAt,
        updatedAt: item.updatedAt,
        proposalRef: ref,
      }]
    }).sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt) || left.actionKey.localeCompare(right.actionKey)
    ))
  }

  async authorize(
    domain: Run2skillDomain,
    currentScope: CurrentScopeV1,
    requested: AttentionActionIdentityV1,
    visibility: PurgeVisibility,
    requiredAction?: string,
  ): Promise<{ readonly item: CaptureWorkItemV1; readonly action: ProjectedAttentionAction }> {
    const actions = await this.project(domain, currentScope, visibility)
    const action = actions.find(candidate => sameIdentity(candidate, requested))
    if (action === undefined || (requiredAction !== undefined && !action.availableActions.includes(requiredAction))) {
      throw new CurrentScopeAuthorizationError('ACTION_STALE')
    }
    const item = domain.table('work_items').get(action.subjectId)
    if (item === undefined || !visibility.workItemVisible(item)) {
      throw new CurrentScopeAuthorizationError('ACTION_STALE')
    }
    return { item, action }
  }
}
