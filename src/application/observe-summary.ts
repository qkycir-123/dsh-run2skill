import type { Run2skillDomain } from '../adapters/dsh-storage/types.js'
import type { GlobalV1 } from '../domain/observe/schemas.js'
import {
  ObserveSummaryV1Schema,
  type ObserveSummaryV1,
} from '../domain/observe/observe-summary.js'
import type {
  RecoveryLifecycleSnapshot,
  RecoveryLifecycleStatus,
} from './capture/recovery-lifecycle.js'
import type { RuntimeNotice, RuntimeNotices } from './capture/runtime-notices.js'
import { PurgeVisibility } from '../adapters/dsh-storage/purge-visibility.js'
import { isIgnoredLearningFailure } from '../domain/learn/index.js'

export type ObserveCompatibility = 'COMPATIBLE' | 'INCOMPATIBLE'

export interface ObserveSummarySources {
  readonly domain: Run2skillDomain
  readonly lifecycle: RecoveryLifecycleSnapshot
  readonly notices: RuntimeNotices
  readonly compatibility: ObserveCompatibility
}

function summaryStatus(
  compatibility: ObserveCompatibility,
  status: RecoveryLifecycleStatus,
  recoveryLag: boolean,
): ObserveSummaryV1['status'] {
  if (compatibility === 'INCOMPATIBLE') return 'INCOMPATIBLE'
  if (status === 'DEGRADED' || status === 'DISPOSED') return 'DEGRADED'
  if (status === 'RECOVERING' || recoveryLag) return 'RECOVERING'
  return 'READY'
}

function latestNotice(notices: readonly RuntimeNotice[]): RuntimeNotice | undefined {
  let latest: RuntimeNotice | undefined
  for (const notice of notices) {
    if (latest === undefined || notice.lastObservedAt >= latest.lastObservedAt) latest = notice
  }
  return latest
}

function latestRecoveryProgressAt(sessions: GlobalV1['sessions']): string | undefined {
  let latest: string | undefined
  for (const session of Object.values(sessions)) {
    const candidate = session.lastScannedAt
    if (candidate !== undefined && (latest === undefined || Date.parse(candidate) > Date.parse(latest))) {
      latest = candidate
    }
  }
  return latest
}

export function createObserveSummary(sources: ObserveSummarySources): ObserveSummaryV1 {
  let capturedCount = 0
  let blockedCaptureCount = 0
  const learning = { captured: 0, analyzing: 0, learned: 0, needsAttention: 0 }
  const visibility = new PurgeVisibility(sources.domain)
  for (const [, item] of sources.domain.table('work_items').entries()) {
    if (!visibility.workItemVisible(item)) continue
    switch (item.processingState) {
      case 'CAPTURED':
        learning.captured += item.scanStatus === 'COMPLETE' ? 1 : 0
        if (item.scanStatus === 'INCOMPLETE') blockedCaptureCount += 1
        else capturedCount += 1
        break
      case 'ANALYZING': learning.analyzing += 1; break
      case 'LEARNED': learning.learned += 1; break
      case 'NEEDS_ATTENTION': learning.needsAttention += isIgnoredLearningFailure(item) ? 0 : 1; break
      case 'RESOLVED_NO_SIGNAL': break
    }
  }

  const notices = sources.notices.list()
  const unsavedSignals = new Set<string>()
  for (const notice of notices) {
    if (notice.kind === 'UNSAVED_SIGNAL' && notice.turnEndSeq !== undefined) {
      unsavedSignals.add(`${notice.sessionId}\u0000${notice.turnEndSeq}`)
    }
  }
  const status = summaryStatus(
    sources.compatibility,
    sources.lifecycle.status,
    sources.lifecycle.recoveryLag,
  )
  const recoveryComplete = status === 'READY'
    && !sources.lifecycle.recoveryLag
    && sources.notices.unsavedCompletenessKnown()
  const latestRuntimeNotice = latestNotice(notices)
  const global = sources.domain.global.get()
  const lastRecoveryProgressAt = status === 'RECOVERING' || status === 'DEGRADED'
    ? latestRecoveryProgressAt(global.sessions)
    : undefined
  const lastHealthCode = sources.compatibility === 'INCOMPATIBLE'
    ? 'DSH_VERSION_INCOMPATIBLE'
    : latestRuntimeNotice?.healthCode ?? global.health.lastCode

  return ObserveSummaryV1Schema.parse({
    apiVersion: 1,
    status,
    capturedCount,
    blockedCaptureCount,
    learning,
    unsaved: {
      completeness: recoveryComplete ? 'KNOWN' : 'UNKNOWN',
      knownCount: unsavedSignals.size,
    },
    recoveryLag: sources.lifecycle.recoveryLag,
    ...(lastRecoveryProgressAt === undefined ? {} : { lastRecoveryProgressAt }),
    ...(lastHealthCode === undefined ? {} : { lastHealthCode }),
  })
}
