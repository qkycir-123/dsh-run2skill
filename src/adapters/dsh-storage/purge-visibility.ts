import type { CaptureWorkItemV1 } from '../../domain/observe/schemas.js'
import type { LineageV1 } from '../../domain/publication/index.js'
import { classifyLineageForPurge, classifyWorkItemForPurge, type PurgeJournalV1 } from '../../domain/purge/index.js'
import type { Run2skillDomain } from './types.js'

export class PurgeVisibility {
  constructor(private readonly domain: Run2skillDomain) {}

  active(): PurgeJournalV1 | undefined {
    return this.domain.global.get().purgeJournal
  }

  workItemVisible(item: CaptureWorkItemV1): boolean {
    const journal = this.active()
    return journal === undefined
      || classifyWorkItemForPurge(item, journal.scopeBinding, journal.hideBefore) !== 'DELETE'
  }

  lineageVisible(lineage: LineageV1): boolean {
    const journal = this.active()
    return journal === undefined
      || classifyLineageForPurge(lineage, journal.scopeBinding, journal.hideBefore) !== 'DELETE'
  }
}
