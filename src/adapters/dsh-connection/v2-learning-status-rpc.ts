import { z } from 'zod'
import type { Run2skillV2Domain } from '../dsh-storage/v2-types.js'
import { deriveProjectScopeIdentityDigest } from '../../domain/purge/index.js'
import {
  ExperienceIntentV2Schema,
  ProposalLineageV2Schema,
  SessionBatchV2Schema,
  type ExperienceIntentV2,
} from '../../domain/v2/index.js'
import { CurrentScopeV1Schema, type CurrentWorkspaceResolver } from './current-scope-authorizer.js'
import type { ObserveRpcResult, ObserveSummaryRpcHandler } from './observe-summary-rpc.js'

export const LEARNING_STATUS_ENDPOINT = 'learning/status'
export const LEARNING_REQUEST_ENDPOINT = 'learning/request'

const requestSchema = z.object({
  apiVersion: z.literal(1),
  currentScope: CurrentScopeV1Schema,
  sessionId: z.string().min(1).max(256),
}).strict()

export type LearningStatusState = 'EMPTY' | 'RECORDED' | 'PROCESSING' | 'CHECKING' | 'COVERED' | 'NEEDS_ATTENTION'

interface LearningStatusSession {
  readonly sessionId: string
  readonly workspaceBinding?: { readonly workspaceId: string; readonly canonicalPath: string }
}

export interface V2LearningStatusRpcOptions {
  readonly resolveSession: (sessionLifecycleKey: string) => LearningStatusSession | undefined
  readonly resolveWorkspace: CurrentWorkspaceResolver
  readonly requestSynthesis: (sessionLifecycleKey: string) => Promise<{
    readonly changed: boolean
    readonly disposition: 'EMPTY' | 'PROCESSING' | 'QUEUED'
  }>
}

function error(code: string, message: string): ObserveRpcResult<never> {
  return { ok: false, error: { code, message, details: {} } }
}

async function sessionMatchesCurrentScope(
  session: LearningStatusSession,
  currentScope: z.infer<typeof CurrentScopeV1Schema>,
  resolveWorkspace: CurrentWorkspaceResolver,
): Promise<boolean> {
  if (currentScope.kind === 'USER_ONLY') return session.workspaceBinding === undefined
  const binding = session.workspaceBinding
  if (binding === undefined) return false
  const workspace = await resolveWorkspace(currentScope.workspaceId)
  return workspace !== undefined
    && binding.workspaceId === workspace.workspaceId
    && deriveProjectScopeIdentityDigest(binding.canonicalPath)
      === deriveProjectScopeIdentityDigest(workspace.canonicalPath)
}

function statusForIntents(
  domain: Run2skillV2Domain,
  intents: readonly ExperienceIntentV2[],
): LearningStatusState {
  if (intents.length === 0) return 'PROCESSING'
  if (intents.some(intent => [
    'NEEDS_CONFIRMATION', 'COVERED_NEEDS_CONFIRMATION', 'NEEDS_ATTENTION',
  ].includes(intent.status))) return 'NEEDS_ATTENTION'
  if (intents.some(intent => intent.status === 'PROPOSAL_READY' && (() => {
    if (intent.lineageId === undefined) return true
    const lineage = ProposalLineageV2Schema.safeParse(domain.table('proposal_lineages').get(intent.lineageId))
    return !lineage.success || lineage.data.state === 'ACTIVE_PROPOSAL'
  })())) return 'NEEDS_ATTENTION'
  if (intents.some(intent => [
    'RECALLING', 'COVERAGE_READY', 'COVERAGE_ANALYZING', 'COVERAGE_RETRY_AUTHORIZED',
  ].includes(intent.status))) return 'CHECKING'
  if (intents.some(intent => [
    'DETECTOR_STAGED', 'READY', 'OWNERSHIP_ARBITRATING', 'RUN2SKILL_OWNED',
    'CREATE_AUTHORIZED', 'MERGE_AUTHORIZED', 'GENERATING',
  ].includes(intent.status))) return 'PROCESSING'
  if (intents.some(intent => intent.status === 'WAITING_FOR_QUIESCENCE')) return 'RECORDED'
  if (intents.every(intent => ['RESOLVED_BY_AGENT', 'COVERED'].includes(intent.status))) return 'COVERED'
  return 'EMPTY'
}

export function projectV2LearningStatus(
  domain: Run2skillV2Domain,
  sessionLifecycleKey: string,
): { readonly state: LearningStatusState; readonly canRequest: boolean } {
  const cursor = domain.global.get().sessions[sessionLifecycleKey]
  if (cursor === undefined) return { state: 'EMPTY', canRequest: false }
  const activeBatch = cursor.activeBatchId === undefined
    ? undefined
    : SessionBatchV2Schema.safeParse(domain.table('session_batches').get(cursor.activeBatchId)).data
  const pendingAfter = activeBatch?.lastTurnEndSeq ?? cursor.detectedThroughTurnEndSeq
  const canRequest = activeBatch === undefined
    && cursor.observedThroughTurnEndSeq > pendingAfter
    && cursor.manualSynthesisRequest === undefined
  if (activeBatch !== undefined) return { state: 'PROCESSING', canRequest }
  if (cursor.observedThroughTurnEndSeq > cursor.detectedThroughTurnEndSeq) {
    return { state: 'RECORDED', canRequest }
  }
  const batches = [...domain.table('session_batches').entries()].flatMap(([, raw]) => {
    const parsed = SessionBatchV2Schema.safeParse(raw)
    return parsed.success && parsed.data.sessionLifecycleKey === sessionLifecycleKey ? [parsed.data] : []
  }).sort((left, right) => right.lastTurnEndSeq - left.lastTurnEndSeq || right.updatedAt.localeCompare(left.updatedAt))
  const latest = batches[0]
  if (latest === undefined || ['COMMITTED_NONE', 'COMMITTED_DEFER'].includes(latest.state)) {
    return { state: 'EMPTY', canRequest }
  }
  if (latest.state === 'NEEDS_ATTENTION') return { state: 'NEEDS_ATTENTION', canRequest }
  const intents = [...domain.table('experience_intents').entries()].flatMap(([, raw]) => {
    const parsed = ExperienceIntentV2Schema.safeParse(raw)
    return parsed.success && parsed.data.batchId === latest.batchId ? [parsed.data] : []
  })
  return { state: statusForIntents(domain, intents), canRequest }
}

export function createV2LearningStatusRpcHandler(
  getDomain: () => Run2skillV2Domain | undefined,
  options: V2LearningStatusRpcOptions,
  fallback?: ObserveSummaryRpcHandler,
): ObserveSummaryRpcHandler {
  return async (endpoint, payload, signal) => {
    if (endpoint !== LEARNING_STATUS_ENDPOINT && endpoint !== LEARNING_REQUEST_ENDPOINT) {
      return fallback === undefined ? error('bad-request', 'invalid learning status request') : await fallback(endpoint, payload, signal)
    }
    const request = requestSchema.safeParse(payload)
    if (!request.success) return error('bad-request', 'invalid learning status request')
    if (signal.aborted) return error('cancelled', 'learning status request cancelled')
    const domain = getDomain()
    if (domain === undefined) return error('unavailable', 'learning status unavailable')
    try {
      const matches = Object.keys(domain.global.get().sessions).flatMap(sessionLifecycleKey => {
        const session = options.resolveSession(sessionLifecycleKey)
        return session?.sessionId === request.data.sessionId ? [{ sessionLifecycleKey, session }] : []
      })
      if (matches.length !== 1) return error('conflict', 'current Session unavailable')
      const match = matches[0]!
      if (!await sessionMatchesCurrentScope(
        match.session,
        request.data.currentScope,
        options.resolveWorkspace,
      )) return error('conflict', 'current Session scope changed')
      if (endpoint === LEARNING_STATUS_ENDPOINT) {
        return { ok: true, value: { apiVersion: 1, ...projectV2LearningStatus(domain, match.sessionLifecycleKey) } }
      }
      const receipt = await options.requestSynthesis(match.sessionLifecycleKey)
      return { ok: true, value: { apiVersion: 1, ...receipt } }
    } catch {
      return error('internal', 'learning status unavailable')
    }
  }
}
