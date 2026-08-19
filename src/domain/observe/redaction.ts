import { REDACTION_KIND_ORDER } from './constants.js'
import type { RedactionKind } from './schemas.js'

export interface PreprocessedSensitiveText {
  text: string
  redactionKinds: RedactionKind[]
  redactionCounts: Partial<Record<RedactionKind, number>>
}

function removeInvisibleControls(value: string): string {
  let result = ''
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    const invisible = /\p{Cf}/u.test(character)
      || codePoint <= 8
      || codePoint === 11
      || codePoint === 12
      || (codePoint >= 14 && codePoint <= 31)
      || (codePoint >= 127 && codePoint <= 159)
    if (!invisible) result += character
  }
  return result
}

function removeFencedCodeAndQuotes(value: string): string {
  const kept: string[] = []
  let fence: { character: '`' | '~'; length: number } | undefined

  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trimStart()
    if (fence !== undefined) {
      let markerLength = 0
      while (trimmed[markerLength] === fence.character) markerLength += 1
      if (
        markerLength >= fence.length
        && trimmed.slice(markerLength).trim().length === 0
      ) {
        fence = undefined
      }
      continue
    }
    const opening = /^(?<marker>`{3,}|~{3,})/u.exec(trimmed)?.groups?.marker
    if (opening !== undefined) {
      fence = { character: opening[0] as '`' | '~', length: opening.length }
      continue
    }
    if (/^\s*>/u.test(line)) continue
    kept.push(line)
  }
  return kept.join('\n')
}

export function preprocessSensitiveText(input: string): PreprocessedSensitiveText {
  const counts: Partial<Record<RedactionKind, number>> = {}
  let text = removeInvisibleControls(input).normalize('NFKC')
  text = removeFencedCodeAndQuotes(text)

  const replace = (
    pattern: RegExp,
    kind: RedactionKind,
    replacement: string | ((substring: string, ...args: string[]) => string),
  ): void => {
    text = text.replace(pattern, (...args: [string, ...string[]]) => {
      counts[kind] = (counts[kind] ?? 0) + 1
      return typeof replacement === 'string' ? replacement : replacement(...args)
    })
  }

  replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/giu,
    'PRIVATE_KEY',
    '[REDACTED]',
  )
  replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^\s<>/?#]*)@/giu,
    'URL_CREDENTIAL',
    (_match, scheme: string) => `${scheme}[REDACTED]@`,
  )
  replace(
    /\bauthorization[^\S\r\n]*:[^\S\r\n]*[^\r\n]*/giu,
    'AUTHORIZATION',
    'authorization: [REDACTED]',
  )
  replace(
    /\bbearer\s+[a-z0-9._~+/=-]{8,}/giu,
    'BEARER_TOKEN',
    'bearer [REDACTED]',
  )
  replace(
    /\b(?:gh[pousr]_[a-z0-9]{20,}|glpat-[a-z0-9_-]{20,}|xox[baprs]-[a-z0-9-]{10,}|npm_[a-z0-9]{20,}|aiza[a-z0-9_-]{30,}|sk-[a-z0-9][a-z0-9_-]{18,}[a-z0-9]|(?:pk|rk)-(?:live|test)-[a-z0-9_-]{16,}|(?:akia|asia|aida|aroa|aipa|anpa|anva|asca)[a-z0-9]{16})\b/giu,
    'API_KEY',
    '[REDACTED]',
  )
  replace(
    /"((?:(?:client|refresh|github|deepseek)[_-]?(?:token|secret|key)|(?:[a-z][a-z0-9]*[_-])+(?:token|secret|password|credential|key)|password|passwd|pwd|token|secret|credential|api[_-]?key|access[_-]?key))"(\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\]]+)/giu,
    'SECRET_ASSIGNMENT',
    (_match, key: string, separator: string) => `"${key.toLowerCase()}"${separator}"[REDACTED]"`,
  )
  replace(
    /'((?:(?:client|refresh|github|deepseek)[_-]?(?:token|secret|key)|(?:[a-z][a-z0-9]*[_-])+(?:token|secret|password|credential|key)|password|passwd|pwd|token|secret|credential|api[_-]?key|access[_-]?key))'(\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\]]+)/giu,
    'SECRET_ASSIGNMENT',
    (_match, key: string, separator: string) => `'${key.toLowerCase()}'${separator}'[REDACTED]'`,
  )
  replace(
    /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gu,
    'SECRET_ASSIGNMENT',
    (match) => `${match.slice(0, match.indexOf('=') + 1)}[REDACTED]`,
  )
  replace(
    /\b((?:(?:client|refresh|github|deepseek)[_-]?(?:token|secret|key)|(?:[a-z][a-z0-9]*[_-])+(?:token|secret|password|credential|key)))\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
    'SECRET_ASSIGNMENT',
    (_match, key: string, separator: string) => `${key.toLowerCase()}${separator}[REDACTED]`,
  )
  replace(
    /\b(password|passwd|pwd|token|secret|credential|api[_-]?key|access[_-]?key)\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
    'SECRET_ASSIGNMENT',
    (_match, key: string, separator: string) => `${key.toLowerCase()}${separator}[REDACTED]`,
  )

  text = text.replace(/\s+/gu, ' ').trim().toLowerCase()
  text = text.replace(/\[redacted\]/gu, '[REDACTED]')
  return {
    text,
    redactionKinds: REDACTION_KIND_ORDER.filter((kind) => (counts[kind] ?? 0) > 0),
    redactionCounts: counts,
  }
}
