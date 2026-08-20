import { describe, expect, it } from 'vitest'
import { run2skillDomainSpec } from '../src/adapters/dsh-storage/domain.js'

describe('run2skill_v1 domain contract', () => {
  it('keeps review state inside the approved v1 WorkItem storage surface', () => {
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
})
