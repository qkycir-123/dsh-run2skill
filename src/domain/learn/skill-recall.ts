import { sha256Utf8 } from '../observe/hashing.js'
import { preprocessPersistentText } from '../observe/redaction.js'
import { canonicalJson } from './identity.js'

const MAX_QUERY_TOKENS = 64
const MAX_CANDIDATES = 5
const MAX_SKILL_BODY_BYTES = 8 * 1024
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'for', 'in', 'of', 'on', 'please', 'the', 'this', 'to', 'use',
])
const CHINESE_STOP_WORDS = [
  '这个', '这些', '那个', '那些', '一个', '一种', '我们', '你们',
  '使用', '进行', '用于', '需要', '可以', '请',
] as const
const VERIFIED_FILESYSTEM_PROVIDER = 'filesystem'

export interface SkillSummaryProjection {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string | undefined
  readonly source: string
  readonly provider: string
}

export interface SkillDefinitionProjection extends SkillSummaryProjection {
  readonly content: string
}

export interface SkillCatalogSnapshotProjection {
  readonly skills: readonly SkillSummaryProjection[]
  readonly complete: boolean
}

export interface SkillCatalogPort<TView extends object> {
  snapshot(view: TView): Promise<SkillCatalogSnapshotProjection>
  get(name: string, view: TView): Promise<SkillDefinitionProjection | undefined>
}

export type CandidatePersistenceScope = 'PROJECT' | 'USER' | 'UNKNOWN'

export interface LoadedSkillCandidate {
  readonly candidateKey: `cand_${string}`
  readonly candidateDigest: string
  readonly source: string
  readonly persistenceScope: CandidatePersistenceScope
  readonly writable: boolean
  readonly name: string
  readonly description: string
  readonly whenToUse?: string | undefined
  readonly content: string
  readonly bodyDigest: string
}

export interface SkillRecallObservation {
  readonly catalogObservationDigest: string
  readonly candidates: readonly LoadedSkillCandidate[]
}

export type SkillRecallResult =
  | { readonly status: 'AVAILABLE'; readonly observation: SkillRecallObservation }
  | { readonly status: 'UNAVAILABLE'; readonly failureCode: 'CATALOG_INCOMPLETE' | 'CANDIDATE_UNAVAILABLE' }

interface ScoredCandidate {
  readonly summary: SkillSummaryProjection
  readonly candidateKey: `cand_${string}`
  readonly nameOverlap: number
  readonly whenToUseOverlap: number
  readonly descriptionOverlap: number
}

export function tokenizeForSkillRecall(value: string): string[] {
  const normalized = value.normalize('NFKC').toLowerCase()
  const result: string[] = []
  const seen = new Set<string>()
  const add = (token: string): void => {
    if (token.length <= 1 || STOP_WORDS.has(token) || seen.has(token) || result.length >= MAX_QUERY_TOKENS) return
    seen.add(token)
    result.push(token)
  }
  for (const match of normalized.matchAll(/[\p{Script=Latin}\p{Number}]+|[\p{Script=Han}]+/gu)) {
    const term = match[0]
    if (/^[\p{Script=Han}]+$/u.test(term)) {
      let meaningful = term
      for (const stopWord of CHINESE_STOP_WORDS) meaningful = meaningful.replaceAll(stopWord, '')
      const characters = [...meaningful]
      for (let index = 0; index + 1 < characters.length; index += 1) {
        add(`${characters[index]}${characters[index + 1]}`)
      }
    } else {
      add(term)
    }
    if (result.length >= MAX_QUERY_TOKENS) break
  }
  return result
}

function overlapCount(value: string | undefined, query: ReadonlySet<string>): number {
  if (value === undefined) return 0
  let count = 0
  for (const token of tokenizeForSkillRecall(value)) if (query.has(token)) count += 1
  return count
}

export function deriveCandidateKey(
  value: Pick<SkillSummaryProjection, 'name' | 'provider' | 'source'>,
): `cand_${string}` {
  return `cand_${sha256Utf8(canonicalJson({ name: value.name, provider: value.provider, source: value.source }))}`
}

function sourceFacts(
  provider: string,
  source: string,
): { persistenceScope: CandidatePersistenceScope; writable: boolean } {
  if (provider !== VERIFIED_FILESYSTEM_PROVIDER) {
    return { persistenceScope: 'UNKNOWN', writable: false }
  }
  switch (source) {
    case 'project-dsh': return { persistenceScope: 'PROJECT', writable: true }
    case 'user-dsh': return { persistenceScope: 'USER', writable: true }
    case 'project-agents': return { persistenceScope: 'PROJECT', writable: false }
    case 'user-agents': return { persistenceScope: 'USER', writable: false }
    default: return { persistenceScope: 'UNKNOWN', writable: false }
  }
}

function sameWinner(summary: SkillSummaryProjection, loaded: SkillDefinitionProjection): boolean {
  return summary.name === loaded.name
    && summary.provider === loaded.provider
    && summary.source === loaded.source
}

function catalogDigest(skills: readonly SkillSummaryProjection[]): string {
  const sanitized = skills.map(skill => ({
    name: preprocessPersistentText(skill.name).text,
    description: preprocessPersistentText(skill.description).text,
    ...(skill.whenToUse === undefined
      ? {}
      : { whenToUse: preprocessPersistentText(skill.whenToUse).text }),
    source: skill.source,
    provider: skill.provider,
  })).sort((left, right) => deriveCandidateKey(left).localeCompare(deriveCandidateKey(right)))
  return sha256Utf8(canonicalJson({ complete: true, skills: sanitized }))
}

export async function recallExistingSkills<TView extends object>(
  port: SkillCatalogPort<TView>,
  view: TView,
  directEvidence: string,
): Promise<SkillRecallResult> {
  let snapshot: SkillCatalogSnapshotProjection
  try {
    snapshot = await port.snapshot(view)
  } catch {
    return { status: 'UNAVAILABLE', failureCode: 'CATALOG_INCOMPLETE' }
  }
  if (!snapshot.complete) return { status: 'UNAVAILABLE', failureCode: 'CATALOG_INCOMPLETE' }

  const query = new Set(tokenizeForSkillRecall(directEvidence))
  const scored: ScoredCandidate[] = snapshot.skills.map(summary => ({
    summary,
    candidateKey: deriveCandidateKey(summary),
    nameOverlap: overlapCount(summary.name, query),
    whenToUseOverlap: overlapCount(summary.whenToUse, query),
    descriptionOverlap: overlapCount(summary.description, query),
  })).filter(candidate => (
    candidate.nameOverlap + candidate.whenToUseOverlap + candidate.descriptionOverlap > 0
  )).sort((left, right) => (
    right.nameOverlap - left.nameOverlap
    || right.whenToUseOverlap - left.whenToUseOverlap
    || right.descriptionOverlap - left.descriptionOverlap
    || left.candidateKey.localeCompare(right.candidateKey)
  )).slice(0, MAX_CANDIDATES)

  const candidates: LoadedSkillCandidate[] = []
  for (const selected of scored) {
    let loaded: SkillDefinitionProjection | undefined
    try {
      loaded = await port.get(selected.summary.name, view)
    } catch {
      return { status: 'UNAVAILABLE', failureCode: 'CANDIDATE_UNAVAILABLE' }
    }
    if (
      loaded === undefined
      || !sameWinner(selected.summary, loaded)
      || Buffer.byteLength(loaded.content, 'utf8') > MAX_SKILL_BODY_BYTES
    ) return { status: 'UNAVAILABLE', failureCode: 'CANDIDATE_UNAVAILABLE' }
    const description = preprocessPersistentText(loaded.description).text
    const whenToUse = loaded.whenToUse === undefined
      ? undefined
      : preprocessPersistentText(loaded.whenToUse).text
    const content = preprocessPersistentText(loaded.content).text
    if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_BODY_BYTES) {
      return { status: 'UNAVAILABLE', failureCode: 'CANDIDATE_UNAVAILABLE' }
    }
    const bodyDigest = sha256Utf8(loaded.content)
    const facts = sourceFacts(loaded.provider, loaded.source)
    const persistedFacts = {
      candidateKey: selected.candidateKey,
      source: loaded.source,
      ...facts,
      name: loaded.name,
      description,
      ...(whenToUse === undefined ? {} : { whenToUse }),
      bodyDigest,
    }
    candidates.push({
      ...persistedFacts,
      candidateDigest: sha256Utf8(canonicalJson(persistedFacts)),
      content,
    })
  }
  const observation = {
    catalogObservationDigest: catalogDigest(snapshot.skills),
    candidates,
  }
  return { status: 'AVAILABLE', observation }
}
