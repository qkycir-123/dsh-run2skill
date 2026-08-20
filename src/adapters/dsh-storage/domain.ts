import {
  CaptureWorkItemV1Schema,
  GlobalV1Schema,
  type GlobalV1,
} from '../../domain/observe/schemas.js'
import { LineageV1Schema } from '../../domain/publication/index.js'

export function createInitialGlobalV1(): GlobalV1 {
  return {
    schemaVersion: 1,
    activeTriggerPolicyVersion: 'cheap-trigger-v1',
    sessions: {},
    health: { counts: {} },
    recovery: { recoveryLag: false },
    checkpoint: { dirty: false, pendingSessionCount: 0 },
  }
}

export const run2skillDomainSpec = {
  name: 'run2skill_v1',
  // Pre-alpha schema break: legacy candidate-root approvals are intentionally not
  // opened under the stock-contract schema. Development data is rebuilt once.
  version: 2,
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
  return await context.storageDomain.open(run2skillDomainSpec)
}
