import { deriveCatalogScanCallIdV2, type ExperienceIntentV2 } from './schemas.js'

export function retryableCatalogCall(intent: ExperienceIntentV2) {
  if (intent.status !== 'NEEDS_ATTENTION'
    || intent.recall.state !== 'INCOMPLETE'
    || intent.recall.incompleteReason !== 'CATALOG_SCAN_TEMPORARY_FAILED'
    || intent.recall.scanPlanDigest === undefined
    || intent.catalogRetry !== undefined) return undefined
  return intent.stageCalls.findLast(call => call.stage === 'CATALOG_SCAN'
    && call.outcome === 'FAILED'
    && call.failureCode === 'CATALOG_SCAN_TEMPORARY_FAILED'
    && call.callId === deriveCatalogScanCallIdV2(intent.intentId, intent.recall.scanPlanDigest!, call.ordinal))
}
