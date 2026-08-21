import { describe, expect, it } from 'vitest'
import {
  ExperienceIntentV2Schema,
  GlobalV2Schema,
  LegacyItemV2Schema,
  ProposalLineageV2Schema,
  SessionBatchV2Schema,
  TurnObservationV2Schema,
  deriveBehaviorSignatureIndexKeyV2,
} from '../src/domain/v2/index.js'
import {
  RUN2SKILL_V2_SCHEMA_CONTRACT,
  createInitialGlobalV2,
  run2skillV2DomainSpec,
} from '../src/adapters/dsh-storage/v2-domain.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

describe('run2skill_v2 storage contract', () => {
  it('uses a new version-1 domain without changing the published v1 identity', () => {
    expect(RUN2SKILL_V2_SCHEMA_CONTRACT).toEqual({
      domainName: 'run2skill_v2',
      domainVersion: 1,
      globalSchemaVersion: 1,
      recordSchemaVersion: 1,
      sourceDomainName: 'run2skill_v1',
      sourceDomainVersion: 2,
    })
    expect(run2skillV2DomainSpec.name).toBe('run2skill_v2')
    expect(run2skillV2DomainSpec.version).toBe(1)
    expect(Object.keys(run2skillV2DomainSpec.tables)).toEqual([
      'turn_observations',
      'session_batches',
      'experience_intents',
      'proposal_lineages',
      'legacy_items',
    ])
    expect(createInitialGlobalV2()).toMatchObject({
      schemaVersion: 1,
      migration: { schemaVersion: 1, phase: 'NOT_STARTED' },
      sessions: {},
      behaviorSignatureIndex: {},
      proposalCatalogEpoch: 0,
    })
  })

  it('accepts a minimal valid fixture for Global and every v2 table', () => {
    const fixture = createMinimalV2Fixtures()
    expect(GlobalV2Schema.parse(fixture.global)).toEqual(fixture.global)
    expect(TurnObservationV2Schema.parse(fixture.turnObservation)).toEqual(fixture.turnObservation)
    expect(SessionBatchV2Schema.parse(fixture.sessionBatch)).toEqual(fixture.sessionBatch)
    expect(ExperienceIntentV2Schema.parse(fixture.experienceIntent)).toEqual(fixture.experienceIntent)
    expect(ProposalLineageV2Schema.parse(fixture.proposalLineage)).toEqual(fixture.proposalLineage)
    expect(LegacyItemV2Schema.parse(fixture.legacyItem)).toEqual(fixture.legacyItem)
  })

  it('rejects only changing schemaVersion on otherwise valid fixtures', () => {
    const fixture = createMinimalV2Fixtures()
    const cases = [
      [GlobalV2Schema, fixture.global],
      [TurnObservationV2Schema, fixture.turnObservation],
      [SessionBatchV2Schema, fixture.sessionBatch],
      [ExperienceIntentV2Schema, fixture.experienceIntent],
      [ProposalLineageV2Schema, fixture.proposalLineage],
      [LegacyItemV2Schema, fixture.legacyItem],
    ] as const
    for (const [schema, valid] of cases) {
      expect(schema.safeParse({ ...valid, schemaVersion: 999 }).success).toBe(false)
    }
  })

  it('rejects a forged legacy disposition and a behavior index under the wrong key', () => {
    const fixture = createMinimalV2Fixtures()
    expect(LegacyItemV2Schema.safeParse({
      ...fixture.legacyItem,
      disposition: 'AUDIT_ONLY_PUBLISHED',
    }).success).toBe(false)

    const behaviorSignature = 'e'.repeat(64)
    const expectedIndexId = deriveBehaviorSignatureIndexKeyV2('PROJECT', behaviorSignature)
    const entry = {
      schemaVersion: 1 as const,
      persistenceScope: 'PROJECT' as const,
      behaviorSignature,
      ownerIntentId: fixture.experienceIntent.intentId,
      ownerRevision: 1,
      state: 'RESERVED' as const,
      updatedAt: '2026-08-22T00:00:00.000Z',
    }
    expect(GlobalV2Schema.safeParse({
      ...fixture.global,
      behaviorSignatureIndex: { [expectedIndexId]: entry },
    }).success).toBe(true)
    expect(GlobalV2Schema.safeParse({
      ...fixture.global,
      behaviorSignatureIndex: { ['f'.repeat(64)]: entry },
    }).success).toBe(false)
  })
})
