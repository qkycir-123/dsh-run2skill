import { dirname, join, normalize, resolve } from 'node:path'
import { canonicalJson } from '../learn/identity.js'
import type { CaptureWorkItemV1 } from '../observe/schemas.js'
import { sha256Utf8 } from '../observe/hashing.js'
import type { LineageV1 } from '../publication/index.js'
import type {
  CompletedAllPurgeFenceV1,
  CompletedProjectPurgeFenceV1,
  CompletedPurgeFencesV1,
  CompletedUserPurgeFenceV1,
  ProjectPurgeScopeBindingV1,
  PurgeJournalV1,
  PurgeScopeBindingV1,
} from './schemas.js'
import { MAX_COMPLETED_PROJECT_PURGE_FENCES } from './schemas.js'

export type PurgeClassification = 'DELETE' | 'KEEP_NEW' | 'KEEP_SCOPE' | 'KEEP_UNPROVEN'

function samePath(left: string, right: string): boolean {
  return canonicalPathIdentity(left) === canonicalPathIdentity(right)
}

function canonicalPathIdentity(value: string): string {
  const canonical = normalize(resolve(value))
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

function deriveProjectScopeIdentityDigest(canonicalWorkspacePath: string): string {
  return sha256Utf8(canonicalJson({
    scope: 'PROJECT',
    canonicalWorkspacePath: canonicalPathIdentity(canonicalWorkspacePath),
  }))
}

export function deriveProjectPurgeScopeIdentityDigest(
  binding: ProjectPurgeScopeBindingV1,
): string {
  return deriveProjectScopeIdentityDigest(binding.canonicalWorkspacePath)
}

function deriveWorkItemProjectScopeIdentityDigest(item: CaptureWorkItemV1): string | undefined {
  return item.workspaceBinding.status === 'BOUND'
    ? deriveProjectScopeIdentityDigest(item.workspaceBinding.canonicalPath)
    : undefined
}

function deriveLineageProjectScopeIdentityDigest(lineage: LineageV1): string | undefined {
  if (lineage.scope !== 'PROJECT' || lineage.provider !== 'filesystem' || lineage.source !== 'project-dsh') {
    return undefined
  }
  const workspace = dirname(dirname(dirname(dirname(lineage.canonicalTargetPath))))
  const expected = join(workspace, '.dsh', 'skills', lineage.skillName, 'SKILL.md')
  return samePath(lineage.canonicalTargetPath, expected)
    ? deriveProjectScopeIdentityDigest(workspace)
    : undefined
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
  if (binding.scope === 'ALL') return 'DELETE'
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
  if (binding.scope === 'ALL') return 'DELETE'
  if (lineage.scope !== binding.scope) return 'KEEP_SCOPE'
  if (binding.scope === 'USER') return 'DELETE'
  if (lineage.provider !== 'filesystem' || lineage.source !== 'project-dsh') return 'KEEP_UNPROVEN'
  const exactTarget = join(binding.canonicalRootPath, lineage.skillName, 'SKILL.md')
  return samePath(lineage.canonicalTargetPath, exactTarget) ? 'DELETE' : 'KEEP_UNPROVEN'
}

export function completedFencesHideWorkItem(
  item: CaptureWorkItemV1,
  fences: CompletedPurgeFencesV1 | undefined,
): boolean {
  if (fences === undefined) return false
  if (fences.all !== undefined && !afterBoundary(item.createdAt, fences.all.hideBefore)) return true
  const learnedScope = item.learning?.proposal?.persistenceScope
  if (
    learnedScope === 'USER'
    && fences.user !== undefined
    && !afterBoundary(item.createdAt, fences.user.hideBefore)
  ) return true
  if (learnedScope === 'USER') return false
  const scopeIdentityDigest = deriveWorkItemProjectScopeIdentityDigest(item)
  const fence = scopeIdentityDigest === undefined ? undefined : fences.projects[scopeIdentityDigest]
  return fence !== undefined && !afterBoundary(item.createdAt, fence.hideBefore)
}

export function completedFencesHideLineage(
  lineage: LineageV1,
  fences: CompletedPurgeFencesV1 | undefined,
): boolean {
  if (fences === undefined) return false
  const firstCommit = lineage.revisions[0]?.committedAt
  if (firstCommit === undefined) return false
  if (fences.all !== undefined && !afterBoundary(firstCommit, fences.all.hideBefore)) return true
  if (lineage.scope === 'USER') {
    return fences.user !== undefined && !afterBoundary(firstCommit, fences.user.hideBefore)
  }
  const scopeIdentityDigest = deriveLineageProjectScopeIdentityDigest(lineage)
  const fence = scopeIdentityDigest === undefined ? undefined : fences.projects[scopeIdentityDigest]
  return fence !== undefined && !afterBoundary(firstCommit, fence.hideBefore)
}

export function canUpsertCompletedPurgeFence(
  fences: CompletedPurgeFencesV1 | undefined,
  binding: PurgeScopeBindingV1,
): boolean {
  if (binding.scope === 'USER' || binding.scope === 'ALL') return true
  const projects = fences?.projects ?? {}
  const scopeIdentityDigest = deriveProjectPurgeScopeIdentityDigest(binding)
  return projects[scopeIdentityDigest] !== undefined
    || Object.keys(projects).length < MAX_COMPLETED_PROJECT_PURGE_FENCES
}

export function upsertCompletedPurgeFence(
  fences: CompletedPurgeFencesV1 | undefined,
  journal: PurgeJournalV1,
  completedAt: string,
): CompletedPurgeFencesV1 {
  const current: CompletedPurgeFencesV1 = fences ?? { schemaVersion: 1, projects: {} }
  if (journal.scopeBinding.scope === 'ALL') {
    const next: CompletedAllPurgeFenceV1 = {
      schemaVersion: 1,
      scope: 'ALL',
      purgeId: journal.purgeId,
      completedAt,
      hideBefore: journal.hideBefore,
    }
    return current.all !== undefined
      && Date.parse(current.all.hideBefore) > Date.parse(next.hideBefore)
      ? current
      : { ...current, all: next }
  }
  if (journal.scopeBinding.scope === 'USER') {
    const next: CompletedUserPurgeFenceV1 = {
      schemaVersion: 1,
      scope: 'USER',
      purgeId: journal.purgeId,
      completedAt,
      hideBefore: journal.hideBefore,
    }
    return current.user !== undefined
      && Date.parse(current.user.hideBefore) > Date.parse(next.hideBefore)
      ? current
      : { ...current, user: next }
  }
  if (!canUpsertCompletedPurgeFence(current, journal.scopeBinding)) {
    throw new RangeError('PURGE_FENCE_LIMIT')
  }
  const scopeIdentityDigest = deriveProjectPurgeScopeIdentityDigest(journal.scopeBinding)
  const next: CompletedProjectPurgeFenceV1 = {
    schemaVersion: 1,
    scope: 'PROJECT',
    purgeId: journal.purgeId,
    completedAt,
    hideBefore: journal.hideBefore,
    scopeIdentityDigest,
  }
  const existing = current.projects[scopeIdentityDigest]
  return existing !== undefined && Date.parse(existing.hideBefore) > Date.parse(next.hideBefore)
    ? current
    : { ...current, projects: { ...current.projects, [scopeIdentityDigest]: next } }
}
