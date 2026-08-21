import type {
  ExperienceIntentV2,
  GlobalV2,
  LegacyItemV2,
  ProposalLineageV2,
  SessionBatchV2,
  TurnObservationV2,
} from '../../domain/v2/index.js'
import type { Run2skillTable } from './types.js'

export interface Run2skillV2Domain {
  readonly name: 'run2skill_v2'
  readonly global: {
    get(): GlobalV2
    set(value: GlobalV2): Promise<void>
  }
  table(name: 'turn_observations'): Run2skillTable<string, TurnObservationV2>
  table(name: 'session_batches'): Run2skillTable<string, SessionBatchV2>
  table(name: 'experience_intents'): Run2skillTable<string, ExperienceIntentV2>
  table(name: 'proposal_lineages'): Run2skillTable<string, ProposalLineageV2>
  table(name: 'legacy_items'): Run2skillTable<string, LegacyItemV2>
  close(): Promise<void>
}

export interface Run2skillV2StorageContext {
  readonly storageDomain: {
    open(spec: typeof import('./v2-domain.js').run2skillV2DomainSpec): Promise<Run2skillV2Domain>
  }
}
