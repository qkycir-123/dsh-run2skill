import type { WorkspaceBindingPort, WorkspaceResolution } from '../../application/capture/turn-capture-processor.js'
import { OBSERVE_LIMITS } from '../../domain/observe/constants.js'

interface DshWorkspaceProjection {
  readonly id: string
  readonly path: string
  status?(): Promise<'ok' | 'missing-dir'>
}

export interface DshWorkspaceRegistryPort {
  resolveByPath(path: string): Promise<DshWorkspaceProjection | undefined>
  get?(id: string): DshWorkspaceProjection | undefined
}

export class DshWorkspaceBindingResolver implements WorkspaceBindingPort {
  constructor(private readonly registry: DshWorkspaceRegistryPort) {}

  async resolve(cwd: string): Promise<WorkspaceResolution> {
    try {
      const workspace = await this.registry.resolveByPath(cwd)
      if (workspace === undefined) return { status: 'UNREGISTERED' }
      if (
        workspace.id.length === 0
        || workspace.path.length === 0
        || workspace.path.length > OBSERVE_LIMITS.maxPathChars
        || Buffer.byteLength(workspace.path, 'utf8') > OBSERVE_LIMITS.maxPathBytes
      ) return { status: 'UNAVAILABLE' }
      return {
        status: 'BOUND',
        workspaceId: workspace.id,
        canonicalPath: workspace.path,
      }
    } catch {
      return { status: 'UNAVAILABLE' }
    }
  }
}
