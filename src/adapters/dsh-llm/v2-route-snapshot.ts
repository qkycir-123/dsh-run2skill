import { canonicalJson } from '../../domain/learn/identity.js'
import type { SessionBatchV2, TurnObservationV2 } from '../../domain/v2/index.js'
import type { DshLlmPort } from './restricted-learning-client.js'

export const V2_ROUTE_BUDGET_POLICY_VERSION = 'route-budget-v2'

const MAX_STAGE_OUTPUT_TOKENS = 16_384
const CONTEXT_SAFETY_TOKENS = 2_048
const OUTPUT_BYTE_RATIO = 4
const ROUTE_RESOLUTION_TIMEOUT_MS = 5_000

type RouteSnapshot = SessionBatchV2['routeSnapshot']

interface DshV2RouteSnapshotAdapterOptions {
  /** @internal Allows deterministic boundary tests; Host wiring uses the versioned default deadline. */
  readonly internalTimeoutMs?: number
}

export class DshV2RouteSnapshotError extends Error {
  constructor(readonly code:
    | 'ROUTE_OBSERVATION_UNAVAILABLE'
    | 'ROUTE_CAPACITY_UNAVAILABLE'
    | 'ROUTE_CAPACITY_CHANGED'
  ) {
    super(code)
    this.name = 'DshV2RouteSnapshotError'
  }
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function resolvedCapacity(value: Awaited<ReturnType<DshLlmPort['resolveModelInfo']>>): {
  readonly contextWindow: number
  readonly outputTokens: number
} | undefined {
  const contextWindow = value.context?.contextWindow
  const defaultMaxTokens = value.defaultMaxTokens
  if (!positiveSafeInteger(contextWindow)) return undefined
  if (defaultMaxTokens !== undefined && !positiveSafeInteger(defaultMaxTokens)) return undefined
  const outputTokens = Math.min(
    defaultMaxTokens ?? MAX_STAGE_OUTPUT_TOKENS,
    MAX_STAGE_OUTPUT_TOKENS,
    Math.max(1, Math.floor(contextWindow / 4)),
  )
  return { contextWindow, outputTokens }
}

/**
 * Freezes one exact provider/model route without making a model request.
 *
 * Input bytes deliberately use one byte per available context token. Since
 * each UTF-8 byte can consume at most one byte-level tokenizer token, this is
 * conservative for arbitrary JSON text. Output bytes use a separate bounded
 * policy and the stage client also caps the requested token count from it.
 */
export class DshV2RouteSnapshotAdapter {
  readonly #timeoutMs: number

  constructor(
    private readonly llm: DshLlmPort,
    options: DshV2RouteSnapshotAdapterOptions = {},
  ) {
    this.#timeoutMs = options.internalTimeoutMs ?? ROUTE_RESOLUTION_TIMEOUT_MS
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new TypeError('Invalid v2 route resolution timeout')
    }
  }

  async capture(
    _sessionLifecycleKey: string,
    observations: readonly TurnObservationV2[],
  ): Promise<RouteSnapshot> {
    const latest = [...observations].sort((left, right) => right.turnEndSeq - left.turnEndSeq)[0]
    const route = latest?.routeObservation
    if (
      route?.complete !== true
      || route.provider === undefined
      || route.model === undefined
    ) throw new DshV2RouteSnapshotError('ROUTE_OBSERVATION_UNAVAILABLE')

    let first
    let second
    try {
      first = resolvedCapacity(await this.#resolveModelInfo(route.provider, route.model))
      second = resolvedCapacity(await this.#resolveModelInfo(route.provider, route.model))
    } catch {
      throw new DshV2RouteSnapshotError('ROUTE_CAPACITY_UNAVAILABLE')
    }
    if (first === undefined || second === undefined) {
      throw new DshV2RouteSnapshotError('ROUTE_CAPACITY_UNAVAILABLE')
    }
    if (canonicalJson(first) !== canonicalJson(second)) {
      throw new DshV2RouteSnapshotError('ROUTE_CAPACITY_CHANGED')
    }
    const safetyTokens = Math.min(CONTEXT_SAFETY_TOKENS, Math.max(1, Math.floor(first.contextWindow / 8)))
    const maxInputBytes = first.contextWindow - first.outputTokens - safetyTokens
    if (!positiveSafeInteger(maxInputBytes)) {
      throw new DshV2RouteSnapshotError('ROUTE_CAPACITY_UNAVAILABLE')
    }
    return {
      provider: route.provider,
      model: route.model,
      policyVersion: V2_ROUTE_BUDGET_POLICY_VERSION,
      maxInputBytes,
      maxOutputBytes: first.outputTokens * OUTPUT_BYTE_RATIO,
    }
  }

  async #resolveModelInfo(
    provider: string,
    model: string,
  ): Promise<Awaited<ReturnType<DshLlmPort['resolveModelInfo']>>> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.llm.resolveModelInfo(provider, model, controller.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new DshV2RouteSnapshotError('ROUTE_CAPACITY_UNAVAILABLE'))
          }, this.#timeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
