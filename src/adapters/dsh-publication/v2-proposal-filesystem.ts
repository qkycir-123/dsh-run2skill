import { join, normalize, posix, resolve, win32 } from 'node:path'
import { z } from 'zod'
import type {
  V2ProposalPublicationInput,
  V2ProposalPublicationOutcome,
  V2ProposalPublicationRecoveryOutcome,
} from '../../application/publication/index.js'
import { parseCanonicalSkillBody } from '../../application/curation/index.js'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import { RootBindingV2Schema, type RootBindingV2 } from '../../domain/review/index.js'
import { deriveCreateTargetDigestV2 } from '../../domain/v2/index.js'
import type { DshSkillRegistryPort } from '../dsh-skills/skill-catalog.js'
import {
  parseWritableDshContextFileSystem,
  readStableContextFile,
  type DshContextFileSystemPublicationPolicy,
  type DshContextFileSystemTarget,
  type DshWritableContextFileSystemPort,
} from '../dsh-filesystem/context-filesystem.js'
import {
  PublicationConflict,
  createBundle,
  finalizeTransaction,
  mergeBundle,
  observePublicationEntry,
  preparePublicationRoot,
  readPublicationText,
  recoverTransaction,
  verifyFinalizedTransaction,
  verifyPublicationDirectoryIdentity,
  withdrawWrittenCreate,
} from './filesystem-cas.mjs'

const runtimeSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  whenToUse: z.string().optional(),
  source: z.string(),
  provider: z.string(),
  path: z.string().optional(),
  invocation: z.object({ modelInvocable: z.boolean(), userInvocable: z.boolean() }).strict().optional(),
}).passthrough()
const runtimeSnapshotSchema = z.object({
  complete: z.boolean(),
  skills: z.array(runtimeSummarySchema).max(1024),
}).passthrough()
const runtimeDefinitionSchema = runtimeSummarySchema.safeExtend({ content: z.string() }).passthrough()

export interface V2DshPublicationBinding<TView extends object> {
  readonly rootBinding: RootBindingV2
  readonly view: TView
  readonly filesystem?: DshWritableContextFileSystemPort | undefined
  readonly rootTarget?: DshContextFileSystemTarget | undefined
  readonly publicationPolicy?: DshContextFileSystemPublicationPolicy | undefined
}

export type V2DshPublicationBindingResult<TView extends object> =
  | ({ readonly status: 'READY' } & V2DshPublicationBinding<TView>)
  | { readonly status: 'STALE' | 'UNAVAILABLE' }

export interface V2DshPublicationBindingPort<TView extends object> {
  resolve(input: V2ProposalPublicationInput): Promise<V2DshPublicationBindingResult<TView>>
}

export interface DshV2ProposalFileSystemOptions<TView extends object> {
  readonly bindings: V2DshPublicationBindingPort<TView>
  readonly registry: DshSkillRegistryPort<TView>
  readonly refreshView?: (view: TView) => TView
  readonly readbackAttempts?: number
  readonly wait?: (milliseconds: number) => Promise<void>
}

function samePath(left: string | undefined, right: string): boolean {
  if (left === undefined) return false
  const a = normalize(resolve(left))
  const b = normalize(resolve(right))
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function providerJoin(root: string, ...segments: string[]): string {
  const api = /^[a-zA-Z]:[\\/]/u.test(root) || root.includes('\\') ? win32 : posix
  return api.join(root, ...segments)
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function validContextTarget(value: unknown): value is DshContextFileSystemTarget {
  return typeof value === 'object' && value !== null
    && 'targetKey' in value && typeof value.targetKey === 'string' && value.targetKey.length > 0
    && 'displayPath' in value && typeof value.displayPath === 'string'
}

function signalFromView(view: object): AbortSignal | undefined {
  return 'signal' in view && view.signal instanceof AbortSignal ? view.signal : undefined
}

function sameRootContract(
  left: RootBindingV2,
  right: RootBindingV2,
  canonicalRoot: string,
  rootIdentityDigest: string,
): boolean {
  return left.scope === right.scope
    && left.expectedProvider === right.expectedProvider
    && left.expectedSource === right.expectedSource
    && left.resolverVersion === right.resolverVersion
    && left.rootContractVersion === right.rootContractVersion
    && left.resolutionContractDigest === right.resolutionContractDigest
    && samePath(left.declaredRootPath, right.declaredRootPath)
    && right.state === 'EXISTING'
    && samePath(right.canonicalRootPath, canonicalRoot)
    && right.rootIdentityDigest === rootIdentityDigest
    && (left.state !== 'EXISTING' || left.rootIdentityDigest === rootIdentityDigest)
}

/**
 * Executes one v2 Proposal against the hardened filesystem CAS and confirms
 * the exact DSH Runtime winner before returning PUBLISHED. Any result whose
 * disk outcome cannot be proven remains UNAVAILABLE so the coordinator keeps
 * the same durable attemptId.
 */
export class DshV2ProposalFileSystemAdapter<TView extends object> {
  readonly #refreshView: (view: TView) => TView
  readonly #attempts: number
  readonly #wait: (milliseconds: number) => Promise<void>
  readonly #contextPublished = new Map<string, V2ProposalPublicationOutcome>()

  constructor(private readonly options: DshV2ProposalFileSystemOptions<TView>) {
    this.#refreshView = options.refreshView ?? (view => view)
    this.#attempts = options.readbackAttempts ?? 5
    if (!Number.isSafeInteger(this.#attempts) || this.#attempts < 1 || this.#attempts > 5) {
      throw new TypeError('v2 publication readback attempts must be between 1 and 5')
    }
    this.#wait = options.wait ?? (async milliseconds => {
      await new Promise(resolveWait => setTimeout(resolveWait, milliseconds))
    })
  }

  async publish(
    input: V2ProposalPublicationInput & { readonly attemptId: string },
  ): Promise<V2ProposalPublicationOutcome> {
    const outcome = await this.#execute(input, true)
    return outcome.status === 'ABSENT' ? { status: 'UNAVAILABLE' } : outcome
  }

  async recover(
    input: V2ProposalPublicationInput & { readonly attemptId: string },
  ): Promise<V2ProposalPublicationRecoveryOutcome> {
    return await this.#execute(input, false)
  }

  async #execute(
    input: V2ProposalPublicationInput & { readonly attemptId: string },
    allowNewWrite: boolean,
  ): Promise<V2ProposalPublicationRecoveryOutcome> {
    let expectedBody: string
    try {
      expectedBody = parseCanonicalSkillBody(input.proposal.body.exactSkillBytes)
    } catch {
      return { status: 'CONFLICT' }
    }
    if (
      input.proposal.action === 'CREATE'
      && input.proposal.targetIdentityDigest !== deriveCreateTargetDigestV2({
        persistenceScope: input.lineage.persistenceScope,
        behaviorSignature: input.lineage.behaviorSignature,
      })
    ) return { status: 'CONFLICT' }
    if (input.proposal.action === 'MERGE' && input.proposal.targetIdentityDigest === undefined) {
      return { status: 'CONFLICT' }
    }
    if (input.proposal.action === 'MERGE' && input.proposal.baseSkillBytesDigest === undefined) {
      return { status: 'CONFLICT' }
    }

    const binding = await this.#binding(input)
    if (binding.status !== 'READY') return binding
    if (binding.filesystem !== undefined || binding.rootTarget !== undefined || binding.publicationPolicy !== undefined) {
      return await this.#executeContextFileSystem(input, binding, expectedBody, allowNewWrite)
    }
    const root = binding.rootBinding.declaredRootPath
    const target = join(root, input.proposal.body.name, 'SKILL.md')
    const flatTarget = join(root, `${input.proposal.body.name}.md`)
    const transactionId = `v2-${sha256Utf8(input.attemptId)}`
    let preparation
    try {
      preparation = await preparePublicationRoot({
        binding: binding.rootBinding,
        verifyIdentity: verifyPublicationDirectoryIdentity,
        verifyParity: async (approved, canonicalRoot, rootIdentityDigest) => {
          const current = await this.#binding(input)
          return current.status === 'READY'
            && sameRootContract(approved, current.rootBinding, canonicalRoot, rootIdentityDigest)
        },
      })
    } catch {
      return { status: 'UNAVAILABLE' }
    }

    try {
      const exactBefore = await readPublicationText(target, 64 * 1024)
      if (
        exactBefore.status === 'AVAILABLE'
        && sha256Utf8(exactBefore.text) === input.proposal.body.skillBytesDigest
        && await this.#confirmRuntime(input, binding, target, expectedBody)
        && await verifyFinalizedTransaction({
          root,
          name: input.proposal.body.name,
          txid: transactionId,
          expectedHash: input.proposal.body.skillBytesDigest,
          expectedRootIdentityDigest: preparation.rootIdentityDigest,
          requireFinalizedJournal: true,
        })
      ) return this.#publishedReceipt(input, binding, target)

      let recovered
      try {
        recovered = await recoverTransaction({ root, txid: transactionId })
      } catch (error) {
        if (!(error instanceof PublicationConflict) || error.code !== 'journal_missing') throw error
        if (!allowNewWrite) return { status: 'ABSENT' }
      }
      if (recovered?.status === 'conflict') return { status: 'CONFLICT' }
      if (recovered?.status === 'finalized') {
        let matchesCurrentProposal = false
        try {
          matchesCurrentProposal = await verifyFinalizedTransaction({
            root,
            name: input.proposal.body.name,
            txid: transactionId,
            expectedHash: input.proposal.body.skillBytesDigest,
            expectedRootIdentityDigest: preparation.rootIdentityDigest,
            requireFinalizedJournal: true,
          })
        } catch {
          return { status: 'UNAVAILABLE' }
        }
        if (!matchesCurrentProposal) return { status: 'CONFLICT' }
        return await this.#confirmRuntime(input, binding, target, expectedBody)
          ? this.#publishedReceipt(input, binding, target)
          : { status: 'UNAVAILABLE' }
      }

      if (recovered?.status !== 'written') {
        if (!allowNewWrite) return { status: 'ABSENT' }
        if (input.proposal.action === 'CREATE') {
          if ((await observePublicationEntry(flatTarget)).status !== 'ABSENT') return { status: 'CONFLICT' }
          recovered = await createBundle({
            root,
            name: input.proposal.body.name,
            txid: transactionId,
            nextBytes: input.proposal.body.exactSkillBytes,
            rootPreparation: preparation,
          })
        } else {
          const base = await readPublicationText(target, 64 * 1024)
          if (base.status !== 'AVAILABLE') return { status: 'CONFLICT' }
          let baseBody: string
          try {
            baseBody = parseCanonicalSkillBody(base.text)
          } catch {
            return { status: 'CONFLICT' }
          }
          if (sha256Utf8(baseBody) !== input.proposal.targetIdentityDigest) {
            return { status: 'CONFLICT' }
          }
          if (sha256Utf8(base.text) !== input.proposal.baseSkillBytesDigest) {
            return { status: 'CONFLICT' }
          }
          recovered = await mergeBundle({
            root,
            name: input.proposal.body.name,
            txid: transactionId,
            expectedHash: input.proposal.baseSkillBytesDigest,
            nextBytes: input.proposal.body.exactSkillBytes,
            rootPreparation: preparation,
          })
        }
      }
      if (recovered.status === 'conflict') return { status: 'CONFLICT' }
      if (recovered.status !== 'written') return { status: 'UNAVAILABLE' }
      const runtimeConfirmed = await this.#confirmRuntime(input, binding, target, expectedBody)
      if (
        input.proposal.action === 'CREATE'
        && (await observePublicationEntry(flatTarget)).status !== 'ABSENT'
      ) {
        const withdrawn = await withdrawWrittenCreate({ root, txid: transactionId })
        return withdrawn.status === 'conflict' ? { status: 'CONFLICT' } : { status: 'UNAVAILABLE' }
      }
      if (!runtimeConfirmed) return { status: 'UNAVAILABLE' }
      const finalized = await finalizeTransaction({
        root,
        txid: transactionId,
        confirmedExactReadback: true,
      })
      if (finalized.status === 'conflict') return { status: 'UNAVAILABLE' }
      if (finalized.status !== 'finalized') return { status: 'UNAVAILABLE' }
      return this.#publishedReceipt(input, binding, target)
    } catch {
      return { status: 'UNAVAILABLE' }
    }
  }

  async #executeContextFileSystem(
    input: V2ProposalPublicationInput & { readonly attemptId: string },
    binding: V2DshPublicationBinding<TView>,
    expectedBody: string,
    allowNewWrite: boolean,
  ): Promise<V2ProposalPublicationRecoveryOutcome> {
    const attemptKey = sha256Utf8(canonicalJson({
      attemptId: input.attemptId,
      proposalId: input.proposalRef.proposalId,
      skillBytesDigest: input.proposal.body.skillBytesDigest,
    }))
    const completed = this.#contextPublished.get(attemptKey)
    if (completed !== undefined) return completed
    const filesystem = parseWritableDshContextFileSystem(binding.filesystem)
    const rootTarget = binding.rootTarget
    const policy = binding.publicationPolicy
    if (filesystem === undefined || !validContextTarget(rootTarget) || policy === undefined) {
      return { status: 'UNAVAILABLE' }
    }
    const signal = signalFromView(binding.view)
    const root = binding.rootBinding.declaredRootPath
    const bundlePath = providerJoin(root, input.proposal.body.name)
    const targetPath = providerJoin(bundlePath, 'SKILL.md')
    const flatPath = providerJoin(root, `${input.proposal.body.name}.md`)
    try {
      const resolvedRoot = await filesystem.resolve(root, { signal })
      if (
        resolvedRoot.targetKey !== rootTarget.targetKey
        || filesystem.processPath(resolvedRoot) !== policy.workspaceRoot
      ) return { status: 'STALE' }
      const target = await filesystem.resolve(targetPath, { signal })
      const flatTarget = await filesystem.resolve(flatPath, { signal })
      if (!filesystem.contains(rootTarget, target) || !filesystem.contains(rootTarget, flatTarget)) {
        return { status: 'CONFLICT' }
      }
      const flat = await filesystem.lstat(flatPath, undefined, signal)
      if (flat !== undefined) return { status: 'CONFLICT' }
      const bundle = await filesystem.lstat(bundlePath, undefined, signal)
      if (bundle !== undefined && bundle.type !== 'directory') return { status: 'CONFLICT' }

      const current = await readStableContextFile(filesystem, targetPath, {
        signal,
        maxBytes: 64 * 1024,
        containWithin: rootTarget,
      })
      const currentBytes = current === undefined ? undefined : Buffer.from(current.bytes).toString('utf8')
      if (!allowNewWrite) {
        if (current === undefined || currentBytes === undefined) return { status: 'ABSENT' }
        if (sha256Utf8(currentBytes) !== input.proposal.body.skillBytesDigest) {
          return { status: 'CONFLICT' }
        }
        if (!await this.#confirmRuntime(
          input,
          binding,
          filesystem.processPath(current.target),
          expectedBody,
        )) return { status: 'UNAVAILABLE' }
        const outcome = this.#contextPublishedReceipt(input, binding, current.target)
        this.#contextPublished.set(attemptKey, outcome)
        return outcome
      }

      let expected: { readonly kind: 'createIfAbsent' } | { readonly kind: 'replaceIfVersion'; readonly version: string }
      if (input.proposal.action === 'CREATE') {
        if (current !== undefined) return { status: 'CONFLICT' }
        expected = { kind: 'createIfAbsent' }
      } else {
        const mergeCurrent = current
        if (mergeCurrent === undefined || currentBytes === undefined) return { status: 'CONFLICT' }
        let baseBody: string
        try {
          baseBody = parseCanonicalSkillBody(currentBytes)
        } catch {
          return { status: 'CONFLICT' }
        }
        if (
          sha256Utf8(baseBody) !== input.proposal.targetIdentityDigest
          || sha256Utf8(currentBytes) !== input.proposal.baseSkillBytesDigest
        ) return { status: 'CONFLICT' }
        expected = { kind: 'replaceIfVersion', version: mergeCurrent.version }
      }

      try {
        await filesystem.writeText(
          target,
          input.proposal.body.exactSkillBytes,
          expected,
          signal,
          policy,
        )
      } catch (error) {
        const code = errorCode(error)
        return code === 'FS_NOT_OBSERVED' || code === 'FS_STALE_VERSION'
          ? { status: 'CONFLICT' }
          : { status: 'UNAVAILABLE' }
      }
      const after = await readStableContextFile(filesystem, targetPath, {
        signal,
        maxBytes: 64 * 1024,
        containWithin: rootTarget,
      })
      if (
        after === undefined
        || sha256Utf8(Buffer.from(after.bytes).toString('utf8')) !== input.proposal.body.skillBytesDigest
        || await filesystem.lstat(flatPath, undefined, signal) !== undefined
      ) return { status: 'CONFLICT' }
      if (!await this.#confirmRuntime(
        input,
        binding,
        filesystem.processPath(after.target),
        expectedBody,
      )) return { status: 'UNAVAILABLE' }
      const outcome = this.#contextPublishedReceipt(input, binding, after.target)
      this.#contextPublished.set(attemptKey, outcome)
      return outcome
    } catch {
      return { status: 'UNAVAILABLE' }
    }
  }

  async #binding(input: V2ProposalPublicationInput): Promise<V2DshPublicationBindingResult<TView>> {
    let raw: V2DshPublicationBindingResult<TView>
    try {
      raw = await this.options.bindings.resolve(input)
    } catch {
      return { status: 'UNAVAILABLE' }
    }
    if (raw.status !== 'READY') return raw
    const rootBinding = RootBindingV2Schema.safeParse(raw.rootBinding)
    if (!rootBinding.success || rootBinding.data.scope !== input.lineage.persistenceScope) {
      return { status: 'STALE' }
    }
    const contextFields = raw.filesystem !== undefined || raw.rootTarget !== undefined || raw.publicationPolicy !== undefined
    if (!contextFields) return { status: 'READY', rootBinding: rootBinding.data, view: raw.view }
    const filesystem = parseWritableDshContextFileSystem(raw.filesystem)
    if (filesystem === undefined || !validContextTarget(raw.rootTarget) || raw.publicationPolicy === undefined) {
      return { status: 'UNAVAILABLE' }
    }
    return {
      status: 'READY',
      rootBinding: rootBinding.data,
      view: raw.view,
      filesystem,
      rootTarget: raw.rootTarget,
      publicationPolicy: raw.publicationPolicy,
    }
  }

  async #confirmRuntime(
    input: V2ProposalPublicationInput,
    binding: V2DshPublicationBinding<TView>,
    target: string,
    expectedBody: string,
  ): Promise<boolean> {
    const delays = [50, 500, 2_000, 7_500]
    const view = this.#refreshView(binding.view)
    for (let attempt = 0; attempt < this.#attempts; attempt += 1) {
      try {
        const snapshot = runtimeSnapshotSchema.safeParse(await this.options.registry.snapshot(view))
        if (snapshot.success && snapshot.data.complete) {
          const winners = snapshot.data.skills.filter(skill => skill.name === input.proposal.body.name)
          if (
            winners.length === 1
            && winners[0]!.provider === binding.rootBinding.expectedProvider
            && winners[0]!.source === binding.rootBinding.expectedSource
            && samePath(winners[0]!.path, target)
          ) {
            const definition = runtimeDefinitionSchema.safeParse(
              await this.options.registry.get(input.proposal.body.name, view),
            )
            if (
              definition.success
              && definition.data.name === input.proposal.body.name
              && definition.data.description === input.proposal.body.description
              && definition.data.whenToUse === input.proposal.body.whenToUse
              && definition.data.provider === binding.rootBinding.expectedProvider
              && definition.data.source === binding.rootBinding.expectedSource
              && samePath(definition.data.path, target)
              && definition.data.content === expectedBody
              && definition.data.invocation?.modelInvocable === true
              && definition.data.invocation.userInvocable === false
            ) return true
          }
        }
      } catch {
        // Bounded retries cover a temporarily invalidated DSH Registry view.
      }
      if (attempt + 1 < this.#attempts) await this.#wait(delays[attempt] ?? 1_000)
    }
    return false
  }

  #publishedReceipt(
    input: V2ProposalPublicationInput & { readonly attemptId: string },
    binding: V2DshPublicationBinding<TView>,
    target: string,
  ): V2ProposalPublicationOutcome {
    return {
      status: 'PUBLISHED',
      externalReceiptDigest: sha256Utf8(canonicalJson({
        contract: 'run2skill-v2-dsh-publication-v1',
        attemptId: input.attemptId,
        proposalId: input.proposalRef.proposalId,
        scope: input.lineage.persistenceScope,
        name: input.proposal.body.name,
        skillBytesDigest: input.proposal.body.skillBytesDigest,
        provider: binding.rootBinding.expectedProvider,
        source: binding.rootBinding.expectedSource,
        targetPathDigest: sha256Utf8(canonicalJson({ path: normalize(resolve(target)) })),
        resolutionContractDigest: binding.rootBinding.resolutionContractDigest,
      })),
    }
  }

  #contextPublishedReceipt(
    input: V2ProposalPublicationInput & { readonly attemptId: string },
    binding: V2DshPublicationBinding<TView>,
    target: DshContextFileSystemTarget,
  ): V2ProposalPublicationOutcome {
    return {
      status: 'PUBLISHED',
      externalReceiptDigest: sha256Utf8(canonicalJson({
        contract: 'run2skill-v2-dsh-fs-publication-v2',
        attemptId: input.attemptId,
        proposalId: input.proposalRef.proposalId,
        action: input.proposal.action,
        scope: input.lineage.persistenceScope,
        name: input.proposal.body.name,
        skillBytesDigest: input.proposal.body.skillBytesDigest,
        provider: binding.rootBinding.expectedProvider,
        source: binding.rootBinding.expectedSource,
        targetKeyDigest: sha256Utf8(target.targetKey),
        resolutionContractDigest: binding.rootBinding.resolutionContractDigest,
      })),
    }
  }
}
