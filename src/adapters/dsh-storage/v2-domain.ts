import {
  ExperienceIntentV2Schema,
  GlobalV2Schema,
  LegacyItemV2Schema,
  ProposalLineageV2Schema,
  SessionBatchV2Schema,
  TurnObservationV2Schema,
  type GlobalV2,
} from '../../domain/v2/index.js'
import type { Run2skillV2Domain, Run2skillV2StorageContext } from './v2-types.js'

export const RUN2SKILL_V2_SCHEMA_CONTRACT = Object.freeze({
  domainName: 'run2skill_v2',
  domainVersion: 1,
  globalSchemaVersion: 1,
  recordSchemaVersion: 1,
  sourceDomainName: 'run2skill_v1',
  sourceDomainVersion: 2,
} as const)

export function createInitialGlobalV2(): GlobalV2 {
  return {
    schemaVersion: 1,
    migration: {
      schemaVersion: 1,
      phase: 'NOT_STARTED',
      source: {
        domainName: 'run2skill_v1',
        domainVersion: 2,
        globalSchemaVersion: 1,
      },
    },
    sessions: {},
    behaviorSignatureIndex: {},
    proposalCatalogEpoch: 0,
  }
}

export const run2skillV2DomainSpec = {
  name: RUN2SKILL_V2_SCHEMA_CONTRACT.domainName,
  version: RUN2SKILL_V2_SCHEMA_CONTRACT.domainVersion,
  global: {
    schema: GlobalV2Schema,
    initial: createInitialGlobalV2(),
  },
  tables: {
    turn_observations: { valueSchema: TurnObservationV2Schema },
    session_batches: { valueSchema: SessionBatchV2Schema },
    experience_intents: { valueSchema: ExperienceIntentV2Schema },
    proposal_lineages: { valueSchema: ProposalLineageV2Schema },
    legacy_items: { valueSchema: LegacyItemV2Schema },
  },
} as const

export async function openRun2skillV2Domain(context: Run2skillV2StorageContext): Promise<Run2skillV2Domain> {
  const domain = await context.storageDomain.open(run2skillV2DomainSpec)
  if (domain.name !== run2skillV2DomainSpec.name) throw new Error('run2skill v2 domain name mismatch')
  return domain
}
