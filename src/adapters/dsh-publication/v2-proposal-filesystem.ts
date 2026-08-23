import { join, normalize, resolve } from 'node:path'
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
    return { status: 'READY', rootBinding: rootBinding.data, view: raw.view }
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
}
