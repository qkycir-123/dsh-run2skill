import {
  RUN2SKILL_REMOTE_DESCRIPTORS,
} from './contract.js'

export const TYPERT = Object.freeze({
  package: 'dsh-run2skill',
  face: 'host',
  schemas: [],
  invocations: RUN2SKILL_REMOTE_DESCRIPTORS,
  model: {
    services: [{
      key: 'run2skillRemote',
      exportName: 'Run2skillRemoteService',
      summary: 'Run2Skill read and mutation boundary for the DSH Web client.',
      tags: [],
      members: [
        {
          kind: 'method',
          name: 'query',
          signature: 'query(request: Run2skillQueryRequest, signal: AbortSignal): Promise<Run2skillRpcResult>',
        },
        {
          kind: 'method',
          name: 'command',
          signature: 'command(request: Run2skillCommandRequest, signal: AbortSignal): Promise<Run2skillRpcResult>',
        },
      ],
      types: [],
    }],
    events: [],
    objects: [],
  },
})

export default TYPERT
