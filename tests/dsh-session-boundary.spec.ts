import { globSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('DSH session adapter boundary', () => {
  it('has no model, Skill, Settings, Store, or filesystem dependency', () => {
    const source = globSync('src/adapters/dsh-session/**/*.ts')
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')
    const dependencySource = source.replaceAll(
      "'session/title-llm-request'",
      "'session/title-request-event'",
    )

    expect(source).not.toMatch(/from ['"]node:fs/)
    expect(dependencySource).not.toMatch(/\b(?:llm|skills|settings|storageDomain)\b/i)
  })
})
