import { canonicalJson } from '../../domain/learn/identity.js'
import type { SessionBatchV2, TurnObservationV2 } from '../../domain/v2/index.js'
import type { DshLlmPort } from './restricted-learning-client.js'

export const V2_ROUTE_BUDGET_POLICY_VERSION = 'route-budget-v1'

const MAX_STAGE_OUTPUT_TOKENS = 16_384
const CONTEXT_SAFETY_TOKENS = 2_048
const OUTPUT_BYTE_RATIO = 4

type RouteSnapshot = SessionBatchV2['routeSnapshot']

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
  constructor(private readonly llm: DshLlmPort) {}

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
      first = resolvedCapacity(await this.llm.resolveModelInfo(route.provider, route.model))
      second = resolvedCapacity(await this.llm.resolveModelInfo(route.provider, route.model))
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
}
