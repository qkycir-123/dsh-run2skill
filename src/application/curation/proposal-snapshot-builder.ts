import { join, normalize } from 'node:path'
import {
  canLoadedCandidateCoverScope,
  recallExistingSkills,
  type LoadedSkillCandidate,
  type SkillCatalogPort,
  type SkillRecallObservation,
} from '../../domain/learn/index.js'
import type { CaptureWorkItemV1 } from '../../domain/observe/schemas.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import { preprocessPersistentText } from '../../domain/observe/redaction.js'
import {
  ROOT_CONTRACT_VERSION_V2,
  ROOT_RESOLVER_VERSION_V2,
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

export type WorkspaceRevalidation =
  | { readonly status: 'BOUND'; readonly workspaceId: string; readonly canonicalPath: string }
  | { readonly status: 'UNREGISTERED' | 'UNAVAILABLE' }

export interface WorkspaceRevalidationPort {
  resolve(path: string): Promise<WorkspaceRevalidation>
}

export interface RootContractResolutionProjection {
  readonly status: 'SUPPORTED'
  readonly expectedProvider: 'filesystem'
  readonly expectedSource: 'project-dsh' | 'user-dsh'
  readonly resolverVersion: typeof ROOT_RESOLVER_VERSION_V2
  readonly rootContractVersion: typeof ROOT_CONTRACT_VERSION_V2
  readonly declaredRootPath: string
  readonly dshHome?: {
    readonly resolutionKind: 'CONFIGURATION' | 'ENVIRONMENT' | 'DEFAULT'
    readonly declaredPath: string
  } | undefined
}

export type RootContractScopeIdentity =
  | { readonly kind: 'WORKSPACE'; readonly workspaceId: string; readonly canonicalPath: string }
  | {
    readonly kind: 'DSH_HOME'
    readonly resolutionKind: 'CONFIGURATION' | 'ENVIRONMENT' | 'DEFAULT'
    readonly canonicalPath: string
    readonly identityDigest: string
  }

export interface PublicationRootContractPort<TView extends object> {
  resolve(input: {
    readonly scope: 'PROJECT' | 'USER'
    readonly workspaceBinding?: { readonly workspaceId: string; readonly canonicalPath: string } | undefined
    readonly view: TView
  }): RootContractResolutionProjection | {
    readonly status: 'UNSUPPORTED'
    readonly code: 'ROOT_CONTRACT_UNSUPPORTED' | 'WORKSPACE_BINDING_UNAVAILABLE'
  }
  deriveResolutionContractDigest(
    resolution: RootContractResolutionProjection,
    identity: RootContractScopeIdentity,
  ): string
}

export type ProposalBuildFailureCode =
  | 'CATALOG_INCOMPLETE'
  | 'CATALOG_CHANGED'
  | 'ROOT_OBSERVATION_UNAVAILABLE'
  | 'ROOT_CONTRACT_UNSUPPORTED'
  | 'ROOT_BINDING_AMBIGUOUS'
  | 'WORKSPACE_BINDING_UNAVAILABLE'
  | 'DSH_HOME_BINDING_UNAVAILABLE'
  | 'CANDIDATE_UNAVAILABLE'
  | 'CURATION_CONFLICT'
  | 'TARGET_FACTS_UNAVAILABLE'
  | 'TARGET_ALREADY_EXISTS'
  | 'TARGET_FORMAT_UNSUPPORTED'
  | 'BASE_UNAVAILABLE'
  | 'UNSAFE_SKILL'
  | 'APPROVAL_FACTS_CHANGED'

export type ProposalBuildResult =
  | { readonly status: 'READY'; readonly proposal: ProposalSnapshotV1 }
  | { readonly status: 'UNAVAILABLE'; readonly failureCode: ProposalBuildFailureCode }

export type RootContractRevalidationResult =
  | { readonly status: 'VALID' }
  | { readonly status: 'UNAVAILABLE'; readonly failureCode: ProposalBuildFailureCode }

export interface ProposalSnapshotBuilderOptions<TView extends object> {
  readonly now?: () => string
  readonly rootContract?: PublicationRootContractPort<TView>
}

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

function candidateFor(
  observation: SkillRecallObservation,
  candidateKey: string | undefined,
): LoadedSkillCandidate | undefined {
  return observation.candidates.find(candidate => candidate.candidateKey === candidateKey)
}

export class ProposalSnapshotBuilder<TView extends object> {
  readonly #skills: SkillCatalogPort<TView>
  readonly #publicationFacts: PublicationFactsPort
  readonly #workspaces: WorkspaceRevalidationPort
  readonly #now: () => string
  readonly #rootContract: PublicationRootContractPort<TView> | undefined

  constructor(
    skills: SkillCatalogPort<TView>,
    publicationFacts: PublicationFactsPort,
    workspaces: WorkspaceRevalidationPort,
    options: ProposalSnapshotBuilderOptions<TView> = {},
  ) {
    this.#skills = skills
    this.#publicationFacts = publicationFacts
    this.#workspaces = workspaces
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#rootContract = options.rootContract
  }

  async build(item: CaptureWorkItemV1, view: TView): Promise<ProposalBuildResult> {
    if (item.processingState !== 'LEARNED' || item.learning?.proposal === undefined) {
      return unavailable('CURATION_CONFLICT')
    }
    return await this.#build(item, view)
  }

  async revalidateApproved(item: CaptureWorkItemV1, view: TView): Promise<ProposalBuildResult> {
    const approved = item.review?.proposal
    if (
      item.processingState !== 'PUBLISHING'
      || item.review?.reviewDecision !== 'APPROVED'
      || item.review.publicationOutcome !== 'PENDING_REVIEW'
      || item.learning?.proposal === undefined
      || approved === undefined
      || approved.actionBinding.kind === 'DISCARD'
    ) return unavailable('CURATION_CONFLICT')
    return await this.#build(item, view, approved)
  }

  async revalidateApprovedRootContract(
    item: CaptureWorkItemV1,
    view: TView,
  ): Promise<RootContractRevalidationResult> {
    const approved = item.review?.proposal
    if (
      item.processingState !== 'PUBLISHING'
      || item.review?.reviewDecision !== 'APPROVED'
      || item.review.publicationOutcome !== 'PENDING_REVIEW'
      || item.learning?.proposal === undefined
      || approved === undefined
      || approved.actionBinding.kind === 'DISCARD'
    ) return { status: 'UNAVAILABLE', failureCode: 'CURATION_CONFLICT' }
    const workspaceBinding = await this.#revalidateWorkspace(
      item,
      item.learning.proposal.persistenceScope,
      approved.createdAt,
    )
    if ('failureCode' in workspaceBinding) {
      return { status: 'UNAVAILABLE', failureCode: workspaceBinding.failureCode }
    }
    const contract = await this.#resolveRootContract(
      item.learning.proposal.persistenceScope,
      workspaceBinding.value,
      view,
      approved.createdAt,
    )
    if ('failureCode' in contract) {
      return { status: 'UNAVAILABLE', failureCode: contract.failureCode }
    }
    const approvedRoot = approved.actionBinding.rootBinding
    return contract.resolutionContractDigest === approvedRoot.resolutionContractDigest
      && samePath(contract.resolution.declaredRootPath, approvedRoot.declaredRootPath)
      ? { status: 'VALID' }
      : { status: 'UNAVAILABLE', failureCode: 'APPROVAL_FACTS_CHANGED' }
  }

  async #build(
    item: CaptureWorkItemV1,
    view: TView,
    approved?: ProposalSnapshotV1,
  ): Promise<ProposalBuildResult> {
    const learned = item.learning!.proposal!
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

    const createdAt = approved?.createdAt ?? this.#now()
    const workspaceBinding = await this.#revalidateWorkspace(item, learned.persistenceScope, createdAt)
    if ('failureCode' in workspaceBinding) return unavailable(workspaceBinding.failureCode)
    const exactSkillBytes = renderCanonicalSkill(learned)
    if (
      hasFormatControls(exactSkillBytes)
      || !MARKDOWN_HEADING.test(learned.content)
      || preprocessPersistentText(exactSkillBytes).redactionKinds.length > 0
    ) {
      return unavailable('UNSAFE_SKILL')
    }

    const commonFacts = {
      schemaVersion: 1 as const,
      revision: approved?.revision ?? 1,
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
      ...(workspaceBinding.value === undefined ? {} : { workspaceBinding: workspaceBinding.value }),
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
      }, approved)
    }

    const contract = await this.#resolveRootContract(
      learned.persistenceScope,
      workspaceBinding.value,
      view,
      createdAt,
    )
    if ('failureCode' in contract) return unavailable(contract.failureCode)
    const writableFacts = {
      ...commonFacts,
      ...(contract.dshHomeBinding === undefined ? {} : { dshHomeBinding: contract.dshHomeBinding }),
    }

    const approvedRoot = approved?.actionBinding.kind === 'CREATE' || approved?.actionBinding.kind === 'MERGE'
      ? approved.actionBinding.rootBinding
      : undefined
    const target = this.#resolveTarget(
      learned.name,
      contract.resolution.declaredRootPath,
    )
    const rootBinding = await this.#bindRoot(
      target.expectedRoot,
      learned.persistenceScope,
      contract.resolution,
      contract.resolutionContractDigest,
      approvedRoot,
    )
    if ('failureCode' in rootBinding) return unavailable(rootBinding.failureCode)

    if (learned.curation.decision === 'CREATE') {
      if (observation.catalogSkills.some(skill => skill.name === learned.name)) {
        return unavailable('CURATION_CONFLICT')
      }
      const entries = await this.#observeTargetEntries(
        target.bundlePath,
        target.skillFilePath,
        target.flatSkillFilePath,
      )
      if ('failureCode' in entries) return unavailable(entries.failureCode)
      return this.#materialize(item.workItemId, {
        ...writableFacts,
        kind: 'CREATE',
        actionBinding: {
          kind: 'CREATE',
          rootBinding: rootBinding.value,
          targetBinding: target.binding,
          expectedAbsence: {
            catalogObservationDigest: learned.catalogObservationDigest,
            observedAt: createdAt,
            flatSkillFilePath: target.flatSkillFilePath,
            bundlePathAbsent: true,
            skillFilePathAbsent: true,
            flatSkillFilePathAbsent: true,
          },
        },
      }, approved)
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
    if (
      hasFormatControls(base.text)
      || preprocessPersistentText(base.text).redactionKinds.length > 0
    ) return unavailable('UNSAFE_SKILL')
    return this.#materialize(item.workItemId, {
      ...writableFacts,
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
    }, approved)
  }

  #resolveTarget(
    name: string,
    expectedRoot: string,
  ): {
    readonly expectedRoot: string
    readonly bundlePath: string
    readonly skillFilePath: string
    readonly flatSkillFilePath: string
    readonly binding: { readonly skillName: string; readonly bundlePath: string; readonly skillFilePath: string }
  } {
    const bundlePath = join(expectedRoot, name)
    const skillFilePath = join(bundlePath, 'SKILL.md')
    const flatSkillFilePath = join(expectedRoot, `${name}.md`)
    return {
      expectedRoot,
      bundlePath,
      skillFilePath,
      flatSkillFilePath,
      binding: { skillName: name, bundlePath, skillFilePath },
    }
  }

  async #bindRoot(
    expectedRoot: string,
    scope: 'PROJECT' | 'USER',
    contract: RootContractResolutionProjection,
    resolutionContractDigest: string,
    approved?: RootBinding,
  ): Promise<
    | { readonly value: RootBinding }
    | { readonly failureCode: ProposalBuildFailureCode }
  > {
    let observed: ObservedRoot
    try {
      observed = await this.#publicationFacts.observeRoot(expectedRoot)
    } catch {
      return { failureCode: 'ROOT_OBSERVATION_UNAVAILABLE' }
    }
    if (observed.status === 'UNAVAILABLE') return { failureCode: 'ROOT_OBSERVATION_UNAVAILABLE' }
    const common = {
      scope,
      expectedProvider: contract.expectedProvider,
      expectedSource: contract.expectedSource,
      resolverVersion: contract.resolverVersion,
      rootContractVersion: contract.rootContractVersion,
      resolutionContractDigest,
      declaredRootPath: contract.declaredRootPath,
    }
    if (approved !== undefined && (
      approved.scope !== common.scope
      || approved.expectedProvider !== common.expectedProvider
      || approved.expectedSource !== common.expectedSource
      || approved.resolverVersion !== common.resolverVersion
      || approved.rootContractVersion !== common.rootContractVersion
      || approved.resolutionContractDigest !== common.resolutionContractDigest
      || !samePath(approved.declaredRootPath, common.declaredRootPath)
    )) return { failureCode: 'ROOT_BINDING_AMBIGUOUS' }
    if (observed.status === 'EXISTING') {
      if (!samePath(observed.canonicalRootPath, expectedRoot)) {
        return { failureCode: 'ROOT_BINDING_AMBIGUOUS' }
      }
      if (approved?.state === 'ABSENT') {
        return { value: approved }
      }
      const current: RootBinding = {
        ...common,
        state: 'EXISTING',
        canonicalRootPath: observed.canonicalRootPath,
        rootIdentityDigest: observed.rootIdentityDigest,
      }
      if (
        approved?.state === 'EXISTING'
        && (
          !samePath(approved.canonicalRootPath, current.canonicalRootPath)
          || approved.rootIdentityDigest !== current.rootIdentityDigest
        )
      ) return { failureCode: 'ROOT_BINDING_AMBIGUOUS' }
      return { value: approved ?? current }
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
    const current: RootBinding = {
      ...common,
      state: 'ABSENT',
      canonicalExistingAncestorPath: observed.canonicalExistingAncestorPath,
      ancestorIdentityDigest: observed.ancestorIdentityDigest,
      missingSegments: [...observed.missingSegments],
    }
    if (approved !== undefined) {
      if (approved.state !== 'ABSENT') return { failureCode: 'ROOT_BINDING_AMBIGUOUS' }
      const remaining = approved.missingSegments.slice(-observed.missingSegments.length)
      if (
        !sameOrdered(remaining, observed.missingSegments)
        || !samePath(
          join(approved.canonicalExistingAncestorPath, ...approved.missingSegments),
          expectedRoot,
        )
      ) return { failureCode: 'ROOT_BINDING_AMBIGUOUS' }
      return { value: approved }
    }
    return { value: current }
  }

  async #resolveRootContract(
    scope: 'PROJECT' | 'USER',
    workspaceBinding: {
      readonly workspaceId: string
      readonly canonicalPath: string
      readonly observedAt: string
    } | undefined,
    view: TView,
    observedAt: string,
  ): Promise<
    | {
      readonly resolution: RootContractResolutionProjection
      readonly resolutionContractDigest: string
      readonly dshHomeBinding?: {
        readonly resolutionKind: 'CONFIGURATION' | 'ENVIRONMENT' | 'DEFAULT'
        readonly canonicalPath: string
        readonly identityDigest: string
        readonly observedAt: string
      } | undefined
    }
    | { readonly failureCode: ProposalBuildFailureCode }
  > {
    if (this.#rootContract === undefined) return { failureCode: 'ROOT_CONTRACT_UNSUPPORTED' }
    const resolution = this.#rootContract.resolve({
      scope,
      ...(workspaceBinding === undefined
        ? {}
        : { workspaceBinding: {
            workspaceId: workspaceBinding.workspaceId,
            canonicalPath: workspaceBinding.canonicalPath,
          } }),
      view,
    })
    if (resolution.status === 'UNSUPPORTED') return { failureCode: resolution.code }
    let identity: RootContractScopeIdentity
    let dshHomeBinding: {
      readonly resolutionKind: 'CONFIGURATION' | 'ENVIRONMENT' | 'DEFAULT'
      readonly canonicalPath: string
      readonly identityDigest: string
      readonly observedAt: string
    } | undefined
    if (scope === 'PROJECT') {
      if (workspaceBinding === undefined) return { failureCode: 'WORKSPACE_BINDING_UNAVAILABLE' }
      identity = {
        kind: 'WORKSPACE',
        workspaceId: workspaceBinding.workspaceId,
        canonicalPath: workspaceBinding.canonicalPath,
      }
    } else {
      const home = resolution.dshHome
      if (home === undefined) return { failureCode: 'DSH_HOME_BINDING_UNAVAILABLE' }
      let observedHome: ObservedRoot
      try {
        observedHome = await this.#publicationFacts.observeRoot(home.declaredPath)
      } catch {
        return { failureCode: 'DSH_HOME_BINDING_UNAVAILABLE' }
      }
      if (
        observedHome.status !== 'EXISTING'
        || !samePath(observedHome.canonicalRootPath, home.declaredPath)
      ) return { failureCode: 'DSH_HOME_BINDING_UNAVAILABLE' }
      dshHomeBinding = {
        resolutionKind: home.resolutionKind,
        canonicalPath: observedHome.canonicalRootPath,
        identityDigest: observedHome.rootIdentityDigest,
        observedAt,
      }
      identity = {
        kind: 'DSH_HOME',
        resolutionKind: home.resolutionKind,
        canonicalPath: observedHome.canonicalRootPath,
        identityDigest: observedHome.rootIdentityDigest,
      }
    }
    return {
      resolution,
      resolutionContractDigest: this.#rootContract.deriveResolutionContractDigest(resolution, identity),
      ...(dshHomeBinding === undefined ? {} : { dshHomeBinding }),
    }
  }

  async #observeTargetEntries(
    bundlePath: string,
    skillFilePath: string,
    flatSkillFilePath: string,
  ): Promise<{ readonly ok: true } | { readonly failureCode: ProposalBuildFailureCode }> {
    let bundle: ObservedEntry
    let skillFile: ObservedEntry
    let flatSkillFile: ObservedEntry
    try {
      const observations = await Promise.all([
        this.#publicationFacts.observeEntry(bundlePath),
        this.#publicationFacts.observeEntry(skillFilePath),
        this.#publicationFacts.observeEntry(flatSkillFilePath),
      ])
      bundle = observations[0]
      skillFile = observations[1]
      flatSkillFile = observations[2]
    } catch {
      return { failureCode: 'TARGET_FACTS_UNAVAILABLE' }
    }
    if (
      bundle.status === 'UNAVAILABLE'
      || skillFile.status === 'UNAVAILABLE'
      || flatSkillFile.status === 'UNAVAILABLE'
    ) {
      return { failureCode: 'TARGET_FACTS_UNAVAILABLE' }
    }
    if (
      bundle.status !== 'ABSENT'
      || skillFile.status !== 'ABSENT'
      || flatSkillFile.status !== 'ABSENT'
    ) {
      return { failureCode: 'TARGET_ALREADY_EXISTS' }
    }
    return { ok: true }
  }

  async #revalidateWorkspace(
    item: CaptureWorkItemV1,
    scope: 'PROJECT' | 'USER',
    observedAt: string,
  ): Promise<
    | { readonly value: { readonly workspaceId: string; readonly canonicalPath: string; readonly observedAt: string } | undefined }
    | { readonly failureCode: ProposalBuildFailureCode }
  > {
    if (scope === 'USER') return { value: undefined }
    if (item.workspaceBinding.status !== 'BOUND') {
      return { failureCode: 'WORKSPACE_BINDING_UNAVAILABLE' }
    }
    let current: WorkspaceRevalidation
    try {
      current = await this.#workspaces.resolve(item.workspaceBinding.canonicalPath)
    } catch {
      return { failureCode: 'WORKSPACE_BINDING_UNAVAILABLE' }
    }
    if (
      current.status !== 'BOUND'
      || current.workspaceId !== item.workspaceBinding.workspaceId
      || current.canonicalPath !== item.workspaceBinding.canonicalPath
    ) return { failureCode: 'WORKSPACE_BINDING_UNAVAILABLE' }
    return {
      value: {
        workspaceId: current.workspaceId,
        canonicalPath: current.canonicalPath,
        observedAt,
      },
    }
  }

  #materialize(
    workItemId: string,
    facts: ProposalSnapshotFactsV1,
    approved?: ProposalSnapshotV1,
  ): ProposalBuildResult {
    try {
      const proposal = materializeProposalSnapshot(workItemId, facts)
      if (approved !== undefined && JSON.stringify(proposal) !== JSON.stringify(approved)) {
        return unavailable('APPROVAL_FACTS_CHANGED')
      }
      return { status: 'READY', proposal }
    } catch {
      return unavailable('CURATION_CONFLICT')
    }
  }
}
