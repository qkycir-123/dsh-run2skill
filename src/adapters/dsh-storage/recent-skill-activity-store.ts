import { normalize, resolve } from 'node:path'
import {
  MAX_RECENT_SKILL_ACTIVITIES,
  RECENT_SKILL_ACTIVITY_WINDOW_MS,
  RecentSkillActivityIndexV1Schema,
  RecentSkillActivityV1Schema,
  deriveRecentSkillActivityId,
  emptyRecentSkillActivityIndex,
  type RecentSkillActivityV1,
} from '../../domain/activity/index.js'
import type { CaptureWorkItemV1 } from '../../domain/observe/schemas.js'
import type { Run2skillDomain } from './types.js'
import { Run2skillGlobalStore } from './global-store.js'
import { PurgeVisibility } from './purge-visibility.js'

export interface RecentSkillActivityListItem {
  readonly activityId: string
  readonly skillName: string
  readonly operation: 'CREATED' | 'UPDATED'
  readonly scope: 'PROJECT' | 'USER'
  readonly occurredAt: string
}

export interface RecentSkillActivityWorkspace {
  readonly workspaceId: string
  readonly canonicalPath: string
}

function sameHostPath(left: string, right: string): boolean {
  const a = normalize(resolve(left))
  const b = normalize(resolve(right))
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function compareActivity(left: RecentSkillActivityV1, right: RecentSkillActivityV1): number {
  return Date.parse(right.occurredAt) - Date.parse(left.occurredAt)
    || left.activityId.localeCompare(right.activityId)
}

function publishedActivityMatches(item: CaptureWorkItemV1, activity: RecentSkillActivityV1): boolean {
  const published = activityForPublishedItem(item)
  return published !== undefined
    && published.activityId === activity.activityId
    && published.workItemId === activity.workItemId
    && published.skillName === activity.skillName
    && published.operation === activity.operation
    && published.scope === activity.scope
    && published.occurredAt === activity.occurredAt
}

function activityForPublishedItem(item: CaptureWorkItemV1): RecentSkillActivityV1 | undefined {
  const review = item.review
  const publication = item.publication
  if (
    item.processingState !== 'TERMINAL'
    || review?.reviewDecision !== 'APPROVED'
    || review.publicationOutcome !== 'PUBLISHED'
    || review.proposal.kind === 'DISCARD'
    || publication === undefined
  ) return undefined
  const outcome = publication.journal.find(event => (
    event.attemptId === publication.activeAttemptId && event.stage === 'OUTCOME_COMMITTED'
  ))
  if (outcome === undefined) return undefined
  return RecentSkillActivityV1Schema.parse({
    schemaVersion: 1,
    activityId: deriveRecentSkillActivityId({
      workItemId: item.workItemId,
      attemptId: publication.activeAttemptId,
    }),
    workItemId: item.workItemId,
    skillName: review.proposal.name,
    operation: review.proposal.kind === 'CREATE' ? 'CREATED' : 'UPDATED',
    scope: review.proposal.persistenceScope,
    occurredAt: outcome.occurredAt,
  })
}

function stagedActivityMatches(item: CaptureWorkItemV1, activity: RecentSkillActivityV1): boolean {
  const review = item.review
  const publication = item.publication
  return item.processingState === 'PUBLISHING'
    && review?.reviewDecision === 'APPROVED'
    && review.publicationOutcome === 'PENDING_REVIEW'
    && review.proposal.kind !== 'DISCARD'
    && publication !== undefined
    && publication.journal.some(event => (
      event.attemptId === publication.activeAttemptId && event.stage === 'LINEAGE_COMMITTED'
    ))
    && deriveRecentSkillActivityId({
      workItemId: item.workItemId,
      attemptId: publication.activeAttemptId,
    }) === activity.activityId
    && item.workItemId === activity.workItemId
    && review.proposal.name === activity.skillName
    && review.proposal.persistenceScope === activity.scope
    && (review.proposal.kind === 'CREATE' ? 'CREATED' : 'UPDATED') === activity.operation
}

export class RecentSkillActivityStore {
  readonly #global
  readonly #workItems
  readonly #visibility

  constructor(
    private readonly domain: Run2skillDomain,
    visibility: PurgeVisibility = new PurgeVisibility(domain),
  ) {
    this.#global = Run2skillGlobalStore.for(domain)
    this.#workItems = domain.table('work_items')
    this.#visibility = visibility
  }

  async stagePublished(item: CaptureWorkItemV1, occurredAt: string): Promise<RecentSkillActivityV1> {
    const review = item.review
    const publication = item.publication
    if (
      item.processingState !== 'PUBLISHING'
      || review?.reviewDecision !== 'APPROVED'
      || review.publicationOutcome !== 'PENDING_REVIEW'
      || review.proposal.kind === 'DISCARD'
      || publication === undefined
      || !publication.journal.some(event => (
        event.attemptId === publication.activeAttemptId && event.stage === 'LINEAGE_COMMITTED'
      ))
    ) throw new Error('INVALID_RECENT_ACTIVITY_STATE')
    const proposal = review.proposal
    const activity = RecentSkillActivityV1Schema.parse({
      schemaVersion: 1,
      activityId: deriveRecentSkillActivityId({
        workItemId: item.workItemId,
        attemptId: publication.activeAttemptId,
      }),
      workItemId: item.workItemId,
      skillName: proposal.name,
      operation: proposal.kind === 'CREATE' ? 'CREATED' : 'UPDATED',
      scope: proposal.persistenceScope,
      occurredAt,
    })
    let committed = activity
    await this.#global.update(global => {
      const index = global.recentSkillActivity ?? emptyRecentSkillActivityIndex()
      const existing = index.items.find(item => item.activityId === activity.activityId)
      if (existing !== undefined) {
        if (
          existing.workItemId !== activity.workItemId
          || existing.skillName !== activity.skillName
          || existing.operation !== activity.operation
          || existing.scope !== activity.scope
        ) throw new Error('RECENT_ACTIVITY_CONFLICT')
        committed = existing
        return global
      }
      const normalized = this.#normalize(index.items, activity.occurredAt, [activity])
      return {
        ...global,
        recentSkillActivity: normalized,
      }
    })
    return committed
  }

  async reconcilePublished(now: string): Promise<void> {
    const snapshot = this.domain.global.get().recentSkillActivity ?? emptyRecentSkillActivityIndex()
    const normalized = this.#normalize(snapshot.items, now)
    if (JSON.stringify(snapshot) === JSON.stringify(normalized)) return
    await this.#global.update(global => {
      const index = global.recentSkillActivity ?? emptyRecentSkillActivityIndex()
      return {
        ...global,
        recentSkillActivity: this.#normalize(index.items, now),
      }
    })
  }

  #normalize(
    indexedItems: readonly RecentSkillActivityV1[],
    now: string,
    additionalStaged: readonly RecentSkillActivityV1[] = [],
  ) {
    const nowMs = Date.parse(now)
    const boundary = nowMs - RECENT_SKILL_ACTIVITY_WINDOW_MS
    const inWindow = (activity: RecentSkillActivityV1) => {
      const occurredAt = Date.parse(activity.occurredAt)
      return occurredAt >= boundary && occurredAt <= nowMs
    }
    const published = [...this.#workItems.entries()].flatMap<RecentSkillActivityV1>(([, item]) => {
      if (!this.#visibility.workItemVisible(item)) return []
      const activity = activityForPublishedItem(item)
      return activity !== undefined && inWindow(activity) ? [activity] : []
    }).sort(compareActivity).slice(0, MAX_RECENT_SKILL_ACTIVITIES)
    const publishedIds = new Set(published.map(item => item.activityId))
    const stagedById = new Map<string, RecentSkillActivityV1>()
    for (const activity of [...indexedItems, ...additionalStaged]) {
      if (publishedIds.has(activity.activityId) || stagedById.has(activity.activityId) || !inWindow(activity)) continue
      const item = this.#workItems.get(activity.workItemId)
      if (
        item !== undefined
        && this.#visibility.workItemVisible(item)
        && stagedActivityMatches(item, activity)
      ) stagedById.set(activity.activityId, activity)
    }
    const remaining = MAX_RECENT_SKILL_ACTIVITIES - published.length
    const staged = [...stagedById.values()].sort(compareActivity).slice(0, remaining)
    return RecentSkillActivityIndexV1Schema.parse({
      schemaVersion: 1,
      items: [...published, ...staged].sort(compareActivity),
    })
  }

  list(input: {
    readonly now: string
    readonly workspace?: RecentSkillActivityWorkspace
  }): readonly RecentSkillActivityListItem[] {
    const now = Date.parse(input.now)
    const cutoff = now - RECENT_SKILL_ACTIVITY_WINDOW_MS
    const index = this.domain.global.get().recentSkillActivity ?? emptyRecentSkillActivityIndex()
    return index.items.flatMap<RecentSkillActivityListItem>(activity => {
      const occurredAt = Date.parse(activity.occurredAt)
      if (occurredAt < cutoff || occurredAt > now) return []
      const item = this.#workItems.get(activity.workItemId)
      if (
        item === undefined
        || !this.#visibility.workItemVisible(item)
        || !publishedActivityMatches(item, activity)
      ) return []
      if (activity.scope === 'PROJECT') {
        const binding = item.review?.proposal.workspaceBinding
        if (
          input.workspace === undefined
          || binding?.workspaceId !== input.workspace.workspaceId
          || !sameHostPath(binding.canonicalPath, input.workspace.canonicalPath)
        ) return []
      }
      return [{
        activityId: activity.activityId,
        skillName: activity.skillName,
        operation: activity.operation,
        scope: activity.scope,
        occurredAt: activity.occurredAt,
      }]
    })
  }
}
