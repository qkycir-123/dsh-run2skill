import { z } from 'zod'
import { RecentSkillActivityStore } from '../dsh-storage/recent-skill-activity-store.js'
import { PurgeVisibility } from '../dsh-storage/purge-visibility.js'
import type { Run2skillDomain } from '../dsh-storage/types.js'
import {
  CurrentScopeV1Schema,
  type CurrentWorkspaceResolver,
} from './current-scope-authorizer.js'
import type { ObserveRpcResult, ObserveSummaryRpcHandler } from './observe-summary-rpc.js'

export const RECENT_SKILL_ACTIVITY_ENDPOINT = 'recent-activity/list'

const RecentSkillActivityRequestV1Schema = z.object({
  apiVersion: z.literal(1),
  currentScope: CurrentScopeV1Schema,
  expectedVisibilityRevision: z.string().regex(/^visibility_[a-f0-9]{64}$/).optional(),
}).strict()

export const RecentSkillActivityResponseV1Schema = z.object({
  apiVersion: z.literal(1),
  visibilityRevision: z.string().regex(/^visibility_[a-f0-9]{64}$/),
  items: z.array(z.object({
    activityId: z.string().regex(/^activity_[a-f0-9]{64}$/),
    skillName: z.string().min(1).max(128),
    operation: z.enum(['CREATED', 'UPDATED']),
    scope: z.enum(['PROJECT', 'USER']),
    occurredAt: z.string().datetime({ offset: true }),
  }).strict()).max(256),
}).strict()

function error(code: string, message: string): ObserveRpcResult<never> {
  return { ok: false, error: { code, message, details: {} } }
}

export function createRecentSkillActivityRpcHandler(
  getDomain: () => Run2skillDomain | undefined,
  resolveWorkspace: CurrentWorkspaceResolver,
  fallback?: ObserveSummaryRpcHandler,
  now: () => string = () => new Date().toISOString(),
): ObserveSummaryRpcHandler {
  return async (endpoint, payload, signal) => {
    if (endpoint !== RECENT_SKILL_ACTIVITY_ENDPOINT) {
      return fallback === undefined
        ? error('bad-request', 'invalid recent activity request')
        : await fallback(endpoint, payload, signal)
    }
    const parsed = RecentSkillActivityRequestV1Schema.safeParse(payload)
    if (!parsed.success) return error('bad-request', 'invalid recent activity request')
    if (signal.aborted) return error('cancelled', 'recent activity request cancelled')
    const domain = getDomain()
    if (domain === undefined) return error('unavailable', 'recent activity unavailable')
    try {
      const currentScope = parsed.data.currentScope
      const workspace = currentScope.kind === 'WORKSPACE'
        ? await resolveWorkspace(currentScope.workspaceId)
        : undefined
      if (currentScope.kind === 'WORKSPACE' && workspace === undefined) {
        return error('scope-unavailable', 'current workspace unavailable')
      }
      if (signal.aborted) return error('cancelled', 'recent activity request cancelled')
      const activities = new RecentSkillActivityStore(domain)
      try {
        await activities.reconcilePublished(now())
      } catch {
        // Reconciliation is retryable derived-state repair; existing authoritative results remain readable.
      }
      const visibility = new PurgeVisibility(domain)
      const visibilityRevision = visibility.revision()
      if (
        parsed.data.expectedVisibilityRevision !== undefined
        && parsed.data.expectedVisibilityRevision !== visibilityRevision
      ) return error('visibility-stale', 'recent activity visibility changed')
      const items = activities.list({
        now: now(),
        ...(workspace === undefined ? {} : { workspace }),
      })
      if (visibility.revision() !== visibilityRevision) {
        return error('visibility-stale', 'recent activity visibility changed')
      }
      const value = RecentSkillActivityResponseV1Schema.parse({
        apiVersion: 1,
        visibilityRevision,
        items,
      })
      return { ok: true, value }
    } catch {
      return error('internal', 'recent activity unavailable')
    }
  }
}
