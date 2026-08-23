import {
  CaptureWorkItemV1Schema,
  GlobalV1Schema,
  type GlobalV1,
} from '../../domain/observe/schemas.js'
import { LineageV1Schema } from '../../domain/publication/index.js'
import { emptyRecentSkillActivityIndex } from '../../domain/activity/index.js'

export const RUN2SKILL_ALPHA_SCHEMA_CONTRACT = Object.freeze({
  release: '0.1.1-alpha',
  dshBaselineCommit: '141eb6fef83422698aef7a981029e843e8161534',
  domainName: 'run2skill_v1',
  domainVersion: 2,
  globalSchemaVersion: 1,
  workItemSchemaVersion: 1,
  lineageSchemaVersion: 1,
} as const)

export function createInitialGlobalV1(): GlobalV1 {
  return {
    schemaVersion: 1,
    activeTriggerPolicyVersion: 'cheap-trigger-v1',
    sessions: {},
    health: { counts: {} },
    recovery: { recoveryLag: false },
    checkpoint: { dirty: false, pendingSessionCount: 0 },
    recentSkillActivity: emptyRecentSkillActivityIndex(),
  }
}

export const run2skillDomainSpec = {
  name: RUN2SKILL_ALPHA_SCHEMA_CONTRACT.domainName,
  // Pre-alpha schema break: legacy candidate-root approvals are intentionally not
  // opened under the stock-contract schema. Development data is rebuilt once.
  version: RUN2SKILL_ALPHA_SCHEMA_CONTRACT.domainVersion,
  global: {
    schema: GlobalV1Schema,
    initial: createInitialGlobalV1(),
  },
  tables: {
    work_items: { valueSchema: CaptureWorkItemV1Schema },
    lineages: { valueSchema: LineageV1Schema },
  },
} as const

export async function openRun2skillDomain(
  context: import('./types.js').Run2skillStorageContext,
): Promise<import('./types.js').Run2skillDomain> {
  const domain = await context.storageDomain.open(run2skillDomainSpec)
  if (domain.name !== run2skillDomainSpec.name) throw new Error('run2skill domain name mismatch')
  return domain
}
