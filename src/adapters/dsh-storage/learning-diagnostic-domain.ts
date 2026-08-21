import { LearningDiagnosticHealthV1Schema, LearningDiagnosticRecordV1Schema } from '../../domain/learn/index.js'
import type { LearningDiagnosticHealthV1, LearningDiagnosticRecordV1 } from '../../domain/learn/index.js'
import type { Run2skillTable } from './types.js'

export const learningDiagnosticDomainSpec = {
  name: 'run2skill_learning_diagnostics_v1',
  version: 1,
  tables: {
    terminal_details: { valueSchema: LearningDiagnosticRecordV1Schema },
    health_checks: { valueSchema: LearningDiagnosticHealthV1Schema },
  },
} as const

export interface LearningDiagnosticDomain {
  readonly name: 'run2skill_learning_diagnostics_v1'
  table(name: 'terminal_details'): Run2skillTable<string, LearningDiagnosticRecordV1>
  table(name: 'health_checks'): Run2skillTable<string, LearningDiagnosticHealthV1>
  close(): Promise<void>
}

export async function openLearningDiagnosticDomain(context: {
  readonly storageDomain: import('./types.js').Run2skillStorageContext['storageDomain']
}): Promise<LearningDiagnosticDomain> {
  const domain = await context.storageDomain.open(learningDiagnosticDomainSpec)
  if (domain.name !== learningDiagnosticDomainSpec.name) {
    throw new Error('Learning diagnostic domain name mismatch')
  }
  return domain
}
