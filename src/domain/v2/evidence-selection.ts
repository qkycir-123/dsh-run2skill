import { sha256Utf8 } from '../observe/hashing.js'

const OMISSION_MARKER = '\n…\n'
const MAX_SEMANTIC_UNIT_BYTES = 1024

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
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  let result = ''
  for (const character of value) {
    if (Buffer.byteLength(result + character, 'utf8') > maxBytes) break
    result += character
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

function semanticScore(value: string): number {
  let score = 0
  if (/(?:保存(?:成|为)|记住|沉淀|写入\s*skill|remember\b|save\b[^.!?。！？\n]{0,80}\bskill\b)/iu.test(value)) {
    score = Math.max(score, 600)
  }
  if (/(?:不得|禁止|不要|不可|严禁|never\b|must\s+not\b|do\s+not\b|don't\b)/iu.test(value)) {
    score = Math.max(score, 550)
  }
  if (/(?:验收|验收条件|核验|验证|测试(?:全部)?通过|重新读取|acceptance\s+criteria|read[- ]?back|verif(?:y|ication)|tests?\s+(?:must\s+)?pass)/iu.test(value)) {
    score = Math.max(score, 500)
  }
  if (/(?:关键步骤|第[一二三四五六七八九十\d]+步|先.+(?:再|然后|最后)|流程|required\s+steps?|first\b|then\b|finally\b|workflow\b)/iu.test(value)) {
    score = Math.max(score, 450)
  }
  if (/(?:必须|只能|只允许|纠正|修正|不对|must\b|only\b|constraint|correction)/iu.test(value)) {
    score = Math.max(score, 400)
  }
  return score
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
  const units: SemanticUnit[] = unitsByRef.flatMap((refUnits, refIndex) => (
    refUnits.map((text, unitIndex) => ({
      refIndex,
      unitIndex,
      text,
      messageSeq: refs[refIndex]!.messageSeq,
      score: semanticScore(text)
        + (unitIndex === refUnits.length - 1 ? 250 : 0)
        + (unitIndex === 0 ? 100 : 0),
    }))
  ))
  units.sort((left, right) => (
    right.score - left.score
    || right.messageSeq - left.messageSeq
    || right.unitIndex - left.unitIndex
    || left.refIndex - right.refIndex
  ))

  const selected = new Map<number, Map<number, string>>()
  let usedBytes = 0
  for (const unit of units) {
    const perRef = selected.get(unit.refIndex) ?? new Map<number, string>()
    const separatorBytes = perRef.size === 0 ? 0 : Buffer.byteLength(OMISSION_MARKER, 'utf8')
    const available = maxTotalBytes - usedBytes - separatorBytes
    if (available <= 0) continue
    const text = Buffer.byteLength(unit.text, 'utf8') <= available
      ? unit.text
      : takeUtf8Prefix(unit.text, available)
    if (text.length === 0) continue
    perRef.set(unit.unitIndex, text)
    selected.set(unit.refIndex, perRef)
    usedBytes += separatorBytes + Buffer.byteLength(text, 'utf8')
    if (usedBytes >= maxTotalBytes) break
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
