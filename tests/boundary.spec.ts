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
})
