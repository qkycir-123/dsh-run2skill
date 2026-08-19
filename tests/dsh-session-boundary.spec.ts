import { globSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('DSH session adapter boundary', () => {
  it('has no model, Skill, Settings, Store, or filesystem dependency', () => {
    const source = globSync('src/adapters/dsh-session/**/*.ts')
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')

    expect(source).not.toMatch(/from ['"]node:fs/)
    expect(source).not.toMatch(/\b(?:llm|skills|settings|storageDomain)\b/i)
  })
})
