import { describe, expect, it } from 'vitest'
import { CompleteCatalogRecallWorker, deriveRecallCandidateId, type RecallCatalogSnapshot } from '../src/application/recall/index.js'
import { CompleteCoverageWorker, type CoverageClassifier } from '../src/application/coverage-analysis/index.js'
import { ExperienceIntentV2Schema, SessionBatchV2Schema } from '../src/domain/v2/index.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

function summary(index: number) {
  const facts = {
    name: `coverage-skill-${index}`, description: `Existing workflow ${index}`, whenToUse: `Use ${index}`,
    provider: 'filesystem', source: 'project-dsh', scope: 'PROJECT' as const, writable: true,
    rootIdentityDigest: index.toString(16).padStart(64, '0'),
  }
  return { candidateId: deriveRecallCandidateId(facts), ...facts }
}

async function seed(options: { explicit?: boolean; candidateCount?: number; unavailable?: boolean; bodyBytes?: number } = {}) {
  const domain = createMemoryRun2skillV2Domain()
  const fixture = createMinimalV2Fixtures()
  const owned = ExperienceIntentV2Schema.parse({
    ...fixture.proposalReadyIntent, revision: 1, explicitSave: options.explicit ?? false,
    status: 'RUN2SKILL_OWNED',
    recall: { state: 'NOT_STARTED', complete: false, summaryScanComplete: false, candidates: [] },
    coverage: { state: 'NOT_STARTED' },
    generation: { state: 'NOT_STARTED', userRetryUsed: false, staleRefreshUsed: false, receipts: [] },
    stageCalls: [], lineageId: undefined,
  })
  const batch = SessionBatchV2Schema.parse(fixture.sessionBatch)
  const summaries = Array.from({ length: options.candidateCount ?? 1 }, (_, index) => summary(index + 1))
  const bodies = new Map<string, string>(summaries.map(item => [
    item.candidateId,
    options.bodyBytes === undefined ? `# ${item.name}\ncomplete body` : 'x'.repeat(options.bodyBytes),
  ]))
  let current: RecallCatalogSnapshot = {
    complete: true, runtimeCatalogDigest: '1'.repeat(64), pendingCatalogDigest: '2'.repeat(64),
    catalogEpoch: 4, catalogMutationReceiptDigest: '3'.repeat(64), summaries,
  }
  const catalog = {
    setSnapshot(next: RecallCatalogSnapshot) { current = next },
    snapshot: async () => current,
    read: async ({ candidateId }: { candidateId: string }) => {
      const item = current.summaries.find(candidate => candidate.candidateId === candidateId)
      const content = bodies.get(candidateId)
      return item === undefined || content === undefined ? undefined : { ...item, content }
    },
  }
  await domain.table('experience_intents').put(owned.intentId, owned)
  await domain.table('session_batches').put(batch.batchId, batch)
  const recallModel = { classify: async (input: { summaries: readonly { candidateId: string }[] }) => ({
    classifications: input.summaries.map(item => ({
      candidateId: item.candidateId, classification: 'RELEVANT' as const,
    })),
  }) }
  await new CompleteCatalogRecallWorker(domain, { catalog, classifier: recallModel }).runOnce()
  if (options.unavailable) {
    const recalled = domain.experienceIntents.get(owned.intentId)!
    await domain.table('experience_intents').put(owned.intentId, ExperienceIntentV2Schema.parse({
      ...recalled,
      recall: { ...recalled.recall, candidates: recalled.recall.candidates.map(candidate => ({
        ...candidate, capability: 'UNAVAILABLE', bodyDigest: undefined, unavailableReason: 'READ_FAILED',
      })) },
    }))
  }
  return { domain, intentId: owned.intentId, batch, catalog, summaries, bodies }
}

function model(decide: (candidateId: string) => 'UNRELATED' | 'COVERED' | 'PARTIAL' | 'AMBIGUOUS') {
  let calls = 0
  const value: CoverageClassifier & { readonly calls: number } = {
    get calls() { return calls },
    classify: async input => {
      calls += 1
      return { decisions: input.candidates.map(candidate => ({
        candidateId: candidate.candidateId, decision: decide(candidate.candidateId), reason: 'bounded reason',
      })) }
    },
  }
  return value
}

describe('v2 complete coverage', () => {
  it('authorizes CREATE without a model call when complete recall has no relevant candidates', async () => {
    const seeded = await seed({ candidateCount: 0 })
    const classifier = model(() => 'UNRELATED')
    await new CompleteCoverageWorker(seeded.domain, { catalog: seeded.catalog, classifier }).runOnce()
    expect(classifier.calls).toBe(0)
    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'CREATE_AUTHORIZED', coverage: { state: 'CREATE' },
      generation: { state: 'GENERATION_AUTHORIZED', action: 'CREATE' },
    })
  })

  it('ends silently for automatic COVERED and asks confirmation for explicit COVERED', async () => {
    for (const explicit of [false, true]) {
      const seeded = await seed({ explicit })
      await new CompleteCoverageWorker(seeded.domain, { catalog: seeded.catalog, classifier: model(() => 'COVERED') }).runOnce()
      expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
        status: explicit ? 'COVERED_NEEDS_CONFIRMATION' : 'COVERED',
        coverage: { state: 'COVERED', targetCandidateId: seeded.summaries[0]!.candidateId },
        generation: { state: 'NOT_STARTED' },
      })
    }
  })

  it('authorizes only one writable PARTIAL target for MERGE', async () => {
    const seeded = await seed({ candidateCount: 2 })
    const target = seeded.summaries[0]!.candidateId
    await new CompleteCoverageWorker(seeded.domain, {
      catalog: seeded.catalog, classifier: model(id => id === target ? 'PARTIAL' : 'UNRELATED'),
    }).runOnce()
    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'MERGE_AUTHORIZED', coverage: { state: 'MERGE', targetCandidateId: target },
      generation: { state: 'GENERATION_AUTHORIZED', action: 'MERGE' },
    })
  })

  it('blocks before the model for unavailable or changed full bodies', async () => {
    for (const failure of ['UNAVAILABLE', 'BODY_CHANGED'] as const) {
      const seeded = await seed({ unavailable: failure === 'UNAVAILABLE' })
      if (failure === 'BODY_CHANGED') seeded.bodies.set(seeded.summaries[0]!.candidateId, '# changed')
      const classifier = model(() => 'UNRELATED')
      await new CompleteCoverageWorker(seeded.domain, { catalog: seeded.catalog, classifier }).runOnce()
      expect(classifier.calls).toBe(0)
      expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
        status: 'NEEDS_ATTENTION', coverage: { state: 'NEEDS_ATTENTION' },
      })
    }
  })

  it('keeps ambiguous or multiple partial coverage out of generation', async () => {
    for (const decision of ['AMBIGUOUS', 'PARTIAL'] as const) {
      const seeded = await seed({ candidateCount: 2 })
      await new CompleteCoverageWorker(seeded.domain, {
        catalog: seeded.catalog, classifier: model(() => decision),
      }).runOnce()
      expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
        status: 'NEEDS_ATTENTION', coverage: { state: 'NEEDS_ATTENTION' }, generation: { state: 'NOT_STARTED' },
      })
    }
  })

  it('allows concurrent workers to classify each candidate only once', async () => {
    const seeded = await seed({ candidateCount: 2 })
    const classifier = model(() => 'UNRELATED')
    await Promise.all([
      new CompleteCoverageWorker(seeded.domain, { catalog: seeded.catalog, classifier }).runOnce(),
      new CompleteCoverageWorker(seeded.domain, { catalog: seeded.catalog, classifier }).runOnce(),
    ])
    expect(classifier.calls).toBe(2)
    expect(seeded.domain.experienceIntents.get(seeded.intentId)?.status).toBe('CREATE_AUTHORIZED')
  })

  it('covers a 20 KiB Skill in full when the route budget permits it', async () => {
    const seeded = await seed({ bodyBytes: 20 * 1024 })
    const classifier = model(() => 'UNRELATED')
    await new CompleteCoverageWorker(seeded.domain, { catalog: seeded.catalog, classifier }).runOnce()
    expect(classifier.calls).toBe(1)
    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'CREATE_AUTHORIZED', coverage: { state: 'CREATE' },
    })
  })

  it('fails closed without truncating a full body that cannot fit the route budget', async () => {
    const seeded = await seed({ bodyBytes: 20 * 1024 })
    const classifier = model(() => 'UNRELATED')
    await new CompleteCoverageWorker(seeded.domain, {
      catalog: seeded.catalog, classifier, policy: { reserveBytes: 20 * 1024 },
    }).runOnce()
    expect(classifier.calls).toBe(0)
    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'NEEDS_ATTENTION', coverage: { state: 'NEEDS_ATTENTION', reasonCode: 'COVERAGE_BUDGET_EXHAUSTED' },
    })
  })

  it('does not replay a successful durable coverage decision after a crash before aggregation', async () => {
    const seeded = await seed()
    await new CompleteCoverageWorker(seeded.domain, {
      catalog: seeded.catalog, classifier: model(() => 'UNRELATED'),
    }).runOnce()
    const completed = ExperienceIntentV2Schema.parse(seeded.domain.experienceIntents.get(seeded.intentId))
    const { inputDigest: _terminalInput, ...analyzingCoverage } = completed.coverage
    await seeded.domain.table('experience_intents').put(completed.intentId, ExperienceIntentV2Schema.parse({
      ...completed,
      revision: completed.revision + 1,
      status: 'COVERAGE_ANALYZING',
      coverage: { ...analyzingCoverage, state: 'ANALYZING' },
      generation: { state: 'NOT_STARTED', userRetryUsed: false, staleRefreshUsed: false, receipts: [] },
    }))
    const classifier = model(() => 'AMBIGUOUS')
    await new CompleteCoverageWorker(seeded.domain, { catalog: seeded.catalog, classifier }).runOnce()
    expect(classifier.calls).toBe(0)
    expect(seeded.domain.experienceIntents.get(seeded.intentId)?.status).toBe('CREATE_AUTHORIZED')
  })

  it('marks an in-flight coverage call outcome unknown instead of replaying it after recovery', async () => {
    const seeded = await seed()
    let signalEntered!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { signalEntered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const classifier: CoverageClassifier = {
      classify: async input => {
        calls += 1
        signalEntered()
        await blocked
        return { decisions: [{ candidateId: input.candidates[0]!.candidateId, decision: 'UNRELATED', reason: 'late' }] }
      },
    }
    const worker = new CompleteCoverageWorker(seeded.domain, { catalog: seeded.catalog, classifier })
    const pending = worker.runOnce()
    await entered
    await worker.recover()
    release()
    await pending
    expect(calls).toBe(1)
    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'NEEDS_ATTENTION',
      coverage: { state: 'NEEDS_ATTENTION', reasonCode: 'COVERAGE_OUTCOME_UNKNOWN' },
      stageCalls: expect.arrayContaining([expect.objectContaining({ stage: 'COVERAGE', outcome: 'OUTCOME_UNKNOWN' })]),
    })
  })

  it('seals invalid model output as a terminal failure without authorizing generation', async () => {
    const seeded = await seed()
    const classifier: CoverageClassifier = { classify: async () => ({ decisions: [] }) }
    await new CompleteCoverageWorker(seeded.domain, { catalog: seeded.catalog, classifier }).runOnce()
    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'NEEDS_ATTENTION',
      coverage: { state: 'NEEDS_ATTENTION', reasonCode: 'INVALID_COVERAGE_OUTPUT' },
      generation: { state: 'NOT_STARTED' },
    })
  })

  it('bounds a multibyte coverage reason by persisted UTF-8 bytes', async () => {
    const seeded = await seed()
    const classifier: CoverageClassifier = {
      classify: async input => ({
        decisions: [{ candidateId: input.candidates[0]!.candidateId, decision: 'COVERED', reason: '测'.repeat(1024) }],
      }),
    }
    await new CompleteCoverageWorker(seeded.domain, { catalog: seeded.catalog, classifier }).runOnce()
    const reason = seeded.domain.experienceIntents.get(seeded.intentId)?.coverage.decisions?.[0]?.reason
    expect(Buffer.byteLength(reason ?? '', 'utf8')).toBeLessThanOrEqual(1024)
    expect(seeded.domain.experienceIntents.get(seeded.intentId)?.status).toBe('COVERED')
  })

  it('starts an authorized explicit coverage retry on a fresh plan without replaying the old call', async () => {
    const seeded = await seed({ explicit: true })
    await new CompleteCoverageWorker(seeded.domain, {
      catalog: seeded.catalog, classifier: model(() => 'COVERED'),
    }).runOnce()
    const covered = ExperienceIntentV2Schema.parse(seeded.domain.experienceIntents.get(seeded.intentId))
    await seeded.domain.table('experience_intents').put(covered.intentId, ExperienceIntentV2Schema.parse({
      ...covered,
      revision: covered.revision + 1,
      status: 'COVERAGE_RETRY_AUTHORIZED',
      coverage: { state: 'ANALYZING' },
    }))
    const classifier = model(() => 'UNRELATED')
    await new CompleteCoverageWorker(seeded.domain, { catalog: seeded.catalog, classifier }).runOnce()
    expect(classifier.calls).toBe(1)
    const retried = seeded.domain.experienceIntents.get(seeded.intentId)
    expect(retried).toMatchObject({ status: 'CREATE_AUTHORIZED', coverage: { state: 'CREATE' } })
    expect(retried?.stageCalls.filter(call => call.stage === 'COVERAGE')).toHaveLength(2)
  })
})
