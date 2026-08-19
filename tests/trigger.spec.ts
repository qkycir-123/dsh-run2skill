import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyzeCheapTriggerV1 } from '../src/domain/observe/trigger.js'

interface TriggerFixture {
  fixtureVersion: number
  policyVersion: string
  cases: Array<{
    id: string
    sourceKind: 'user' | 'synthetic' | 'tool' | 'plugin'
    text: string
    expectedKinds: string[]
  }>
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/cheap-trigger-v1.json', import.meta.url), 'utf8'),
) as TriggerFixture

describe('cheap-trigger-v1', () => {
  it('keeps the fixture and policy version pinned', () => {
    expect(fixture.fixtureVersion).toBe(1)
    expect(fixture.policyVersion).toBe('cheap-trigger-v1')
  })

  it.each(fixture.cases)('$id', ({ sourceKind, text, expectedKinds }) => {
    const result = analyzeCheapTriggerV1([{ messageSeq: 2, sourceKind, text }])

    expect(result.status).toBe('COMPLETE')
    expect(result.triggerHits.map((hit) => hit.kind)).toEqual(expectedKinds)
  })

  it('returns one bounded evidence window per message and never raw secret text', () => {
    const secret = ['not', 'a', 'real', 'token'].join('-')
    const result = analyzeCheapTriggerV1([{
      messageSeq: 7,
      sourceKind: 'user',
      text: `以后必须读取 token=${secret}，再执行这个流程。`,
    }])

    expect(result.status).toBe('COMPLETE')
    expect(result.evidenceRefs).toHaveLength(1)
    expect(Buffer.byteLength(result.evidenceRefs[0]!.excerpt, 'utf8')).toBeLessThanOrEqual(512)
    expect(result.evidenceRefs[0]!.excerpt).not.toContain(secret)
    expect(result.evidenceRefs[0]!.redactionKinds).toContain('SECRET_ASSIGNMENT')
  })

  it('keeps every word of an unquoted secret assignment out of durable evidence', () => {
    const secretWords = ['invalid-alpha', 'invalid-bravo', 'invalid-charlie']
    const result = analyzeCheapTriggerV1([{
      messageSeq: 7,
      sourceKind: 'user',
      text: `Remember this workflow.\npassword: ${secretWords.join(' ')}`,
    }])

    expect(result.status).toBe('COMPLETE')
    expect(result.evidenceRefs).toHaveLength(1)
    for (const word of secretWords) expect(result.evidenceRefs[0]!.excerpt).not.toContain(word)
  })

  it('keeps a secret after an ordinary assignment out of durable evidence', () => {
    const secretWords = ['invalid-alpha', 'invalid-bravo', 'invalid-charlie']
    const result = analyzeCheapTriggerV1([{
      messageSeq: 7,
      sourceKind: 'user',
      text: `Remember this workflow. mode=dev password: ${secretWords.join(' ')}`,
    }])

    expect(result.status).toBe('COMPLETE')
    expect(result.evidenceRefs).toHaveLength(1)
    for (const word of secretWords) expect(result.evidenceRefs[0]!.excerpt).not.toContain(word)
  })

  it.each([
    {
      kind: 'URL_CREDENTIAL',
      secret: 'synthetic%0Aurl%2Fpassword',
      text: 'Remember this workflow.\nhttps://user:synthetic%0Aurl%2Fpassword@example.invalid/path',
    },
    {
      kind: 'AUTHORIZATION',
      secret: 'synthetic-response',
      text: 'Remember this workflow.\nAuthorization: Digest username="demo", response="synthetic-response"',
    },
    {
      kind: 'SECRET_ASSIGNMENT',
      secret: 'synthetic-zero-width-secret',
      text: 'Remember this workflow.\ntok\u200Ben=synthetic-zero-width-secret',
    },
    {
      kind: 'API_KEY',
      secret: 'ghp_abcdefghijklmnopqrstuvwxyz123456',
      text: 'Remember this workflow.\nghp_abcdefghijklmnopqrstuvwxyz123456',
    },
    {
      kind: 'API_KEY',
      secret: 'sk-abcdefghijklmnopqrstuvwxyz123456789012345678901234',
      text: 'Remember this workflow.\nsk-abcdefghijklmnopqrstuvwxyz123456789012345678901234',
    },
  ])('keeps $kind secrets out of durable evidence', ({ kind, secret, text }) => {
    const result = analyzeCheapTriggerV1([{ messageSeq: 1, sourceKind: 'user', text }])

    expect(result.status).toBe('COMPLETE')
    expect(result.evidenceRefs).toHaveLength(1)
    expect(result.evidenceRefs[0]!.excerpt).not.toContain(secret)
    expect(result.evidenceRefs[0]!.redactionKinds).toContain(kind)
  })

  it.each([
    ['SECRET_ASSIGNMENT', 'deepseek_key=synthetic-provider-value'],
    ['SECRET_ASSIGNMENT', 'client_secret=synthetic-client-value'],
    ['SECRET_ASSIGNMENT', 'refresh_token=synthetic-refresh-value'],
    ['SECRET_ASSIGNMENT', 'github_token=synthetic-github-value'],
    ['API_KEY', 'xoxb-1234567890-synthetic-slack-token'],
    ['API_KEY', 'glpat-abcdefghijklmnopqrstuvwxyz123456'],
  ])('keeps selected %s form out of durable evidence', (kind, secret) => {
    const result = analyzeCheapTriggerV1([{
      messageSeq: 1,
      sourceKind: 'user',
      text: `Remember this workflow. ${secret}`,
    }])

    expect(result.status).toBe('COMPLETE')
    expect(result.evidenceRefs).toHaveLength(1)
    expect(result.evidenceRefs[0]!.excerpt).not.toContain('synthetic')
    expect(result.evidenceRefs[0]!.redactionKinds).toContain(kind)
  })

  it.each([
    '{"client_secret":"synthetic-client-value"}',
    '{"refresh_token":"synthetic-refresh-value"}',
    '{"github_token":"synthetic-github-value"}',
    '{"password":"synthetic-password-value"}',
    '{"clientSecret":"synthetic-client-value"}',
    '{"refreshToken":"synthetic-refresh-value"}',
    '{"githubToken":"synthetic-github-value"}',
    '{"deepseekKey":"synthetic-provider-value"}',
    '{"serviceCredential":"synthetic-service-value"}',
    '{"accessToken":"synthetic-access-value"}',
    '{"databasePassword":"synthetic-database-value"}',
    '{"awsSecretAccessKey":"synthetic-aws-value"}',
  ])('keeps a quoted JSON credential out of durable evidence: %s', (secret) => {
    const result = analyzeCheapTriggerV1([{
      messageSeq: 1,
      sourceKind: 'user',
      text: `Remember this workflow. ${secret}`,
    }])

    expect(result.status).toBe('COMPLETE')
    expect(result.evidenceRefs).toHaveLength(1)
    expect(result.evidenceRefs[0]!.excerpt).not.toContain('synthetic')
    expect(result.evidenceRefs[0]!.redactionKinds).toContain('SECRET_ASSIGNMENT')
  })

  it('fails closed to metadata-only when message or turn limits are exceeded', () => {
    const oversizedMessage = 'a'.repeat(64 * 1024 + 1)
    const result = analyzeCheapTriggerV1([{ messageSeq: 1, sourceKind: 'user', text: oversizedMessage }])

    expect(result).toMatchObject({
      status: 'INCOMPLETE',
      captureBlockers: ['TEXT_LIMIT_EXCEEDED'],
      triggerHits: [],
      evidenceRefs: [],
    })
  })

  it('fails closed when individually valid messages exceed the total Turn limit', () => {
    const messages = Array.from({ length: 5 }, (_, index) => ({
      messageSeq: index + 1,
      sourceKind: 'user' as const,
      text: 'a'.repeat(64 * 1024),
    }))

    expect(analyzeCheapTriggerV1(messages)).toEqual({
      status: 'INCOMPLETE',
      captureBlockers: ['TEXT_LIMIT_EXCEEDED'],
      triggerHits: [],
      evidenceRefs: [],
    })
  })

  it('fails closed when direct-user message count exceeds the bounded scan envelope', () => {
    const messages = Array.from({ length: 1025 }, (_, index) => ({
      messageSeq: index + 1,
      sourceKind: 'user' as const,
      text: '',
    }))

    expect(analyzeCheapTriggerV1(messages)).toEqual({
      status: 'INCOMPLETE',
      captureBlockers: ['TEXT_LIMIT_EXCEEDED'],
      triggerHits: [],
      evidenceRefs: [],
    })
  })

  it('handles a maximum-size multi-clause near miss without regex backtracking', () => {
    const clause = 'For future reference, the process was documented. '
    const text = clause.repeat(Math.ceil((64 * 1024) / clause.length)).slice(0, 64 * 1024)
    const result = analyzeCheapTriggerV1([{ messageSeq: 1, sourceKind: 'user', text }])

    expect(result.status).toBe('COMPLETE')
    expect(result.triggerHits).toEqual([])
  })

  it('fails closed without text when redaction is unavailable', () => {
    const result = analyzeCheapTriggerV1(
      [{ messageSeq: 1, sourceKind: 'user', text: '把这个流程保存成 Skill' }],
      { redact: () => { throw new Error('contains-sensitive-details') } },
    )

    expect(result).toEqual({
      status: 'INCOMPLETE',
      captureBlockers: ['REDACTION_UNAVAILABLE'],
      triggerHits: [],
      evidenceRefs: [],
    })
    expect(JSON.stringify(result)).not.toContain('contains-sensitive-details')
  })

  it('caps a WorkItem at four evidence refs and 2 KiB total', () => {
    const result = analyzeCheapTriggerV1(Array.from({ length: 6 }, (_, index) => ({
      messageSeq: index + 1,
      sourceKind: 'user' as const,
      text: `以后遇到任务 ${index}，先检查输入，然后再执行这个流程。${'字'.repeat(600)}`,
    })))

    expect(result.evidenceRefs).toHaveLength(4)
    expect(result.evidenceRefs.reduce((sum, ref) => sum + Buffer.byteLength(ref.excerpt, 'utf8'), 0)).toBeLessThanOrEqual(2048)
  })

  it('keeps a late trigger inside the bounded evidence window', () => {
    const result = analyzeCheapTriggerV1([{
      messageSeq: 1,
      sourceKind: 'user',
      text: `${'普通上下文。'.repeat(2_000)}把这个流程保存成 Skill。`,
    }])

    expect(result.evidenceRefs[0]!.excerpt).toContain('保存成 skill')
    expect(result.evidenceRefs[0]!.truncated).toBe(true)
  })

  it('hashes only the filtered evidence rather than the secret value', () => {
    const first = analyzeCheapTriggerV1([{
      messageSeq: 1,
      sourceKind: 'user',
      text: `以后必须使用 token=${['secret', 'one'].join('-')} 再执行流程。`,
    }])
    const second = analyzeCheapTriggerV1([{
      messageSeq: 1,
      sourceKind: 'user',
      text: `以后必须使用 token=${['secret', 'two'].join('-')} 再执行流程。`,
    }])

    expect(first.evidenceRefs[0]!.excerptDigest).toBe(second.evidenceRefs[0]!.excerptDigest)
  })
})
