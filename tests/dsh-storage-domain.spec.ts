import { describe, expect, it } from 'vitest'
import {
  RUN2SKILL_ALPHA_SCHEMA_CONTRACT,
  createInitialGlobalV1,
  run2skillDomainSpec,
} from '../src/adapters/dsh-storage/domain.js'
import { makeWorkItem } from './support/work-item-fixture.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'

describe('run2skill_v1 domain contract', () => {
  it('freezes the public alpha storage identity and record versions', () => {
    expect(RUN2SKILL_ALPHA_SCHEMA_CONTRACT).toEqual({
      release: '0.1.1-alpha',
      dshBaselineCommit: '141eb6fef83422698aef7a981029e843e8161534',
      domainName: 'run2skill_v1',
      domainVersion: 2,
      globalSchemaVersion: 1,
      workItemSchemaVersion: 1,
      lineageSchemaVersion: 1,
    })
    expect(run2skillDomainSpec.name).toBe('run2skill_v1')
    expect(run2skillDomainSpec.version).toBe(2)
    expect(Object.keys(run2skillDomainSpec.tables)).toEqual(['work_items', 'lineages'])
    expect(run2skillDomainSpec.global.initial).toMatchObject({
      schemaVersion: 1,
      activeTriggerPolicyVersion: 'cheap-trigger-v1',
      sessions: {},
      checkpoint: { dirty: false, pendingSessionCount: 0 },
    })
  })

  it('fails closed on incompatible Global, WorkItem, and Lineage record versions', () => {
    const validGlobal = createInitialGlobalV1()
    const validWorkItem = makeWorkItem()
    const validLineage = createMinimalV2Fixtures().proposalLineage.legacySnapshot
    expect(run2skillDomainSpec.global.schema.safeParse(validGlobal).success).toBe(true)
    expect(run2skillDomainSpec.tables.work_items.valueSchema.safeParse(validWorkItem).success).toBe(true)
    expect(run2skillDomainSpec.tables.lineages.valueSchema.safeParse(validLineage).success).toBe(true)
    expect(run2skillDomainSpec.global.schema.safeParse({ ...validGlobal, schemaVersion: 999 }).success).toBe(false)
    expect(run2skillDomainSpec.tables.work_items.valueSchema.safeParse({ ...validWorkItem, schemaVersion: 999 }).success).toBe(false)
    expect(run2skillDomainSpec.tables.lineages.valueSchema.safeParse({ ...validLineage, schemaVersion: 999 }).success).toBe(false)
  })
})
