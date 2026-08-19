const MAX_DIAGNOSTIC_LENGTH = 4_096
const assignmentTailMarker = '\u0000'
const providerCredential = /\b(?:gh[pousr]_[a-z0-9]{20,}|glpat-[a-z0-9_-]{20,}|xox[baprs]-[a-z0-9-]{10,}|npm_[a-z0-9]{20,}|aiza[a-z0-9_-]{30,}|sk-[a-z0-9][a-z0-9_-]{18,}[a-z0-9]|(?:pk|rk)-(?:live|test)-[a-z0-9_-]{16,}|(?:akia|asia|aida|aroa|aipa|anpa|anva|asca)[a-z0-9]{16})\b/giu
const windowsAbsolutePath = /[A-Za-z]:\\(?:[^\s\\]+\\)+[^\s]*/gu
const unixAbsolutePath = /(?:\/Users|\/home|\/tmp|\/var|\/etc|\/opt|\/srv|\/private)\/[^\s]*/gu

function isSensitiveAssignmentKey(key) {
  const normalized = key.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase()
  const parts = normalized.split(/[_-]+/u).filter(Boolean)
  const suffix = parts.at(-1)
  if (suffix === undefined) return false
  if (['password', 'passwd', 'pwd', 'token', 'secret', 'credential'].includes(suffix)) return true
  if (suffix === 'key' && parts.length > 1) return true
  return ['apikey', 'accesskey'].includes(normalized)
}

function redactAssignments(text, pattern) {
  return text.replace(pattern, (match, key, separator, value) => {
    if (!isSensitiveAssignmentKey(key)) return match
    const tail = value.startsWith('"') || value.startsWith("'") ? '' : assignmentTailMarker
    return `${key}${separator}[REDACTED]${tail}`
  })
}

function redactSensitive(value) {
  let text = String(value).normalize('NFKC')
  const replace = (pattern, replacement) => { text = text.replace(pattern, replacement) }
  replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/giu,
    '[REDACTED_PRIVATE_KEY]',
  )
  replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^\s<>/?#]*)@/giu,
    (_match, scheme) => `${scheme}[REDACTED]@`,
  )
  replace(/\bauthorization[^\S\r\n]*:[^\S\r\n]*[^\r\n]*/giu, 'authorization: [REDACTED]')
  replace(/\bbearer\s+[a-z0-9._~+/=-]{8,}/giu, 'bearer [REDACTED]')
  replace(providerCredential, '[REDACTED_API_KEY]')
  text = redactAssignments(
    text,
    /["']([a-z][a-z0-9_-]{0,127})["'](\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\]]+)/giu,
  )
  text = redactAssignments(
    text,
    /\b([a-z][a-z0-9_-]{0,127})\s*([:=])\s*("[^"]*"|'[^']*'|[^\s,;]+)/giu,
  )
  text = text.replace(new RegExp(`${assignmentTailMarker}[^,;，；}\\]\\r\\n]*`, 'gu'), '')
  return text
}

export function sanitizeDiagnostic(value) {
  return redactSensitive(value)
    .replace(windowsAbsolutePath, '[REDACTED_ABSOLUTE_PATH]')
    .replace(unixAbsolutePath, '[REDACTED_ABSOLUTE_PATH]')
    .slice(0, MAX_DIAGNOSTIC_LENGTH)
}

export function isSafeDiagnosticOutput(value) {
  const text = String(value)
  return text.length <= MAX_DIAGNOSTIC_LENGTH
    && sanitizeDiagnostic(text) === text
}

export function safeFailure(summary, diagnostic) {
  const safeSummary = String(summary).replace(/[\r\n]+/gu, ' ').slice(0, 160)
  const safeDiagnostic = sanitizeDiagnostic(diagnostic).trim()
  return safeDiagnostic.length === 0 ? safeSummary : `${safeSummary}\n${safeDiagnostic}`
}
