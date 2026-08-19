import { CHEAP_TRIGGER_V1_POLICY, type TriggerKind } from './cheap-trigger-v1-policy.js'
import { OBSERVE_LIMITS } from './constants.js'
import { sha256Utf8 } from './hashing.js'
import { preprocessSensitiveText, type PreprocessedSensitiveText } from './redaction.js'
import type { CaptureBlocker, EvidenceRef, RedactionKind, TriggerHit } from './schemas.js'

export type CandidateSourceKind = 'user' | 'synthetic' | 'tool' | 'plugin'

export interface TriggerCandidateMessage {
  messageSeq: number
  sourceKind: CandidateSourceKind
  text: string
}

interface TriggerAnalysisOptions {
  redact?: (text: string) => PreprocessedSensitiveText
}

interface CompleteTriggerAnalysis {
  status: 'COMPLETE'
  triggerHits: TriggerHit[]
  evidenceRefs: EvidenceRef[]
  redactionCounts: Partial<Record<RedactionKind, number>>
}

interface IncompleteTriggerAnalysis {
  status: 'INCOMPLETE'
  captureBlockers: CaptureBlocker[]
  triggerHits: []
  evidenceRefs: []
}

export type TriggerAnalysis = CompleteTriggerAnalysis | IncompleteTriggerAnalysis

interface MatchedRule {
  kind: TriggerKind
  ruleId: string
  matchIndex: number
}

const WORD_BOUNDARY = String.raw`(?:^|[\s，。！？,.!?;；:：])`
const WORD_END = String.raw`(?=$|[\s，。！？,.!?;；:：])`

const explicitSaveForward = new RegExp(
  `${CHEAP_TRIGGER_V1_POLICY.explicitSave.saveWords}.{0,${CHEAP_TRIGGER_V1_POLICY.explicitSave.maxDistance}}${CHEAP_TRIGGER_V1_POLICY.explicitSave.targetWords}`,
  'iu',
)
const explicitSaveReverse = new RegExp(
  `${CHEAP_TRIGGER_V1_POLICY.explicitSave.targetWords}.{0,${CHEAP_TRIGGER_V1_POLICY.explicitSave.maxDistance}}${CHEAP_TRIGGER_V1_POLICY.explicitSave.saveWords}`,
  'iu',
)
const explicitSaveFixed = new RegExp(CHEAP_TRIGGER_V1_POLICY.explicitSave.fixedPhrases, 'iu')
const explicitSaveRequestContext = new RegExp(
  CHEAP_TRIGGER_V1_POLICY.explicitSave.requestContext,
  'iu',
)
const explicitSaveNegation = new RegExp(CHEAP_TRIGGER_V1_POLICY.explicitSave.negation, 'iu')
const explicitSaveExplanation = new RegExp(
  CHEAP_TRIGGER_V1_POLICY.explicitSave.explanation,
  'iu',
)
const correctionAnchor = new RegExp(
  `${WORD_BOUNDARY}${CHEAP_TRIGGER_V1_POLICY.correction.anchors}${WORD_END}`,
  'iu',
)
const correctionBehavior = new RegExp(CHEAP_TRIGGER_V1_POLICY.correction.behaviorWords, 'iu')
const persistentScope = new RegExp(CHEAP_TRIGGER_V1_POLICY.constraint.persistentScope, 'iu')
const constraintOperator = new RegExp(CHEAP_TRIGGER_V1_POLICY.constraint.operators, 'iu')
const constraintDescriptiveSubject = new RegExp(
  CHEAP_TRIGGER_V1_POLICY.constraint.descriptiveSubject,
  'iu',
)
const reusableScope = new RegExp(CHEAP_TRIGGER_V1_POLICY.workflow.reusableScope, 'iu')
const processWords = new RegExp(CHEAP_TRIGGER_V1_POLICY.workflow.processWords, 'iu')
const workflowDirective = new RegExp(CHEAP_TRIGGER_V1_POLICY.workflow.directiveWords, 'iu')
const explicitSavePatterns = [explicitSaveForward, explicitSaveReverse, explicitSaveFixed] as const
const correctionPatterns = [correctionAnchor] as const
const constraintPatterns = [persistentScope] as const
const workflowPatterns = [reusableScope] as const

function firstMatchIndex(text: string, patterns: readonly RegExp[]): number | undefined {
  let first: number | undefined
  for (const pattern of patterns) {
    const index = pattern.exec(text)?.index
    if (index !== undefined && (first === undefined || index < first)) first = index
  }
  return first
}

function textClauses(
  text: string,
  splitCommas: boolean,
  splitContrasts = false,
): Array<{ text: string; start: number }> {
  const clauses: Array<{ text: string; start: number }> = []
  const delimiter = splitContrasts
    ? /[。！？.!?;；,，]|\b(?:but|instead)\b|而是|但是|—|–/giu
    : splitCommas
      ? /[。！？.!?;；,，]/gu
      : /[。！？.!?;；]/gu
  let start = 0
  for (const match of text.matchAll(delimiter)) {
    const raw = text.slice(start, match.index)
    const leadingWhitespace = raw.length - raw.trimStart().length
    const clause = raw.trim()
    if (clause.length > 0) {
      clauses.push({ text: clause, start: start + leadingWhitespace })
    }
    start = (match.index ?? 0) + match[0].length
  }
  const raw = text.slice(start)
  const leadingWhitespace = raw.length - raw.trimStart().length
  const clause = raw.trim()
  if (clause.length > 0) {
    clauses.push({ text: clause, start: start + leadingWhitespace })
  }
  return clauses
}

function firstExplicitSaveIndex(text: string): number | undefined {
  for (const clause of textClauses(text, true, true)) {
    const candidateIndex = firstMatchIndex(clause.text, explicitSavePatterns)
    if (
      candidateIndex !== undefined
      && explicitSaveRequestContext.test(clause.text)
      && !explicitSaveNegation.test(clause.text)
      && !explicitSaveExplanation.test(clause.text)
    ) {
      return clause.start + candidateIndex
    }
  }
  return undefined
}

function firstCorrectionIndex(text: string): number | undefined {
  const clauses = textClauses(text, false)
  for (const [index, clause] of clauses.entries()) {
    const anchorIndex = firstMatchIndex(clause.text, correctionPatterns)
    if (anchorIndex === undefined) continue
    const candidates = [clause, clauses[index + 1]].filter((value) => value !== undefined)
    if (candidates.some((candidate) => isPersistentDirective(
      candidate.text,
      correctionBehavior,
    ))) {
      return clause.start + anchorIndex
    }
  }
  return undefined
}

function isPersistentDirective(text: string, directive: RegExp): boolean {
  return persistentScope.test(text)
    && directive.test(text)
    && !constraintDescriptiveSubject.test(text)
}

function firstConstraintIndex(text: string): number | undefined {
  for (const clause of textClauses(text, false)) {
    const scopeIndex = firstMatchIndex(clause.text, constraintPatterns)
    if (
      scopeIndex !== undefined
      && isPersistentDirective(clause.text, constraintOperator)
    ) {
      return clause.start + scopeIndex
    }
  }
  return undefined
}

function firstWorkflowIndex(text: string): number | undefined {
  for (const clause of textClauses(text, false)) {
    const scopeIndex = firstMatchIndex(clause.text, workflowPatterns)
    if (
      scopeIndex !== undefined
      && (
        hasOrderedSteps(clause.text)
        || (
          processWords.test(clause.text)
          && (
            workflowDirective.test(clause.text)
            || firstExplicitSaveIndex(clause.text) !== undefined
          )
        )
      )
    ) {
      return clause.start + scopeIndex
    }
  }
  return undefined
}

function hasOrderedSteps(text: string): boolean {
  for (const pattern of CHEAP_TRIGGER_V1_POLICY.workflow.orderedSteps) {
    const start = text.indexOf(pattern.start)
    if (start === -1) continue
    const searchFrom = start + pattern.start.length
    if (pattern.ends.some((end) => text.indexOf(end, searchFrom) !== -1)) return true
  }
  return false
}

function matchRules(text: string): MatchedRule[] {
  const matches: MatchedRule[] = []
  const explicitSaveIndex = firstExplicitSaveIndex(text)
  if (explicitSaveIndex !== undefined) {
    matches.push({
      kind: 'EXPLICIT_SAVE',
      ruleId: 'ctv1.explicit-save.save-target',
      matchIndex: explicitSaveIndex,
    })
  }
  const correctionIndex = firstCorrectionIndex(text)
  if (correctionIndex !== undefined) {
    matches.push({
      kind: 'CORRECTION',
      ruleId: 'ctv1.correction.anchor-behavior',
      matchIndex: correctionIndex,
    })
  }
  const constraintIndex = firstConstraintIndex(text)
  if (constraintIndex !== undefined) {
    matches.push({
      kind: 'CONSTRAINT',
      ruleId: 'ctv1.constraint.persistent-operator',
      matchIndex: constraintIndex,
    })
  }
  const workflowIndex = firstWorkflowIndex(text)
  if (workflowIndex !== undefined) {
    matches.push({
      kind: 'WORKFLOW',
      ruleId: 'ctv1.workflow.reusable-process',
      matchIndex: workflowIndex,
    })
  }
  return matches
}

function sliceUtf8Window(
  value: string,
  matchIndex: number,
  maxBytes: number,
): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { value, truncated: false }

  const start = Math.max(0, matchIndex - 64)
  const candidate = value.slice(start)
  let result = ''
  let bytes = 0
  for (const character of candidate) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > maxBytes) break
    result += character
    bytes += size
  }
  return { value: result, truncated: start > 0 || result.length < candidate.length }
}

function addRedactionCounts(
  total: Partial<Record<RedactionKind, number>>,
  next: Partial<Record<RedactionKind, number>>,
): void {
  for (const [kind, count] of Object.entries(next) as Array<[RedactionKind, number]>) {
    total[kind] = (total[kind] ?? 0) + count
  }
}

export function analyzeCheapTriggerV1(
  messages: readonly TriggerCandidateMessage[],
  options: TriggerAnalysisOptions = {},
): TriggerAnalysis {
  let turnBytes = 0
  let directUserMessages = 0
  for (const message of messages) {
    if (message.sourceKind !== 'user') continue
    directUserMessages += 1
    const messageBytes = Buffer.byteLength(message.text, 'utf8')
    turnBytes += messageBytes
    if (
      directUserMessages > OBSERVE_LIMITS.maxDirectUserMessages
      || messageBytes > OBSERVE_LIMITS.maxMessageBytes
      || turnBytes > OBSERVE_LIMITS.maxTurnBytes
    ) {
      return {
        status: 'INCOMPLETE',
        captureBlockers: ['TEXT_LIMIT_EXCEEDED'],
        triggerHits: [],
        evidenceRefs: [],
      }
    }
  }

  const redact = options.redact ?? preprocessSensitiveText
  const triggerHits: TriggerHit[] = []
  const evidenceRefs: EvidenceRef[] = []
  const redactionCounts: Partial<Record<RedactionKind, number>> = {}

  for (const message of messages) {
    if (message.sourceKind !== 'user') continue
    let processed: PreprocessedSensitiveText
    try {
      processed = redact(message.text)
    } catch {
      return {
        status: 'INCOMPLETE',
        captureBlockers: ['REDACTION_UNAVAILABLE'],
        triggerHits: [],
        evidenceRefs: [],
      }
    }

    addRedactionCounts(redactionCounts, processed.redactionCounts)
    const matchedRules = matchRules(processed.text)
    for (const rule of matchedRules) {
      triggerHits.push({
        kind: rule.kind,
        messageSeq: message.messageSeq,
        ruleId: rule.ruleId,
        confidence: 'HIGH',
      })
    }

    if (matchedRules.length > 0 && evidenceRefs.length < OBSERVE_LIMITS.maxEvidenceRefs) {
      const firstMatch = Math.min(...matchedRules.map((rule) => rule.matchIndex))
      const excerpt = sliceUtf8Window(
        processed.text,
        firstMatch,
        OBSERVE_LIMITS.maxEvidenceBytes,
      )
      evidenceRefs.push({
        source: 'USER_DIRECT',
        messageSeq: message.messageSeq,
        excerpt: excerpt.value,
        excerptDigest: sha256Utf8(excerpt.value),
        redactionKinds: processed.redactionKinds,
        truncated: excerpt.truncated,
      })
    }
  }

  triggerHits.sort((left, right) => {
    const messageOrder = left.messageSeq - right.messageSeq
    if (messageOrder !== 0) return messageOrder
    return CHEAP_TRIGGER_V1_POLICY.kindOrder.indexOf(left.kind)
      - CHEAP_TRIGGER_V1_POLICY.kindOrder.indexOf(right.kind)
  })

  return { status: 'COMPLETE', triggerHits, evidenceRefs, redactionCounts }
}
