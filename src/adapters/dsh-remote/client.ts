import type {
  RemoteFailure,
  TypertClientRemote,
  TypertDisposer,
} from '@deepseek-ai/dsh-typert-protocol'
import type { ObserveRpcResult } from '../dsh-connection/observe-summary-rpc.js'
import {
  RUN2SKILL_REMOTE,
  routeRun2skillEndpoint,
  type Run2skillEndpoint,
} from './contract.js'

export type Run2skillRemoteCall = (
  endpoint: string,
  payload: unknown,
  signal?: AbortSignal,
) => Promise<ObserveRpcResult<unknown>>

export interface MountedRun2skillRemote {
  readonly call: Run2skillRemoteCall
  readonly dispose: TypertDisposer
}

function carrierFailure(error: RemoteFailure): ObserveRpcResult<never> {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      details: error.details as Record<string, unknown>,
    },
  }
}

export async function createRun2skillRemoteCaller(
  remote: TypertClientRemote,
): Promise<MountedRun2skillRemote> {
  const dispose = await remote.$mount(RUN2SKILL_REMOTE)
  return {
    dispose,
    async call(endpoint, payload, signal) {
      const route = routeRun2skillEndpoint(endpoint)
      const request = { endpoint: endpoint as Run2skillEndpoint, payload }
      const result = route === 'query'
        ? await remote.run2skill.query(request as never, signal)
        : await remote.run2skill.command(request as never, signal)
      return result.ok ? result.value : carrierFailure(result.error)
    },
  }
}
