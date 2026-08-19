import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { globSync } from 'node:fs'

describe('domain boundary', () => {
  it('does not import DSH, Cordis, React, or Node filesystem APIs', () => {
    const files = globSync('src/domain/observe/**/*.ts')
    const source = files.map((file) => readFileSync(file, 'utf8')).join('\n')

    expect(source).not.toMatch(/from ['"](?:@deepseek-ai\/|cordis|react|node:fs)/)
    expect(source).not.toMatch(/\b(?:llm|skills|settings)\b/)
  })

  it('keeps Slice A capture free of model, Skill, UI, and direct filesystem dependencies', () => {
    const files = [
      ...globSync('src/application/capture/**/*.ts'),
      ...globSync('src/adapters/dsh-storage/**/*.ts'),
    ]
    const source = files.map((file) => readFileSync(file, 'utf8')).join('\n')

    expect(source).not.toMatch(/from ['"](?:@deepseek-ai\/dsh-llm|@deepseek-ai\/dsh-skill|react|node:fs)/)
    expect(source).not.toMatch(/\b(?:modelInvocable|llm\.generate|skills\.get)\b/)
  })
})
