import { describe, expect, it } from 'vitest'
import { preprocessSensitiveText } from '../src/domain/observe/redaction.js'

describe('Sensitive Data Filter', () => {
  it('normalizes Unicode before redacting authorization values', () => {
    const secret = ['not', 'a', 'real', 'bearer', 'value'].join('-')
    const input = `Ａｕｔｈｏｒｉｚａｔｉｏｎ： Ｂｅａｒｅｒ ${secret}`
    const result = preprocessSensitiveText(input)

    expect(result.text).toBe('authorization: [REDACTED]')
    expect(result.redactionKinds).toContain('AUTHORIZATION')
    expect(result.text).not.toContain(secret)
  })

  it('redacts private keys, secret assignments, API keys, and URL userinfo', () => {
    const privateBody = ['synthetic', 'private', 'material'].join('-')
    const password = ['synthetic', 'password'].join('-')
    const apiKey = ['sk', 'test', 'abcdefghijklmnopqrstuvwx'].join('-')
    const urlPassword = ['url', 'password'].join('-')
    const input = [
      `-----BEGIN PRIVATE KEY-----\n${privateBody}\n-----END PRIVATE KEY-----`,
      `password=${password}`,
      `api_key: ${apiKey}`,
      `https://user:${urlPassword}@example.invalid/path`,
    ].join('\n')
    const result = preprocessSensitiveText(input)

    expect(result.text).not.toContain(privateBody)
    expect(result.text).not.toContain(password)
    expect(result.text).not.toContain(apiKey)
    expect(result.text).not.toContain(urlPassword)
    expect(result.redactionKinds).toEqual(expect.arrayContaining([
      'PRIVATE_KEY',
      'SECRET_ASSIGNMENT',
      'API_KEY',
      'URL_CREDENTIAL',
    ]))
  })

  it('removes fenced code and quote lines before rule scanning', () => {
    const result = preprocessSensitiveText('> remember this workflow\n```text\nsave as skill\n```\nordinary request')

    expect(result.text).toBe('ordinary request')
  })

  it('normalizes encoded URL userinfo before redacting it', () => {
    const secret = ['url', 'encoded', 'password'].join('-')
    const encoded = encodeURIComponent(secret)
    const result = preprocessSensitiveText(`https://user:${encoded}@example.invalid/path`)

    expect(result.text).toBe('https://[REDACTED]@example.invalid/path')
    expect(result.redactionKinds).toContain('URL_CREDENTIAL')
    expect(result.text).not.toContain(secret)
    expect(result.text).not.toContain(encoded.toLowerCase())
  })

  it('redacts encoded URL delimiters before they can escape the authority', () => {
    const encodedSecret = 'synthetic%0Aurl%2Fpassword'
    const result = preprocessSensitiveText(`https://user:${encodedSecret}@example.invalid/path`)

    expect(result.text).toBe('https://[REDACTED]@example.invalid/path')
    expect(result.redactionKinds).toContain('URL_CREDENTIAL')
    expect(result.text).not.toContain('synthetic')
  })

  it('redacts complete Authorization values for any scheme', () => {
    const digest = preprocessSensitiveText(
      'Authorization: Digest username="demo", response="synthetic-response"\nordinary request',
    )
    const aws = preprocessSensitiveText(
      'Authorization: AWS4-HMAC-SHA256 Credential=SYNTHETIC/20260819, Signature=not-real\nordinary request',
    )

    expect(digest.text).toBe('authorization: [REDACTED] ordinary request')
    expect(digest.text).not.toContain('synthetic-response')
    expect(aws.text).toBe('authorization: [REDACTED] ordinary request')
    expect(aws.text).not.toContain('signature')
  })

  it('removes Unicode format controls before matching assignments', () => {
    const secret = 'synthetic-zero-width-secret'
    const result = preprocessSensitiveText(`tok\u200Ben=${secret}`)

    expect(result.text).toBe('token=[REDACTED]')
    expect(result.redactionKinds).toContain('SECRET_ASSIGNMENT')
    expect(result.text).not.toContain(secret)
  })

  it.each([
    'ghp_abcdefghijklmnopqrstuvwxyz123456',
    'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
    'sk-abcdefghijklmnopqrstuvwxyz123456789012345678901234',
    'AKIAABCDEFGHIJKLMNOP',
  ])('redacts a common provider credential form: %s', (credential) => {
    const result = preprocessSensitiveText(credential)

    expect(result.text).toBe('[REDACTED]')
    expect(result.redactionKinds).toContain('API_KEY')
  })

  it.each([
    'sk-short-value',
    'tasksk-abcdefghijklmnopqrstuvwxyz123456789012345678901234',
  ])('does not redact an API-key near miss: %s', (value) => {
    expect(preprocessSensitiveText(value).text).toBe(value)
  })

  it('keeps nested shorter fences inside a longer outer fence', () => {
    const result = preprocessSensitiveText([
      '````text',
      '```',
      'save this workflow as a skill',
      '```',
      '````',
      'ordinary request',
    ].join('\n'))

    expect(result.text).toBe('ordinary request')
  })
})
