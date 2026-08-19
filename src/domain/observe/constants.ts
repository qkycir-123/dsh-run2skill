export const TRIGGER_POLICY_VERSION = 'cheap-trigger-v1' as const

export const TRIGGER_KIND_ORDER = Object.freeze([
  'EXPLICIT_SAVE',
  'CORRECTION',
  'CONSTRAINT',
  'WORKFLOW',
] as const)

export const REDACTION_KIND_ORDER = Object.freeze([
  'PRIVATE_KEY',
  'AUTHORIZATION',
  'BEARER_TOKEN',
  'API_KEY',
  'SECRET_ASSIGNMENT',
  'URL_CREDENTIAL',
] as const)

export const CAPTURE_BLOCKER_ORDER = Object.freeze([
  'TURN_BOUNDARY_INCOMPLETE',
  'TEXT_LIMIT_EXCEEDED',
  'REDACTION_UNAVAILABLE',
] as const)

export const OBSERVE_LIMITS = Object.freeze({
  maxMessageBytes: 64 * 1024,
  maxTurnBytes: 256 * 1024,
  maxDirectUserMessages: 1024,
  maxTriggerHits: 1024 * TRIGGER_KIND_ORDER.length,
  maxEvidenceBytes: 512,
  maxEvidenceRefs: 4,
  maxEvidenceTotalBytes: 2 * 1024,
  maxRedactionKinds: REDACTION_KIND_ORDER.length,
  maxIdentityChars: 1024,
  maxTurnIdentityBytes: 256 * 1024,
  maxPathChars: 32 * 1024,
  maxPathBytes: 32 * 1024,
  maxHeaderRevisionChars: 1024,
})
