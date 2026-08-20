import { describe, expect, it } from 'vitest'
import { DshSkillCatalogAdapter } from '../src/adapters/dsh-skills/skill-catalog.js'

describe('DSH Skill catalog adapter', () => {
  it('ignores candidate root extensions while preserving exact candidate path facts', async () => {
    const view = { cwd: 'D:\\workspace' }
    const old = new DshSkillCatalogAdapter({
      snapshot: async () => ({ skills: [], complete: true }),
      get: async () => undefined,
    })
    await expect(old.snapshot(view)).resolves.toEqual({ skills: [], complete: true })

    const current = new DshSkillCatalogAdapter({
      snapshot: async () => ({
        complete: true,
        roots: [{ provider: 'filesystem', source: 'project-dsh', path: 'D:\\workspace\\.dsh\\skills' }],
        skills: [{
          name: 'review-hygiene',
          description: 'Review carefully.',
          invocation: { modelInvocable: true, userInvocable: false },
          provider: 'filesystem',
          source: 'project-dsh',
        }],
      }),
      get: async () => ({
        name: 'review-hygiene',
        description: 'Review carefully.',
        provider: 'filesystem',
        source: 'project-dsh',
        path: 'D:\\workspace\\.dsh\\skills\\review-hygiene\\SKILL.md',
        content: '# Review\n\nCheck the diff.',
      }),
    })
    await expect(current.snapshot(view)).resolves.toEqual({
      complete: true,
      skills: [{
        name: 'review-hygiene',
        description: 'Review carefully.',
        invocation: { modelInvocable: true, userInvocable: false },
        provider: 'filesystem',
        source: 'project-dsh',
      }],
    })
    await expect(current.get('review-hygiene', view)).resolves.toMatchObject({
      path: 'D:\\workspace\\.dsh\\skills\\review-hygiene\\SKILL.md',
    })
  })

  it('rejects malformed snapshots and fails malformed exact gets closed', async () => {
    const malformed = new DshSkillCatalogAdapter({
      snapshot: async () => ({ skills: [], complete: 'yes' }),
      get: async () => ({ name: 'missing-required-fields', content: '# Body' }),
    })
    await expect(malformed.snapshot({})).rejects.toThrow()
    await expect(malformed.get('missing-required-fields', {})).resolves.toBeUndefined()
  })
})
