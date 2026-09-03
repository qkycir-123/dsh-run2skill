import type { Context } from '@deepseek-ai/cordis'
import {
  RemoteError,
  TypertRemoteService,
} from '@deepseek-ai/dsh-typert-protocol'
import type { ObserveRpcResult } from '../dsh-connection/observe-summary-rpc.js'
import {
  routeRun2skillEndpoint,
  type Run2skillCommandEndpoint,
  type Run2skillQueryEndpoint,
  type Run2skillRemoteHandler,
  type Run2skillRemoteRequest,
} from './contract.js'

function assertRoute(endpoint: string, expected: 'query' | 'command'): void {
  let actual: 'query' | 'command'
  try {
    actual = routeRun2skillEndpoint(endpoint)
  } catch (cause) {
    throw new RemoteError('gateway/bad-request', `unknown run2skill endpoint: ${endpoint}`, {}, { cause })
  }
  if (actual !== expected) {
    throw new RemoteError(
      'gateway/bad-request',
      `run2skill endpoint ${endpoint} must use ${actual}`,
      {},
    )
  }
}

export class Run2skillRemoteService extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly handler: Run2skillRemoteHandler,
  ) {
    super(ctx, 'run2skillRemote', { namespace: 'run2skill' })
  }

  async query(
    request: Run2skillRemoteRequest<Run2skillQueryEndpoint>,
    signal: AbortSignal,
  ): Promise<ObserveRpcResult<unknown>> {
    assertRoute(request.endpoint, 'query')
    return await this.handler(request.endpoint, request.payload, signal)
  }

  async command(
    request: Run2skillRemoteRequest<Run2skillCommandEndpoint>,
    signal: AbortSignal,
  ): Promise<ObserveRpcResult<unknown>> {
    assertRoute(request.endpoint, 'command')
    return await this.handler(request.endpoint, request.payload, signal)
  }
}
