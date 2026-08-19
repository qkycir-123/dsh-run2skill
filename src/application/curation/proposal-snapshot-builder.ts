import { join, normalize } from 'node:path'
import {
  canLoadedCandidateCoverScope,
  recallExistingSkills,
  type LoadedSkillCandidate,
  type SkillCatalogPort,
  type SkillCatalogRootProjection,
  type SkillRecallObservation,
} from '../../domain/learn/index.js'
import { canonicalJson } from '../../domain/learn/identity.js'
import type { CaptureWorkItemV1 } from '../../domain/observe/schemas.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import { preprocessPersistentText } from '../../domain/observe/redaction.js'
import {
  materializeProposalSnapshot,
  type ProposalSnapshotFactsV1,
  type ProposalSnapshotV1,
} from '../../domain/review/index.js'
import { renderCanonicalSkill, SKILL_RENDERER_VERSION } from './skill-renderer.js'

export type ObservedRoot =
  | {
    readonly status: 'EXISTING'
    readonly canonicalRootPath: string
    readonly rootIdentityDigest: string
  }
  | {
    readonly status: 'ABSENT'
    readonly canonicalExistingAncestorPath: string
    readonly ancestorIdentityDigest: string
    readonly missingSegments: readonly string[]
  }
  | { readonly status: 'UNAVAILABLE' }

export type ObservedEntry =
  | { readonly status: 'ABSENT' | 'FILE' | 'DIRECTORY' | 'LINK' | 'OTHER' }
  | { readonly status: 'UNAVAILABLE' }

export type ExactTextObservation =
  | { readonly status: 'AVAILABLE'; readonly text: string }
  | { readonly status: 'UNAVAILABLE' }

export interface PublicationFactsPort {
  observeRoot(path: string): Promise<ObservedRoot>
  observeEntry(path: string): Promise<ObservedEntry>
  readExactText(path: string, maxBytes: number): Promise<ExactTextObservation>
}

export type ProposalBuildFailureCode =
  | 'CATALOG_INCOMPLETE'
  | 'CATALOG_CHANGED'
  | 'ROOT_OBSERVATION_UNAVAILABLE'
  | 'ROOT_BINDING_AMBIGUOUS'
  | 'WORKSPACE_BINDING_UNAVAILABLE'
  | 'CANDIDATE_UNAVAILABLE'
  | 'CURATION_CONFLICT'
  | 'TARGET_FACTS_UNAVAILABLE'
  | 'TARGET_ALREADY_EXISTS'
  | 'TARGET_FORMAT_UNSUPPORTED'
  | 'BASE_UNAVAILABLE'
  | 'UNSAFE_SKILL'

export type ProposalBuildResult =
  | { readonly status: 'READY'; readonly proposal: ProposalSnapshotV1 }
  | { readonly status: 'UNAVAILABLE'; readonly failureCode: ProposalBuildFailureCode }

export interface ProposalSnapshotBuilderOptions {
  readonly now?: () => string
  readonly effectiveDshHome?: string
}

const FILESYSTEM_PROVIDER = 'filesystem'
const ROOT_RESOLVER_VERSION = 'root-resolver-v1'
const MAX_BASE_BYTES = 64 * 1024
const MARKDOWN_HEADING = /^#{1,6}\s+\S/mu
type RootBinding = Extract<
  ProposalSnapshotFactsV1['actionBinding'],
  { kind: 'CREATE' }
>['rootBinding']

function unavailable(failureCode: ProposalBuildFailureCode): ProposalBuildResult {
  return { status: 'UNAVAILABLE', failureCode }
}

function sameOrdered(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function samePath(left: string, right: string): boolean {
  return normalize(left) === normalize(right)
}

function hasFormatControls(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (
      /\p{Cf}/u.test(character)
      || codePoint <= 8
      || codePoint === 11
      || codePoint === 12
      || (codePoint >= 14 && codePoint <= 31)
      || (codePoint >= 127 && codePoint <= 159)
    ) return true
  }
  return false
}

function rootObservationDigest(roots: readonly SkillCatalogRootProjection[]): string {
  const ordered = roots.map(root => ({ ...root })).sort((left, right) => (
    left.provider.localeCompare(right.provider)
    || left.source.localeCompare(right.source)
    || left.path.localeCompare(right.path)
  ))
  return sha256Utf8(canonicalJson({ complete: true, roots: ordered }))
}

function candidateFor(
  observation: SkillRecallObservation,
  candidateKey: string | undefined,
): LoadedSkillCandidate | undefined {
  return observation.candidates.find(candidate => candidate.candidateKey === candidateKey)
}

export class ProposalSnapshotBuilder<TView extends object> {
  readonly #skills: SkillCatalogPort<TView>
  readonly #publicationFacts: PublicationFactsPort
  readonly #now: () => string
  readonly #effectiveDshHome: string | undefined

  constructor(
    skills: SkillCatalogPort<TView>,
    publicationFacts: PublicationFactsPort,
    options: ProposalSnapshotBuilderOptions = {},
  ) {
    this.#skills = skills
    this.#publicationFacts = publicationFacts
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#effectiveDshHome = options.effectiveDshHome
  }

  async build(item: CaptureWorkItemV1, view: TView): Promise<ProposalBuildResult> {
    if (item.processingState !== 'LEARNED' || item.learning?.proposal === undefined) {
      return unavailable('CURATION_CONFLICT')
    }
    const learned = item.learning.proposal
    const recalled = await recallExistingSkills(
      this.#skills,
      view,
      item.evidenceRefs.map(evidence => evidence.excerpt).join('\n'),
    )
    if (recalled.status === 'UNAVAILABLE') return unavailable(recalled.failureCode)
    const observation = recalled.observation
    if (
      learned.catalogObservationDigest !== observation.catalogObservationDigest
      || !sameOrdered(
        learned.shortlistDigests,
        observation.candidates.map(candidate => candidate.candidateDigest),
      )
    ) return unavailable('CATALOG_CHANGED')

    const exactSkillBytes = renderCanonicalSkill(learned)
    if (
      hasFormatControls(exactSkillBytes)
      || !MARKDOWN_HEADING.test(learned.content)
      || preprocessPersistentText(exactSkillBytes).redactionKinds.length > 0
    ) {
      return unavailable('UNSAFE_SKILL')
    }

    const createdAt = this.#now()
    const commonFacts = {
      schemaVersion: 1 as const,
      revision: 1,
      createdAt,
      sourceLearningProposalId: learned.learningProposalId,
      kind: learned.curation.decision,
      name: learned.name,
      description: learned.description,
      whenToUse: learned.whenToUse,
      invocation: learned.invocation,
      exactSkillBytes,
      skillBytesDigest: sha256Utf8(exactSkillBytes),
      rendererVersion: SKILL_RENDERER_VERSION,
      persistenceScope: learned.persistenceScope,
      ...(learned.persistenceScope === 'PROJECT' && item.workspaceBinding.status === 'BOUND'
        ? { workspaceBinding: {
          workspaceId: item.workspaceBinding.workspaceId,
          canonicalPath: item.workspaceBinding.canonicalPath,
          observedAt: item.workspaceBinding.observedAt,
        } }
        : {}),
      supportingExperienceIds: learned.supportingExperienceIds,
      catalogObservationDigest: learned.catalogObservationDigest,
      curationRationale: learned.curation.rationale,
    }

    if (learned.curation.decision === 'DISCARD') {
      const candidate = candidateFor(observation, learned.curation.candidateKey)
      if (
        candidate === undefined
        || !canLoadedCandidateCoverScope(learned.persistenceScope, candidate)
        || candidate.bodyDigest !== sha256Utf8(candidate.content)
      ) return unavailable('CANDIDATE_UNAVAILABLE')
      return this.#materialize(item.workItemId, {
        ...commonFacts,
        kind: 'DISCARD',
        actionBinding: {
          kind: 'DISCARD',
          coveringCandidateBinding: {
            candidateKey: candidate.candidateKey,
            provider: candidate.provider,
            source: candidate.source,
            name: candidate.name,
            description: candidate.description,
            ...(candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse }),
            content: candidate.content,
            contentDigest: candidate.bodyDigest,
            ...(candidate.path === undefined ? {} : { path: candidate.path }),
            catalogObservationDigest: learned.catalogObservationDigest,
            observedAt: createdAt,
          },
        },
      })
    }

    const target = this.#resolveTarget(item, learned.persistenceScope, learned.name, observation)
    if ('failureCode' in target) return unavailable(target.failureCode)
    const rootBinding = await this.#bindRoot(target.root, target.expectedRoot, learned.persistenceScope, observation.roots!)
    if ('failureCode' in rootBinding) return unavailable(rootBinding.failureCode)

    if (learned.curation.decision === 'CREATE') {
      if (observation.catalogSkills.some(skill => skill.name === learned.name)) {
        return unavailable('CURATION_CONFLICT')
      }
      const entries = await this.#observeTargetEntries(target.bundlePath, target.skillFilePath)
      if ('failureCode' in entries) return unavailable(entries.failureCode)
      return this.#materialize(item.workItemId, {
        ...commonFacts,
        kind: 'CREATE',
        actionBinding: {
          kind: 'CREATE',
          rootBinding: rootBinding.value,
          targetBinding: target.binding,
          expectedAbsence: {
            catalogObservationDigest: learned.catalogObservationDigest,
            observedAt: createdAt,
            bundlePathAbsent: true,
            skillFilePathAbsent: true,
          },
        },
      })
    }

    const candidate = candidateFor(observation, learned.curation.candidateKey)
    if (
      candidate === undefined
      || !candidate.writable
      || candidate.persistenceScope !== learned.persistenceScope
    ) return unavailable('CURATION_CONFLICT')
    if (rootBinding.value.state !== 'EXISTING' || candidate.path === undefined) {
      return unavailable('TARGET_FORMAT_UNSUPPORTED')
    }
    if (!samePath(candidate.path, target.skillFilePath)) {
      return unavailable('TARGET_FORMAT_UNSUPPORTED')
    }
    let base: ExactTextObservation
    try {
      base = await this.#publicationFacts.readExactText(candidate.path, MAX_BASE_BYTES)
    } catch {
      return unavailable('BASE_UNAVAILABLE')
    }
    if (base.status !== 'AVAILABLE' || Buffer.byteLength(base.text, 'utf8') > MAX_BASE_BYTES) {
      return unavailable('BASE_UNAVAILABLE')
    }
    return this.#materialize(item.workItemId, {
      ...commonFacts,
      kind: 'MERGE',
      actionBinding: {
        kind: 'MERGE',
        rootBinding: rootBinding.value,
        targetBinding: target.binding,
        baseBinding: {
          candidateKey: candidate.candidateKey,
          provider: candidate.provider,
          source: candidate.source,
          path: candidate.path,
          exactBytes: base.text,
          bytesDigest: sha256Utf8(base.text),
          catalogObservationDigest: learned.catalogObservationDigest,
          observedAt: createdAt,
        },
      },
    })
  }

  #resolveTarget(
    item: CaptureWorkItemV1,
    scope: 'PROJECT' | 'USER',
    name: string,
    observation: SkillRecallObservation,
  ):
    | {
      readonly root: SkillCatalogRootProjection
      readonly expectedRoot: string
      readonly bundlePath: string
      readonly skillFilePath: string
      readonly binding: { readonly skillName: string; readonly bundlePath: string; readonly skillFilePath: string }
    }
    | { readonly failureCode: ProposalBuildFailureCode } {
    if (observation.roots === undefined) return { failureCode: 'ROOT_OBSERVATION_UNAVAILABLE' }
    const base = scope === 'PROJECT'
      ? item.workspaceBinding.status === 'BOUND' ? item.workspaceBinding.canonicalPath : undefined
      : this.#effectiveDshHome
    if (base === undefined) return { failureCode: 'WORKSPACE_BINDING_UNAVAILABLE' }
    const source = scope === 'PROJECT' ? 'project-dsh' : 'user-dsh'
    const expectedRoot = scope === 'PROJECT' ? join(base, '.dsh', 'skills') : join(base, 'skills')
    const matches = observation.roots.filter(root => (
      root.provider === FILESYSTEM_PROVIDER
      && root.source === source
      && samePath(root.path, expectedRoot)
    ))
    if (matches.length !== 1) return { failureCode: 'ROOT_BINDING_AMBIGUOUS' }
    const bundlePath = join(expectedRoot, name)
    const skillFilePath = join(bundlePath, 'SKILL.md')
    return {
      root: matches[0]!,
      expectedRoot,
      bundlePath,
      skillFilePath,
      binding: { skillName: name, bundlePath, skillFilePath },
    }
  }

  async #bindRoot(
    root: SkillCatalogRootProjection,
    expectedRoot: string,
    scope: 'PROJECT' | 'USER',
    roots: readonly SkillCatalogRootProjection[],
  ): Promise<
    | { readonly value: RootBinding }
    | { readonly failureCode: ProposalBuildFailureCode }
  > {
    let observed: ObservedRoot
    try {
      observed = await this.#publicationFacts.observeRoot(root.path)
    } catch {
      return { failureCode: 'ROOT_OBSERVATION_UNAVAILABLE' }
    }
    if (observed.status === 'UNAVAILABLE') return { failureCode: 'ROOT_OBSERVATION_UNAVAILABLE' }
    const common = {
      scope,
      provider: FILESYSTEM_PROVIDER,
      source: (scope === 'PROJECT' ? 'project-dsh' : 'user-dsh') as 'project-dsh' | 'user-dsh',
      resolverVersion: ROOT_RESOLVER_VERSION,
      observationDigest: rootObservationDigest(roots),
      declaredRootPath: root.path,
    }
    if (observed.status === 'EXISTING') {
      if (!samePath(observed.canonicalRootPath, expectedRoot)) {
        return { failureCode: 'ROOT_BINDING_AMBIGUOUS' }
      }
      return { value: {
        ...common,
        state: 'EXISTING',
        canonicalRootPath: observed.canonicalRootPath,
        rootIdentityDigest: observed.rootIdentityDigest,
      } }
    }
    const allowedMissingSegments = scope === 'PROJECT'
      ? [['.dsh', 'skills'], ['skills']]
      : [['skills']]
    if (!allowedMissingSegments.some(allowed => sameOrdered(allowed, observed.missingSegments))) {
      return { failureCode: 'ROOT_BINDING_AMBIGUOUS' }
    }
    if (!samePath(join(observed.canonicalExistingAncestorPath, ...observed.missingSegments), expectedRoot)) {
      return { failureCode: 'ROOT_BINDING_AMBIGUOUS' }
    }
    return { value: {
      ...common,
      state: 'ABSENT',
      canonicalExistingAncestorPath: observed.canonicalExistingAncestorPath,
      ancestorIdentityDigest: observed.ancestorIdentityDigest,
      missingSegments: [...observed.missingSegments],
    } }
  }

  async #observeTargetEntries(
    bundlePath: string,
    skillFilePath: string,
  ): Promise<{ readonly ok: true } | { readonly failureCode: ProposalBuildFailureCode }> {
    let bundle: ObservedEntry
    let skillFile: ObservedEntry
    try {
      const observations = await Promise.all([
        this.#publicationFacts.observeEntry(bundlePath),
        this.#publicationFacts.observeEntry(skillFilePath),
      ])
      bundle = observations[0]
      skillFile = observations[1]
    } catch {
      return { failureCode: 'TARGET_FACTS_UNAVAILABLE' }
    }
    if (bundle.status === 'UNAVAILABLE' || skillFile.status === 'UNAVAILABLE') {
      return { failureCode: 'TARGET_FACTS_UNAVAILABLE' }
    }
    if (bundle.status !== 'ABSENT' || skillFile.status !== 'ABSENT') {
      return { failureCode: 'TARGET_ALREADY_EXISTS' }
    }
    return { ok: true }
  }

  #materialize(workItemId: string, facts: ProposalSnapshotFactsV1): ProposalBuildResult {
    try {
      return { status: 'READY', proposal: materializeProposalSnapshot(workItemId, facts) }
    } catch {
      return unavailable('CURATION_CONFLICT')
    }
  }
}
