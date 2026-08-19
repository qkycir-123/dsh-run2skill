export const TRIGGER_POLICY_VERSION = 'cheap-trigger-v1' as const

export const OBSERVE_LIMITS = Object.freeze({
  maxMessageBytes: 64 * 1024,
  maxTurnBytes: 256 * 1024,
  maxDirectUserMessages: 1024,
  maxEvidenceBytes: 512,
  maxEvidenceRefs: 4,
  maxEvidenceTotalBytes: 2 * 1024,
})
