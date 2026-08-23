import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Run2skillV2Domain } from '../dsh-storage/v2-types.js'
import { deriveProjectScopeIdentityDigest } from '../../domain/purge/index.js'
import { GlobalV2Schema, ProposalLineageV2Schema } from '../../domain/v2/index.js'
import {
  CurrentScopeV1Schema,
  type CurrentWorkspaceResolver,
} from './current-scope-authorizer.js'
import {
  RECENT_SKILL_ACTIVITY_ENDPOINT,
  RecentSkillActivityResponseV1Schema,
} from './recent-skill-activity-rpc.js'
import type { ObserveRpcResult, ObserveSummaryRpcHandler } from './observe-summary-rpc.js'

const requestSchema = z.object({
  apiVersion: z.literal(1),
  currentScope: CurrentScopeV1Schema,
  expectedVisibilityRevision: z.string().regex(/^visibility_[a-f0-9]{64}$/).optional(),
}).strict()

const MAX_AGE_MS = 7 * 24 * 60 * 60_000

function error(code: string, message: string): ObserveRpcResult<never> {
  return { ok: false, error: { code, message, details: {} } }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function activityId(lineageId: string, revision: number, publishedAt: string): `activity_${string}` {
  return `activity_${digest(['run2skill-v2-activity', lineageId, revision, publishedAt])}`
}

export function createV2RecentSkillActivityRpcHandler(
  getDomain: () => Run2skillV2Domain | undefined,
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
    const request = requestSchema.safeParse(payload)
    if (!request.success) return error('bad-request', 'invalid recent activity request')
    if (signal.aborted) return error('cancelled', 'recent activity request cancelled')
    const domain = getDomain()
    if (domain === undefined) return error('unavailable', 'recent activity unavailable')
    try {
      const workspace = request.data.currentScope.kind === 'WORKSPACE'
        ? await resolveWorkspace(request.data.currentScope.workspaceId)
        : undefined
      if (request.data.currentScope.kind === 'WORKSPACE' && workspace === undefined) {
        return error('scope-unavailable', 'current workspace unavailable')
      }
      const cutoff = Date.parse(now()) - MAX_AGE_MS
      const items = [...domain.table('proposal_lineages').entries()].flatMap(([, raw]) => {
        const parsed = ProposalLineageV2Schema.safeParse(raw)
        if (!parsed.success || parsed.data.origin !== 'RUN2SKILL_V2' || parsed.data.state !== 'PUBLISHED') return []
        const lineage = parsed.data
        const proposal = lineage.proposalRevisions.at(-1)
        if (proposal?.publishedAt === undefined || Date.parse(proposal.publishedAt) < cutoff) return []
        if (lineage.persistenceScope === 'PROJECT' && (
          workspace === undefined
          || proposal.projectScopeBinding?.workspaceId !== workspace.workspaceId
          || proposal.projectScopeBinding.scopeIdentityDigest
            !== deriveProjectScopeIdentityDigest(workspace.canonicalPath)
        )) return []
        return [{
          activityId: activityId(lineage.lineageId, proposal.revision, proposal.publishedAt),
          skillName: proposal.body.name,
          operation: proposal.action === 'CREATE' ? 'CREATED' as const : 'UPDATED' as const,
          scope: lineage.persistenceScope,
          occurredAt: proposal.publishedAt,
        }]
      }).sort((left, right) => (
        right.occurredAt.localeCompare(left.occurredAt) || left.activityId.localeCompare(right.activityId)
      )).slice(0, 256)
      const global = GlobalV2Schema.parse(domain.global.get())
      const visibilityRevision = `visibility_${digest({
        catalogEpoch: global.proposalCatalogEpoch,
        purge: global.purgeJournal ?? null,
        items,
      })}`
      if (
        request.data.expectedVisibilityRevision !== undefined
        && request.data.expectedVisibilityRevision !== visibilityRevision
      ) return error('visibility-stale', 'recent activity visibility changed')
      return { ok: true, value: RecentSkillActivityResponseV1Schema.parse({
        apiVersion: 1,
        visibilityRevision,
        items,
      }) }
    } catch {
      return error('internal', 'recent activity unavailable')
    }
  }
}
