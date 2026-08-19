import { describe, expect, it, vi } from 'vitest'
import {
  deriveCandidateKey,
  recallExistingSkills,
  tokenizeForSkillRecall,
  type SkillCatalogPort,
  type SkillSummaryProjection,
} from '../src/domain/learn/index.js'

function summary(overrides: Partial<SkillSummaryProjection> & Pick<SkillSummaryProjection, 'name'>): SkillSummaryProjection {
  return {
    name: overrides.name,
    description: overrides.description ?? 'unrelated',
    whenToUse: overrides.whenToUse,
    source: overrides.source ?? 'project-dsh',
    provider: overrides.provider ?? 'filesystem',
  }
}

describe('Skill recall', () => {
  it('normalizes Latin and overlapping Chinese tokens with a 64-token bound', () => {
    expect(tokenizeForSkillRecall('Code Reviews 代码审查')).toEqual(['code', 'reviews', '代码', '码审', '审查'])
    expect(tokenizeForSkillRecall('révision naïve café')).toEqual(['révision', 'naïve', 'café'])
    expect(tokenizeForSkillRecall('请使用这个代码审查')).toEqual(['代码', '码审', '审查'])
    expect(tokenizeForSkillRecall(Array.from({ length: 80 }, (_, index) => `word${index}`).join(' '))).toHaveLength(64)
  })

  it('does not let Chinese stop words create a shortlist hit', async () => {
    const rows = [
      summary({ name: 'generic', description: '请使用这个' }),
      summary({ name: 'code-review', description: '代码审查' }),
    ]
    const result = await recallExistingSkills({
      snapshot: async () => ({ skills: rows, complete: true }),
      get: async name => ({ ...rows.find(row => row.name === name)!, content: '# Skill\n\nBody.' }),
    }, { cwd: 'D:\\repo', scope: {} }, '请使用这个代码审查')
    expect(result.status).toBe('AVAILABLE')
    if (result.status !== 'AVAILABLE') return
    expect(result.observation.candidates.map(candidate => candidate.name)).toEqual(['code-review'])
  })

  it('uses the frozen tuple, supports whenToUse-only hits, and loads at most five winners in the same view', async () => {
    const rows = [
      summary({ name: 'zeta', description: 'code review' }),
      summary({ name: 'alpha', description: 'code', whenToUse: 'review changes' }),
      summary({ name: 'review', description: 'unrelated' }),
      summary({ name: 'only-when', whenToUse: 'code review' }),
      summary({ name: 'fifth', description: 'code review' }),
      summary({ name: 'sixth', description: 'code review' }),
      summary({ name: 'no-match', description: 'deploy release' }),
    ]
    const view = { cwd: 'D:\\repo', scope: {}, signal: new AbortController().signal }
    const snapshot = vi.fn(async (_received: typeof view) => ({ skills: rows, complete: true as const }))
    const get = vi.fn(async (name: string, _received: typeof view) => ({
      ...rows.find(row => row.name === name)!,
      content: `# ${name}\n\nFull body.`,
    }))
    const result = await recallExistingSkills({ snapshot, get }, view, 'Please do a code review')

    expect(result.status).toBe('AVAILABLE')
    if (result.status !== 'AVAILABLE') return
    const tied = ['zeta', 'fifth', 'sixth'].sort((left, right) => (
      deriveCandidateKey(rows.find(row => row.name === left)!)
        .localeCompare(deriveCandidateKey(rows.find(row => row.name === right)!))
    )).slice(0, 2)
    expect(result.observation.candidates.map(candidate => candidate.name)).toEqual([
      'review', 'only-when', 'alpha', ...tied,
    ])
    expect(get).toHaveBeenCalledTimes(5)
    expect(snapshot.mock.calls[0]![0]).toBe(view)
    for (const call of get.mock.calls) expect(call[1]).toBe(view)
  })

  it('derives collision-safe keys and maps source scope/writability', async () => {
    expect(deriveCandidateKey({ name: 'ab', provider: 'c', source: 'project-dsh' }))
      .not.toBe(deriveCandidateKey({ name: 'a', provider: 'bc', source: 'project-dsh' }))

    const rows = [
      summary({ name: 'project', description: 'review', source: 'project-dsh' }),
      summary({ name: 'user', description: 'review', source: 'user-agents' }),
      summary({ name: 'runtime', description: 'review', source: 'runtime' }),
      summary({ name: 'spoofed', description: 'review', source: 'project-dsh', provider: 'custom-provider' }),
    ]
    const port: SkillCatalogPort<object> = {
      snapshot: async () => ({ skills: rows, complete: true }),
      get: async name => ({ ...rows.find(row => row.name === name)!, content: '# Skill\n\nBody.' }),
    }
    const result = await recallExistingSkills(port, { cwd: 'D:\\repo', scope: {} }, 'review')
    expect(result.status).toBe('AVAILABLE')
    if (result.status !== 'AVAILABLE') return
    expect(Object.fromEntries(result.observation.candidates.map(({ name, persistenceScope, writable }) => (
      [name, { persistenceScope, writable }]
    )))).toEqual({
      project: { persistenceScope: 'PROJECT', writable: true },
      runtime: { persistenceScope: 'UNKNOWN', writable: false },
      spoofed: { persistenceScope: 'UNKNOWN', writable: false },
      user: { persistenceScope: 'USER', writable: false },
    })
  })

  it('fails closed for incomplete catalogs, disappearing or changed winners, and oversized bodies', async () => {
    const row = summary({ name: 'review', description: 'review' })
    const view = { cwd: 'D:\\repo', scope: {} }
    expect(await recallExistingSkills({
      snapshot: async () => ({ skills: [row], complete: false }),
      get: async () => ({ ...row, content: '# Body' }),
    }, view, 'review')).toEqual({ status: 'UNAVAILABLE', failureCode: 'CATALOG_INCOMPLETE' })

    for (const loaded of [
      undefined,
      { ...row, provider: 'changed', content: '# Body' },
      { ...row, content: `# Body\n${'x'.repeat(8192)}` },
      { ...row, content: 'token=x\n'.repeat(1000) },
    ]) {
      expect(await recallExistingSkills({
        snapshot: async () => ({ skills: [row], complete: true }),
        get: async () => loaded,
      }, view, 'review')).toEqual({ status: 'UNAVAILABLE', failureCode: 'CANDIDATE_UNAVAILABLE' })
    }

    expect(await recallExistingSkills({
      snapshot: async () => { throw new Error('snapshot failed') },
      get: async () => ({ ...row, content: '# Body' }),
    }, view, 'review')).toEqual({ status: 'UNAVAILABLE', failureCode: 'CATALOG_INCOMPLETE' })
    expect(await recallExistingSkills({
      snapshot: async () => ({ skills: [row], complete: true }),
      get: async () => { throw new Error('load failed') },
    }, view, 'review')).toEqual({ status: 'UNAVAILABLE', failureCode: 'CANDIDATE_UNAVAILABLE' })
  })
})
