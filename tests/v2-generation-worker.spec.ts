import { describe, expect, it } from 'vitest'
import { CompleteCoverageWorker } from '../src/application/coverage-analysis/index.js'
import {
  GenerationWorker,
  type GenerationCatalogPort,
  type SkillGenerator,
} from '../src/application/generation/index.js'
import { CompleteCatalogRecallWorker, deriveRecallCandidateId, type RecallCatalogSnapshot } from '../src/application/recall/index.js'
import { V2ProposalRefreshCoordinator, deriveV2ProposalRef } from '../src/application/review/index.js'
import { canonicalJson } from '../src/domain/learn/identity.js'
import {
  deriveCreateTargetDigestV2,
  deriveProposalCatalogMutationAnchorV2,
  deriveProposalCatalogMutationIdV2,
  ExperienceIntentV2Schema,
  GlobalV2Schema,
  ProposalLineageV2Schema,
  SessionBatchV2Schema,
} from '../src/domain/v2/index.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'

const NOW = Date.parse('2026-08-22T01:00:00.000Z')

function testCatalogAnchor(epoch: number, ownerId = 'generation-test-catalog') {
  return deriveProposalCatalogMutationAnchorV2({
    ownerId,
    kind: 'LEGACY',
    inputCatalogEpoch: epoch - 1,
  })
}

function summary() {
  const facts = {
    name: 'generation-fixture',
    description: 'Existing generation fixture.',
    whenToUse: 'Use when generation behavior is tested.',
    provider: 'filesystem',
    source: 'project-dsh',
    scope: 'PROJECT' as const,
    writable: true,
    rootIdentityDigest: 'f'.repeat(64),
  }
  return { candidateId: deriveRecallCandidateId(facts), ...facts }
}

async function seedAuthorized(action: 'CREATE' | 'MERGE' = 'CREATE') {
  const domain = createMemoryRun2skillV2Domain()
  const fixture = createMinimalV2Fixtures()
  const owned = ExperienceIntentV2Schema.parse({
    ...fixture.proposalReadyIntent,
    revision: 1,
    explicitSave: false,
    status: 'RUN2SKILL_OWNED',
    recall: { state: 'NOT_STARTED', complete: false, summaryScanComplete: false, candidates: [] },
    coverage: { state: 'NOT_STARTED', retryUsed: false },
    generation: { state: 'NOT_STARTED', userRetryUsed: false, staleRefreshUsed: false, receipts: [] },
    stageCalls: [],
    lineageId: undefined,
  })
  const candidate = summary()
  const summaries = action === 'CREATE' ? [] : [candidate]
  const bodies = new Map<string, string>([[candidate.candidateId, '# Generation fixture\n\nExisting behavior.\n']])
  let snapshot: RecallCatalogSnapshot = {
    complete: true,
    runtimeCatalogDigest: '1'.repeat(64),
    pendingCatalogDigest: '2'.repeat(64),
    catalogEpoch: 4,
    catalogMutationReceiptDigest: '3'.repeat(64),
    summaries,
  }
  const recallCatalog = {
    snapshot: async () => snapshot,
    read: async ({ candidateId }: { candidateId: string }) => {
      const item = summaries.find(value => value.candidateId === candidateId)
      const content = bodies.get(candidateId)
      return item === undefined || content === undefined
        ? undefined
        : (() => {
            const exactSkillBytes = action === 'MERGE'
              ? `---\nname: ${item.name}\n---\n\n${content}`
              : content
            return {
            ...item,
            content,
              exactSkillBytes,
              skillBytesDigest: sha256Utf8(exactSkillBytes),
            }
          })()
    },
  }
  await domain.table('experience_intents').put(owned.intentId, owned)
  await domain.table('turn_observations').put(fixture.turnObservation.observationId, fixture.turnObservation)
  const batch = SessionBatchV2Schema.parse(fixture.sessionBatch)
  await domain.table('session_batches').put(batch.batchId, batch)
  await new CompleteCatalogRecallWorker(domain, {
    catalog: recallCatalog,
    classifier: { classify: async input => ({
      classifications: input.summaries.map(item => ({ candidateId: item.candidateId, classification: 'RELEVANT' as const })),
    }) },
  }).runOnce()
  await new CompleteCoverageWorker(domain, {
    catalog: recallCatalog,
    classifier: { classify: async input => ({ decisions: input.candidates.map(item => ({
      candidateId: item.candidateId,
      decision: action === 'MERGE' ? 'PARTIAL' as const : 'UNRELATED' as const,
      reason: 'The new experience adds behavior.',
    })) }) },
  }).runOnce()
  const authorized = ExperienceIntentV2Schema.parse(domain.experienceIntents.get(owned.intentId))
  expect(authorized.status).toBe(action === 'CREATE' ? 'CREATE_AUTHORIZED' : 'MERGE_AUTHORIZED')
  expect(authorized.coverage.targetDigest).toMatch(/^[a-f0-9]{64}$/u)
  if (action === 'CREATE') expect(authorized.coverage.targetDigest).toBe(deriveCreateTargetDigestV2(authorized))
  await domain.global.set(GlobalV2Schema.parse({
    ...domain.global.get(),
    proposalCatalogEpoch: snapshot.catalogEpoch,
    proposalCatalogLastMutation: testCatalogAnchor(snapshot.catalogEpoch),
  }))

  let generationSnapshot = {
    complete: true,
    runtimeCatalogDigest: snapshot.runtimeCatalogDigest,
    pendingCatalogDigest: snapshot.pendingCatalogDigest,
    externalPendingDigest: snapshot.pendingCatalogDigest,
    catalogEpoch: snapshot.catalogEpoch,
    catalogMutationReceiptDigest: snapshot.catalogMutationReceiptDigest,
  }
  let reads = 0
  const snapshotExclusions: Array<Parameters<GenerationCatalogPort['snapshot']>[0]['exclude']> = []
  let snapshotHook: ((input: Parameters<GenerationCatalogPort['snapshot']>[0], ordinal: number) => void) | undefined
  const catalog: GenerationCatalogPort = {
    snapshot: async input => {
      snapshotExclusions.push(input.exclude)
      const captured = generationSnapshot
      snapshotHook?.(input, snapshotExclusions.length)
      return captured
    },
    read: async input => {
      reads += 1
      return recallCatalog.read(input)
    },
  }
  let quiescenceState: 'VALID' | 'STALE' | 'INCOMPLETE' = 'VALID'
  let quiescenceHook: (() => typeof quiescenceState) | undefined
  const quiescence = { validate: async () => quiescenceHook?.() ?? quiescenceState }
  return {
    domain,
    intentId: owned.intentId,
    candidate,
    bodies,
    catalog,
    quiescence,
    get reads() { return reads },
    snapshotExclusions,
    setGenerationSnapshot(next: typeof generationSnapshot) { generationSnapshot = next },
    setSnapshotHook(next: typeof snapshotHook) { snapshotHook = next },
    setQuiescence(next: typeof quiescenceState) { quiescenceState = next },
    setQuiescenceHook(next: typeof quiescenceHook) { quiescenceHook = next },
  }
}

async function exposeSealedResultForRevalidation(seeded: Awaited<ReturnType<typeof seedAuthorized>>) {
  const intent = ExperienceIntentV2Schema.parse(seeded.domain.experienceIntents.get(seeded.intentId))
  const result = intent.generation.sealedResult!
  seeded.setGenerationSnapshot({
    complete: true,
    runtimeCatalogDigest: result.runtimeCatalogDigest,
    pendingCatalogDigest: 'e'.repeat(64),
    externalPendingDigest: result.externalPendingDigest,
    catalogEpoch: result.outcomeCatalogEpoch,
    catalogMutationReceiptDigest: result.mutationReceiptDigest,
  })
  return { intent, result }
}

function generator(overrides: Partial<SkillGenerator> = {}) {
  let calls = 0
  const value: SkillGenerator & { readonly calls: number } = {
    get calls() { return calls },
    generate: overrides.generate ?? (async input => {
      calls += 1
      return {
        name: input.action === 'MERGE' ? 'generation-fixture' : 'generated-workflow',
        description: 'A reusable generated workflow.',
        whenToUse: 'Use when the same workflow recurs.',
        content: '# Generated workflow\n\n1. Observe.\n2. Verify.',
      }
    }),
  }
  if (overrides.generate !== undefined) {
    const custom = overrides.generate
    value.generate = async input => {
      calls += 1
      return custom(input)
    }
  }
  return value
}

function generationWorker(
  seeded: Awaited<ReturnType<typeof seedAuthorized>>,
  options: Omit<ConstructorParameters<typeof GenerationWorker>[1], 'quiescence'>,
) {
  return new GenerationWorker(seeded.domain, { ...options, quiescence: seeded.quiescence })
}

describe('v2 generation lease worker', () => {
  it('supplies the exact writable Skill name to MERGE generation', async () => {
    const seeded = await seedAuthorized('MERGE')
    let targetName: string | undefined
    const model = generator({ generate: async input => {
      targetName = (input as typeof input & { targetName?: string }).targetName
      return {
        name: 'generation-fixture',
        description: 'A reusable generated workflow.',
        whenToUse: 'Use when the same workflow recurs.',
        content: '# Generated workflow\n\n1. Observe.\n2. Verify.',
      }
    } })

    await generationWorker(seeded, {
      catalog: seeded.catalog, generator: model, now: () => NOW,
    }).runOnce()

    expect(targetName).toBe('generation-fixture')
    expect(model.calls).toBe(1)
  })

  it('lets concurrent workers make exactly one generation call', async () => {
    const seeded = await seedAuthorized()
    const model = generator()
    await Promise.all([
      generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW }).runOnce(),
      generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW }).runOnce(),
    ])

    expect(model.calls).toBe(1)
    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'GENERATING',
      generation: { state: 'RESULT_COMMITTED', action: 'CREATE' },
    })
    expect(seeded.domain.proposalLineages.size).toBe(0)
    expect(seeded.domain.global.get().proposalGenerationLease).toMatchObject({ state: 'RESULT_COMMITTED' })
  })

  it('does not call the model while another Intent owns the global lease', async () => {
    const seeded = await seedAuthorized()
    const current = seeded.domain.global.get()
    await seeded.domain.global.set(GlobalV2Schema.parse({
      ...current,
      proposalGenerationLease: {
        schemaVersion: 1,
        leaseId: `lease_${'a'.repeat(64)}`,
        ownerIntentId: `intent_${'b'.repeat(64)}`,
        ownerRevision: 1,
        generationRevision: 1,
        action: 'CREATE',
        inputDigest: 'c'.repeat(64),
        externalPendingDigest: 'd'.repeat(64),
        catalogEpoch: current.proposalCatalogEpoch,
        acquiredAt: new Date(NOW).toISOString(),
        state: 'NOT_CALLED',
      },
    }))
    const model = generator()

    await generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW }).runOnce()

    expect(model.calls).toBe(0)
    expect(seeded.domain.experienceIntents.get(seeded.intentId)?.status).toBe('CREATE_AUTHORIZED')
  })

  it('releases the lease and stops before the model when either Catalog changed', async () => {
    const seeded = await seedAuthorized()
    seeded.setGenerationSnapshot({
      ...(await seeded.catalog.snapshot({} as never)),
      externalPendingDigest: '9'.repeat(64),
    })
    const model = generator()

    await generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW }).runOnce()

    expect(model.calls).toBe(0)
    expect(seeded.domain.global.get().proposalGenerationLease).toBeUndefined()
    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'NEEDS_ATTENTION',
      coverage: { state: 'NEEDS_ATTENTION', reasonCode: 'GENERATION_CATALOG_CHANGED' },
      generation: { state: 'NOT_STARTED' },
    })
  })

  it('moves a stale authorized Intent out of the queue instead of starving newer work', async () => {
    const seeded = await seedAuthorized()
    await seeded.domain.global.set(GlobalV2Schema.parse({
      ...seeded.domain.global.get(),
      proposalCatalogEpoch: seeded.domain.global.get().proposalCatalogEpoch + 1,
      proposalCatalogLastMutation: testCatalogAnchor(
        seeded.domain.global.get().proposalCatalogEpoch + 1,
        'external-catalog-change',
      ),
    }))
    const model = generator()

    await generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW }).runOnce()

    expect(model.calls).toBe(0)
    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'NEEDS_ATTENTION',
      coverage: { state: 'NEEDS_ATTENTION', reasonCode: 'GENERATION_CATALOG_CHANGED' },
    })
  })

  it('does not acquire a generation lease while an ALL purge is active', async () => {
    const seeded = await seedAuthorized()
    await seeded.domain.global.set(GlobalV2Schema.parse({
      ...seeded.domain.global.get(),
      purgeJournal: {
        schemaVersion: 1,
        purgeId: `purge_${'a'.repeat(64)}`,
        scopeBinding: { scope: 'ALL' },
        hideBefore: new Date(NOW).toISOString(),
        phase: 'QUIESCED',
        updatedAt: new Date(NOW).toISOString(),
      },
    }))
    const model = generator()

    await generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW }).runOnce()

    expect(model.calls).toBe(0)
    expect(seeded.domain.global.get().proposalGenerationLease).toBeUndefined()
    expect(seeded.domain.experienceIntents.get(seeded.intentId)?.status).toBe('CREATE_AUTHORIZED')
  })

  it('seals safe output, advances one Catalog epoch, and does not create a Proposal body', async () => {
    const seeded = await seedAuthorized()
    const beforeEpoch = seeded.domain.global.get().proposalCatalogEpoch

    await generationWorker(seeded, {
      catalog: seeded.catalog,
      generator: generator(),
      now: () => NOW,
    }).runOnce()

    const intent = ExperienceIntentV2Schema.parse(seeded.domain.experienceIntents.get(seeded.intentId))
    expect(intent.generation.sealedResult?.body).toMatchObject({ name: 'generated-workflow' })
    expect(intent.generation.sealedResult?.body.exactSkillBytes).toContain('# Generated workflow')
    expect(intent.generation.receipts.map(item => item.kind)).toEqual([
      'LEASE_ACQUIRED', 'CALL_RESERVED', 'CALL_TERMINAL', 'RESULT_SEALED',
    ])
    expect(seeded.domain.global.get()).toMatchObject({
      proposalCatalogEpoch: beforeEpoch + 1,
      proposalCatalogLastMutation: {
        kind: 'GENERATION_RESULT',
        ownerId: intent.generation.sealedResult!.resultId,
        digest: intent.generation.sealedResult!.mutationReceiptDigest,
      },
      proposalGenerationLease: { state: 'RESULT_COMMITTED' },
    })
    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toBeUndefined()
    expect(seeded.domain.proposalLineages.size).toBe(0)
  })

  it('revalidates the sealed result and commits exactly one active Proposal', async () => {
    const seeded = await seedAuthorized()
    const model = generator()
    const worker = generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW })

    await worker.runOnce()
    const { result } = await exposeSealedResultForRevalidation(seeded)
    await worker.runOnce()
    await worker.runOnce()

    expect(model.calls).toBe(1)
    expect(seeded.snapshotExclusions).toContainEqual({
      kind: 'GENERATION_RESULT', resultId: result.resultId, receiptDigest: result.receiptDigest,
    })
    expect(seeded.domain.proposalLineages.size).toBe(1)
    const lineage = [...seeded.domain.proposalLineages.values()][0]
    expect(lineage).toMatchObject({
      origin: 'RUN2SKILL_V2',
      state: 'ACTIVE_PROPOSAL',
      persistenceScope: 'PROJECT',
      behaviorSignature: ExperienceIntentV2Schema.parse(seeded.domain.experienceIntents.get(seeded.intentId)).behaviorSignature,
      currentProposalRevision: 1,
      proposalRevisions: [expect.objectContaining({
        action: 'CREATE',
        body: result.body,
        generationResultReceiptDigest: result.receiptDigest,
        state: 'ACTIVE_PROPOSAL',
      })],
    })
    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'PROPOSAL_READY',
      generation: {
        state: 'PROPOSAL_READY',
        receipts: [
          expect.objectContaining({ kind: 'LEASE_ACQUIRED' }),
          expect.objectContaining({ kind: 'CALL_RESERVED' }),
          expect.objectContaining({ kind: 'CALL_TERMINAL' }),
          expect.objectContaining({ kind: 'RESULT_SEALED' }),
          expect.objectContaining({ kind: 'PROPOSAL_AUTHORIZED' }),
          expect.objectContaining({ kind: 'BODY_COMMITTED' }),
          expect.objectContaining({ kind: 'INDEX_COMMITTED' }),
        ],
      },
    })
    const global = seeded.domain.global.get()
    if (lineage?.origin !== 'RUN2SKILL_V2') throw new Error('expected native Proposal lineage')
    expect(global.proposalCatalogEpoch).toBe(result.outcomeCatalogEpoch + 1)
    expect(global.proposalCatalogLastMutation).toMatchObject({
      kind: 'PROPOSAL',
      ownerId: lineage.proposalRevisions[0]!.proposalId,
      digest: lineage.proposalRevisions[0]!.catalogMutationReceiptDigest,
    })
    expect(global.proposalGenerationLease).toBeUndefined()
    expect(global.proposalCatalogMutationJournal).toBeUndefined()
    expect(Object.values(global.behaviorSignatureIndex)).toEqual([
      expect.objectContaining({ ownerIntentId: seeded.intentId, state: 'ACTIVE' }),
    ])
  })

  it('appends a refreshed Proposal revision and preserves the superseded draft during crash rollback', async () => {
    const seeded = await seedAuthorized()
    const firstWorker = generationWorker(seeded, { catalog: seeded.catalog, generator: generator(), now: () => NOW })
    await firstWorker.runOnce()
    await exposeSealedResultForRevalidation(seeded)
    await firstWorker.runOnce()
    await firstWorker.runOnce()

    const first = ProposalLineageV2Schema.parse([...seeded.domain.proposalLineages.values()][0])
    if (first.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
    const stale = ProposalLineageV2Schema.parse({
      ...first,
      revision: first.revision + 1,
      proposalRevisions: first.proposalRevisions.map(proposal => ({
        ...proposal,
        reviewFailureCode: 'CATALOG_CHANGED',
        reviewAttemptedAt: new Date(NOW).toISOString(),
      })),
    })
    if (stale.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
    await seeded.domain.table('proposal_lineages').put(stale.lineageId, stale)
    await seeded.domain.global.set(GlobalV2Schema.parse({
      ...seeded.domain.global.get(),
      migration: {
        schemaVersion: 1,
        phase: 'COMMITTED',
        source: { domainName: 'run2skill_v1', domainVersion: 2, globalSchemaVersion: 1 },
        sourceFingerprint: 'a'.repeat(64),
        counts: { workItems: 0, lineages: 0, activeLegacyProposals: 0 },
        startedAt: new Date(NOW).toISOString(),
        updatedAt: new Date(NOW).toISOString(),
        committedAt: new Date(NOW).toISOString(),
        activationFenceDigest: 'b'.repeat(64),
      },
      activation: {
        committedAt: new Date(NOW).toISOString(),
        sourceFingerprint: 'a'.repeat(64),
        observerStartWatermarks: {},
        observerStartWatermarkDigest: sha256Utf8(canonicalJson({})),
        legacyPendingCatalogDigest: sha256Utf8(canonicalJson([])),
        legacyPendingCandidateCount: 0,
      },
    }))
    await new V2ProposalRefreshCoordinator(seeded.domain, {
      now: () => new Date(NOW).toISOString(),
    }).refresh({
      lineageId: stale.lineageId,
      expectedLineageRevision: stale.revision,
      proposalRef: deriveV2ProposalRef(stale),
    })

    const refreshedGlobal = seeded.domain.global.get()
    const refreshedSnapshot = {
      complete: true as const,
      runtimeCatalogDigest: 'a'.repeat(64),
      pendingCatalogDigest: 'b'.repeat(64),
      externalPendingDigest: 'b'.repeat(64),
      catalogEpoch: refreshedGlobal.proposalCatalogEpoch,
      catalogMutationReceiptDigest: refreshedGlobal.proposalCatalogLastMutation.digest,
      summaries: [],
    }
    const { externalPendingDigest: _externalPendingDigest, ...recallSnapshot } = refreshedSnapshot
    const recallCatalog = {
      snapshot: async () => recallSnapshot,
      read: async () => undefined,
    }
    await new CompleteCatalogRecallWorker(seeded.domain, {
      catalog: recallCatalog,
      classifier: { classify: async () => ({ classifications: [] }) },
    }).runOnce()
    await new CompleteCoverageWorker(seeded.domain, {
      catalog: recallCatalog,
      classifier: { classify: async () => ({ decisions: [] }) },
    }).runOnce()
    const refreshedAuthorized = seeded.domain.experienceIntents.get(seeded.intentId)
    if (refreshedAuthorized?.status !== 'CREATE_AUTHORIZED') {
      throw new Error(JSON.stringify(refreshedAuthorized))
    }
    expect(refreshedAuthorized).toMatchObject({
      status: 'CREATE_AUTHORIZED',
      generation: { staleRefreshUsed: true },
    })
    seeded.setGenerationSnapshot(refreshedSnapshot)

    const secondWorker = generationWorker(seeded, { catalog: seeded.catalog, generator: generator(), now: () => NOW + 1_000 })
    await secondWorker.runOnce()
    const refreshedResultGlobal = seeded.domain.global.get()
    const { result: refreshedResult } = await exposeSealedResultForRevalidation(seeded)
    await secondWorker.runOnce()
    await secondWorker.runOnce()

    const lineage = ProposalLineageV2Schema.parse(seeded.domain.proposalLineages.get(stale.lineageId))
    if (lineage.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
    expect(lineage).toMatchObject({
      origin: 'RUN2SKILL_V2',
      state: 'ACTIVE_PROPOSAL',
      currentProposalRevision: 2,
      proposalRevisions: [
        expect.objectContaining({ revision: 1, state: 'SUPERSEDED', reviewFailureCode: 'CATALOG_CHANGED' }),
        expect.objectContaining({ revision: 2, state: 'ACTIVE_PROPOSAL' }),
      ],
    })
    expect(new Set(lineage.proposalRevisions.map(proposal => proposal.proposalId)).size).toBe(2)

    const ready = ExperienceIntentV2Schema.parse(seeded.domain.experienceIntents.get(seeded.intentId))
    const proposalAuthorized = ExperienceIntentV2Schema.parse({
      ...ready,
      revision: lineage.ownerIntentRevision,
      status: 'GENERATING',
      generation: {
        ...ready.generation,
        state: 'PROPOSAL_COMMIT_AUTHORIZED',
        receipts: ready.generation.receipts.slice(0, 5),
      },
    })
    await seeded.domain.table('experience_intents').put(proposalAuthorized.intentId, proposalAuthorized)
    await seeded.domain.global.set(GlobalV2Schema.parse({
      ...refreshedResultGlobal,
      proposalGenerationLease: {
        ...refreshedResultGlobal.proposalGenerationLease!,
        proposalAuthorizationReceiptDigest: proposalAuthorized.generation.receipts[4]!.digest,
        state: 'PROPOSAL_COMMIT_AUTHORIZED',
      },
      proposalCatalogMutationJournal: {
        schemaVersion: 1,
        mutationId: deriveProposalCatalogMutationIdV2({
          ownerId: proposalAuthorized.generation.proposalId!,
          kind: 'PROPOSAL',
          inputCatalogEpoch: refreshedResult.outcomeCatalogEpoch,
        }),
        ownerId: proposalAuthorized.generation.proposalId!,
        kind: 'PROPOSAL',
        phase: 'PREPARED',
        preparedAt: new Date(NOW).toISOString(),
      },
    }))
    seeded.setQuiescence('STALE')

    await generationWorker(seeded, {
      catalog: seeded.catalog, generator: generator(), now: () => NOW + 2_000,
    }).recover()

    const retained = ProposalLineageV2Schema.parse(seeded.domain.proposalLineages.get(stale.lineageId))
    expect(retained).toMatchObject({
      origin: 'RUN2SKILL_V2',
      state: 'REFRESHING',
      currentProposalRevision: 1,
      proposalRevisions: [expect.objectContaining({ revision: 1, state: 'SUPERSEDED' })],
    })
    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toBeUndefined()
    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'NEEDS_ATTENTION', generation: { state: 'NEEDS_ATTENTION', reasonCode: 'STALE_RESULT' },
    })
  })

  it('does not commit a Proposal when external Pending Catalog membership changed after generation', async () => {
    const seeded = await seedAuthorized()
    const model = generator()
    const worker = generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW })

    await worker.runOnce()
    const { result } = await exposeSealedResultForRevalidation(seeded)
    seeded.setGenerationSnapshot({
      complete: true,
      runtimeCatalogDigest: result.runtimeCatalogDigest,
      pendingCatalogDigest: 'e'.repeat(64),
      externalPendingDigest: '9'.repeat(64),
      catalogEpoch: result.outcomeCatalogEpoch,
      catalogMutationReceiptDigest: result.mutationReceiptDigest,
    })
    await worker.runOnce()

    expect(model.calls).toBe(1)
    expect(seeded.domain.proposalLineages.size).toBe(0)
    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'NEEDS_ATTENTION',
      generation: { state: 'NEEDS_ATTENTION', reasonCode: 'STALE_RESULT', sealedResult: result },
    })
    expect(seeded.domain.global.get().proposalGenerationLease).toBeUndefined()
    expect(Object.values(seeded.domain.global.get().behaviorSignatureIndex)).toEqual([
      expect.objectContaining({ ownerIntentId: seeded.intentId, state: 'RESERVED' }),
    ])
  })

  it('allows a late Runtime change after the final snapshot to stale the draft at review instead of requiring CAS', async () => {
    const seeded = await seedAuthorized()
    const model = generator()
    const worker = generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW })
    await worker.runOnce()
    const { result } = await exposeSealedResultForRevalidation(seeded)
    let excludedSnapshots = 0
    seeded.setSnapshotHook(input => {
      if (input.exclude?.kind !== 'GENERATION_RESULT' || ++excludedSnapshots !== 2) return
      seeded.setGenerationSnapshot({
        complete: true,
        runtimeCatalogDigest: '9'.repeat(64),
        pendingCatalogDigest: 'e'.repeat(64),
        externalPendingDigest: result.externalPendingDigest,
        catalogEpoch: result.outcomeCatalogEpoch,
        catalogMutationReceiptDigest: result.mutationReceiptDigest,
      })
    })

    await worker.runOnce()

    expect(model.calls).toBe(1)
    expect(seeded.domain.proposalLineages.size).toBe(1)
    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'PROPOSAL_READY', generation: { state: 'PROPOSAL_READY' },
    })
    expect(seeded.domain.global.get().proposalGenerationLease).toBeUndefined()
  })

  it.each(['STALE', 'INCOMPLETE'] as const)(
    'does not call the model when the Session quiescence fence is %s',
    async fenceState => {
      const seeded = await seedAuthorized()
      const model = generator()
      seeded.setQuiescence(fenceState)

      await generationWorker(seeded, {
        catalog: seeded.catalog, generator: model, now: () => NOW,
      }).runOnce()

      expect(model.calls).toBe(0)
      expect(seeded.domain.proposalLineages.size).toBe(0)
      expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
        status: 'NEEDS_ATTENTION',
        coverage: { reasonCode: `SESSION_QUIESCENCE_${fenceState}` },
        generation: { state: 'NOT_STARTED' },
      })
      expect(seeded.domain.global.get().proposalGenerationLease).toBeUndefined()
    },
  )

  it('seals the result as stale without creating a Proposal when the Session resumes during generation', async () => {
    const seeded = await seedAuthorized()
    const model = generator({ generate: async () => {
      seeded.setQuiescence('STALE')
      return {
        name: 'generated-workflow',
        description: 'A reusable generated workflow.',
        whenToUse: 'Use when the same workflow recurs.',
        content: '# Generated workflow\n\n1. Observe.\n2. Verify.',
      }
    } })

    await generationWorker(seeded, {
      catalog: seeded.catalog, generator: model, now: () => NOW,
    }).runOnce()

    expect(model.calls).toBe(1)
    expect(seeded.domain.proposalLineages.size).toBe(0)
    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'NEEDS_ATTENTION', generation: { state: 'NEEDS_ATTENTION', reasonCode: 'STALE_RESULT' },
    })
    expect(seeded.domain.global.get().proposalGenerationLease).toBeUndefined()
  })

  it('rolls back a prepared Proposal body when Session quiescence is lost during the body commit', async () => {
    const seeded = await seedAuthorized()
    const model = generator()
    const worker = generationWorker(seeded, {
      catalog: seeded.catalog, generator: model, now: () => NOW,
    })
    await worker.runOnce()
    await exposeSealedResultForRevalidation(seeded)
    seeded.setQuiescenceHook(() => {
      const intent = ExperienceIntentV2Schema.parse(seeded.domain.experienceIntents.get(seeded.intentId))
      return intent.generation.state === 'PROPOSAL_BODY_COMMITTED' ? 'STALE' : 'VALID'
    })

    await worker.runOnce()

    expect(model.calls).toBe(1)
    expect(seeded.domain.proposalLineages.size).toBe(0)
    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'NEEDS_ATTENTION', generation: { state: 'NEEDS_ATTENTION', reasonCode: 'STALE_RESULT' },
    })
    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toBeUndefined()
    expect(seeded.domain.global.get().proposalGenerationLease).toBeUndefined()
  })

  it('re-reads the exact MERGE target after generation and rejects a changed body', async () => {
    const seeded = await seedAuthorized('MERGE')
    const model = generator()
    const worker = generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW })
    await worker.runOnce()
    await exposeSealedResultForRevalidation(seeded)
    seeded.bodies.set(seeded.candidate.candidateId, '# Changed after generation\n')

    await worker.runOnce()

    expect(model.calls).toBe(1)
    expect(seeded.reads).toBe(2)
    expect(seeded.domain.proposalLineages.size).toBe(0)
    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'NEEDS_ATTENTION', generation: { state: 'NEEDS_ATTENTION', reasonCode: 'STALE_RESULT' },
    })
  })

  it('never duplicates the Proposal body when commit workers race or replay', async () => {
    const seeded = await seedAuthorized()
    const model = generator()
    const first = generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW })
    const second = generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW })
    await first.runOnce()
    await exposeSealedResultForRevalidation(seeded)

    await Promise.all([first.runOnce(), second.runOnce()])
    expect(seeded.domain.proposalLineages.size).toBe(1)
    await Promise.all([first.recover(), second.recover()])

    expect(model.calls).toBe(1)
    expect(seeded.domain.proposalLineages.size).toBe(1)
    const lineage = [...seeded.domain.proposalLineages.values()][0]
    expect(lineage?.origin === 'RUN2SKILL_V2' ? lineage.proposalRevisions : []).toHaveLength(1)
    expect(seeded.domain.global.get().proposalGenerationLease).toBeUndefined()
  })

  it('recovers when the Intent authorization was durable but the lease promotion was lost', async () => {
    const seeded = await seedAuthorized()
    const model = generator()
    const worker = generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW })
    await worker.runOnce()
    const resultGlobal = seeded.domain.global.get()
    await exposeSealedResultForRevalidation(seeded)
    await worker.runOnce()
    const ready = ExperienceIntentV2Schema.parse(seeded.domain.experienceIntents.get(seeded.intentId))
    const authorized = ExperienceIntentV2Schema.parse({
      ...ready,
      revision: ready.revision - 2,
      status: 'GENERATING',
      lineageId: undefined,
      generation: {
        ...ready.generation,
        state: 'PROPOSAL_COMMIT_AUTHORIZED',
        receipts: ready.generation.receipts.slice(0, 5),
      },
    })
    seeded.domain.proposalLineages.clear()
    await seeded.domain.table('experience_intents').put(authorized.intentId, authorized)
    await seeded.domain.global.set(resultGlobal)

    await worker.recover()

    expect(model.calls).toBe(1)
    expect(seeded.domain.proposalLineages.size).toBe(1)
    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'PROPOSAL_READY', generation: { state: 'PROPOSAL_READY' },
    })
    expect(seeded.domain.global.get().proposalGenerationLease).toBeUndefined()
  })

  it('repairs a prepared Proposal mutation from the authoritative body without generating again', async () => {
    const seeded = await seedAuthorized()
    const model = generator()
    const worker = generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW })
    await worker.runOnce()
    const resultGlobal = seeded.domain.global.get()
    const { result } = await exposeSealedResultForRevalidation(seeded)
    await worker.runOnce()
    const ready = ExperienceIntentV2Schema.parse(seeded.domain.experienceIntents.get(seeded.intentId))
    const authorized = ExperienceIntentV2Schema.parse({
      ...ready,
      revision: ready.revision - 2,
      status: 'GENERATING',
      lineageId: undefined,
      generation: {
        ...ready.generation,
        state: 'PROPOSAL_COMMIT_AUTHORIZED',
        receipts: ready.generation.receipts.slice(0, 5),
      },
    })
    const authorizationReceipt = authorized.generation.receipts.at(-1)!
    const mutationId = deriveProposalCatalogMutationIdV2({
      ownerId: authorized.generation.proposalId!,
      kind: 'PROPOSAL',
      inputCatalogEpoch: result.outcomeCatalogEpoch,
    })
    await seeded.domain.table('experience_intents').put(authorized.intentId, authorized)
    await seeded.domain.global.set(GlobalV2Schema.parse({
      ...resultGlobal,
      proposalGenerationLease: {
        ...resultGlobal.proposalGenerationLease!,
        proposalAuthorizationReceiptDigest: authorizationReceipt.digest,
        state: 'PROPOSAL_COMMIT_AUTHORIZED',
      },
      proposalCatalogMutationJournal: {
        schemaVersion: 1,
        mutationId,
        ownerId: authorized.generation.proposalId!,
        kind: 'PROPOSAL',
        phase: 'PREPARED',
        preparedAt: new Date(NOW).toISOString(),
      },
    }))

    await worker.recover()

    expect(model.calls).toBe(1)
    expect(seeded.domain.proposalLineages.size).toBe(1)
    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'PROPOSAL_READY', generation: { state: 'PROPOSAL_READY' },
    })
    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toBeUndefined()
    expect(seeded.domain.global.get().proposalGenerationLease).toBeUndefined()
  })

  it('finalizes a prepared Proposal when both body and Intent body receipt were already durable', async () => {
    const seeded = await seedAuthorized()
    const model = generator()
    const worker = generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW })
    await worker.runOnce()
    const resultGlobal = seeded.domain.global.get()
    const { result } = await exposeSealedResultForRevalidation(seeded)
    await worker.runOnce()
    const ready = ExperienceIntentV2Schema.parse(seeded.domain.experienceIntents.get(seeded.intentId))
    const bodyCommitted = ExperienceIntentV2Schema.parse({
      ...ready,
      revision: ready.revision - 1,
      status: 'GENERATING',
      generation: {
        ...ready.generation,
        state: 'PROPOSAL_BODY_COMMITTED',
        receipts: ready.generation.receipts.slice(0, 6),
      },
    })
    await seeded.domain.table('experience_intents').put(bodyCommitted.intentId, bodyCommitted)
    await seeded.domain.global.set(GlobalV2Schema.parse({
      ...resultGlobal,
      proposalGenerationLease: {
        ...resultGlobal.proposalGenerationLease!,
        proposalAuthorizationReceiptDigest: bodyCommitted.generation.receipts[4]!.digest,
        state: 'PROPOSAL_COMMIT_AUTHORIZED',
      },
      proposalCatalogMutationJournal: {
        schemaVersion: 1,
        mutationId: deriveProposalCatalogMutationIdV2({
          ownerId: bodyCommitted.generation.proposalId!, kind: 'PROPOSAL', inputCatalogEpoch: result.outcomeCatalogEpoch,
        }),
        ownerId: bodyCommitted.generation.proposalId!,
        kind: 'PROPOSAL',
        phase: 'PREPARED',
        preparedAt: new Date(NOW).toISOString(),
      },
    }))

    await worker.recover()

    expect(model.calls).toBe(1)
    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'PROPOSAL_READY', generation: { state: 'PROPOSAL_READY' },
    })
    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toBeUndefined()
    expect(seeded.domain.global.get().proposalGenerationLease).toBeUndefined()
    expect(Object.values(seeded.domain.global.get().behaviorSignatureIndex)).toEqual([
      expect.objectContaining({ ownerIntentId: seeded.intentId, state: 'ACTIVE' }),
    ])
  })

  it('rolls a prepared body-committed crash back to stale attention when Session quiescence is lost', async () => {
    const seeded = await seedAuthorized()
    const model = generator()
    const worker = generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW })
    await worker.runOnce()
    const resultGlobal = seeded.domain.global.get()
    const { result } = await exposeSealedResultForRevalidation(seeded)
    await worker.runOnce()
    const ready = ExperienceIntentV2Schema.parse(seeded.domain.experienceIntents.get(seeded.intentId))
    const bodyCommitted = ExperienceIntentV2Schema.parse({
      ...ready,
      revision: ready.revision - 1,
      status: 'GENERATING',
      generation: {
        ...ready.generation,
        state: 'PROPOSAL_BODY_COMMITTED',
        receipts: ready.generation.receipts.slice(0, 6),
      },
    })
    await seeded.domain.table('experience_intents').put(bodyCommitted.intentId, bodyCommitted)
    await seeded.domain.global.set(GlobalV2Schema.parse({
      ...resultGlobal,
      proposalGenerationLease: {
        ...resultGlobal.proposalGenerationLease!,
        proposalAuthorizationReceiptDigest: bodyCommitted.generation.receipts[4]!.digest,
        state: 'PROPOSAL_COMMIT_AUTHORIZED',
      },
      proposalCatalogMutationJournal: {
        schemaVersion: 1,
        mutationId: deriveProposalCatalogMutationIdV2({
          ownerId: bodyCommitted.generation.proposalId!, kind: 'PROPOSAL', inputCatalogEpoch: result.outcomeCatalogEpoch,
        }),
        ownerId: bodyCommitted.generation.proposalId!,
        kind: 'PROPOSAL',
        phase: 'PREPARED',
        preparedAt: new Date(NOW).toISOString(),
      },
    }))
    seeded.setQuiescence('STALE')

    await generationWorker(seeded, {
      catalog: seeded.catalog, generator: model, now: () => NOW,
    }).recover()

    expect(model.calls).toBe(1)
    expect(seeded.domain.proposalLineages.size).toBe(0)
    const stale = seeded.domain.experienceIntents.get(seeded.intentId)!
    expect(stale).toMatchObject({
      status: 'NEEDS_ATTENTION',
      generation: {
        state: 'NEEDS_ATTENTION', reasonCode: 'STALE_RESULT',
      },
    })
    expect(stale).not.toHaveProperty('lineageId')
    expect(stale.generation).not.toHaveProperty('proposalId')
    expect(stale.generation).not.toHaveProperty('revalidationAuthorization')
    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toBeUndefined()
    expect(seeded.domain.global.get().proposalGenerationLease).toBeUndefined()
    expect(Object.values(seeded.domain.global.get().behaviorSignatureIndex)).toEqual([
      expect.objectContaining({ ownerIntentId: seeded.intentId, state: 'RESERVED' }),
    ])
  })

  it('recovers stale after rollback deleted the body, whether the prepared journal was cleared or not', async () => {
    for (const keepPreparedJournal of [true, false]) {
      const seeded = await seedAuthorized()
      const model = generator()
      const worker = generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW })
      await worker.runOnce()
      const resultGlobal = seeded.domain.global.get()
      const { result } = await exposeSealedResultForRevalidation(seeded)
      await worker.runOnce()
      const ready = ExperienceIntentV2Schema.parse(seeded.domain.experienceIntents.get(seeded.intentId))
      const bodyCommitted = ExperienceIntentV2Schema.parse({
        ...ready,
        revision: ready.revision - 1,
        status: 'GENERATING',
        generation: {
          ...ready.generation,
          state: 'PROPOSAL_BODY_COMMITTED',
          receipts: ready.generation.receipts.slice(0, 6),
        },
      })
      seeded.domain.proposalLineages.clear()
      await seeded.domain.table('experience_intents').put(bodyCommitted.intentId, bodyCommitted)
      await seeded.domain.global.set(GlobalV2Schema.parse({
        ...resultGlobal,
        proposalGenerationLease: {
          ...resultGlobal.proposalGenerationLease!,
          proposalAuthorizationReceiptDigest: bodyCommitted.generation.receipts[4]!.digest,
          state: 'PROPOSAL_COMMIT_AUTHORIZED',
        },
        proposalCatalogMutationJournal: keepPreparedJournal ? {
          schemaVersion: 1,
          mutationId: deriveProposalCatalogMutationIdV2({
            ownerId: bodyCommitted.generation.proposalId!, kind: 'PROPOSAL', inputCatalogEpoch: result.outcomeCatalogEpoch,
          }),
          ownerId: bodyCommitted.generation.proposalId!,
          kind: 'PROPOSAL',
          phase: 'PREPARED',
          preparedAt: new Date(NOW).toISOString(),
        } : undefined,
      }))

      await worker.recover()
      await worker.recover()

      expect(model.calls).toBe(1)
      expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
        status: 'NEEDS_ATTENTION', generation: { state: 'NEEDS_ATTENTION', reasonCode: 'STALE_RESULT' },
      })
      expect(seeded.domain.global.get().proposalCatalogMutationJournal).toBeUndefined()
      expect(seeded.domain.global.get().proposalGenerationLease).toBeUndefined()
      expect(Object.values(seeded.domain.global.get().behaviorSignatureIndex)).toEqual([
        expect.objectContaining({ ownerIntentId: seeded.intentId, state: 'RESERVED' }),
      ])
    }
  })

  it('rejects a schema-valid prepared Proposal body that differs from the sealed result', async () => {
    const seeded = await seedAuthorized()
    const model = generator()
    const worker = generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW })
    await worker.runOnce()
    const resultGlobal = seeded.domain.global.get()
    const { result } = await exposeSealedResultForRevalidation(seeded)
    await worker.runOnce()
    const ready = ExperienceIntentV2Schema.parse(seeded.domain.experienceIntents.get(seeded.intentId))
    const authorized = ExperienceIntentV2Schema.parse({
      ...ready,
      revision: ready.revision - 2,
      status: 'GENERATING',
      lineageId: undefined,
      generation: {
        ...ready.generation,
        state: 'PROPOSAL_COMMIT_AUTHORIZED',
        receipts: ready.generation.receipts.slice(0, 5),
      },
    })
    const lineage = ProposalLineageV2Schema.parse([...seeded.domain.proposalLineages.values()][0])
    if (lineage.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
    const tampered = ProposalLineageV2Schema.parse({
      ...lineage,
      proposalRevisions: lineage.proposalRevisions.map(revision => ({
        ...revision,
        body: { ...revision.body, description: 'Different but schema-valid body.' },
      })),
    })
    await seeded.domain.table('proposal_lineages').put(tampered.lineageId, tampered)
    await seeded.domain.table('experience_intents').put(authorized.intentId, authorized)
    await seeded.domain.global.set(GlobalV2Schema.parse({
      ...resultGlobal,
      proposalGenerationLease: {
        ...resultGlobal.proposalGenerationLease!,
        proposalAuthorizationReceiptDigest: authorized.generation.receipts.at(-1)!.digest,
        state: 'PROPOSAL_COMMIT_AUTHORIZED',
      },
      proposalCatalogMutationJournal: {
        schemaVersion: 1,
        mutationId: deriveProposalCatalogMutationIdV2({
          ownerId: authorized.generation.proposalId!, kind: 'PROPOSAL', inputCatalogEpoch: result.outcomeCatalogEpoch,
        }),
        ownerId: authorized.generation.proposalId!,
        kind: 'PROPOSAL',
        phase: 'PREPARED',
        preparedAt: new Date(NOW).toISOString(),
      },
    }))

    await worker.recover()

    expect(model.calls).toBe(1)
    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'NEEDS_ATTENTION', generation: { state: 'NEEDS_ATTENTION', reasonCode: 'STALE_RESULT' },
    })
    expect(seeded.domain.global.get().proposalGenerationLease).toBeUndefined()
    expect(Object.values(seeded.domain.global.get().behaviorSignatureIndex)).toEqual([
      expect.objectContaining({ ownerIntentId: seeded.intentId, state: 'RESERVED' }),
    ])
  })

  it('keeps ACTIVE_COMPLETE leased when the exact ACTIVE behavior index is missing', async () => {
    const seeded = await seedAuthorized()
    const model = generator()
    const worker = generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW })
    await worker.runOnce()
    const resultGlobal = seeded.domain.global.get()
    await exposeSealedResultForRevalidation(seeded)
    await worker.runOnce()
    const ready = ExperienceIntentV2Schema.parse(seeded.domain.experienceIntents.get(seeded.intentId))
    const completed = ready.generation.receipts.find(receipt => receipt.kind === 'INDEX_COMMITTED')!
    const authorized = ready.generation.receipts.find(receipt => receipt.kind === 'PROPOSAL_AUTHORIZED')!
    await seeded.domain.global.set(GlobalV2Schema.parse({
      ...seeded.domain.global.get(),
      behaviorSignatureIndex: {},
      proposalGenerationLease: {
        ...resultGlobal.proposalGenerationLease!,
        proposalAuthorizationReceiptDigest: authorized.digest,
        completionReceiptDigest: completed.digest,
        state: 'ACTIVE_COMPLETE',
      },
    }))

    await worker.recover()

    expect(model.calls).toBe(1)
    expect(seeded.domain.global.get().proposalGenerationLease).toMatchObject({
      leaseId: ready.generation.leaseId,
      state: 'ACTIVE_COMPLETE',
      completionReceiptDigest: completed.digest,
    })
    expect(seeded.domain.global.get().behaviorSignatureIndex).toEqual({})
  })

  it('keeps ACTIVE_COMPLETE leased when immutable target binding was changed', async () => {
    const seeded = await seedAuthorized()
    const model = generator()
    const worker = generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW })
    await worker.runOnce()
    const resultGlobal = seeded.domain.global.get()
    await exposeSealedResultForRevalidation(seeded)
    await worker.runOnce()
    const ready = ExperienceIntentV2Schema.parse(seeded.domain.experienceIntents.get(seeded.intentId))
    const completed = ready.generation.receipts.find(receipt => receipt.kind === 'INDEX_COMMITTED')!
    const authorized = ready.generation.receipts.find(receipt => receipt.kind === 'PROPOSAL_AUTHORIZED')!
    const lineage = ProposalLineageV2Schema.parse([...seeded.domain.proposalLineages.values()][0])
    if (lineage.origin !== 'RUN2SKILL_V2') throw new Error('expected native lineage')
    const tampered = ProposalLineageV2Schema.parse({
      ...lineage,
      proposalRevisions: lineage.proposalRevisions.map(revision => ({
        ...revision,
        targetIdentityDigest: '9'.repeat(64),
      })),
    })
    await seeded.domain.table('proposal_lineages').put(tampered.lineageId, tampered)
    await seeded.domain.global.set(GlobalV2Schema.parse({
      ...seeded.domain.global.get(),
      proposalGenerationLease: {
        ...resultGlobal.proposalGenerationLease!,
        proposalAuthorizationReceiptDigest: authorized.digest,
        completionReceiptDigest: completed.digest,
        state: 'ACTIVE_COMPLETE',
      },
    }))

    await worker.recover()

    expect(model.calls).toBe(1)
    expect(seeded.domain.global.get().proposalGenerationLease).toMatchObject({
      leaseId: ready.generation.leaseId, state: 'ACTIVE_COMPLETE', completionReceiptDigest: completed.digest,
    })
  })

  it('distinguishes a known call failure from a returned result rejected by the Guard', async () => {
    for (const testCase of [
      {
        generate: async () => { throw new Error('model unavailable') },
        reasonCode: 'GENERATION_KNOWN_FAILED',
        barrierKind: 'KNOWN_FAILED',
        callOutcome: 'FAILED',
      },
      {
        generate: async () => ({
          name: 'unsafe-workflow',
          description: 'unsafe',
          whenToUse: 'unsafe',
          content: 'no markdown heading',
        }),
        reasonCode: 'GENERATION_RESULT_LOST',
        barrierKind: 'RESULT_LOST',
        callOutcome: 'SUCCEEDED',
      },
    ] as const) {
      const seeded = await seedAuthorized()
      await generationWorker(seeded, {
        catalog: seeded.catalog,
        generator: generator({ generate: testCase.generate }),
        now: () => NOW,
      }).runOnce()

      expect(seeded.domain.global.get().proposalGenerationLease).toBeUndefined()
      expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
        status: 'NEEDS_ATTENTION',
        generation: { state: 'NEEDS_ATTENTION', reasonCode: testCase.reasonCode },
        duplicateBarrier: { kind: testCase.barrierKind },
        stageCalls: expect.arrayContaining([expect.objectContaining({ stage: 'GENERATION', outcome: testCase.callOutcome })]),
      })
    }
  })

  it('rejects a returned body that exceeds the exact route output budget', async () => {
    const seeded = await seedAuthorized()
    await generationWorker(seeded, {
      catalog: seeded.catalog,
      generator: generator({ generate: async () => ({
        name: 'oversized-workflow',
        description: 'oversized',
        whenToUse: 'oversized',
        content: `# Oversized\n\n${'x'.repeat(9 * 1024)}`,
      }) }),
      now: () => NOW,
    }).runOnce()

    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'NEEDS_ATTENTION',
      generation: { reasonCode: 'GENERATION_RESULT_LOST' },
      duplicateBarrier: { kind: 'RESULT_LOST' },
    })
  })

  it('marks a reserved in-flight call outcome unknown and never replays it', async () => {
    const seeded = await seedAuthorized()
    let entered!: () => void
    let release!: () => void
    const didEnter = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    const model = generator({ generate: async () => {
      entered()
      await blocked
      return {
        name: 'late-workflow', description: 'late', whenToUse: 'late', content: '# Late\n',
      }
    } })
    const worker = generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW })
    const pending = worker.runOnce()
    await didEnter
    await worker.recover()
    release()
    await pending
    await worker.runOnce()

    expect(model.calls).toBe(1)
    expect(seeded.domain.global.get().proposalGenerationLease).toBeUndefined()
    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'NEEDS_ATTENTION',
      generation: { state: 'NEEDS_ATTENTION', reasonCode: 'GENERATION_OUTCOME_UNKNOWN' },
      duplicateBarrier: { kind: 'OUTCOME_UNKNOWN' },
    })
  })

  it('recovers a globally reserved call even if the Intent reservation write was lost', async () => {
    const seeded = await seedAuthorized()
    const authorized = ExperienceIntentV2Schema.parse(seeded.domain.experienceIntents.get(seeded.intentId))
    let entered!: () => void
    let release!: () => void
    const didEnter = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    const model = generator({ generate: async () => {
      entered()
      await blocked
      return { name: 'late-workflow', description: 'late', whenToUse: 'late', content: '# Late\n' }
    } })
    const worker = generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW })
    const pending = worker.runOnce()
    await didEnter
    expect(seeded.domain.global.get().proposalGenerationLease?.state).toBe('CALL_RESERVED')
    await seeded.domain.table('experience_intents').put(authorized.intentId, authorized)

    await worker.recover()
    release()
    await pending

    expect(model.calls).toBe(1)
    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'NEEDS_ATTENTION',
      generation: { reasonCode: 'GENERATION_OUTCOME_UNKNOWN' },
      duplicateBarrier: { kind: 'OUTCOME_UNKNOWN' },
    })
    expect(seeded.domain.global.get().proposalGenerationLease).toBeUndefined()
  })

  it('releases an orphan NOT_CALLED lease after its Intent already entered pre-call attention', async () => {
    const seeded = await seedAuthorized()
    const model = generator()
    const worker = generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW })
    await worker.runOnce()
    const completed = ExperienceIntentV2Schema.parse(seeded.domain.experienceIntents.get(seeded.intentId))
    const lease = seeded.domain.global.get().proposalGenerationLease!
    const attended = ExperienceIntentV2Schema.parse({
      ...completed,
      revision: completed.revision + 1,
      status: 'NEEDS_ATTENTION',
      coverage: { ...completed.coverage, state: 'NEEDS_ATTENTION', reasonCode: 'GENERATION_CATALOG_CHANGED' },
      generation: { state: 'NOT_STARTED', userRetryUsed: false, staleRefreshUsed: false, receipts: [] },
      stageCalls: completed.stageCalls.filter(call => call.stage !== 'GENERATION'),
      updatedAt: new Date(NOW).toISOString(),
    })
    await seeded.domain.table('experience_intents').put(attended.intentId, attended)
    await seeded.domain.global.set(GlobalV2Schema.parse({
      ...seeded.domain.global.get(),
      proposalCatalogEpoch: lease.catalogEpoch,
      proposalCatalogLastMutation: testCatalogAnchor(lease.catalogEpoch),
      proposalGenerationLease: {
        schemaVersion: 1,
        leaseId: lease.leaseId,
        ownerIntentId: lease.ownerIntentId,
        ownerRevision: lease.ownerRevision,
        generationRevision: lease.generationRevision,
        action: lease.action,
        inputDigest: lease.inputDigest,
        externalPendingDigest: lease.externalPendingDigest,
        catalogEpoch: lease.catalogEpoch,
        acquiredAt: lease.acquiredAt,
        state: 'NOT_CALLED',
      },
      proposalCatalogMutationJournal: undefined,
    }))

    await worker.recover()

    expect(seeded.domain.global.get().proposalGenerationLease).toBeUndefined()
  })

  it('requires an exact unchanged target body for MERGE before generation', async () => {
    const seeded = await seedAuthorized('MERGE')
    seeded.bodies.set(seeded.candidate.candidateId, '# Changed after coverage\n')
    const model = generator()

    await generationWorker(seeded, { catalog: seeded.catalog, generator: model, now: () => NOW }).runOnce()

    expect(seeded.reads).toBe(1)
    expect(model.calls).toBe(0)
    expect(seeded.domain.global.get().proposalGenerationLease).toBeUndefined()
    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'NEEDS_ATTENTION', coverage: { reasonCode: 'GENERATION_TARGET_CHANGED' },
    })
  })

  it('finalizes a sealed result when recovery finds the prepared Catalog journal', async () => {
    const seeded = await seedAuthorized()
    const worker = generationWorker(seeded, { catalog: seeded.catalog, generator: generator(), now: () => NOW })
    await worker.runOnce()
    const intent = ExperienceIntentV2Schema.parse(seeded.domain.experienceIntents.get(seeded.intentId))
    const result = intent.generation.sealedResult!
    const completedGlobal = seeded.domain.global.get()
    const lease = completedGlobal.proposalGenerationLease!
    await seeded.domain.global.set(GlobalV2Schema.parse({
      ...completedGlobal,
      proposalCatalogEpoch: result.inputCatalogEpoch,
      proposalCatalogLastMutation: testCatalogAnchor(result.inputCatalogEpoch),
      proposalGenerationLease: {
        schemaVersion: 1,
        leaseId: lease.leaseId,
        ownerIntentId: lease.ownerIntentId,
        ownerRevision: lease.ownerRevision,
        generationRevision: lease.generationRevision,
        action: lease.action,
        inputDigest: lease.inputDigest,
        externalPendingDigest: lease.externalPendingDigest,
        catalogEpoch: lease.catalogEpoch,
        acquiredAt: lease.acquiredAt,
        callId: result.callId,
        state: 'CALL_RESERVED',
      },
      proposalCatalogMutationJournal: {
        schemaVersion: 1,
        mutationId: deriveProposalCatalogMutationIdV2({
          ownerId: result.resultId, kind: 'GENERATION_RESULT', inputCatalogEpoch: result.inputCatalogEpoch,
        }),
        ownerId: result.resultId,
        kind: 'GENERATION_RESULT',
        phase: 'PREPARED',
        preparedAt: new Date(NOW).toISOString(),
      },
    }))

    await worker.recover()

    expect(seeded.domain.global.get()).toMatchObject({
      proposalCatalogEpoch: result.outcomeCatalogEpoch,
      proposalGenerationLease: { state: 'RESULT_COMMITTED', sealedResultReceiptDigest: result.receiptDigest },
    })
    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toBeUndefined()
  })

  it('abandons an uncommitted prepared result and seals RESULT_LOST instead of replaying', async () => {
    const seeded = await seedAuthorized()
    const worker = generationWorker(seeded, { catalog: seeded.catalog, generator: generator(), now: () => NOW })
    await worker.runOnce()
    const completed = ExperienceIntentV2Schema.parse(seeded.domain.experienceIntents.get(seeded.intentId))
    const result = completed.generation.sealedResult!
    const terminal = ExperienceIntentV2Schema.parse({
      ...completed,
      revision: completed.revision + 1,
      generation: {
        ...completed.generation,
        state: 'GENERATION_CALL_TERMINAL',
        resultDigest: undefined,
        sealedResult: undefined,
        receipts: completed.generation.receipts.slice(0, 3),
      },
      updatedAt: new Date(NOW).toISOString(),
    })
    await seeded.domain.table('experience_intents').put(terminal.intentId, terminal)
    const completedGlobal = seeded.domain.global.get()
    const lease = completedGlobal.proposalGenerationLease!
    await seeded.domain.global.set(GlobalV2Schema.parse({
      ...completedGlobal,
      proposalCatalogEpoch: result.inputCatalogEpoch,
      proposalCatalogLastMutation: testCatalogAnchor(result.inputCatalogEpoch),
      proposalGenerationLease: {
        schemaVersion: 1,
        leaseId: lease.leaseId,
        ownerIntentId: lease.ownerIntentId,
        ownerRevision: lease.ownerRevision,
        generationRevision: lease.generationRevision,
        action: lease.action,
        inputDigest: lease.inputDigest,
        externalPendingDigest: lease.externalPendingDigest,
        catalogEpoch: lease.catalogEpoch,
        acquiredAt: lease.acquiredAt,
        callId: result.callId,
        state: 'CALL_RESERVED',
      },
      proposalCatalogMutationJournal: {
        schemaVersion: 1,
        mutationId: deriveProposalCatalogMutationIdV2({
          ownerId: result.resultId, kind: 'GENERATION_RESULT', inputCatalogEpoch: result.inputCatalogEpoch,
        }),
        ownerId: result.resultId,
        kind: 'GENERATION_RESULT',
        phase: 'PREPARED',
        preparedAt: new Date(NOW).toISOString(),
      },
    }))

    await worker.recover()

    expect(seeded.domain.experienceIntents.get(seeded.intentId)).toMatchObject({
      status: 'NEEDS_ATTENTION',
      generation: { reasonCode: 'GENERATION_RESULT_LOST' },
      duplicateBarrier: { kind: 'RESULT_LOST' },
    })
    expect(seeded.domain.global.get().proposalGenerationLease).toBeUndefined()
    expect(seeded.domain.global.get().proposalCatalogMutationJournal).toBeUndefined()
  })
})
