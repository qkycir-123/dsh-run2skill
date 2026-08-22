import { describe, expect, it } from 'vitest'
import {
  AgentFirstOwnershipCoordinator,
  type OwnershipObservationPort,
} from '../src/application/ownership/index.js'
import {
  ExperienceIntentV2Schema,
  SessionBatchV2Schema,
  deriveOwnershipClaimIdV2,
  deriveOwnershipEvidenceDigestV2,
  type OwnershipEvidenceV2,
} from '../src/domain/v2/index.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

const NOW = '2026-08-22T01:00:00.000Z'

function observed(overrides: Partial<Extract<OwnershipEvidenceV2, { status: 'OBSERVED' }>> = {}): Extract<OwnershipEvidenceV2, { status: 'OBSERVED' }> {
  return {
    status: 'OBSERVED',
    observedAt: NOW,
    endManifest: {
      rootManifestDigest: '1'.repeat(64),
      runtimeCatalogDigest: '2'.repeat(64),
      complete: true,
    },
    catalogComplete: true,
    toolEvidenceComplete: true,
    agentActivity: 'NONE',
    changedCandidates: [],
    ...overrides,
  }
}

function port(evidence: OwnershipEvidenceV2): OwnershipObservationPort & { readonly calls: number } {
  let calls = 0
  return {
    get calls() { return calls },
    observe: async () => {
      calls += 1
      return evidence
    },
  }
}

async function seedReadyIntent() {
  const domain = createMemoryRun2skillV2Domain()
  const fixture = createMinimalV2Fixtures()
  const intent = ExperienceIntentV2Schema.parse(fixture.experienceIntent)
  const batch = SessionBatchV2Schema.parse({
    ...fixture.sessionBatch,
    revision: 2,
    detector: {
      result: 'READY',
      calls: [{
        stage: 'DETECTION', callId: `call_${'3'.repeat(64)}`, ordinal: 1,
        inputDigest: '4'.repeat(64), provider: fixture.sessionBatch.routeSnapshot.provider,
        model: fixture.sessionBatch.routeSnapshot.model,
        policyVersion: fixture.sessionBatch.routeSnapshot.policyVersion,
        outcome: 'SUCCEEDED', outputDigest: '5'.repeat(64),
      }],
      intentIds: [intent.intentId],
      carry: [],
    },
    state: 'COMMITTED_READY',
    updatedAt: NOW,
  })
  await domain.table('session_batches').put(batch.batchId, batch)
  await domain.table('experience_intents').put(intent.intentId, intent)
  return { domain, batch, intent }
}

describe('v2 Agent-first ownership coordinator', () => {
  it('gives Run2Skill ownership only when complete facts prove no Agent Skill activity or manifest change', async () => {
    const { domain, batch, intent } = await seedReadyIntent()
    const observation = port(observed())
    const worker = new AgentFirstOwnershipCoordinator(domain, { observation, now: () => Date.parse(NOW) })

    expect(await worker.runOnce()).toBe('PROCESSED')
    expect(await worker.runOnce()).toBe('IDLE')
    expect(observation.calls).toBe(1)
    expect(domain.experienceIntents.get(intent.intentId)).toMatchObject({
      status: 'RUN2SKILL_OWNED',
      ownership: { state: 'RUN2SKILL_OWNED', reasonCode: 'NO_AGENT_SKILL_ACTIVITY' },
    })
    expect(domain.sessionBatches.get(batch.batchId)?.manifestEndObservation).toMatchObject({
      state: 'OBSERVED', complete: true, rootManifestDigest: batch.batchManifestBaseline.rootManifestDigest,
    })
  })

  it('resolves the intent by Agent only with one exact successfully written matching candidate', async () => {
    const { domain, intent } = await seedReadyIntent()
    const candidate = {
      candidateId: 'project:agent-saved-skill', provider: 'filesystem', source: 'project-dsh',
      scope: 'PROJECT' as const, writable: true, exactReadbackComplete: true,
      bodyDigest: 'a'.repeat(64), writeAttribution: 'AGENT_WRITE_SUCCEEDED' as const,
      intentBinding: 'MATCH' as const,
    }
    const observation = port(observed({
      endManifest: { rootManifestDigest: '9'.repeat(64), runtimeCatalogDigest: '8'.repeat(64), complete: true },
      agentActivity: 'WRITE_SUCCEEDED', changedCandidates: [candidate],
    }))
    await new AgentFirstOwnershipCoordinator(domain, { observation }).runOnce()

    expect(domain.experienceIntents.get(intent.intentId)).toMatchObject({
      status: 'RESOLVED_BY_AGENT',
      ownership: {
        state: 'RESOLVED_BY_AGENT', reasonCode: 'AGENT_SAVED_MATCHING_SKILL',
        resolvedCandidateId: candidate.candidateId, resolvedCandidateBodyDigest: candidate.bodyDigest,
      },
    })
  })

  it.each([
    ['END_MANIFEST_INCOMPLETE', observed({ endManifest: { rootManifestDigest: '9'.repeat(64), runtimeCatalogDigest: '8'.repeat(64), complete: false } })],
    ['CATALOG_INCOMPLETE', observed({ catalogComplete: false })],
    ['TOOL_EVIDENCE_INCOMPLETE', observed({ toolEvidenceComplete: false })],
    ['AGENT_BODY_GENERATED', observed({ agentActivity: 'BODY_GENERATED' })],
    ['MANIFEST_CHANGE_UNATTRIBUTED', observed({
      endManifest: { rootManifestDigest: '9'.repeat(64), runtimeCatalogDigest: '8'.repeat(64), complete: true },
    })],
  ])('stops at confirmation for %s instead of granting ownership', async (reasonCode, evidence) => {
    const { domain, intent } = await seedReadyIntent()
    await new AgentFirstOwnershipCoordinator(domain, { observation: port(evidence) }).runOnce()
    expect(domain.experienceIntents.get(intent.intentId)).toMatchObject({
      status: 'NEEDS_CONFIRMATION', ownership: { state: 'NEEDS_CONFIRMATION', reasonCode },
    })
  })

  it('does not observe at all when the frozen baseline or Intent is incomplete', async () => {
    const { domain, batch, intent } = await seedReadyIntent()
    await domain.table('session_batches').put(batch.batchId, SessionBatchV2Schema.parse({
      ...batch, revision: batch.revision + 1,
      batchManifestBaseline: { ...batch.batchManifestBaseline, complete: false },
    }))
    const observation = port(observed())
    await new AgentFirstOwnershipCoordinator(domain, { observation }).runOnce()
    expect(observation.calls).toBe(0)
    expect(domain.experienceIntents.get(intent.intentId)).toMatchObject({
      status: 'NEEDS_CONFIRMATION', ownership: { reasonCode: 'BASELINE_INCOMPLETE' },
    })
  })

  it('fails closed when exact candidate readback or binding is incomplete', async () => {
    const { domain, intent } = await seedReadyIntent()
    const observation = port(observed({
      endManifest: { rootManifestDigest: '9'.repeat(64), runtimeCatalogDigest: '8'.repeat(64), complete: true },
      agentActivity: 'WRITE_SUCCEEDED',
      changedCandidates: [{
        candidateId: 'project:unknown-body', provider: 'filesystem', source: 'project-dsh',
        scope: 'PROJECT', writable: true, exactReadbackComplete: false,
        writeAttribution: 'AGENT_WRITE_SUCCEEDED', intentBinding: 'UNKNOWN',
      }],
    }))
    await new AgentFirstOwnershipCoordinator(domain, { observation }).runOnce()
    expect(domain.experienceIntents.get(intent.intentId)).toMatchObject({
      status: 'NEEDS_CONFIRMATION', ownership: { reasonCode: 'CANDIDATE_READBACK_INCOMPLETE' },
    })
  })

  it('recovers a sealed arbitration without observing external state again', async () => {
    const { domain, intent } = await seedReadyIntent()
    const evidence = observed()
    const claimId = deriveOwnershipClaimIdV2({ intentId: intent.intentId, intentRevision: intent.revision })
    await domain.table('experience_intents').put(intent.intentId, ExperienceIntentV2Schema.parse({
      ...intent,
      revision: intent.revision + 1,
      status: 'OWNERSHIP_ARBITRATING',
      ownership: {
        state: 'ARBITRATING', claimId, claimedIntentRevision: intent.revision, claimedAt: NOW,
        evidence, evidenceDigest: deriveOwnershipEvidenceDigestV2(evidence),
      },
      updatedAt: NOW,
    }))
    const observation = port(observed({ agentActivity: 'AMBIGUOUS' }))
    const worker = new AgentFirstOwnershipCoordinator(domain, { observation })
    await worker.recover()
    expect(observation.calls).toBe(0)
    expect(domain.experienceIntents.get(intent.intentId)).toMatchObject({ status: 'RUN2SKILL_OWNED' })
  })

  it('turns a crash-left unsealed claim into confirmation without re-observing', async () => {
    const { domain, intent } = await seedReadyIntent()
    await domain.table('experience_intents').put(intent.intentId, ExperienceIntentV2Schema.parse({
      ...intent,
      revision: intent.revision + 1,
      status: 'OWNERSHIP_ARBITRATING',
      ownership: {
        state: 'ARBITRATING',
        claimId: deriveOwnershipClaimIdV2({ intentId: intent.intentId, intentRevision: intent.revision }),
        claimedIntentRevision: intent.revision,
        claimedAt: NOW,
      },
      updatedAt: NOW,
    }))
    const observation = port(observed())
    await new AgentFirstOwnershipCoordinator(domain, { observation }).recover()
    expect(observation.calls).toBe(0)
    expect(domain.experienceIntents.get(intent.intentId)).toMatchObject({
      status: 'NEEDS_CONFIRMATION', ownership: { reasonCode: 'OBSERVATION_OUTCOME_UNKNOWN' },
    })
  })

  it('claims once when multiple workers race and therefore observes only once', async () => {
    const { domain, intent } = await seedReadyIntent()
    const observation = port(observed())
    const first = new AgentFirstOwnershipCoordinator(domain, { observation })
    const second = new AgentFirstOwnershipCoordinator(domain, { observation })
    await Promise.all([first.runOnce(), second.runOnce()])
    expect(observation.calls).toBe(1)
    expect(domain.experienceIntents.get(intent.intentId)?.status).toBe('RUN2SKILL_OWNED')
  })
})
