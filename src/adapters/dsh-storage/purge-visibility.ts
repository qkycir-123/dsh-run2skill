import type { CaptureWorkItemV1 } from '../../domain/observe/schemas.js'
import type { LineageV1 } from '../../domain/publication/index.js'
import { classifyLineageForPurge, classifyWorkItemForPurge, type PurgeJournalV1 } from '../../domain/purge/index.js'
import type { Run2skillDomain } from './types.js'

export class PurgeVisibility {
  readonly #completedFences = new Map<string, PurgeJournalV1>()

  constructor(private readonly domain: Run2skillDomain) {}

  active(): PurgeJournalV1 | undefined {
    return this.domain.global.get().purgeJournal
  }

  remember(journal: PurgeJournalV1): void {
    const key = journal.scopeBinding.scope === 'USER'
      ? 'USER'
      : JSON.stringify({
          workspaceId: journal.scopeBinding.workspaceId,
          canonicalWorkspacePath: journal.scopeBinding.canonicalWorkspacePath,
          canonicalRootPath: journal.scopeBinding.canonicalRootPath,
          rootContractVersion: journal.scopeBinding.rootContractVersion,
          resolverVersion: journal.scopeBinding.resolverVersion,
          resolutionContractDigest: journal.scopeBinding.resolutionContractDigest,
        })
    const existing = this.#completedFences.get(key)
    if (existing === undefined || Date.parse(journal.hideBefore) > Date.parse(existing.hideBefore)) {
      this.#completedFences.set(key, journal)
    }
  }

  workItemWasPurged(item: CaptureWorkItemV1): boolean {
    for (const journal of this.#completedFences.values()) {
      if (classifyWorkItemForPurge(item, journal.scopeBinding, journal.hideBefore) === 'DELETE') return true
    }
    return false
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
