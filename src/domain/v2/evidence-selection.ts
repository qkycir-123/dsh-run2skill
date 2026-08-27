import { sha256Utf8 } from '../observe/hashing.js'
import { CHEAP_TRIGGER_V1_POLICY } from '../observe/cheap-trigger-v1-policy.js'

const OMISSION_MARKER = '\n…\n'
const MAX_SEMANTIC_UNIT_BYTES = 512

const explicitSaveForward = new RegExp(
  `${CHEAP_TRIGGER_V1_POLICY.explicitSave.saveWords}.{0,${String(CHEAP_TRIGGER_V1_POLICY.explicitSave.maxDistance)}}${CHEAP_TRIGGER_V1_POLICY.explicitSave.targetWords}`,
  'iu',
)
const explicitSaveReverse = new RegExp(
  `${CHEAP_TRIGGER_V1_POLICY.explicitSave.targetWords}.{0,${String(CHEAP_TRIGGER_V1_POLICY.explicitSave.maxDistance)}}${CHEAP_TRIGGER_V1_POLICY.explicitSave.saveWords}`,
  'iu',
)
const explicitSaveFixed = new RegExp(CHEAP_TRIGGER_V1_POLICY.explicitSave.fixedPhrases, 'iu')

type SemanticClass = 'EXPLICIT_SAVE' | 'PROHIBITION' | 'ACCEPTANCE' | 'ORDERED_STEPS' | 'CONSTRAINT' | 'LATEST_TAIL'

const MANDATORY_CLASS_ORDER: readonly SemanticClass[] = [
  'EXPLICIT_SAVE',
  'PROHIBITION',
  'ACCEPTANCE',
  'ORDERED_STEPS',
  'CONSTRAINT',
  'LATEST_TAIL',
]

const CLASS_CAPS: Readonly<Record<SemanticClass, number>> = Object.freeze({
  EXPLICIT_SAVE: 2,
  PROHIBITION: 2,
  ACCEPTANCE: 3,
  ORDERED_STEPS: 2,
  CONSTRAINT: 2,
  LATEST_TAIL: 1,
})

export interface SelectableEvidenceRefV2 {
  readonly source: 'USER_DIRECT'
  readonly messageSeq: number
  readonly excerpt: string
  readonly excerptDigest: string
  readonly redactionKinds: readonly string[]
  readonly truncated: boolean
}

interface SemanticUnit {
  readonly refIndex: number
  readonly unitIndex: number
  readonly text: string
  readonly score: number
  readonly messageSeq: number
  readonly classes: readonly SemanticClass[]
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  let result = ''
  let usedBytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (usedBytes + characterBytes > maxBytes) break
    result += character
    usedBytes += characterBytes
  }
  return result
}

function splitUtf8(value: string, maxBytes: number): string[] {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return [value]
  const result: string[] = []
  let remaining = value
  while (remaining.length > 0) {
    const chunk = takeUtf8Prefix(remaining, maxBytes)
    if (chunk.length === 0) break
    result.push(chunk)
    remaining = remaining.slice(chunk.length)
  }
  return result
}

function semanticUnits(value: string): string[] {
  const units = value.match(/[^.!?。！？；;\n]+[.!?。！？；;]?|\n+/gu) ?? [value]
  return units
    .filter(unit => !/^\s+$/u.test(unit))
    .flatMap(unit => splitUtf8(unit, MAX_SEMANTIC_UNIT_BYTES))
    .map(unit => unit.trim())
    .filter(Boolean)
}

function semanticClasses(value: string): SemanticClass[] {
  const result: SemanticClass[] = []
  if (explicitSaveForward.test(value) || explicitSaveReverse.test(value) || explicitSaveFixed.test(value)) {
    result.push('EXPLICIT_SAVE')
  }
  if (/(?:不得|禁止|不要|不可|严禁|never\b|must\s+not\b|do\s+not\b|don['’]t\b)/iu.test(value)) {
    result.push('PROHIBITION')
  }
  if (/(?:验收(?:条件)?|核验|验证|测试(?:全部)?通过|重新读取|acceptance\s+criteria|read[- ]?back|verif(?:y|ication)|tests?\s+(?:must\s+)?pass)/iu.test(value)) {
    result.push('ACCEPTANCE')
  }
  if (/(?:关键步骤|第[一二三四五六七八九十\d]+步|先.+(?:再|然后|最后)|required\s+steps?|first\b.+(?:then\b|finally\b))/iu.test(value)) {
    result.push('ORDERED_STEPS')
  }
  if (/(?:必须|只能|只允许|务必|纠正|修正|不对|must\b|only\b|constraint|correction)/iu.test(value)) {
    result.push('CONSTRAINT')
  }
  return result
}

function semanticScore(classes: readonly SemanticClass[]): number {
  return classes.reduce((score, category) => Math.max(score, ({
    EXPLICIT_SAVE: 600,
    PROHIBITION: 550,
    ACCEPTANCE: 500,
    ORDERED_STEPS: 450,
    CONSTRAINT: 400,
    LATEST_TAIL: 250,
  } satisfies Record<SemanticClass, number>)[category]), 0)
}

/**
 * Selects model/durable evidence under one exact UTF-8 text budget.
 *
 * Selection is deterministic and model-free. It ranks explicit-save semantics,
 * prohibitions, acceptance/verification, ordered steps and constraints before
 * generic context, while still retaining the newest tail and a small head anchor.
 */
export function selectBoundedEvidenceRefsV2<T extends SelectableEvidenceRefV2>(
  refs: readonly T[],
  maxTotalBytes: number,
): T[] {
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 0) {
    throw new TypeError('Invalid v2 evidence byte budget')
  }
  if (maxTotalBytes === 0 || refs.length === 0) return []
  const originalBytes = refs.reduce(
    (total, ref) => total + Buffer.byteLength(ref.excerpt, 'utf8'),
    0,
  )
  if (originalBytes <= maxTotalBytes) {
    return refs.map(ref => ({
      ...ref,
      excerptDigest: sha256Utf8(ref.excerpt),
    }))
  }

  const unitsByRef = refs.map(ref => semanticUnits(ref.excerpt))
  const latestRefIndex = refs.reduce((latest, ref, index) => (
    ref.messageSeq > refs[latest]!.messageSeq || (ref.messageSeq === refs[latest]!.messageSeq && index > latest)
      ? index
      : latest
  ), 0)
  const units: SemanticUnit[] = unitsByRef.flatMap((refUnits, refIndex) => (
    refUnits.map((text, unitIndex) => {
      const classes = semanticClasses(text)
      if (refIndex === latestRefIndex && unitIndex === refUnits.length - 1) classes.push('LATEST_TAIL')
      return {
      refIndex,
      unitIndex,
      text,
      messageSeq: refs[refIndex]!.messageSeq,
      classes,
      score: semanticScore(classes)
        + (unitIndex === refUnits.length - 1 ? 250 : 0)
        + (unitIndex === 0 ? 100 : 0),
      }
    })
  ))
  units.sort((left, right) => (
    right.score - left.score
    || right.messageSeq - left.messageSeq
    || right.unitIndex - left.unitIndex
    || left.refIndex - right.refIndex
  ))

  const selected = new Map<number, Map<number, string>>()
  const selectedKeys = new Set<string>()
  const classCounts = new Map<SemanticClass, number>()
  let usedBytes = 0

  const addUnit = (unit: SemanticUnit, allowPartial: boolean): boolean => {
    const key = `${String(unit.refIndex)}:${String(unit.unitIndex)}`
    if (selectedKeys.has(key)) return true
    const perRef = selected.get(unit.refIndex) ?? new Map<number, string>()
    const separatorBytes = perRef.size === 0 ? 0 : Buffer.byteLength(OMISSION_MARKER, 'utf8')
    const available = maxTotalBytes - usedBytes - separatorBytes
    if (available <= 0) return false
    const unitBytes = Buffer.byteLength(unit.text, 'utf8')
    if (!allowPartial && unitBytes > available) return false
    const text = Buffer.byteLength(unit.text, 'utf8') <= available
      ? unit.text
      : takeUtf8Prefix(unit.text, available)
    if (text.length === 0) return false
    perRef.set(unit.unitIndex, text)
    selected.set(unit.refIndex, perRef)
    selectedKeys.add(key)
    for (const category of unit.classes) {
      classCounts.set(category, (classCounts.get(category) ?? 0) + 1)
    }
    usedBytes += separatorBytes + Buffer.byteLength(text, 'utf8')
    return true
  }

  for (const category of MANDATORY_CLASS_ORDER) {
    if ((classCounts.get(category) ?? 0) > 0) continue
    const candidate = units.find(unit => unit.classes.includes(category))
    if (candidate !== undefined && !addUnit(candidate, false)) return []
  }

  for (const unit of units) {
    if (selectedKeys.has(`${String(unit.refIndex)}:${String(unit.unitIndex)}`)) continue
    if (unit.classes.some(category => (classCounts.get(category) ?? 0) >= CLASS_CAPS[category])) continue
    if (!addUnit(unit, true) && usedBytes >= maxTotalBytes) break
  }

  return refs.flatMap((ref, refIndex) => {
    const chosen = selected.get(refIndex)
    if (chosen === undefined) return []
    const excerpt = [...chosen.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, text]) => text)
      .join(OMISSION_MARKER)
    return [{
      ...ref,
      excerpt,
      excerptDigest: sha256Utf8(excerpt),
      truncated: ref.truncated
        || chosen.size !== unitsByRef[refIndex]!.length
        || excerpt !== ref.excerpt,
    }]
  })
}
