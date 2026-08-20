import { join, normalize, resolve } from 'node:path'
import type { CaptureWorkItemV1 } from '../observe/schemas.js'
import type { LineageV1 } from '../publication/index.js'
import type { PurgeScopeBindingV1 } from './schemas.js'

export type PurgeClassification = 'DELETE' | 'KEEP_NEW' | 'KEEP_SCOPE' | 'KEEP_UNPROVEN'

function samePath(left: string, right: string): boolean {
  const a = normalize(resolve(left))
  const b = normalize(resolve(right))
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function afterBoundary(value: string, hideBefore: string): boolean {
  return Date.parse(value) > Date.parse(hideBefore)
}

export function classifyWorkItemForPurge(
  item: CaptureWorkItemV1,
  binding: PurgeScopeBindingV1,
  hideBefore: string,
): PurgeClassification {
  if (afterBoundary(item.createdAt, hideBefore)) return 'KEEP_NEW'
  const learnedScope = item.learning?.proposal?.persistenceScope
  if (binding.scope === 'USER') {
    if (learnedScope === undefined) return 'KEEP_UNPROVEN'
    return learnedScope === 'USER' ? 'DELETE' : 'KEEP_SCOPE'
  }
  if (learnedScope === 'USER') return 'KEEP_SCOPE'
  if (learnedScope !== undefined && learnedScope !== 'PROJECT') return 'KEEP_UNPROVEN'
  const workspace = item.workspaceBinding
  if (
    workspace.status !== 'BOUND'
    || workspace.workspaceId !== binding.workspaceId
    || !samePath(workspace.canonicalPath, binding.canonicalWorkspacePath)
  ) return 'KEEP_UNPROVEN'
  return 'DELETE'
}

export function classifyLineageForPurge(
  lineage: LineageV1,
  binding: PurgeScopeBindingV1,
  hideBefore: string,
): PurgeClassification {
  const firstCommit = lineage.revisions[0]?.committedAt
  if (firstCommit === undefined) return 'KEEP_UNPROVEN'
  if (afterBoundary(firstCommit, hideBefore)) return 'KEEP_NEW'
  if (lineage.scope !== binding.scope) return 'KEEP_SCOPE'
  if (binding.scope === 'USER') return 'DELETE'
  if (lineage.provider !== 'filesystem' || lineage.source !== 'project-dsh') return 'KEEP_UNPROVEN'
  const exactTarget = join(binding.canonicalRootPath, lineage.skillName, 'SKILL.md')
  return samePath(lineage.canonicalTargetPath, exactTarget) ? 'DELETE' : 'KEEP_UNPROVEN'
}
