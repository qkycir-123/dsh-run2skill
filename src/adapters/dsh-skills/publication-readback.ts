import { normalize, resolve } from 'node:path'
import type { PublicationReadbackPort, PublicationReadbackResult } from '../../application/publication/index.js'
import { parseCanonicalSkillBody } from '../../application/curation/index.js'
import type { SkillCatalogPort, SkillDefinitionProjection } from '../../domain/learn/index.js'
import type { CaptureWorkItemV1 } from '../../domain/observe/schemas.js'

export interface PublicationReadbackOptions {
  readonly attempts?: number
  readonly wait?: (milliseconds: number) => Promise<void>
}

function samePath(left: string | undefined, right: string): boolean {
  if (left === right) return true
  if (left === undefined) return false
  const a = normalize(resolve(left))
  const b = normalize(resolve(right))
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function exactLoadedSkill(
  loaded: SkillDefinitionProjection | undefined,
  item: CaptureWorkItemV1,
  expectedBody: string,
): boolean {
  const proposal = item.review!.proposal
  const binding = proposal.actionBinding
  if (loaded === undefined || binding.kind === 'DISCARD') return false
  return loaded.name === proposal.name
    && loaded.description === proposal.description
    && loaded.whenToUse === proposal.whenToUse
    && loaded.provider === binding.rootBinding.provider
    && loaded.source === binding.rootBinding.source
    && samePath(loaded.path, binding.targetBinding.skillFilePath)
    && loaded.content === expectedBody
    && loaded.invocation?.modelInvocable === proposal.invocation.modelInvocable
    && loaded.invocation.userInvocable === proposal.invocation.userInvocable
}

export class DshPublicationReadbackAdapter<TView extends object> implements PublicationReadbackPort {
  readonly #skills
  readonly #resolveView
  readonly #attempts
  readonly #wait

  constructor(
    skills: SkillCatalogPort<TView>,
    resolveView: (item: CaptureWorkItemV1) => TView | undefined,
    options: PublicationReadbackOptions = {},
  ) {
    const attempts = options.attempts ?? 3
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5) {
      throw new TypeError('Publication readback attempts must be between 1 and 5')
    }
    this.#skills = skills
    this.#resolveView = resolveView
    this.#attempts = attempts
    this.#wait = options.wait ?? (async milliseconds => {
      await new Promise(resolveWait => setTimeout(resolveWait, milliseconds))
    })
  }

  async confirmExact(item: CaptureWorkItemV1): Promise<PublicationReadbackResult> {
    const proposal = item.review?.proposal
    const binding = proposal?.actionBinding
    const view = this.#resolveView(item)
    if (
      item.review?.reviewDecision !== 'APPROVED'
      || proposal === undefined
      || binding === undefined
      || binding.kind === 'DISCARD'
      || view === undefined
    ) return { status: 'TIMEOUT', code: 'READBACK_SCOPE_UNAVAILABLE' }

    let expectedBody: string
    try {
      expectedBody = parseCanonicalSkillBody(proposal.exactSkillBytes)
    } catch {
      return { status: 'CHANGED', code: 'REGISTRY_READBACK_CHANGED' }
    }

    let sawCompleteMismatch = false
    const delays = [50, 200, 500, 1_000]
    for (let attempt = 0; attempt < this.#attempts; attempt += 1) {
      try {
        const snapshot = await this.#skills.snapshot(view)
        if (snapshot.complete) {
          const winner = snapshot.skills.find(skill => skill.name === proposal.name)
          if (
            winner !== undefined
            && winner.provider === binding.rootBinding.provider
            && winner.source === binding.rootBinding.source
          ) {
            const loaded = await this.#skills.get(proposal.name, view)
            if (exactLoadedSkill(loaded, item, expectedBody)) {
              return { status: 'CONFIRMED', observedHash: proposal.skillBytesDigest }
            }
          }
          sawCompleteMismatch = true
        }
      } catch {
        // A bounded retry may recover an invalidated or temporarily unavailable catalog.
      }
      if (attempt + 1 < this.#attempts) await this.#wait(delays[attempt] ?? 1_000)
    }
    return sawCompleteMismatch
      ? { status: 'CHANGED', code: 'REGISTRY_READBACK_CHANGED' }
      : { status: 'TIMEOUT', code: 'READBACK_TIMEOUT' }
  }
}
