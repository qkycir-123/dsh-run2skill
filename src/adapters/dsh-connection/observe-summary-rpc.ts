import { z } from 'zod'
import {
  ObserveSummaryV1Schema,
  type ObserveSummaryV1,
} from '../../domain/observe/observe-summary.js'

export const RUN2SKILL_RPC_CHANNEL = '/run2skill'
export const OBSERVE_SUMMARY_ENDPOINT = 'observe-summary'

const ObserveSummaryRequestV1Schema = z.object({ apiVersion: z.literal(1) }).strict()

type ObserveRpcError = {
  readonly code: 'bad-request' | 'cancelled' | 'internal' | 'not-found' | 'conflict' | 'invalid-state'
  readonly message: string
  readonly details: Record<string, never> | { readonly issues: never[] }
}

export type ObserveRpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ObserveRpcError }

export type ObserveSummaryRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<ObserveRpcResult<unknown>>

export interface ObserveSummaryHostConnection {
  readonly rpc: {
    handle(
      channel: string,
      handler: ObserveSummaryRpcHandler,
      options: { readonly authority: 'loopback' },
    ): () => Promise<void>
  }
}

function badRequest(): ObserveRpcResult<never> {
  return {
    ok: false,
    error: { code: 'bad-request', message: 'invalid observe summary request', details: { issues: [] } },
  }
}

export function registerObserveSummaryRpc(
  connection: ObserveSummaryHostConnection,
  readSummary: () => ObserveSummaryV1 | Promise<ObserveSummaryV1>,
  fallback?: ObserveSummaryRpcHandler,
): () => Promise<void> {
  return connection.rpc.handle(
    RUN2SKILL_RPC_CHANNEL,
    async (endpoint, payload, signal) => {
      if (endpoint !== OBSERVE_SUMMARY_ENDPOINT) {
        return fallback === undefined ? badRequest() : await fallback(endpoint, payload, signal)
      }
      if (!ObserveSummaryRequestV1Schema.safeParse(payload).success) return badRequest()
      if (signal.aborted) {
        return {
          ok: false,
          error: { code: 'cancelled', message: 'observe summary request cancelled', details: {} },
        }
      }
      try {
        const summary = ObserveSummaryV1Schema.parse(await readSummary())
        return { ok: true, value: summary }
      } catch {
        return {
          ok: false,
          error: { code: 'internal', message: 'observe summary unavailable', details: {} },
        }
      }
    },
    { authority: 'loopback' },
  )
}
