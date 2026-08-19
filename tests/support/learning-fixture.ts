import {
  deriveExperienceId,
  deriveLearningProposalId,
  type ExperienceRecordV1,
  type LearningProposalV1,
} from '../../src/domain/learn/index.js'
import { makeWorkItem } from './work-item-fixture.js'

export interface LearningResultFixture {
  experiences: ExperienceRecordV1[]
  proposal: LearningProposalV1
}

export function makeLearningResult(item = makeWorkItem()): LearningResultFixture {
  const experienceFacts = {
    type: 'CONSTRAINT' as const,
    lesson: 'Keep generated files out of source control.',
    persistenceScope: 'PROJECT' as const,
    evidenceStrength: 'HIGH' as const,
    supportingEvidence: [{
      messageSeq: item.evidenceRefs[0]!.messageSeq,
      excerptDigest: item.evidenceRefs[0]!.excerptDigest,
    }],
  }
  const experience: ExperienceRecordV1 = {
    experienceId: deriveExperienceId(item.workItemId, experienceFacts),
    ...experienceFacts,
  }
  const proposalFacts = {
    policyVersion: 'learning-v1' as const,
    name: 'generated-file-hygiene',
    description: 'Keep generated files out of source control.',
    whenToUse: 'Use for generated output.',
    content: '# Generated file hygiene\n\nDo not commit generated output.',
    invocation: { modelInvocable: true as const, userInvocable: false as const },
    persistenceScope: 'PROJECT' as const,
    supportingExperienceIds: [experience.experienceId],
    curation: { decision: 'CREATE' as const, rationale: 'No existing Skill matched.' },
    catalogObservationDigest: 'c'.repeat(64),
    shortlistDigests: [],
  }
  return {
    experiences: [experience],
    proposal: {
      learningProposalId: deriveLearningProposalId(item.workItemId, proposalFacts),
      ...proposalFacts,
    },
  }
}
