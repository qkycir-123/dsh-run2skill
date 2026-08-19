import { describe, expect, it } from 'vitest'
import {
  canCandidateCoverScope,
  guardLearningResult,
  resolveLearningScope,
  type SkillRecallObservation,
} from '../src/domain/learn/index.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import { makeLearningResult } from './support/learning-fixture.js'
import { makeWorkItem } from './support/work-item-fixture.js'

function observation(overrides: Partial<SkillRecallObservation> = {}): SkillRecallObservation {
  return {
    catalogObservationDigest: 'c'.repeat(64),
    candidates: [],
    ...overrides,
  }
}

describe('Learning scope and Core Guards', () => {
  it('defaults bound work to PROJECT and requires explicit cross-project evidence for USER', () => {
    const bound = makeWorkItem({
      workspaceBinding: {
        status: 'BOUND',
        workspaceId: 'workspace-1',
        canonicalPath: 'D:\\repo',
        observedAt: '2026-08-19T00:00:00.000Z',
      },
    })
    expect(resolveLearningScope(bound, 'D:\\session')).toEqual({
      status: 'AVAILABLE', persistenceScope: 'PROJECT', cwd: 'D:\\repo',
    })

    const excerpt = 'Apply this rule across all projects.'
    const user = makeWorkItem({
      evidenceRefs: [{
        ...makeWorkItem().evidenceRefs[0]!, excerpt, excerptDigest: sha256Utf8(excerpt),
      }],
    })
    expect(resolveLearningScope(user, 'D:\\session')).toEqual({
      status: 'AVAILABLE', persistenceScope: 'USER', cwd: 'D:\\session',
    })
    expect(resolveLearningScope(makeWorkItem(), 'D:\\session')).toEqual({
      status: 'UNAVAILABLE', failureCode: 'LEARNING_GUARD_REJECTED',
    })
  })

  it('enforces directional coverage independently from writability', () => {
    expect(canCandidateCoverScope('PROJECT', 'PROJECT')).toBe(true)
    expect(canCandidateCoverScope('PROJECT', 'USER')).toBe(true)
    expect(canCandidateCoverScope('USER', 'PROJECT')).toBe(false)
    expect(canCandidateCoverScope('USER', 'UNKNOWN')).toBe(false)
  })

  it('accepts an in-scope CREATE and rejects unobserved candidates, unsafe MERGE, and secrets', () => {
    const item = makeWorkItem({
      workspaceBinding: {
        status: 'BOUND', workspaceId: 'workspace-1', canonicalPath: 'D:\\repo',
        observedAt: '2026-08-19T00:00:00.000Z',
      },
    })
    const result = makeLearningResult(item)
    expect(guardLearningResult({
      item,
      expectedScope: 'PROJECT',
      observation: observation(),
      ...result,
    })).toEqual({ status: 'ACCEPTED' })
    expect(guardLearningResult({
      item,
      expectedScope: 'USER',
      observation: observation(),
      experiences: result.experiences.map(experience => ({ ...experience, persistenceScope: 'USER' })),
      proposal: { ...result.proposal, persistenceScope: 'USER' },
    })).toEqual({ status: 'REJECTED', reason: 'SCOPE_MISMATCH' })

    const candidate = {
      candidateKey: `cand_${'a'.repeat(64)}` as const,
      candidateDigest: 'd'.repeat(64),
      source: 'project-agents',
      persistenceScope: 'PROJECT' as const,
      writable: false,
      name: 'existing', description: 'Existing.', whenToUse: 'Use now.',
      content: '# Existing\n\nBody.', bodyDigest: sha256Utf8('# Existing\n\nBody.'),
    }
    const merge = {
      ...result.proposal,
      shortlistDigests: [candidate.candidateDigest],
      curation: { decision: 'MERGE' as const, candidateKey: candidate.candidateKey, rationale: 'Improve it.' },
    }
    expect(guardLearningResult({
      item, expectedScope: 'PROJECT', observation: observation({ candidates: [candidate] }),
      experiences: result.experiences, proposal: merge,
    })).toEqual({ status: 'REJECTED', reason: 'CANDIDATE_NOT_WRITABLE' })

    expect(guardLearningResult({
      item, expectedScope: 'PROJECT', observation: observation(),
      experiences: result.experiences,
      proposal: { ...result.proposal, content: '# Skill\n\napi_key=synthetic-secret-value' },
    })).toEqual({ status: 'REJECTED', reason: 'UNSAFE_CONTENT' })
  })
})
