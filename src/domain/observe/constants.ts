export const TRIGGER_POLICY_VERSION = 'cheap-trigger-v1' as const

export const OBSERVE_LIMITS = Object.freeze({
  maxMessageBytes: 64 * 1024,
  maxTurnBytes: 256 * 1024,
  maxDirectUserMessages: 1024,
  maxTriggerHits: 1024 * 4,
  maxEvidenceBytes: 512,
  maxEvidenceRefs: 4,
  maxEvidenceTotalBytes: 2 * 1024,
  maxRedactionKinds: 6,
  maxIdentityChars: 1024,
  maxPathChars: 32 * 1024,
  maxHeaderRevisionChars: 1024,
})
