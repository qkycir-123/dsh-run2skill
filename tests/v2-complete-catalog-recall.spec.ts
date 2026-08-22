import { describe, expect, it } from 'vitest'
import {
  CompleteCatalogRecallWorker,
  deriveRecallCandidateId,
  type CatalogRecallClassifier,
  type CompleteRecallCatalogPort,
  type RecallCatalogSnapshot,
} from '../src/application/recall/index.js'
import { ExperienceIntentV2Schema, SessionBatchV2Schema } from '../src/domain/v2/index.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

const NOW = '2026-08-22T02:00:00.000Z'

function summary(index: number) {
  const facts = {
    name: `skill-${index}`,
    description: `Reusable workflow number ${index}`,
    whenToUse: `Use workflow ${index}`,
    provider: 'filesystem',
    source: 'project-dsh',
    scope: 'PROJECT' as const,
    writable: true,
    rootIdentityDigest: index.toString(16).padStart(64, '0'),
  }
  return { candidateId: deriveRecallCandidateId(facts), ...facts }
}

function snapshot(summaries: ReturnType<typeof summary>[], overrides: Partial<RecallCatalogSnapshot> = {}): RecallCatalogSnapshot {
  return {
    complete: true,
    runtimeCatalogDigest: '1'.repeat(64),
    pendingCatalogDigest: '2'.repeat(64),
    catalogEpoch: 4,
    catalogMutationReceiptDigest: '3'.repeat(64),
    summaries,
    ...overrides,
  }
}

async function seedOwnedIntent(maxInputBytes = 32 * 1024) {
  const domain = createMemoryRun2skillV2Domain()
  const fixture = createMinimalV2Fixtures()
  const owned = ExperienceIntentV2Schema.parse({
    ...fixture.proposalReadyIntent,
    status: 'RUN2SKILL_OWNED',
    recall: { state: 'NOT_STARTED', complete: false, summaryScanComplete: false, candidates: [] },
    coverage: { state: 'NOT_STARTED' },
    generation: { state: 'NOT_STARTED', userRetryUsed: false, staleRefreshUsed: false, receipts: [] },
    stageCalls: [],
  })
  const batch = SessionBatchV2Schema.parse({
    ...fixture.sessionBatch,
    routeSnapshot: { ...fixture.sessionBatch.routeSnapshot, maxInputBytes },
  })
  await domain.table('experience_intents').put(owned.intentId, owned)
  await domain.table('session_batches').put(batch.batchId, batch)
  return { domain, intent: owned, batch }
}

function catalog(initial: RecallCatalogSnapshot, bodies: Map<string, string> = new Map()) {
  let current = initial
  let snapshots = 0
  let reads = 0
  const value: CompleteRecallCatalogPort & {
    readonly snapshots: number
    readonly reads: number
    setSnapshot(next: RecallCatalogSnapshot): void
  } = {
    get snapshots() { return snapshots },
    get reads() { return reads },
    setSnapshot(next) { current = next },
    snapshot: async () => {
      snapshots += 1
      return current
    },
    read: async ({ candidateId }) => {
      reads += 1
      const item = current.summaries.find(candidate => candidate.candidateId === candidateId)
      const content = bodies.get(candidateId)
      return item === undefined || content === undefined ? undefined : { ...item, content }
    },
  }
  return value
}

function classifier(classify: CatalogRecallClassifier['classify']) {
  let calls = 0
  const pages: string[][] = []
  return {
    get calls() { return calls },
    pages,
    classify: async (...args: Parameters<CatalogRecallClassifier['classify']>) => {
      calls += 1
      pages.push(args[0].summaries.map(item => item.candidateId))
      return classify(...args)
    },
  }
}

describe('v2 complete Catalog recall', () => {
  it('commits an empty complete Catalog without a model call', async () => {
    const { domain, intent } = await seedOwnedIntent()
    const registry = catalog(snapshot([]))
    const model = classifier(async () => ({ classifications: [] }))
    const worker = new CompleteCatalogRecallWorker(domain, { catalog: registry, classifier: model, now: () => Date.parse(NOW) })
    expect(await worker.runOnce()).toBe('PROCESSED')
    expect(model.calls).toBe(0)
    expect(domain.experienceIntents.get(intent.intentId)).toMatchObject({
      status: 'COVERAGE_READY',
      recall: { state: 'COMPLETE', complete: true, summaryScanComplete: true, candidates: [] },
    })
  })

  it('scans every summary in stable pages instead of selecting a Top N', async () => {
    const { domain, intent } = await seedOwnedIntent(4 * 1024)
    const summaries = Array.from({ length: 23 }, (_, index) => summary(index))
    const bodies = new Map(summaries.map(item => [item.candidateId, `# ${item.name}\nfull body`]))
    const registry = catalog(snapshot(summaries), bodies)
    const model = classifier(async input => ({
      classifications: input.summaries.map(item => ({
        candidateId: item.candidateId,
        classification: Number(item.name.slice(6)) % 7 === 0 ? 'POSSIBLE' as const : 'UNRELATED' as const,
      })),
    }))
    const worker = new CompleteCatalogRecallWorker(domain, {
      catalog: registry,
      classifier: model,
      policy: { catalogScanReserveBytes: 1024, coverageReserveBytes: 1024, maxCatalogScanCalls: 16 },
    })
    await worker.runOnce()
    expect(model.pages.flat()).toEqual(summaries.map(item => item.candidateId).sort())
    expect(model.calls).toBeGreaterThan(1)
    expect(domain.experienceIntents.get(intent.intentId)).toMatchObject({
      status: 'COVERAGE_READY', recall: { summaryScanComplete: true },
    })
    expect(domain.experienceIntents.get(intent.intentId)?.recall.candidates).toHaveLength(4)
  })

  it('reads 8940-byte and 14/20 KiB candidates completely when each fits the route envelope', async () => {
    const { domain, intent } = await seedOwnedIntent(32 * 1024)
    const summaries = [summary(1), summary(2), summary(3)]
    const sizes = [8_940, 14 * 1024, 20 * 1024]
    const bodies = new Map(summaries.map((item, index) => [item.candidateId, 'x'.repeat(sizes[index]!)]))
    const registry = catalog(snapshot(summaries), bodies)
    const model = classifier(async input => ({
      classifications: input.summaries.map(item => ({ candidateId: item.candidateId, classification: 'RELEVANT' as const })),
    }))
    await new CompleteCatalogRecallWorker(domain, { catalog: registry, classifier: model }).runOnce()
    const recalled = domain.experienceIntents.get(intent.intentId)!
    expect(recalled.status).toBe('COVERAGE_READY')
    expect(recalled.recall.candidates.map(item => item.capability)).toEqual(['AVAILABLE', 'AVAILABLE', 'AVAILABLE'])
    expect(recalled.recall.candidates.every(item => item.bodyDigest !== undefined)).toBe(true)
  })

  it('fails before calling the model when complete full-scan pagination exceeds the hard call budget', async () => {
    const { domain, intent } = await seedOwnedIntent(2 * 1024)
    const registry = catalog(snapshot(Array.from({ length: 50 }, (_, index) => summary(index))))
    const model = classifier(async () => ({ classifications: [] }))
    await new CompleteCatalogRecallWorker(domain, {
      catalog: registry,
      classifier: model,
      policy: { catalogScanReserveBytes: 1024, coverageReserveBytes: 1024, maxCatalogScanCalls: 1 },
    }).runOnce()
    expect(model.calls).toBe(0)
    expect(domain.experienceIntents.get(intent.intentId)).toMatchObject({
      status: 'NEEDS_ATTENTION', recall: { state: 'INCOMPLETE', incompleteReason: 'CATALOG_SCAN_BUDGET_EXHAUSTED' },
    })
  })

  it('does not call the model for an incomplete Catalog or a forged stable candidate identity', async () => {
    for (const failure of ['INCOMPLETE', 'FORGED_IDENTITY'] as const) {
      const { domain, intent } = await seedOwnedIntent()
      const item = summary(1)
      const registry = catalog(failure === 'INCOMPLETE'
        ? snapshot([item], { complete: false })
        : snapshot([{ ...item, rootIdentityDigest: 'f'.repeat(64) }]))
      const model = classifier(async () => ({ classifications: [] }))
      await new CompleteCatalogRecallWorker(domain, { catalog: registry, classifier: model }).runOnce()
      expect(model.calls).toBe(0)
      expect(domain.experienceIntents.get(intent.intentId)).toMatchObject({
        status: 'NEEDS_ATTENTION', recall: { state: 'INCOMPLETE', incompleteReason: 'CATALOG_INCOMPLETE' },
      })
    }
  })

  it('blocks downstream work when a relevant candidate disappears or cannot fit whole', async () => {
    for (const failure of ['DISAPPEARED', 'TOO_LARGE'] as const) {
      const { domain, intent } = await seedOwnedIntent(16 * 1024)
      const item = summary(1)
      const bodies = failure === 'TOO_LARGE' ? new Map([[item.candidateId, 'x'.repeat(15 * 1024)]]) : new Map<string, string>()
      const registry = catalog(snapshot([item]), bodies)
      const model = classifier(async input => ({
        classifications: input.summaries.map(candidate => ({ candidateId: candidate.candidateId, classification: 'RELEVANT' as const })),
      }))
      await new CompleteCatalogRecallWorker(domain, {
        catalog: registry,
        classifier: model,
        policy: { catalogScanReserveBytes: 1024, coverageReserveBytes: 4 * 1024, maxCatalogScanCalls: 8 },
      }).runOnce()
      expect(domain.experienceIntents.get(intent.intentId)).toMatchObject({
        status: 'NEEDS_ATTENTION', recall: { state: 'INCOMPLETE' },
      })
    }
  })

  it('does not mix bodies with a Catalog snapshot that changes during reads', async () => {
    const { domain, intent } = await seedOwnedIntent()
    const item = summary(1)
    const registry = catalog(snapshot([item]), new Map([[item.candidateId, 'full body']]))
    let modelCalls = 0
    const model = {
      classify: async (input: Parameters<CatalogRecallClassifier['classify']>[0]) => {
        modelCalls += 1
        registry.setSnapshot(snapshot([item], { runtimeCatalogDigest: '9'.repeat(64) }))
        return { classifications: input.summaries.map(candidate => ({ candidateId: candidate.candidateId, classification: 'RELEVANT' as const })) }
      },
    }
    await new CompleteCatalogRecallWorker(domain, { catalog: registry, classifier: model }).runOnce()
    expect(modelCalls).toBe(1)
    expect(registry.reads).toBe(0)
    expect(domain.experienceIntents.get(intent.intentId)).toMatchObject({
      status: 'NEEDS_ATTENTION', recall: { state: 'INCOMPLETE', incompleteReason: 'CATALOG_CHANGED' },
    })
  })

  it('marks a crash-left reserved scan call outcome unknown without replaying it', async () => {
    const { domain, intent } = await seedOwnedIntent()
    const item = summary(1)
    await domain.table('experience_intents').put(intent.intentId, ExperienceIntentV2Schema.parse({
      ...intent,
      revision: intent.revision + 1,
      status: 'RECALLING',
      recall: {
        state: 'SCANNING', complete: false, summaryScanComplete: false, candidates: [],
        runtimeCatalogDigest: '1'.repeat(64), pendingCatalogDigest: '2'.repeat(64), catalogEpoch: 4,
        catalogMutationReceiptDigest: '3'.repeat(64), scanPlanDigest: '4'.repeat(64), scanPageCount: 1,
        summaryClassifications: [],
      },
      stageCalls: [{
        stage: 'CATALOG_SCAN', intentRevision: intent.revision + 1,
        callId: `call_${'5'.repeat(64)}`, ordinal: 1, inputDigest: '6'.repeat(64),
        provider: 'deepseek-official', model: 'deepseek-chat', policyVersion: 'catalog-scan-v1', outcome: 'RESERVED',
      }],
    }))
    const model = classifier(async input => ({
      classifications: input.summaries.map(candidate => ({ candidateId: candidate.candidateId, classification: 'RELEVANT' as const })),
    }))
    const worker = new CompleteCatalogRecallWorker(domain, { catalog: catalog(snapshot([item])), classifier: model })
    await worker.recover()
    expect(model.calls).toBe(0)
    expect(domain.experienceIntents.get(intent.intentId)).toMatchObject({
      status: 'NEEDS_ATTENTION', recall: { incompleteReason: 'CATALOG_SCAN_OUTCOME_UNKNOWN' },
      stageCalls: [{ outcome: 'OUTCOME_UNKNOWN' }],
    })
  })

  it('allows only the queued transition winner to start recall', async () => {
    const { domain, intent } = await seedOwnedIntent()
    const registry = catalog(snapshot([]))
    const model = classifier(async () => ({ classifications: [] }))
    const first = new CompleteCatalogRecallWorker(domain, { catalog: registry, classifier: model })
    const second = new CompleteCatalogRecallWorker(domain, { catalog: registry, classifier: model })
    await Promise.all([first.runOnce(), second.runOnce()])
    expect(registry.snapshots).toBe(2)
    expect(model.calls).toBe(0)
    expect(domain.experienceIntents.get(intent.intentId)?.status).toBe('COVERAGE_READY')
  })
})
