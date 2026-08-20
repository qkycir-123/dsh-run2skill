import type { DshSessionGapReader } from '../../adapters/dsh-session/gap-reader.js'
import { projectLearningWindow } from '../../adapters/dsh-session/learning-window.js'
import type {
  AgentScopeProjection,
  ExactAgentScopeRegistry,
} from '../../adapters/dsh-skills/exact-agent-scope.js'
import {
  LearningStoreError,
  type LearningWorkItemStore,
} from '../../adapters/dsh-storage/learning-work-item-store.js'
import type {
  LearningEnvelopeBudgetResult,
  RestrictedLearningRequest,
  RestrictedLearningResult,
} from '../../adapters/dsh-llm/restricted-learning-client.js'
import type { RuntimeNotices } from '../capture/runtime-notices.js'
import {
  buildLearningEnvelope,
  canonicalJson,
  guardLearningResult,
  recallExistingSkills,
  resolveLearningScope,
  type LearningFailureCode,
  type LearningWindowBlock,
  type LearningWindowProjection,
  type SkillCatalogPort,
  type SkillRecallObservation,
  type SkillRecallResult,
} from '../../domain/learn/index.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import type { CaptureWorkItemV1 } from '../../domain/observe/schemas.js'

export const LEARNING_ANALYSIS_DEADLINE_MS = 125_000
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const
const CATALOG_RETRY_DELAYS_MS = [250, 1_000, 4_000] as const
const RESULT_WRITE_RETRY_DELAYS_MS = [0, 1_000, 5_000] as const

type LearningAgent = object & AgentScopeProjection

export interface LearningSkillView<TAgent extends LearningAgent> {
  readonly cwd?: string
  readonly scope: TAgent
  readonly signal: AbortSignal
}

export interface RestrictedLearningClientPort {
  envelopeByteBudget(
    route: RestrictedLearningRequest['route'],
    signal?: AbortSignal,
  ): Promise<LearningEnvelopeBudgetResult>
  learn(request: RestrictedLearningRequest): Promise<RestrictedLearningResult>
}

export interface LearningWorkerOptions<TAgent extends LearningAgent> {
  readonly store: LearningWorkItemStore
  readonly sessionReader: DshSessionGapReader
  readonly scopes: ExactAgentScopeRegistry<TAgent>
  readonly skills: SkillCatalogPort<LearningSkillView<TAgent>>
  readonly client: RestrictedLearningClientPort
  readonly notices: RuntimeNotices
  readonly now?: () => number
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly onCompleted?: (item: CaptureWorkItemV1) => Promise<void>
}

class LearningInputStale extends Error {}

const RETRYABLE_FAILURES = new Set<LearningFailureCode>([
  'SESSION_LOG_UNAVAILABLE',
  'CATALOG_INCOMPLETE',
  'CANDIDATE_UNAVAILABLE',
  'MODEL_TIMEOUT',
  'MODEL_TERMINAL_FAILURE',
  'STORE_WRITE_FAILED',
])

function existingSkillBlocks(
  item: CaptureWorkItemV1,
  observation: SkillRecallObservation,
): LearningWindowBlock[] {
  return observation.candidates.flatMap((candidate, index) => {
    const rank = index + 1
    const summary = canonicalJson({
      candidateKey: candidate.candidateKey,
      candidateDigest: candidate.candidateDigest,
      source: candidate.source,
      persistenceScope: candidate.persistenceScope,
      writable: candidate.writable,
      name: candidate.name,
      description: candidate.description,
      ...(candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse }),
      bodyDigest: candidate.bodyDigest,
    })
    const body = canonicalJson({ candidateKey: candidate.candidateKey, content: candidate.content })
    const facts = {
      source: 'EXISTING_SKILL' as const,
      sessionId: item.signalKey.rootSessionId,
      turn: item.signalKey.turn,
      eventSeq: item.signalKey.turnEndSeq,
      truncated: false,
    }
    return [{
      ...facts,
      text: summary,
      digest: sha256Utf8(summary),
      retention: { kind: 'SKILL_SUMMARY' as const, rank },
    }, {
      ...facts,
      text: body,
      digest: sha256Utf8(body),
      retention: { kind: 'SKILL' as const, rank },
    }]
  })
}

function addSkillObservation(
  projection: LearningWindowProjection,
  item: CaptureWorkItemV1,
  observation: SkillRecallObservation,
): LearningWindowProjection {
  return { ...projection, blocks: [...projection.blocks, ...existingSkillBlocks(item, observation)] }
}

function nextRetryAt(now: number, attempt: number): string {
  const retryDelay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]!
  return new Date(now + retryDelay).toISOString()
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

export class LearningWorker<TAgent extends LearningAgent = LearningAgent> {
  readonly #store
  readonly #sessionReader
  readonly #scopes
  readonly #skills
  readonly #client
  readonly #notices
  readonly #now
  readonly #sleep
  readonly #onCompleted

  constructor(options: LearningWorkerOptions<TAgent>) {
    this.#store = options.store
    this.#sessionReader = options.sessionReader
    this.#scopes = options.scopes
    this.#skills = options.skills
    this.#client = options.client
    this.#notices = options.notices
    this.#now = options.now ?? Date.now
    this.#sleep = options.sleep ?? delay
    this.#onCompleted = options.onCompleted
  }

  canResolveScope(item: CaptureWorkItemV1): boolean {
    return this.#scopes.resolve(item).status === 'AVAILABLE'
  }

  async run(candidate: CaptureWorkItemV1, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    const controller = new AbortController()
    let deadlineExpired = false
    const abort = () => { controller.abort(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      deadlineExpired = true
      controller.abort(new Error('run2skill learning analysis deadline exceeded'))
    }, LEARNING_ANALYSIS_DEADLINE_MS)
    try {
      await this.#run(candidate, controller.signal, () => deadlineExpired)
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }

  async #run(
    candidate: CaptureWorkItemV1,
    signal: AbortSignal,
    deadlineExpired: () => boolean,
  ): Promise<void> {
    let current: CaptureWorkItemV1
    try {
      current = await this.#store.claim(candidate.workItemId, candidate.revision)
    } catch (error) {
      if (!(error instanceof LearningStoreError)) this.#notice('STORE_WRITE_FAILED', candidate)
      return
    }
    const attempt = current.learning?.attempt
    if (attempt === undefined) return

    const fail = async (code: LearningFailureCode, forceRetryable?: boolean): Promise<void> => {
      const retryable = forceRetryable ?? RETRYABLE_FAILURES.has(code)
      try {
        current = await this.#store.fail(
          current.workItemId,
          current.revision,
          { code, retryable, occurredAt: new Date(this.#now()).toISOString() },
          retryable ? nextRetryAt(this.#now(), attempt) : undefined,
        )
      } catch (error) {
        if (error instanceof LearningStoreError && error.code === 'LEARNING_REVISION_CONFLICT') {
          await this.#resetStale(current, attempt)
        } else {
          this.#notice('STORE_WRITE_FAILED', current)
        }
      }
    }

    try {
      const read = await this.#sessionReader.readFrom(
        current.signalKey.rootSessionId,
        0,
        signal,
      )
      if (read.status === 'UNAVAILABLE') return await fail('SESSION_LOG_UNAVAILABLE')
      const projected = projectLearningWindow(read.header, read.events, current)
      if (projected.status === 'UNAVAILABLE') return await fail(projected.failureCode)

      const scope = this.#scopes.resolve(current)
      if (scope.status === 'UNAVAILABLE') return await fail('AGENT_SCOPE_UNAVAILABLE')
      const scopeResolution = resolveLearningScope(current, scope.cwd)
      if (scopeResolution.status === 'UNAVAILABLE') return await fail(scopeResolution.failureCode)
      const view: LearningSkillView<TAgent> = {
        cwd: scopeResolution.cwd,
        scope: scope.agent,
        signal,
      }
      const recalled = await this.#recallSkills(
        view,
        current.evidenceRefs.map(evidence => evidence.excerpt).join('\n'),
        signal,
      )
      if (recalled.status === 'UNAVAILABLE') return await fail(recalled.failureCode)
      if (signal.aborted) return await fail('MODEL_ABORTED', true)

      const budget = await this.#client.envelopeByteBudget(projected.projection.route, signal)
      if (budget.status === 'FAILED') {
        return await fail(deadlineExpired() ? 'MODEL_TIMEOUT' : budget.failureCode)
      }
      const envelope = buildLearningEnvelope(
        current,
        addSkillObservation(projected.projection, current, recalled.observation),
        budget.maxBytes,
      )
      if (envelope.status === 'UNAVAILABLE') return await fail(envelope.failureCode)

      let stale = false
      const ledger: RestrictedLearningRequest['ledger'] = {
        reserve: async (_kind) => {
          try {
            current = await this.#store.reserveRequest(
              current.workItemId,
              current.revision,
              projected.projection.route,
            )
          } catch (error) {
            if (error instanceof LearningStoreError && error.code === 'LEARNING_REVISION_CONFLICT') {
              stale = true
              throw new LearningInputStale()
            }
            throw error
          }
          const ordinal = current.learning?.requestBudgetUsed
          if (ordinal !== 1 && ordinal !== 2) throw new Error('Invalid durable request ordinal')
          return { requestOrdinal: ordinal }
        },
        record: async (call) => {
          try {
            current = await this.#store.recordCall(current.workItemId, current.revision, call)
          } catch (error) {
            if (error instanceof LearningStoreError && error.code === 'LEARNING_REVISION_CONFLICT') {
              current = await this.#store.recordCallLatest(current.workItemId, attempt, call)
              stale = true
              throw new LearningInputStale()
            }
            throw error
          }
        },
      }
      let learned: RestrictedLearningResult
      try {
        learned = await this.#client.learn({
          route: projected.projection.route,
          envelope: envelope.serialized,
          workItemId: current.workItemId,
          catalogObservationDigest: recalled.observation.catalogObservationDigest,
          shortlistDigests: recalled.observation.candidates.map(item => item.candidateDigest),
          ledger,
          signal,
        })
      } catch (error) {
        if (error instanceof LearningInputStale || stale) {
          await this.#resetStale(current, attempt)
          return
        }
        this.#notice('STORE_WRITE_FAILED', current)
        return await fail('STORE_WRITE_FAILED')
      }
      if (stale) return await this.#resetStale(current, attempt)
      if (learned.status === 'FAILED') {
        const code = deadlineExpired() ? 'MODEL_TIMEOUT' : learned.failureCode
        return await fail(code, signal.aborted ? true : undefined)
      }
      const guarded = guardLearningResult({
        item: current,
        expectedScope: scopeResolution.persistenceScope,
        observation: recalled.observation,
        experiences: learned.experiences,
        proposal: learned.proposal,
      })
      if (guarded.status === 'REJECTED') {
        return await fail('LEARNING_GUARD_REJECTED')
      }

      for (const wait of RESULT_WRITE_RETRY_DELAYS_MS) {
        if (wait > 0) await this.#sleep(wait)
        try {
          current = await this.#store.complete(current.workItemId, current.revision, learned)
          try {
            await this.#onCompleted?.(current)
          } catch {
            this.#notice('CURATION_STAGE_FAILED', current)
          }
          return
        } catch (error) {
          if (error instanceof LearningStoreError && error.code === 'LEARNING_REVISION_CONFLICT') {
            await this.#resetStale(current, attempt)
            return
          }
        }
      }
      await fail('STORE_WRITE_FAILED')
    } catch (error) {
      if (error instanceof LearningInputStale) return await this.#resetStale(current, attempt)
      if (signal.aborted) return await fail(deadlineExpired() ? 'MODEL_TIMEOUT' : 'MODEL_ABORTED', true)
      this.#notice('LEARNING_WORKER_FAILED', current)
      await fail('STORE_WRITE_FAILED')
    }
  }

  async #resetStale(current: CaptureWorkItemV1, attempt: number): Promise<void> {
    try {
      await this.#store.resetStale(current.workItemId, attempt)
      this.#notice('LEARNING_INPUT_STALE', current)
    } catch {
      this.#notice('STORE_WRITE_FAILED', current)
    }
  }

  async #recallSkills(
    view: LearningSkillView<TAgent>,
    evidence: string,
    signal: AbortSignal,
  ): Promise<SkillRecallResult> {
    let result = await recallExistingSkills(this.#skills, view, evidence)
    for (const wait of CATALOG_RETRY_DELAYS_MS) {
      if (result.status !== 'UNAVAILABLE' || result.failureCode !== 'CATALOG_INCOMPLETE') return result
      if (signal.aborted) throw signal.reason
      await this.#sleep(wait)
      if (signal.aborted) throw signal.reason
      result = await recallExistingSkills(this.#skills, view, evidence)
    }
    return result
  }

  #notice(healthCode: string, item: CaptureWorkItemV1): void {
    this.#notices.record({
      healthCode,
      sessionId: item.signalKey.rootSessionId,
      turnEndSeq: item.signalKey.turnEndSeq,
    })
  }
}
