import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Run2skillDomain } from '../dsh-storage/types.js'
import { PurgeVisibility } from '../../application/purge/index.js'
import type { RuntimeNotices } from '../../application/capture/runtime-notices.js'
import type { ObserveRpcResult, ObserveSummaryRpcHandler } from './observe-summary-rpc.js'
import {
  CurrentScopeAuthorizer,
  CurrentScopeAuthorizationError,
  CurrentScopeV1Schema,
  type CurrentWorkspaceResolver,
} from './current-scope-authorizer.js'

export const ATTENTION_ENDPOINT = 'attention'

const identity = z.string().min(1).max(256)
export const attentionRequestSchema = z.object({
  apiVersion: z.literal(1),
  currentScope: CurrentScopeV1Schema,
  sessionId: identity.optional(),
}).strict()

function noticeKey(parts: readonly string[]): string {
  return `notice_${createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex')}`
}

function badRequest(): ObserveRpcResult<never> {
  return { ok: false, error: { code: 'bad-request', message: 'invalid attention request', details: {} } }
}

export function createAttentionRpcHandler(
  getDomain: () => Run2skillDomain | undefined,
  notices: RuntimeNotices,
  resolveWorkspace: CurrentWorkspaceResolver = async () => undefined,
  fallback?: ObserveSummaryRpcHandler,
): ObserveSummaryRpcHandler {
  const visibilities = new WeakMap<Run2skillDomain, PurgeVisibility>()
  const authorizer = new CurrentScopeAuthorizer(resolveWorkspace)
  return async (endpoint, payload, signal) => {
    if (endpoint !== ATTENTION_ENDPOINT) {
      return fallback === undefined ? badRequest() : await fallback(endpoint, payload, signal)
    }
    const parsed = attentionRequestSchema.safeParse(payload)
    if (!parsed.success) return badRequest()
    if (signal.aborted) {
      return { ok: false, error: { code: 'cancelled', message: 'attention request cancelled', details: {} } }
    }
    const domain = getDomain()
    const projectCompleteness = parsed.data.currentScope.kind === 'USER_ONLY'
      ? 'UNAVAILABLE' as const
      : domain === undefined ? 'UNKNOWN' as const : 'KNOWN' as const
    let actions = [] as Awaited<ReturnType<CurrentScopeAuthorizer['project']>>
    if (domain !== undefined) {
      let visibility = visibilities.get(domain)
      if (visibility === undefined) {
        visibility = new PurgeVisibility(domain)
        visibilities.set(domain, visibility)
      }
      try {
        actions = await authorizer.project(domain, parsed.data.currentScope, visibility)
      } catch (caught) {
        if (caught instanceof CurrentScopeAuthorizationError) return badRequest()
        throw caught
      }
    }
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
        projectCompleteness,
        actions,
        runtimeCompleteness: notices.unsavedCompletenessKnown() ? 'KNOWN' : 'UNKNOWN',
        runtimeWarnings,
      },
    }
  }
}
