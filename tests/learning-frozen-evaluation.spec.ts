import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  RestrictedLearningClient,
  type DshGenerateOptions,
  type DshLlmPort,
  type DshStreamChunk,
} from '../src/adapters/dsh-llm/restricted-learning-client.js'
import { DshSessionGapReader } from '../src/adapters/dsh-session/gap-reader.js'
import { projectLearningWindow } from '../src/adapters/dsh-session/learning-window.js'
import type { DshSessionEvent } from '../src/adapters/dsh-session/types.js'
import { ExactAgentScopeRegistry } from '../src/adapters/dsh-skills/exact-agent-scope.js'
import { LearningWorkItemStore } from '../src/adapters/dsh-storage/learning-work-item-store.js'
import { RuntimeNotices } from '../src/application/capture/runtime-notices.js'
import { LearningWorker } from '../src/application/learn/learning-worker.js'
import {
  buildLearningEnvelope,
  deriveCandidateKey,
  LEARNING_ENVELOPE_MAX_BYTES,
  recallExistingSkills,
  type ModelLearningOutputV1,
  type SkillDefinitionProjection,
} from '../src/domain/learn/index.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import { preprocessSensitiveText } from '../src/domain/observe/redaction.js'
import type { CaptureWorkItemV1 } from '../src/domain/observe/schemas.js'
import {
  makeLearningSessionFixture,
  makeLearningWorkItem,
} from './support/learning-session-fixture.js'
import { createMemoryRun2skillDomain } from './support/memory-run2skill-domain.js'
import { makeWorkItem } from './support/work-item-fixture.js'

type ExperienceType = 'CORRECTION' | 'CONSTRAINT' | 'WORKFLOW'
type Scope = 'PROJECT' | 'USER'
type Curation = 'CREATE' | 'MERGE' | 'DISCARD'
type CandidateKind = 'NONE' | 'PROJECT_WRITABLE' | 'PROJECT_READONLY' | 'USER_WRITABLE'
type ContentMode = 'NORMAL' | 'SYNTHETIC_SECRET' | 'BIDI_CONTROL'

interface LearningEvaluationCase {
  readonly id: string
  readonly evidence: string
  readonly workspaceBound: boolean
  readonly candidate: CandidateKind
  readonly expected: {
    readonly type: ExperienceType
    readonly scope: Scope
    readonly curation: Curation
    readonly guard: 'ACCEPTED' | 'BLOCKED'
  }
  readonly safetyCase?: boolean
}

interface LearningFixture {
  readonly fixtureVersion: number
  readonly policyVersion: 'learning-v1'
  readonly cases: readonly LearningEvaluationCase[]
}

interface FrozenPrediction {
  readonly type: ExperienceType
  readonly scope: Scope
  readonly curation: Curation
  readonly contentMode: ContentMode
}

interface PredictionSet {
  readonly predictionSetVersion: number
  readonly policyVersion: 'learning-v1'
  readonly cases: ReadonlyArray<{ readonly id: string; readonly prediction: FrozenPrediction }>
}

interface EvaluationResult {
  readonly metrics: {
    readonly experienceType: number
    readonly scope: number
    readonly curation: number
    readonly safetyBlock: number
  }
  readonly failedCaseIds: readonly string[]
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/learning-v1.json', import.meta.url), 'utf8'),
) as LearningFixture
const predictionSet = JSON.parse(
  readFileSync(new URL('./fixtures/learning-v1.predictions.json', import.meta.url), 'utf8'),
) as PredictionSet

const OBSERVED_AT = '2026-08-20T00:00:00.000Z'
const BOUNDARY_CASE_IDS = [
  'catalog-incomplete',
  'no-model-request',
  'failed-turn',
  'cancelled-turn',
  'long-context-bounded',
  'stale-input',
] as const

function sessionFor(sample: LearningEvaluationCase) {
  const base = makeLearningSessionFixture()
  const events: DshSessionEvent[] = base.events.map(event => event.seq === 11
    ? {
        type: 'user/message', seq: event.seq, time: event.time,
        data: {
          id: 'trigger-user',
          role: 'user',
          content: [{ type: 'text', text: sample.evidence }],
          source: { kind: 'user' },
        },
      }
    : event)
  const observed = makeLearningWorkItem(
    base.header,
    events,
    20,
    11,
    preprocessSensitiveText(sample.evidence).text,
  )
  const item: CaptureWorkItemV1 = {
    ...observed,
    workspaceBinding: sample.workspaceBound
      ? {
          status: 'BOUND', workspaceId: 'workspace-frozen',
          canonicalPath: base.header.cwd!, observedAt: OBSERVED_AT,
        }
      : { status: 'NO_CWD', observedAt: OBSERVED_AT },
  }
  return { header: base.header, events, item }
}

function candidateFor(sample: LearningEvaluationCase): SkillDefinitionProjection | undefined {
  if (sample.candidate === 'NONE') return undefined
  const source = sample.candidate === 'USER_WRITABLE'
    ? 'user-dsh'
    : sample.candidate === 'PROJECT_READONLY' ? 'project-agents' : 'project-dsh'
  return {
    name: `frozen-${sample.candidate.toLowerCase().replaceAll('_', '-')}`,
    description: sample.evidence,
    whenToUse: `Use when ${sample.evidence}`,
    source,
    provider: 'filesystem',
    content: '# Existing guidance\n\nExisting durable behavior.',
  }
}

function proposalContent(sample: LearningEvaluationCase, prediction: FrozenPrediction): string {
  if (prediction.contentMode === 'SYNTHETIC_SECRET') {
    return `# Safe deployment\n\nRemove ${'api_' + 'key=runtime-fixture-value'} before persistence.`
  }
  if (prediction.contentMode === 'BIDI_CONTROL') {
    return '# Visible ordering\n\nReject hidden ordering control \u202e in durable text.'
  }
  return `# ${sample.id}\n\nApply the durable behavior for ${sample.id}.`
}

function rawPrediction(
  sample: LearningEvaluationCase,
  prediction: FrozenPrediction,
  item: CaptureWorkItemV1,
  candidate: SkillDefinitionProjection | undefined,
): ModelLearningOutputV1 {
  const candidateKey = candidate === undefined ? undefined : deriveCandidateKey(candidate)
  return {
    experiences: [{
      type: prediction.type,
      lesson: `Retain the durable lesson for ${sample.id}.`,
      persistenceScope: prediction.scope,
      evidenceStrength: 'HIGH',
      supportingEvidence: [{
        messageSeq: item.evidenceRefs[0]!.messageSeq,
        excerptDigest: item.evidenceRefs[0]!.excerptDigest,
      }],
    }],
    proposal: {
      policyVersion: fixture.policyVersion,
      name: sample.id,
      description: `Frozen proposal for ${sample.id}.`,
      whenToUse: `Use for ${sample.id}.`,
      content: proposalContent(sample, prediction),
      invocation: { modelInvocable: true, userInvocable: false },
      persistenceScope: prediction.scope,
      curation: prediction.curation === 'CREATE'
        ? { decision: 'CREATE', rationale: 'No matching candidate covers the behavior.' }
        : {
            decision: prediction.curation,
            candidateKey: candidateKey!,
            rationale: 'The recalled candidate determines the frozen curation result.',
          },
    },
  }
}

class FrozenPredictionLlm implements DshLlmPort {
  constructor(private readonly output: ModelLearningOutputV1) {}

  async resolveModelInfo() {
    return { context: { contextWindow: 32_000 } }
  }

  async * stream(_options: DshGenerateOptions): AsyncIterable<DshStreamChunk> {
    const text = JSON.stringify(this.output)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function runPipeline(
  sample: LearningEvaluationCase,
  prediction: FrozenPrediction,
): Promise<CaptureWorkItemV1> {
  const session = sessionFor(sample)
  const skill = candidateFor(sample)
  const domain = createMemoryRun2skillDomain()
  domain.workItems.set(session.item.workItemId, session.item)
  const store = new LearningWorkItemStore(domain, () => OBSERVED_AT)
  const reader = new DshSessionGapReader({
    async listSnapshots() { return [] },
    async readFrom() { return { meta: session.header, events: session.events } },
  })
  const agent = { id: session.header.id, session: { header: session.header } }
  const scopes = new ExactAgentScopeRegistry<typeof agent>()
  scopes.register(agent)
  const client = new RestrictedLearningClient(new FrozenPredictionLlm(
    rawPrediction(sample, prediction, session.item, skill),
  ))
  const worker = new LearningWorker({
    store,
    sessionReader: reader,
    scopes,
    skills: {
      async snapshot() {
        return { skills: skill === undefined ? [] : [skill], complete: true }
      },
      async get(name) { return skill?.name === name ? skill : undefined },
    },
    client,
    notices: new RuntimeNotices({ now: () => Date.parse(OBSERVED_AT) }),
    now: () => Date.parse(OBSERVED_AT),
    sleep: async () => {},
  })
  await worker.run(session.item, new AbortController().signal, { automaticLearning: true })
  return domain.workItems.get(session.item.workItemId)!
}

async function evaluate(predictions: ReadonlyMap<string, FrozenPrediction>): Promise<EvaluationResult> {
  const typeFailures: string[] = []
  const scopeFailures: string[] = []
  const curationFailures: string[] = []
  const safetyFailures: string[] = []
  const semanticCases = fixture.cases.filter(sample => sample.expected.guard === 'ACCEPTED')
  const safetyCases = fixture.cases.filter(sample => sample.safetyCase === true)

  for (const sample of fixture.cases) {
    const prediction = predictions.get(sample.id)
    if (prediction === undefined) {
      if (sample.expected.guard === 'ACCEPTED') {
        typeFailures.push(sample.id)
        scopeFailures.push(sample.id)
        curationFailures.push(sample.id)
      } else safetyFailures.push(sample.id)
      continue
    }
    const durable = await runPipeline(sample, prediction)
    if (sample.expected.guard === 'BLOCKED') {
      if (
        durable.processingState !== 'NEEDS_ATTENTION'
        || durable.learning?.failure?.code !== 'LEARNING_GUARD_REJECTED'
      ) safetyFailures.push(sample.id)
      continue
    }
    const experience = durable.learning?.experiences?.[0]
    const proposal = durable.learning?.proposal
    if (experience?.type !== sample.expected.type) typeFailures.push(sample.id)
    if (proposal?.persistenceScope !== sample.expected.scope) scopeFailures.push(sample.id)
    if (proposal?.curation.decision !== sample.expected.curation) curationFailures.push(sample.id)
  }

  const metrics = {
    experienceType: (semanticCases.length - typeFailures.length) / semanticCases.length,
    scope: (semanticCases.length - scopeFailures.length) / semanticCases.length,
    curation: (semanticCases.length - curationFailures.length) / semanticCases.length,
    safetyBlock: (safetyCases.length - safetyFailures.length) / safetyCases.length,
  }
  return {
    metrics,
    failedCaseIds: [...new Set([
      ...typeFailures, ...scopeFailures, ...curationFailures, ...safetyFailures,
    ])].sort(),
  }
}

async function evaluateBoundaries(): Promise<string[]> {
  const failures: string[] = []
  const catalog = await recallExistingSkills({
    async snapshot() { return { skills: [], complete: false } },
    async get() { return undefined },
  }, {}, 'frozen catalog evidence')
  if (!(catalog.status === 'UNAVAILABLE' && catalog.failureCode === 'CATALOG_INCOMPLETE')) {
    failures.push('catalog-incomplete')
  }

  const session = makeLearningSessionFixture()
  const noRouteEvents: DshSessionEvent[] = session.events.map(event => event.type === 'request/header'
    ? { ...event, type: 'todo/write', data: { todos: [] } }
    : event)
  const noRoute = projectLearningWindow(session.header, noRouteEvents, session.item)
  if (!(noRoute.status === 'UNAVAILABLE' && noRoute.failureCode === 'MODEL_ROUTE_UNAVAILABLE')) {
    failures.push('no-model-request')
  }

  for (const outcome of ['failed', 'cancelled'] as const) {
    const events: DshSessionEvent[] = session.events.map(event => (
      event.seq === session.item.signalKey.turnEndSeq
        ? { ...event, data: { turn: session.item.signalKey.turn, reason: { kind: outcome } } }
        : event
    ))
    const item = makeLearningWorkItem(session.header, events, 20, 11)
    const projected = projectLearningWindow(session.header, events, item)
    if (!(projected.status === 'AVAILABLE' && item.turnOutcomeKind === outcome)) {
      failures.push(`${outcome}-turn`)
    }
  }

  const projected = projectLearningWindow(session.header, session.events, session.item)
  if (projected.status !== 'AVAILABLE') throw new Error('Frozen Session projection failed')
  const longText = 'x'.repeat(60 * 1024)
  const longEnvelope = buildLearningEnvelope(session.item, {
    ...projected.projection,
    blocks: [...projected.projection.blocks, {
      source: 'ASSISTANT_CONTEXT',
      sessionId: session.item.signalKey.rootSessionId,
      turn: session.item.signalKey.turn,
      eventSeq: 19,
      text: longText,
      digest: sha256Utf8(longText),
      truncated: false,
      retention: { kind: 'ASSISTANT' },
    }],
  })
  if (!(longEnvelope.status === 'AVAILABLE' && longEnvelope.byteLength <= LEARNING_ENVELOPE_MAX_BYTES)) {
    failures.push('long-context-bounded')
  }

  const staleDomain = createMemoryRun2skillDomain()
  const staleItem = makeWorkItem({
    learning: { policyVersion: 'learning-v1', attempt: 2, requestBudgetUsed: 0, calls: [] },
  })
  staleDomain.workItems.set(staleItem.workItemId, staleItem)
  const staleStore = new LearningWorkItemStore(staleDomain)
  const claimed = await staleStore.claim(staleItem.workItemId, staleItem.revision)
  staleDomain.workItems.set(staleItem.workItemId, { ...claimed, revision: claimed.revision + 1 })
  const stale = await staleStore.resetStale(staleItem.workItemId, 3)
  if (stale.processingState !== 'NEEDS_ATTENTION') failures.push('stale-input')
  return failures
}

describe('Learning v1 frozen evaluation', () => {
  it('scores independent predictions after the restricted client, worker, and durable store', async () => {
    expect(predictionSet.policyVersion).toBe(fixture.policyVersion)
    const predictions = new Map(predictionSet.cases.map(entry => [entry.id, entry.prediction]))
    expect(predictions.size).toBe(fixture.cases.length)
    const result = await evaluate(predictions)
    const boundaryFailures = await evaluateBoundaries()
    const failedCaseIds = [...new Set([...result.failedCaseIds, ...boundaryFailures])].sort()
    console.info(`LEARNING_FROZEN_EVALUATION=${JSON.stringify({
      fixtureVersion: fixture.fixtureVersion,
      predictionSetVersion: predictionSet.predictionSetVersion,
      policyVersion: fixture.policyVersion,
      sampleCount: fixture.cases.length + BOUNDARY_CASE_IDS.length,
      boundaryCaseIds: BOUNDARY_CASE_IDS,
      metrics: result.metrics,
      failedCaseIds,
    })}`)

    expect(result.metrics.experienceType).toBeGreaterThanOrEqual(0.9)
    expect(result.metrics.scope).toBeGreaterThanOrEqual(0.9)
    expect(result.metrics.curation).toBeGreaterThanOrEqual(0.9)
    expect(result.metrics.safetyBlock).toBe(1)
    expect(failedCaseIds).toEqual([])
  })

  it('fails the quality thresholds for an unrelated constant prediction', async () => {
    const constant: FrozenPrediction = {
      type: 'CORRECTION', scope: 'PROJECT', curation: 'CREATE', contentMode: 'NORMAL',
    }
    const predictions = new Map(fixture.cases.map(sample => [sample.id, constant]))
    const result = await evaluate(predictions)

    expect(result.metrics.experienceType).toBeLessThan(0.9)
    expect(result.metrics.scope).toBeLessThan(0.9)
    expect(result.metrics.curation).toBeLessThan(0.9)
    expect(result.failedCaseIds).not.toEqual([])
  })
})
