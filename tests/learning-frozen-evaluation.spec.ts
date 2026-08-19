import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { projectLearningWindow } from '../src/adapters/dsh-session/learning-window.js'
import { LearningWorkItemStore } from '../src/adapters/dsh-storage/learning-work-item-store.js'
import {
  buildLearningEnvelope,
  guardLearningResult,
  LEARNING_ENVELOPE_MAX_BYTES,
  materializeModelLearningOutput,
  recallExistingSkills,
  resolveLearningScope,
  type CandidatePersistenceScope,
  type LearningGuardReason,
  type ModelLearningOutputV1,
  type SkillRecallObservation,
} from '../src/domain/learn/index.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
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
type GuardOutcome = 'ACCEPTED' | LearningGuardReason

interface LearningEvaluationCase {
  readonly id: string
  readonly evidence: string
  readonly workspaceBound: boolean
  readonly candidate: CandidateKind
  readonly modelOutput: {
    readonly type: ExperienceType
    readonly scope: Scope
    readonly curation: Curation
    readonly contentMode: ContentMode
  }
  readonly expected: {
    readonly type: ExperienceType
    readonly scope: Scope
    readonly curation: Curation
    readonly guard: GuardOutcome
  }
  readonly safetyCase?: boolean
}

interface LearningFixture {
  readonly fixtureVersion: number
  readonly policyVersion: 'learning-v1'
  readonly cases: readonly LearningEvaluationCase[]
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/learning-v1.json', import.meta.url), 'utf8'),
) as LearningFixture

const CATALOG_DIGEST = 'c'.repeat(64)
const OBSERVED_AT = '2026-08-20T00:00:00.000Z'

function workItem(sample: LearningEvaluationCase): CaptureWorkItemV1 {
  const base = makeWorkItem()
  return makeWorkItem({
    workspaceBinding: sample.workspaceBound
      ? {
          status: 'BOUND', workspaceId: 'workspace-frozen',
          canonicalPath: 'D:\\frozen-project', observedAt: OBSERVED_AT,
        }
      : { status: 'NO_CWD', observedAt: OBSERVED_AT },
    evidenceRefs: [{
      ...base.evidenceRefs[0]!,
      excerpt: sample.evidence,
      excerptDigest: sha256Utf8(sample.evidence),
    }],
  })
}

function candidate(kind: CandidateKind): SkillRecallObservation['candidates'][number] | undefined {
  if (kind === 'NONE') return undefined
  const persistenceScope: CandidatePersistenceScope = kind === 'USER_WRITABLE' ? 'USER' : 'PROJECT'
  const writable = kind !== 'PROJECT_READONLY'
  const source = kind === 'USER_WRITABLE'
    ? 'user-dsh'
    : writable ? 'project-dsh' : 'project-agents'
  const content = '# Existing guidance\n\nExisting durable behavior.'
  return {
    candidateKey: `cand_${sha256Utf8(kind)}`,
    candidateDigest: sha256Utf8(`candidate:${kind}`),
    source,
    persistenceScope,
    writable,
    name: `frozen-${kind.toLowerCase().replaceAll('_', '-')}`,
    description: 'Existing frozen evaluation candidate.',
    whenToUse: 'Use for the frozen evaluation scenario.',
    content,
    bodyDigest: sha256Utf8(content),
  }
}

function proposalContent(sample: LearningEvaluationCase): string {
  if (sample.modelOutput.contentMode === 'SYNTHETIC_SECRET') {
    return `# Safe deployment\n\nRemove ${'api_' + 'key=runtime-fixture-value'} before persistence.`
  }
  if (sample.modelOutput.contentMode === 'BIDI_CONTROL') {
    return '# Visible ordering\n\nReject hidden ordering control \u202e in durable text.'
  }
  return `# ${sample.id}\n\nApply the durable behavior for ${sample.id}.`
}

function modelOutput(
  sample: LearningEvaluationCase,
  item: CaptureWorkItemV1,
  recalled: SkillRecallObservation['candidates'][number] | undefined,
): ModelLearningOutputV1 {
  return {
    experiences: [{
      type: sample.modelOutput.type,
      lesson: `Retain the durable lesson for ${sample.id}.`,
      persistenceScope: sample.modelOutput.scope,
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
      content: proposalContent(sample),
      invocation: { modelInvocable: true, userInvocable: false },
      persistenceScope: sample.modelOutput.scope,
      curation: sample.modelOutput.curation === 'CREATE'
        ? { decision: 'CREATE', rationale: 'No matching candidate covers the behavior.' }
        : {
            decision: sample.modelOutput.curation,
            candidateKey: recalled!.candidateKey,
            rationale: 'The recalled candidate determines the frozen curation result.',
          },
    },
  }
}

describe('Learning v1 frozen evaluation', () => {
  it('meets semantic and safety gates without printing fixture text', async () => {
    const typeFailures: string[] = []
    const scopeFailures: string[] = []
    const curationFailures: string[] = []
    const guardFailures: string[] = []
    const safetyFailures: string[] = []

    for (const sample of fixture.cases) {
      const item = workItem(sample)
      const recalled = candidate(sample.candidate)
      const observation: SkillRecallObservation = {
        catalogObservationDigest: CATALOG_DIGEST,
        candidates: recalled === undefined ? [] : [recalled],
      }
      const scope = resolveLearningScope(item, 'D:\\frozen-session')
      if (scope.status !== 'AVAILABLE' || scope.persistenceScope !== sample.expected.scope) {
        scopeFailures.push(sample.id)
        continue
      }
      const output = modelOutput(sample, item, recalled)
      const materialized = materializeModelLearningOutput(output, {
        workItemId: item.workItemId,
        catalogObservationDigest: observation.catalogObservationDigest,
        shortlistDigests: observation.candidates.map(entry => entry.candidateDigest),
      })
      const guarded = guardLearningResult({
        item,
        expectedScope: scope.persistenceScope,
        observation,
        ...materialized,
      })
      const guardOutcome: GuardOutcome = guarded.status === 'ACCEPTED'
        ? 'ACCEPTED'
        : guarded.reason
      if (materialized.experiences[0]?.type !== sample.expected.type) typeFailures.push(sample.id)
      if (materialized.proposal.persistenceScope !== sample.expected.scope) scopeFailures.push(sample.id)
      if (materialized.proposal.curation.decision !== sample.expected.curation) {
        curationFailures.push(sample.id)
      }
      if (guardOutcome !== sample.expected.guard) guardFailures.push(sample.id)
      if (sample.safetyCase === true && guarded.status !== 'REJECTED') safetyFailures.push(sample.id)
    }

    const boundaryCaseIds: string[] = []
    const catalog = await recallExistingSkills({
      async snapshot() { return { skills: [], complete: false } },
      async get() { return undefined },
    }, {}, 'frozen catalog evidence')
    if (catalog.status === 'UNAVAILABLE' && catalog.failureCode === 'CATALOG_INCOMPLETE') {
      boundaryCaseIds.push('catalog-incomplete')
    } else safetyFailures.push('catalog-incomplete')

    const session = makeLearningSessionFixture()
    const noRouteEvents = session.events.map(event => event.type === 'request/header'
      ? { ...event, type: 'todo/write', data: { todos: [] } }
      : event)
    const noRoute = projectLearningWindow(session.header, noRouteEvents, session.item)
    if (noRoute.status === 'UNAVAILABLE' && noRoute.failureCode === 'MODEL_ROUTE_UNAVAILABLE') {
      boundaryCaseIds.push('no-model-request')
    } else safetyFailures.push('no-model-request')

    for (const outcome of ['failed', 'cancelled'] as const) {
      const events = session.events.map(event => event.seq === session.item.signalKey.turnEndSeq
        ? { ...event, data: { turn: session.item.signalKey.turn, reason: { kind: outcome } } }
        : event)
      const item = makeLearningWorkItem(session.header, events, 20, 11)
      const projected = projectLearningWindow(session.header, events, item)
      if (projected.status === 'AVAILABLE' && item.turnOutcomeKind === outcome) {
        boundaryCaseIds.push(`${outcome}-turn`)
      } else guardFailures.push(`${outcome}-turn`)
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
    if (longEnvelope.status === 'AVAILABLE' && longEnvelope.byteLength <= LEARNING_ENVELOPE_MAX_BYTES) {
      boundaryCaseIds.push('long-context-bounded')
    } else safetyFailures.push('long-context-bounded')

    const staleDomain = createMemoryRun2skillDomain()
    const staleItem = makeWorkItem({
      learning: { policyVersion: 'learning-v1', attempt: 2, requestBudgetUsed: 0, calls: [] },
    })
    staleDomain.workItems.set(staleItem.workItemId, staleItem)
    const staleStore = new LearningWorkItemStore(staleDomain)
    const claimed = await staleStore.claim(staleItem.workItemId, staleItem.revision)
    staleDomain.workItems.set(staleItem.workItemId, { ...claimed, revision: claimed.revision + 1 })
    const stale = await staleStore.resetStale(staleItem.workItemId, 3)
    if (stale.processingState === 'NEEDS_ATTENTION') boundaryCaseIds.push('stale-input')
    else safetyFailures.push('stale-input')

    const sampleCount = fixture.cases.length
    const metrics = {
      experienceType: (sampleCount - typeFailures.length) / sampleCount,
      scope: (sampleCount - scopeFailures.length) / sampleCount,
      curation: (sampleCount - curationFailures.length) / sampleCount,
      safetyBlock: safetyFailures.length === 0 ? 1 : 0,
    }
    const failedCaseIds = [...new Set([
      ...typeFailures,
      ...scopeFailures,
      ...curationFailures,
      ...guardFailures,
      ...safetyFailures,
    ])].sort()
    console.info(`LEARNING_FROZEN_EVALUATION=${JSON.stringify({
      fixtureVersion: fixture.fixtureVersion,
      policyVersion: fixture.policyVersion,
      sampleCount: sampleCount + boundaryCaseIds.length,
      boundaryCaseIds,
      metrics,
      failedCaseIds,
    })}`)

    expect(metrics.experienceType).toBeGreaterThanOrEqual(0.9)
    expect(metrics.scope).toBeGreaterThanOrEqual(0.9)
    expect(metrics.curation).toBeGreaterThanOrEqual(0.9)
    expect(metrics.safetyBlock).toBe(1)
    expect(failedCaseIds).toEqual([])
  })
})
