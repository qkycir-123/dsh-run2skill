import type {
  InvocationDescriptor,
  RemoteResult,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type {
  ObserveRpcResult,
  ObserveSummaryRpcHandler,
} from '../dsh-connection/observe-summary-rpc.js'

export const RUN2SKILL_QUERY_ENDPOINTS = [
  'observe-summary',
  'attention',
  'proposals/list',
  'summary',
  'proposals/get',
  'recent-activity/list',
  'learning/status',
  'learning/issues/list',
  'purge/preview',
  'purge/status',
] as const

export const RUN2SKILL_COMMAND_ENDPOINTS = [
  'proposals/approve',
  'proposals/reject',
  'proposals/retry',
  'proposals/refresh',
  'proposals/revise',
  'coverage/confirm-discard',
  'learning/request',
  'learning/issues/retry',
  'learning/issues/dismiss',
  'purge/confirm',
  'purge/retry',
] as const

export type Run2skillQueryEndpoint = typeof RUN2SKILL_QUERY_ENDPOINTS[number]
export type Run2skillCommandEndpoint = typeof RUN2SKILL_COMMAND_ENDPOINTS[number]
export type Run2skillEndpoint = Run2skillQueryEndpoint | Run2skillCommandEndpoint
export type Run2skillRemoteRoute = 'query' | 'command'

const queryEndpoints = new Set<string>(RUN2SKILL_QUERY_ENDPOINTS)
const commandEndpoints = new Set<string>(RUN2SKILL_COMMAND_ENDPOINTS)

export function routeRun2skillEndpoint(endpoint: string): Run2skillRemoteRoute {
  if (queryEndpoints.has(endpoint)) return 'query'
  if (commandEndpoints.has(endpoint)) return 'command'
  throw new TypeError(`unknown run2skill endpoint: ${endpoint}`)
}

const jsonValue = z.json()
const queryRequest = z.object({
  endpoint: z.enum(RUN2SKILL_QUERY_ENDPOINTS),
  payload: jsonValue,
}).strict()
const commandRequest = z.object({
  endpoint: z.enum(RUN2SKILL_COMMAND_ENDPOINTS),
  payload: jsonValue,
}).strict()
const rpcResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: jsonValue }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string().min(1),
      message: z.string(),
      details: z.record(z.string(), jsonValue),
    }).strict(),
  }).strict(),
])

function descriptor(
  method: Run2skillRemoteRoute,
  requestSchema: typeof queryRequest | typeof commandRequest,
): InvocationDescriptor {
  const value: InvocationDescriptor = {
    id: `dsh-run2skill#run2skill/${method}`,
    service: 'run2skillRemote',
    namespace: 'run2skill',
    method,
    invocation: { kind: 'direct' as const },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: {
        mode: 'strict',
        typeSymbol: method === 'query' ? 'Run2skillQueryRequest' : 'Run2skillCommandRequest',
        schema: requestSchema,
      },
    }],
    cancellation: { parameter: 'signal' },
    result: {
      mode: 'strict',
      typeSymbol: 'Run2skillRpcResult',
      schema: rpcResult,
    },
  }
  return Object.freeze(value)
}

export const RUN2SKILL_REMOTE_DESCRIPTORS = Object.freeze([
  descriptor('query', queryRequest),
  descriptor('command', commandRequest),
])

export const RUN2SKILL_REMOTE: TypertRemoteContribution = Object.freeze({
  package: 'dsh-run2skill',
  descriptors: RUN2SKILL_REMOTE_DESCRIPTORS,
})

export interface Run2skillRemoteRequest<Endpoint extends Run2skillEndpoint = Run2skillEndpoint> {
  readonly endpoint: Endpoint
  readonly payload: unknown
}

export interface Run2skillRemoteNamespace {
  query(
    request: Run2skillRemoteRequest<Run2skillQueryEndpoint>,
    signal?: AbortSignal,
  ): Promise<RemoteResult<ObserveRpcResult<unknown>>>
  command(
    request: Run2skillRemoteRequest<Run2skillCommandEndpoint>,
    signal?: AbortSignal,
  ): Promise<RemoteResult<ObserveRpcResult<unknown>>>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    run2skill: Run2skillRemoteNamespace
  }
}

export type Run2skillRemoteHandler = ObserveSummaryRpcHandler
