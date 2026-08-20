import { describe, expect, it, vi } from 'vitest'
import { DshSessionGapReader } from '../src/adapters/dsh-session/gap-reader.js'
import { ExactAgentScopeRegistry } from '../src/adapters/dsh-skills/exact-agent-scope.js'
import { LearningWorkItemStore } from '../src/adapters/dsh-storage/learning-work-item-store.js'
import { LearningWorker, type RestrictedLearningClientPort } from '../src/application/learn/learning-worker.js'
import {
  materializeModelLearningOutput,
  type ModelLearningOutputV1,
} from '../src/domain/learn/index.js'
import { RuntimeNotices } from '../src/application/capture/runtime-notices.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { makeLearningSessionFixture } from './support/learning-session-fixture.js'

const NOW = '2026-08-20T00:00:00.000Z'

function rawOutput(item: ReturnType<typeof makeLearningSessionFixture>['item']): ModelLearningOutputV1 {
  return {
    experiences: [{
      type: 'WORKFLOW',
      lesson: 'Run focused verification before the full suite.',
      persistenceScope: 'PROJECT',
      evidenceStrength: 'HIGH',
      supportingEvidence: [{
        messageSeq: item.evidenceRefs[0]!.messageSeq,
        excerptDigest: item.evidenceRefs[0]!.excerptDigest,
      }],
    }],
    proposal: {
      policyVersion: 'learning-v1',
      name: 'focused-verification',
      description: 'Run focused verification first.',
      whenToUse: 'Use after changing a narrow implementation unit.',
      content: '# Focused verification\n\nRun the focused test, then the full suite.',
      invocation: { modelInvocable: true, userInvocable: false },
      persistenceScope: 'PROJECT',
      curation: { decision: 'CREATE', rationale: 'No existing Skill matched.' },
    },
  }
}

function setup(options: {
  sessionAvailable?: boolean
  registerScope?: boolean
  beforeRecord?: () => void
  resultScope?: 'PROJECT' | 'USER'
  learnThrows?: boolean
  catalogIncompleteCalls?: number
  modelFails?: boolean
} = {}) {
  const fixture = makeLearningSessionFixture()
  const item = {
    ...fixture.item,
    workspaceBinding: {
      status: 'BOUND' as const,
      workspaceId: 'workspace-1',
      canonicalPath: 'D:\\canonical-workspace',
      observedAt: NOW,
    },
  }
  const domain = createMemoryRun2skillDomain()
  domain.workItems.set(item.workItemId, item)
  const store = new LearningWorkItemStore(domain, () => NOW)
  const sessionReader = new DshSessionGapReader({
    async listSnapshots() { return [] },
    async readFrom() {
      if (options.sessionAvailable === false) throw new Error('session unavailable')
      return { meta: fixture.header, events: fixture.events }
    },
  })
  const agent = { id: fixture.header.id, session: { header: fixture.header } }
  const scopes = new ExactAgentScopeRegistry<typeof agent>()
  if (options.registerScope !== false) scopes.register(agent)
  const learn = vi.fn<RestrictedLearningClientPort['learn']>(async (request) => {
    if (options.learnThrows === true) throw new Error('synthetic client failure')
    const reservation = await request.ledger.reserve('PRIMARY')
    options.beforeRecord?.()
    await request.ledger.record({
      requestOrdinal: reservation.requestOrdinal,
      kind: 'PRIMARY', inputTokens: 12, outputTokens: 8,
      outcome: options.modelFails === true ? 'FAILED' : 'SUCCEEDED',
    })
    if (options.modelFails === true) {
      return { status: 'FAILED' as const, failureCode: 'MODEL_TERMINAL_FAILURE' }
    }
    const output = rawOutput(item)
    if (options.resultScope !== undefined) {
      output.experiences[0]!.persistenceScope = options.resultScope
      output.proposal.persistenceScope = options.resultScope
    }
    return {
      status: 'SUCCEEDED' as const,
      ...materializeModelLearningOutput(output, {
        workItemId: item.workItemId,
        catalogObservationDigest: request.catalogObservationDigest,
        shortlistDigests: request.shortlistDigests,
      }),
    }
  })
  const client: RestrictedLearningClientPort = {
    envelopeByteBudget: async () => ({ status: 'AVAILABLE', maxBytes: 48 * 1024 }),
    learn,
  }
  let snapshotCalls = 0
  const snapshot = vi.fn(async (_view: object) => ({
    skills: [],
    complete: ++snapshotCalls > (options.catalogIncompleteCalls ?? 0),
  }))
  const sleeps: number[] = []
  const onCompleted = vi.fn(async () => undefined)
  const worker = new LearningWorker({
    store,
    sessionReader,
    scopes,
    skills: {
      snapshot,
      get: async () => undefined,
    },
    client,
    notices: new RuntimeNotices({ now: () => Date.parse(NOW) }),
    now: () => Date.parse(NOW),
    sleep: async milliseconds => { sleeps.push(milliseconds) },
    onCompleted,
  })
  return { fixture, item, domain, store, scopes, client, learn, snapshot, sleeps, onCompleted, worker }
}

describe('LearningWorker', () => {
  it('orchestrates the exact Session, Agent scope, Skill view, Envelope, guard, and durable result', async () => {
    const { item, domain, learn, snapshot, onCompleted, worker } = setup()

    await worker.run(item, new AbortController().signal, { automaticLearning: true })

    expect(domain.workItems.get(item.workItemId)).toMatchObject({
      processingState: 'LEARNED',
      learning: {
        attempt: 1,
        requestBudgetUsed: 1,
        modelRoute: { provider: 'target-provider', model: 'target-model-last' },
        calls: [{ requestOrdinal: 1, inputTokens: 12, outputTokens: 8, outcome: 'SUCCEEDED' }],
      },
    })
    const request = learn.mock.calls[0]![0]
    expect(request.route).toEqual({ provider: 'target-provider', model: 'target-model-last' })
    expect(request.envelope).toContain('USER_EVIDENCE')
    expect(request.envelope).not.toContain('future-provider')
    expect(snapshot.mock.calls[0]?.[0]).toMatchObject({ cwd: 'D:\\canonical-workspace' })
    expect(onCompleted).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: item.workItemId,
      processingState: 'LEARNED',
    }))
  })

  it('persists a retryable pre-model failure without consuming request budget', async () => {
    const { item, domain, worker } = setup({ sessionAvailable: false })

    await worker.run(item, new AbortController().signal, { automaticLearning: true })

    expect(domain.workItems.get(item.workItemId)).toMatchObject({
      processingState: 'CAPTURED',
      learning: {
        attempt: 1,
        requestBudgetUsed: 0,
        nextEligibleAt: '2026-08-20T00:00:01.000Z',
        failure: { code: 'SESSION_LOG_UNAVAILABLE', retryable: true },
      },
    })
  })

  it('does not strand ANALYZING when the restricted client throws', async () => {
    const { item, domain, worker } = setup({ learnThrows: true })

    await worker.run(item, new AbortController().signal, { automaticLearning: true })

    expect(domain.workItems.get(item.workItemId)).toMatchObject({
      processingState: 'CAPTURED',
      learning: {
        attempt: 1,
        requestBudgetUsed: 0,
        failure: { code: 'STORE_WRITE_FAILED', retryable: true },
      },
    })
  })

  it('keeps the effective model route with a failed durable call', async () => {
    const { item, domain, worker } = setup({ modelFails: true })

    await worker.run(item, new AbortController().signal, { automaticLearning: true })

    expect(domain.workItems.get(item.workItemId)).toMatchObject({
      processingState: 'CAPTURED',
      learning: {
        modelRoute: { provider: 'target-provider', model: 'target-model-last' },
        calls: [{ requestOrdinal: 1, outcome: 'FAILED' }],
        failure: { code: 'MODEL_TERMINAL_FAILURE', retryable: true },
      },
    })
  })

  it('retries an incomplete Skill catalog with the frozen bounded delays', async () => {
    const { item, domain, learn, snapshot, sleeps, worker } = setup({ catalogIncompleteCalls: 3 })

    await worker.run(item, new AbortController().signal, { automaticLearning: true })

    expect(snapshot).toHaveBeenCalledTimes(4)
    expect(sleeps).toEqual([250, 1_000, 4_000])
    expect(learn).toHaveBeenCalledOnce()
    expect(domain.workItems.get(item.workItemId)?.processingState).toBe('LEARNED')
  })

  it('fails closed when the exact Agent scope is unavailable or the Core guard rejects', async () => {
    const missing = setup({ registerScope: false })
    await missing.worker.run(missing.item, new AbortController().signal, { automaticLearning: true })
    expect(missing.domain.workItems.get(missing.item.workItemId)).toMatchObject({
      processingState: 'NEEDS_ATTENTION',
      learning: { failure: { code: 'AGENT_SCOPE_UNAVAILABLE', retryable: false } },
    })

    const rejected = setup({ resultScope: 'USER' })
    await rejected.worker.run(rejected.item, new AbortController().signal, { automaticLearning: true })
    expect(rejected.domain.workItems.get(rejected.item.workItemId)).toMatchObject({
      processingState: 'NEEDS_ATTENTION',
      learning: { failure: { code: 'LEARNING_GUARD_REJECTED', retryable: false } },
    })
  })

  it('keeps completed-call usage and resets a revision-stale input without committing its result', async () => {
    let domain: ReturnType<typeof createMemoryRun2skillDomain>
    let itemId = ''
    const built = setup({
      beforeRecord: () => {
        const current = domain.workItems.get(itemId)!
        domain.workItems.set(itemId, { ...current, revision: current.revision + 1 })
      },
    })
    domain = built.domain
    itemId = built.item.workItemId

    await built.worker.run(built.item, new AbortController().signal, { automaticLearning: true })

    expect(domain.workItems.get(itemId)).toMatchObject({
      processingState: 'CAPTURED',
      learning: {
        requestBudgetUsed: 1,
        calls: [{ requestOrdinal: 1, outcome: 'SUCCEEDED' }],
      },
    })
    expect(domain.workItems.get(itemId)?.learning).not.toHaveProperty('claimedAt')
  })
})
