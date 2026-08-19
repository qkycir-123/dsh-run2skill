const MAX_DIAGNOSTIC_LENGTH = 4_096

const replacements = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, '[REDACTED_PRIVATE_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu, '[REDACTED_GITHUB_TOKEN]'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/gu, '[REDACTED_API_KEY]'],
  [/(authorization\s*[:=]\s*bearer)\s+[^\s]+/giu, '$1 [REDACTED]'],
  [/\b((?:deepseek|api)[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\s*[:=]\s*[^\s,;]+/giu, '$1=[REDACTED]'],
  [/[A-Za-z]:\\(?:[^\s\\]+\\)+[^\s]*/gu, '[REDACTED_ABSOLUTE_PATH]'],
  [/(?:\/Users|\/home)\/[^\s]+/gu, '[REDACTED_ABSOLUTE_PATH]'],
]

export function sanitizeDiagnostic(value) {
  let safe = String(value)
  for (const [pattern, replacement] of replacements) safe = safe.replace(pattern, replacement)
  return safe.slice(0, MAX_DIAGNOSTIC_LENGTH)
}

export function safeFailure(summary, diagnostic) {
  const safeSummary = String(summary).replace(/[\r\n]+/gu, ' ').slice(0, 160)
  const safeDiagnostic = sanitizeDiagnostic(diagnostic).trim()
  return safeDiagnostic.length === 0 ? safeSummary : `${safeSummary}\n${safeDiagnostic}`
}
