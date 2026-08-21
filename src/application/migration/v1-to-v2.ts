import type { Run2skillDomain } from '../../adapters/dsh-storage/types.js'
import type { Run2skillV2Domain } from '../../adapters/dsh-storage/v2-types.js'
import {
  materializeLegacyItemV2,
  materializeLegacyProposalLineageV2,
} from '../../adapters/dsh-storage/legacy-v1-adapter.js'
import { canonicalJson } from '../../domain/learn/identity.js'
import { CaptureWorkItemV1Schema, GlobalV1Schema } from '../../domain/observe/schemas.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import { LineageV1Schema } from '../../domain/publication/schemas.js'
import { deriveLineageId } from '../../domain/publication/schemas.js'
import {
  deriveLegacyPendingProposalCatalogV2,
  GlobalV2Schema,
  LegacyItemV2Schema,
  ProposalLineageV2Schema,
  type GlobalV2,
  type LegacyItemV2,
  type MigrationJournalV2,
  type ProposalLineageV2,
} from '../../domain/v2/index.js'
import type { LegacySourceCutoverGate } from './legacy-source-cutover-gate.js'

export type MigrationPhaseV2 = MigrationJournalV2['phase']

export class Run2skillV2MigrationError extends Error {
  constructor(readonly code:
    | 'LEGACY_PURGE_ACTIVE'
    | 'LEGACY_SOURCE_INVALID'
    | 'LEGACY_SOURCE_NOT_QUIESCENT'
    | 'SOURCE_CHANGED_DURING_MIGRATION'
    | 'SOURCE_CHANGED_AFTER_COMMIT'
    | 'MIGRATION_ALREADY_FAILED'
    | 'V2_IDENTITY_CONFLICT'
    | 'V2_VALIDATION_FAILED',
  ) {
    super(code)
    this.name = 'Run2skillV2MigrationError'
  }
}

interface LegacySnapshot {
  readonly fingerprint: string
  readonly global: ReturnType<typeof GlobalV1Schema.parse>
  readonly workItems: readonly ReturnType<typeof CaptureWorkItemV1Schema.parse>[]
  readonly lineages: readonly ReturnType<typeof LineageV1Schema.parse>[]
  readonly counts: {
    readonly workItems: number
    readonly lineages: number
    readonly activeLegacyProposals: number
  }
}

export interface Run2skillV2MigrationOptions {
  readonly cutoverGate: LegacySourceCutoverGate
  readonly now?: () => string
  readonly afterPhase?: (phase: Exclude<MigrationPhaseV2, 'NOT_STARTED' | 'FAILED'>) => void | Promise<void>
}

export interface Run2skillV2MigrationResult {
  readonly status: 'COMMITTED' | 'ALREADY_COMMITTED'
  readonly sourceFingerprint: string
  readonly counts: LegacySnapshot['counts']
}

function isActiveLegacyProposal(item: LegacyItemV2): boolean {
  return item.disposition === 'ACTIVE_LEGACY_PROPOSAL'
    || item.disposition === 'ACTIVE_LEGACY_PUBLICATION'
}

function readLegacySnapshot(domain: Run2skillDomain, importedAt: string): LegacySnapshot {
  const parsedGlobal = GlobalV1Schema.safeParse(domain.global.get())
  if (!parsedGlobal.success) throw new Run2skillV2MigrationError('LEGACY_SOURCE_INVALID')
  if (parsedGlobal.data.purgeJournal !== undefined) {
    throw new Run2skillV2MigrationError('LEGACY_PURGE_ACTIVE')
  }
  if (
    parsedGlobal.data.recovery.recoveryLag
    || parsedGlobal.data.checkpoint.dirty
    || Object.values(parsedGlobal.data.sessions).some(session => session.durableNextSeq !== session.observedTailSeq + 1)
  ) throw new Run2skillV2MigrationError('LEGACY_SOURCE_NOT_QUIESCENT')
  const workItems = [...domain.table('work_items').entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, raw]) => {
      const parsed = CaptureWorkItemV1Schema.safeParse(raw)
      if (!parsed.success || parsed.data.workItemId !== key) {
        throw new Run2skillV2MigrationError('LEGACY_SOURCE_INVALID')
      }
      return parsed.data
    })
  const lineages = [...domain.table('lineages').entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, raw]) => {
      const parsed = LineageV1Schema.safeParse(raw)
      if (!parsed.success || parsed.data.lineageId !== key) {
        throw new Run2skillV2MigrationError('LEGACY_SOURCE_INVALID')
      }
      return parsed.data
    })
  const lineagesById = new Map(lineages.map(lineage => [lineage.lineageId, lineage]))
  for (const item of workItems) {
    if (item.processingState !== 'TERMINAL' || item.review?.publicationOutcome !== 'PUBLISHED') continue
    const proposal = item.review.proposal
    const targetIdentityDigest = item.publication?.targetIdentityDigest
    if (targetIdentityDigest === undefined) throw new Run2skillV2MigrationError('LEGACY_SOURCE_INVALID')
    const lineage = lineagesById.get(deriveLineageId(proposal.persistenceScope, targetIdentityDigest))
    const matchingRevisions = lineage?.revisions.filter(revision => (
      revision.origin === 'RUN2SKILL'
      && revision.proposalId === proposal.proposalId
      && revision.skillBytesDigest === proposal.skillBytesDigest
      && revision.exactSkillBytes === proposal.exactSkillBytes
    )) ?? []
    if (
      lineage === undefined
      || lineage.scope !== proposal.persistenceScope
      || lineage.targetIdentityDigest !== targetIdentityDigest
      || matchingRevisions.length !== 1
    ) throw new Run2skillV2MigrationError('LEGACY_SOURCE_INVALID')
  }
  let activeLegacyProposals = 0
  for (const item of workItems) {
    if (isActiveLegacyProposal(materializeLegacyItemV2(item, importedAt))) activeLegacyProposals += 1
  }
  const fingerprint = sha256Utf8(canonicalJson({
    contract: { domainName: 'run2skill_v1', domainVersion: 2, globalSchemaVersion: 1 },
    global: parsedGlobal.data,
    workItems,
    lineages,
  }))
  return {
    fingerprint,
    global: parsedGlobal.data,
    workItems,
    lineages,
    counts: { workItems: workItems.length, lineages: lineages.length, activeLegacyProposals },
  }
}

function runningJournal(
  phase: 'COPYING' | 'VALIDATING',
  snapshot: LegacySnapshot,
  startedAt: string,
  updatedAt: string,
): MigrationJournalV2 {
  return {
    schemaVersion: 1,
    phase,
    source: { domainName: 'run2skill_v1', domainVersion: 2, globalSchemaVersion: 1 },
    sourceFingerprint: snapshot.fingerprint,
    counts: snapshot.counts,
    startedAt,
    updatedAt,
  }
}

async function setGlobal(domain: Run2skillV2Domain, value: GlobalV2): Promise<void> {
  await domain.global.set(GlobalV2Schema.parse(value))
}

async function markMigrationFailed(
  domain: Run2skillV2Domain,
  code: Run2skillV2MigrationError['code'],
  failedAt: string,
): Promise<void> {
  const global = GlobalV2Schema.parse(domain.global.get())
  const migration = global.migration
  if (migration.phase !== 'COPYING' && migration.phase !== 'VALIDATING') return
  await setGlobal(domain, {
    ...global,
    migration: {
      ...migration,
      phase: 'FAILED',
      updatedAt: failedAt,
      failureCode: code,
    },
  })
}

async function putExact<V>(
  table: { get(key: string): V | undefined; put(key: string, value: V): Promise<void> },
  key: string,
  value: V,
): Promise<void> {
  const existing = table.get(key)
  if (existing !== undefined) {
    if (canonicalJson(existing) !== canonicalJson(value)) {
      throw new Run2skillV2MigrationError('V2_IDENTITY_CONFLICT')
    }
    return
  }
  await table.put(key, value)
}

function verifyExactTable<V>(
  actual: IterableIterator<[string, V]>,
  expected: readonly [string, V][],
): void {
  const actualEntries = [...actual].sort(([left], [right]) => left.localeCompare(right))
  const expectedEntries = [...expected].sort(([left], [right]) => left.localeCompare(right))
  if (actualEntries.length !== expectedEntries.length) {
    throw new Run2skillV2MigrationError('V2_VALIDATION_FAILED')
  }
  for (let index = 0; index < expectedEntries.length; index += 1) {
    const [expectedKey, expectedValue] = expectedEntries[index]!
    const [actualKey, actualValue] = actualEntries[index]!
    if (
      actualKey !== expectedKey
      || canonicalJson(actualValue) !== canonicalJson(expectedValue)
    ) throw new Run2skillV2MigrationError('V2_VALIDATION_FAILED')
  }
}

export async function migrateRun2skillV1ToV2(
  v1: Run2skillDomain,
  v2: Run2skillV2Domain,
  options: Run2skillV2MigrationOptions,
): Promise<Run2skillV2MigrationResult> {
  const result = await options.cutoverGate.sealAndRun(
    () => migrateUnderCutover(v1, v2, options),
    () => GlobalV2Schema.safeParse(v2.global.get()).data?.migration.phase === 'COMMITTED',
  )
  if (result.status === 'COMMITTED') await options.afterPhase?.('COMMITTED')
  return result
}

async function migrateUnderCutover(
  v1: Run2skillDomain,
  v2: Run2skillV2Domain,
  options: Run2skillV2MigrationOptions,
): Promise<Run2skillV2MigrationResult> {
  const now = options.now ?? (() => new Date().toISOString())
  const importedAt = now()
  const source = readLegacySnapshot(v1, importedAt)
  const initialGlobal = GlobalV2Schema.parse(v2.global.get())
  const current = initialGlobal.migration
  if (current.phase === 'COMMITTED') {
    if (current.sourceFingerprint !== source.fingerprint) {
      throw new Run2skillV2MigrationError('SOURCE_CHANGED_AFTER_COMMIT')
    }
    return { status: 'ALREADY_COMMITTED', sourceFingerprint: source.fingerprint, counts: source.counts }
  }
  if (current.phase === 'FAILED') throw new Run2skillV2MigrationError('MIGRATION_ALREADY_FAILED')
  if (
    current.phase !== 'NOT_STARTED'
    && current.sourceFingerprint !== source.fingerprint
  ) {
    const error = new Run2skillV2MigrationError('SOURCE_CHANGED_DURING_MIGRATION')
    await markMigrationFailed(v2, error.code, importedAt)
    throw error
  }

  const startedAt = current.phase === 'NOT_STARTED' ? importedAt : current.startedAt
  if (current.phase === 'NOT_STARTED') {
    await setGlobal(v2, {
      ...initialGlobal,
      migration: runningJournal('COPYING', source, startedAt, importedAt),
      ...(source.global.completedPurgeFences === undefined
        ? {}
        : { legacyCompletedPurgeFences: source.global.completedPurgeFences }),
    })
    await options.afterPhase?.('COPYING')
  }

  let expectedLegacyItems: readonly [string, LegacyItemV2][]
  let expectedLineages: readonly [string, ProposalLineageV2][]
  try {
    expectedLegacyItems = source.workItems.map((item): [string, LegacyItemV2] => {
      const record = materializeLegacyItemV2(item, startedAt)
      return [record.legacyItemId, record]
    })
    expectedLineages = source.lineages.map((lineage): [string, ProposalLineageV2] => {
      const record = materializeLegacyProposalLineageV2(lineage, startedAt)
      return [record.lineageId, record]
    })
    const legacyTable = v2.table('legacy_items')
    const lineageTable = v2.table('proposal_lineages')
    for (const [key, record] of expectedLegacyItems) await putExact(legacyTable, key, record)
    for (const [key, record] of expectedLineages) await putExact(lineageTable, key, record)

    const beforeValidation = GlobalV2Schema.parse(v2.global.get())
    if (beforeValidation.migration.phase === 'COPYING') {
      await setGlobal(v2, {
        ...beforeValidation,
        migration: runningJournal('VALIDATING', source, startedAt, now()),
      })
      await options.afterPhase?.('VALIDATING')
    }

    for (const [, record] of legacyTable.entries()) {
      if (!LegacyItemV2Schema.safeParse(record).success) {
        throw new Run2skillV2MigrationError('V2_VALIDATION_FAILED')
      }
    }
    for (const [, record] of lineageTable.entries()) {
      if (!ProposalLineageV2Schema.safeParse(record).success) {
        throw new Run2skillV2MigrationError('V2_VALIDATION_FAILED')
      }
    }
    verifyExactTable(legacyTable.entries(), expectedLegacyItems)
    verifyExactTable(lineageTable.entries(), expectedLineages)
    if (
      [...legacyTable.entries()].filter(([, item]) => isActiveLegacyProposal(item)).length
      !== source.counts.activeLegacyProposals
    ) throw new Run2skillV2MigrationError('V2_VALIDATION_FAILED')
    const legacyPendingCatalog = deriveLegacyPendingProposalCatalogV2(
      [...legacyTable.entries()].map(([, item]) => item),
    )
    if (
      !legacyPendingCatalog.complete
      || legacyPendingCatalog.entries.length !== source.counts.activeLegacyProposals
    ) throw new Run2skillV2MigrationError('V2_VALIDATION_FAILED')
    if (
      v2.table('turn_observations').size !== 0
      || v2.table('session_batches').size !== 0
      || v2.table('experience_intents').size !== 0
      || beforeValidation.proposalGenerationLease !== undefined
      || Object.keys(beforeValidation.behaviorSignatureIndex).length !== 0
    ) throw new Run2skillV2MigrationError('V2_VALIDATION_FAILED')

    const sourceAtCommit = readLegacySnapshot(v1, startedAt)
    if (sourceAtCommit.fingerprint !== source.fingerprint) {
      throw new Run2skillV2MigrationError('SOURCE_CHANGED_DURING_MIGRATION')
    }
  } catch (error) {
    if (error instanceof Run2skillV2MigrationError) {
      await markMigrationFailed(v2, error.code, now())
    }
    throw error
  }
  const committedAt = now()
  const observerStartWatermarks = Object.fromEntries(
    Object.entries(source.global.sessions).map(([lifecycleKey, session]) => [lifecycleKey, {
      nextSeq: session.observedTailSeq + 1,
      observedTailSeq: session.observedTailSeq,
      ...(session.headerRevision === undefined ? {} : { headerRevision: session.headerRevision }),
      ...(session.headerDigest === undefined ? {} : { headerDigest: session.headerDigest }),
    }]),
  )
  const sessions = Object.fromEntries(
    Object.entries(source.global.sessions).map(([lifecycleKey, session]) => [lifecycleKey, {
      observedThroughTurnEndSeq: session.observedTailSeq,
      detectedThroughTurnEndSeq: session.observedTailSeq,
      openExperienceCarry: [],
      updatedAt: committedAt,
    }]),
  )
  const legacyPendingCatalog = deriveLegacyPendingProposalCatalogV2(
    [...v2.table('legacy_items').entries()].map(([, item]) => item),
  )
  const activationFenceDigest = sha256Utf8(canonicalJson({
    sourceFingerprint: source.fingerprint,
    counts: source.counts,
    committedAt,
  }))
  const observerStartWatermarkDigest = sha256Utf8(canonicalJson(observerStartWatermarks))
  const validatingGlobal = GlobalV2Schema.parse(v2.global.get())
  await setGlobal(v2, {
    ...validatingGlobal,
    migration: {
      schemaVersion: 1,
      phase: 'COMMITTED',
      source: { domainName: 'run2skill_v1', domainVersion: 2, globalSchemaVersion: 1 },
      sourceFingerprint: source.fingerprint,
      counts: source.counts,
      startedAt,
      updatedAt: committedAt,
      committedAt,
      activationFenceDigest,
    },
    proposalCatalogEpoch: source.counts.activeLegacyProposals > 0 ? 1 : 0,
    sessions,
    activation: {
      committedAt,
      sourceFingerprint: source.fingerprint,
      observerStartWatermarks,
      observerStartWatermarkDigest,
      legacyPendingCatalogDigest: legacyPendingCatalog.digest,
      legacyPendingCandidateCount: legacyPendingCatalog.entries.length,
    },
  })
  return { status: 'COMMITTED', sourceFingerprint: source.fingerprint, counts: source.counts }
}
