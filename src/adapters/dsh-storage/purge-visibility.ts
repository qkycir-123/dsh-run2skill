import type { CaptureWorkItemV1 } from '../../domain/observe/schemas.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import type { LineageV1 } from '../../domain/publication/index.js'
import { canonicalJson } from '../../domain/learn/identity.js'
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

  revision(): `visibility_${string}` {
    const global = this.domain.global.get()
    return `visibility_${sha256Utf8(canonicalJson({
      purgeJournal: global.purgeJournal ?? null,
      completedPurgeFences: global.completedPurgeFences ?? null,
    }))}`
  }

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
