export type DomainErrorCode =
  | 'SIGNAL_KEY_CONFLICT'
  | 'IMMUTABLE_FIELD_CONFLICT'
  | 'EVIDENCE_LIMIT_EXCEEDED'
  | 'INVALID_WORK_ITEM'

const ERROR_MESSAGES: Record<DomainErrorCode, string> = {
  SIGNAL_KEY_CONFLICT: 'WorkItem identity does not match its SignalKey',
  IMMUTABLE_FIELD_CONFLICT: 'Immutable WorkItem facts do not match',
  EVIDENCE_LIMIT_EXCEEDED: 'Merged evidence exceeds the WorkItem limit',
  INVALID_WORK_ITEM: 'WorkItem does not satisfy the domain schema',
}

export class DomainError extends Error {
  readonly code: DomainErrorCode

  constructor(code: DomainErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'DomainError'
    this.code = code
  }
}
