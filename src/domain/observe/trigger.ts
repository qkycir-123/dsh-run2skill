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
const correctionAnchor = new RegExp(
  `${WORD_BOUNDARY}${CHEAP_TRIGGER_V1_POLICY.correction.anchors}${WORD_END}`,
  'iu',
)
const correctionBehavior = new RegExp(CHEAP_TRIGGER_V1_POLICY.correction.behaviorWords, 'iu')
const persistentScope = new RegExp(CHEAP_TRIGGER_V1_POLICY.constraint.persistentScope, 'iu')
const constraintOperator = new RegExp(CHEAP_TRIGGER_V1_POLICY.constraint.operators, 'iu')
const reusableScope = new RegExp(CHEAP_TRIGGER_V1_POLICY.workflow.reusableScope, 'iu')
const processWords = new RegExp(CHEAP_TRIGGER_V1_POLICY.workflow.processWords, 'iu')
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
  const explicitSaveIndex = firstMatchIndex(text, explicitSavePatterns)
  if (explicitSaveIndex !== undefined) {
    matches.push({
      kind: 'EXPLICIT_SAVE',
      ruleId: 'ctv1.explicit-save.save-target',
      matchIndex: explicitSaveIndex,
    })
  }
  const correctionIndex = firstMatchIndex(text, correctionPatterns)
  if (
    correctionIndex !== undefined
    && correctionBehavior.test(text)
    && persistentScope.test(text)
  ) {
    matches.push({
      kind: 'CORRECTION',
      ruleId: 'ctv1.correction.anchor-behavior',
      matchIndex: correctionIndex,
    })
  }
  const constraintIndex = firstMatchIndex(text, constraintPatterns)
  if (constraintIndex !== undefined && constraintOperator.test(text)) {
    matches.push({
      kind: 'CONSTRAINT',
      ruleId: 'ctv1.constraint.persistent-operator',
      matchIndex: constraintIndex,
    })
  }
  const workflowIndex = firstMatchIndex(text, workflowPatterns)
  if (workflowIndex !== undefined && (processWords.test(text) || hasOrderedSteps(text))) {
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
