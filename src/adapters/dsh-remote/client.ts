import type {
  RemoteFailure,
  TypertClientRemote,
  TypertDisposer,
} from '@deepseek-ai/dsh-typert-protocol'
import type { ObserveRpcResult } from '../dsh-connection/observe-summary-rpc.js'
import type { Context } from '@deepseek-ai/cordis'
import {
  RUN2SKILL_REMOTE,
  routeRun2skillEndpoint,
  type Run2skillEndpoint,
  type Run2skillRemoteNamespace,
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
  context?: Pick<Context, 'inject'>,
): Promise<MountedRun2skillRemote> {
  const dispose = await remote.$mount(RUN2SKILL_REMOTE)
  let namespace: Run2skillRemoteNamespace | undefined
  const scope = context?.inject(['remote.run2skill'], child => {
    namespace = child.get('remote.run2skill') as Run2skillRemoteNamespace
  })
  try {
    if (scope !== undefined) await scope
  } catch (error) {
    await dispose()
    throw error
  }
  return {
    async dispose() {
      await scope?.dispose()
      await dispose()
    },
    async call(endpoint, payload, signal) {
      const route = routeRun2skillEndpoint(endpoint)
      const request = { endpoint: endpoint as Run2skillEndpoint, payload }
      const target = context === undefined ? remote.run2skill : namespace!
      const result = route === 'query'
        ? await target.query(request as never, signal)
        : await target.command(request as never, signal)
      return result.ok ? result.value : carrierFailure(result.error)
    },
  }
}
