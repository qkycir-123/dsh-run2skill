import type { CaptureWorkItemV1 } from '../../domain/observe/schemas.js'
import type { LineageV1 } from '../../domain/publication/index.js'
import {
  classifyLineageForPurge,
  classifyWorkItemForPurge,
  completedFencesHideLineage,
  completedFencesHideWorkItem,
  type PurgeJournalV1,
} from '../../domain/purge/index.js'
import type { Run2skillDomain } from './types.js'

export class PurgeVisibility {
  constructor(private readonly domain: Run2skillDomain) {}

  active(): PurgeJournalV1 | undefined {
    return this.domain.global.get().purgeJournal
  }

  workItemWasPurged(item: CaptureWorkItemV1): boolean {
    return !this.workItemVisible(item)
  }

  workItemVisible(item: CaptureWorkItemV1): boolean {
    const global = this.domain.global.get()
    const journal = global.purgeJournal
    return (
      journal === undefined
      || classifyWorkItemForPurge(item, journal.scopeBinding, journal.hideBefore) !== 'DELETE'
    ) && !completedFencesHideWorkItem(item, global.completedPurgeFences)
  }

  lineageVisible(lineage: LineageV1): boolean {
    const global = this.domain.global.get()
    const journal = global.purgeJournal
    return (
      journal === undefined
      || classifyLineageForPurge(lineage, journal.scopeBinding, journal.hideBefore) !== 'DELETE'
    ) && !completedFencesHideLineage(lineage, global.completedPurgeFences)
  }
}
