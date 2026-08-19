import { sha256Utf8 } from '../../src/domain/observe/hashing.js'
import {
  materializeProposalSnapshot,
  type ProposalSnapshotFactsV1,
} from '../../src/domain/review/index.js'
import { makeLearningResult } from './learning-fixture.js'
import { makeWorkItem } from './work-item-fixture.js'

export function makeLearnedWorkItem(overrides: Parameters<typeof makeWorkItem>[0] = {}) {
  const item = makeWorkItem({
    workspaceBinding: {
      status: 'BOUND',
      workspaceId: 'workspace-fixture',
      canonicalPath: 'D:\\workspace',
      observedAt: '2026-08-20T00:00:00.000Z',
    },
    ...overrides,
  })
  const result = makeLearningResult(item)
  return makeWorkItem({
    workspaceBinding: item.workspaceBinding,
    ...overrides,
    signalKey: item.signalKey,
    workItemId: item.workItemId,
    processingState: 'LEARNED',
    learning: {
      policyVersion: 'learning-v1',
      attempt: 1,
      requestBudgetUsed: 1,
      calls: [{ requestOrdinal: 1, kind: 'PRIMARY', outcome: 'SUCCEEDED' }],
      experiences: result.experiences,
      proposal: result.proposal,
    },
  })
}

export function makeCreateProposalSnapshot(item = makeLearnedWorkItem()) {
  const proposal = item.learning!.proposal!
  const exactSkillBytes = '---\nname: generated-file-hygiene\ndescription: Keep generated files out of source control.\nuser-invocable: false\n---\n\n# Generated file hygiene\n'
  const facts: ProposalSnapshotFactsV1 = {
    schemaVersion: 1,
    revision: 1,
    createdAt: '2026-08-20T00:00:00.000Z',
    sourceLearningProposalId: proposal.learningProposalId,
    kind: 'CREATE',
    name: proposal.name,
    description: proposal.description,
    whenToUse: proposal.whenToUse,
    invocation: proposal.invocation,
    exactSkillBytes,
    skillBytesDigest: sha256Utf8(exactSkillBytes),
    rendererVersion: 'skill-renderer-v1',
    persistenceScope: 'PROJECT',
    workspaceBinding: {
      workspaceId: item.workspaceBinding.status === 'BOUND'
        ? item.workspaceBinding.workspaceId
        : 'workspace-fixture',
      canonicalPath: item.workspaceBinding.status === 'BOUND'
        ? item.workspaceBinding.canonicalPath
        : 'D:\\workspace',
      observedAt: '2026-08-20T00:00:00.000Z',
    },
    supportingExperienceIds: proposal.supportingExperienceIds,
    catalogObservationDigest: 'c'.repeat(64),
    curationRationale: 'No matching Skill exists in the complete catalog.',
    actionBinding: {
      kind: 'CREATE',
      rootBinding: {
        state: 'ABSENT',
        scope: 'PROJECT',
        provider: 'filesystem',
        source: 'project-dsh',
        resolverVersion: 'root-resolver-v1',
        observationDigest: 'a'.repeat(64),
        declaredRootPath: 'D:\\workspace\\.dsh\\skills',
        canonicalExistingAncestorPath: 'D:\\workspace',
        ancestorIdentityDigest: 'b'.repeat(64),
        missingSegments: ['.dsh', 'skills'],
      },
      targetBinding: {
        skillName: proposal.name,
        bundlePath: 'D:\\workspace\\.dsh\\skills\\generated-file-hygiene',
        skillFilePath: 'D:\\workspace\\.dsh\\skills\\generated-file-hygiene\\SKILL.md',
      },
      expectedAbsence: {
        catalogObservationDigest: 'c'.repeat(64),
        observedAt: '2026-08-20T00:00:00.000Z',
        bundlePathAbsent: true,
        skillFilePathAbsent: true,
      },
    },
  }
  return materializeProposalSnapshot(item.workItemId, facts)
}

export function makeDiscardProposalSnapshot(item = makeLearnedWorkItem()) {
  const create = makeCreateProposalSnapshot(item)
  const { proposalId: _proposalId, digest: _digest, ...facts } = create
  return materializeProposalSnapshot(item.workItemId, {
    ...facts,
    revision: 1,
    kind: 'DISCARD',
    actionBinding: {
      kind: 'DISCARD',
      coveringCandidateBinding: {
        candidateKey: `cand_${'d'.repeat(64)}`,
        provider: 'filesystem',
        source: 'bundled',
        path: 'D:\\bundled\\generated-file-hygiene\\SKILL.md',
        exactBytes: create.exactSkillBytes,
        bytesDigest: create.skillBytesDigest,
        catalogObservationDigest: create.catalogObservationDigest,
        observedAt: '2026-08-20T00:00:00.000Z',
      },
    },
  })
}
