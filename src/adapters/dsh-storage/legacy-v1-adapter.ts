import { canonicalJson } from '../../domain/learn/identity.js'
import { CaptureWorkItemV1Schema, type CaptureWorkItemV1 } from '../../domain/observe/schemas.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import { LineageV1Schema, type LineageV1 } from '../../domain/publication/schemas.js'
import {
  LegacyItemV2Schema,
  ProposalLineageV2Schema,
  deriveLegacyDispositionV2,
  deriveLegacyItemIdV2,
  type LegacyDispositionV2,
  type LegacyItemV2,
  type ProposalLineageV2,
} from '../../domain/v2/index.js'

export class LegacyV1AdapterError extends Error {
  constructor(readonly code: 'LEGACY_SCHEMA_INVALID' | 'LEGACY_STATE_UNMAPPED') {
    super(code)
    this.name = 'LegacyV1AdapterError'
  }
}

export function classifyLegacyWorkItem(raw: CaptureWorkItemV1): LegacyDispositionV2 {
  const parsed = CaptureWorkItemV1Schema.safeParse(raw)
  if (!parsed.success) throw new LegacyV1AdapterError('LEGACY_SCHEMA_INVALID')
  const disposition = deriveLegacyDispositionV2(parsed.data)
  if (disposition === undefined) throw new LegacyV1AdapterError('LEGACY_STATE_UNMAPPED')
  return disposition
}

export function materializeLegacyItemV2(raw: CaptureWorkItemV1, importedAt: string): LegacyItemV2 {
  const parsed = CaptureWorkItemV1Schema.safeParse(raw)
  if (!parsed.success) throw new LegacyV1AdapterError('LEGACY_SCHEMA_INVALID')
  const sourceWorkItem = parsed.data
  return LegacyItemV2Schema.parse({
    schemaVersion: 1,
    legacyItemId: deriveLegacyItemIdV2(sourceWorkItem.workItemId),
    sourceWorkItemId: sourceWorkItem.workItemId,
    sourceDigest: sha256Utf8(canonicalJson(sourceWorkItem)),
    disposition: classifyLegacyWorkItem(sourceWorkItem),
    importedAt,
    sourceWorkItem,
  })
}

export function materializeLegacyProposalLineageV2(raw: LineageV1, importedAt: string): ProposalLineageV2 {
  const legacySnapshot = LineageV1Schema.parse(raw)
  return ProposalLineageV2Schema.parse({
    schemaVersion: 1,
    revision: 1,
    lineageId: legacySnapshot.lineageId,
    persistenceScope: legacySnapshot.scope,
    origin: 'LEGACY_V1',
    state: 'PUBLISHED',
    sourceDigest: sha256Utf8(canonicalJson(legacySnapshot)),
    importedAt,
    updatedAt: importedAt,
    legacySnapshot,
  })
}
