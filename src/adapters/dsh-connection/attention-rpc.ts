import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Run2skillDomain } from '../dsh-storage/types.js'
import { PurgeVisibility } from '../../application/purge/index.js'
import type { RuntimeNotices } from '../../application/capture/runtime-notices.js'
import { PUBLICATION_LIMITS } from '../../domain/publication/index.js'
import { proposalRefOf } from '../../domain/review/index.js'
import type { ObserveRpcResult, ObserveSummaryRpcHandler } from './observe-summary-rpc.js'

export const ATTENTION_ENDPOINT = 'attention'

const identity = z.string().min(1).max(256)
const requestSchema = z.object({
  apiVersion: z.literal(1),
  workspaceId: identity.optional(),
  sessionId: identity.optional(),
}).strict()

interface ProjectedAttentionAction {
  readonly actionKey: string
  readonly subjectId: string
  readonly kind: 'REVIEW_PROPOSAL' | 'RETRY_PUBLICATION'
  readonly reasonCode: string
  readonly scope: 'PROJECT' | 'USER'
  readonly availableActions: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

function actionKey(parts: readonly string[]): string {
  return `act_${createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex')}`
}

function noticeKey(parts: readonly string[]): string {
  return `notice_${createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex')}`
}

function badRequest(): ObserveRpcResult<never> {
  return { ok: false, error: { code: 'bad-request', message: 'invalid attention request', details: {} } }
}

export function createAttentionRpcHandler(
  getDomain: () => Run2skillDomain | undefined,
  notices: RuntimeNotices,
  fallback?: ObserveSummaryRpcHandler,
): ObserveSummaryRpcHandler {
  const visibilities = new WeakMap<Run2skillDomain, PurgeVisibility>()
  return async (endpoint, payload, signal) => {
    if (endpoint !== ATTENTION_ENDPOINT) {
      return fallback === undefined ? badRequest() : await fallback(endpoint, payload, signal)
    }
    const parsed = requestSchema.safeParse(payload)
    if (!parsed.success) return badRequest()
    if (signal.aborted) {
      return { ok: false, error: { code: 'cancelled', message: 'attention request cancelled', details: {} } }
    }
    const domain = getDomain()
    const workspaceId = parsed.data.workspaceId
    const actions = domain === undefined ? [] : (() => {
      let visibility = visibilities.get(domain)
      if (visibility === undefined) {
        visibility = new PurgeVisibility(domain)
        visibilities.set(domain, visibility)
      }
      return [...domain.table('work_items').entries()].flatMap<ProjectedAttentionAction>(([, item]) => {
        const review = item.review
        if (review === undefined || !visibility.workItemVisible(item)) return []
        const scope = review.proposal.persistenceScope
        if (scope === 'PROJECT' && (
          workspaceId === undefined
          || review.proposal.workspaceBinding?.workspaceId !== workspaceId
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
            kind: 'RETRY_PUBLICATION' as const,
            reasonCode: review.failure.code,
            scope,
            availableActions: ['RETRY'] as const,
            createdAt: review.proposal.createdAt,
            updatedAt: item.updatedAt,
          }]
        }
        if (
          item.processingState !== 'READY_FOR_REVIEW'
          || review.reviewDecision !== 'PENDING'
          || review.publicationOutcome !== 'PENDING_REVIEW'
        ) return []
        return [{
          actionKey: actionKey([
            'run2skill-action-v1', item.workItemId, 'REVIEW_PROPOSAL',
            'PROPOSAL_READY',
            ref.proposalId, String(ref.revision), ref.digest,
          ]),
          subjectId: item.workItemId,
          kind: 'REVIEW_PROPOSAL' as const,
          reasonCode: 'PROPOSAL_READY',
          scope,
          availableActions: review.proposal.kind === 'DISCARD'
            ? ['CONFIRM_DISCARD', 'RETRY'] as const
            : ['APPROVE', 'REJECT'] as const,
          createdAt: review.proposal.createdAt,
          updatedAt: item.updatedAt,
        }]
      }).sort((left, right) => (
        left.createdAt.localeCompare(right.createdAt) || left.actionKey.localeCompare(right.actionKey)
      ))
    })()
    const runtimeWarnings = notices.list().flatMap(notice => {
      if (
        notice.kind !== 'UNSAVED_SIGNAL'
        || !notice.requiresAttention
        || notice.signalClass === undefined
        || (notice.sessionId !== 'global' && notice.sessionId !== parsed.data.sessionId)
      ) return []
      return [{
        noticeKey: noticeKey([
          notice.healthCode,
          notice.sessionId,
          String(notice.turnEndSeq ?? ''),
          String(notice.firstObservedAt),
        ]),
        kind: 'UNSAVED_SIGNAL' as const,
        healthCode: notice.healthCode,
        signalClass: notice.signalClass,
        count: notice.count,
        message: notice.signalClass === 'EXPLICIT_SAVE'
          ? '保存请求尚未持久化，请保持 DSH 运行并稍后重试。'
          : '学习信号尚未持久化，请保持 DSH 运行并稍后重试。',
      }]
    })
    return {
      ok: true,
      value: {
        apiVersion: 1,
        userCompleteness: domain === undefined ? 'UNKNOWN' : 'KNOWN',
        projectCompleteness: workspaceId === undefined
          ? 'UNAVAILABLE'
          : domain === undefined ? 'UNKNOWN' : 'KNOWN',
        actions,
        runtimeCompleteness: notices.unsavedCompletenessKnown() ? 'KNOWN' : 'UNKNOWN',
        runtimeWarnings,
      },
    }
  }
}
