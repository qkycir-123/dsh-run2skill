import { describe, expect, it } from 'vitest'
import {
  DshV2OwnershipObservationAdapter,
  deriveOwnershipTargetPathDigest,
} from '../src/adapters/dsh-skills/v2-ownership-observation.js'
import { AgentFirstOwnershipCoordinator } from '../src/application/ownership/index.js'
import { canonicalJson } from '../src/domain/learn/identity.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import { deriveSessionBatchIdV2, SessionBatchV2Schema } from '../src/domain/v2/index.js'
import { deriveSessionCwdDigest, deriveSessionLifecycleKey } from '../src/domain/observe/signal-key.js'
import type { DshSessionEvent, DshSessionHeader, SessionPersistenceSnapshot } from '../src/adapters/dsh-session/types.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'

const header: DshSessionHeader = { version: 1, id: 'session-v2', createdAt: 100, cwd: 'D:\\repo' }
const skillPath = 'D:\\repo\\.dsh\\skills\\fixture-workflow\\SKILL.md'
const exactSkillBody = [
  '# Fixture workflow', '', 'Apply the fixture workflow.', '',
  'Observe', '', 'Verify', '', 'Do not skip verification',
].join('\n')
const exactSkillBytes = [
  '---', 'name: fixture-workflow', 'description: Apply the fixture workflow.', '---', '',
  exactSkillBody, '',
].join('\n')

function candidate(
  body = exactSkillBody,
  scope: 'PROJECT' | 'USER' = 'PROJECT',
  targetPath = skillPath,
) {
  return {
    candidateId: 'candidate-fixture', name: 'fixture-workflow', provider: 'filesystem', source: 'project-dsh',
    scope, writable: true,
    targetPathDigest: deriveOwnershipTargetPathDigest(targetPath, header.cwd),
    bodyDigest: sha256Utf8(body),
  }
}

function event(type: string, seq: number, data: unknown): DshSessionEvent {
  return { type, seq, time: 1_725_000_000_000 + seq, data }
}

function toolResult(seq: number, callId: string, isError = false): DshSessionEvent {
  return event('tool/result', seq, {
    turn: 2, step: 1,
    message: {
      role: 'user',
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, isError, content: [] }],
    },
  })
}

function harness(options: {
  readonly baselineCandidates?: readonly ReturnType<typeof candidate>[]
  readonly endCandidates?: readonly ReturnType<typeof candidate>[]
  readonly between?: readonly DshSessionEvent[]
  readonly snapshots?: readonly SessionPersistenceSnapshot[][]
  readonly seqOffset?: number
  readonly turnEndSeq?: number
  readonly onReadFrom?: (fromSeq: number) => void
  readonly resolveTargetPathDigest?: (path: string, cwd?: string) => Promise<string | undefined>
  readonly sessionAvailable?: boolean
  readonly resolvedHeader?: DshSessionHeader
  readonly resolveSessionError?: Error
  readonly readFromError?: Error
  readonly manifestError?: Error
}) {
  const fixture = createMinimalV2Fixtures()
  const seqOffset = options.seqOffset ?? 0
  const turnEndSeq = options.turnEndSeq ?? 8 + seqOffset
  const baselineCandidates = [...(options.baselineCandidates ?? [])]
  const endCandidates = [...(options.endCandidates ?? [])]
  const manifestUnchanged = JSON.stringify(baselineCandidates) === JSON.stringify(endCandidates)
  const observationManifest = fixture.sessionBatch.observationManifest.map(entry => ({
    ...entry, turnStartSeq: entry.turnStartSeq + seqOffset, turnEndSeq,
  }))
  const batchFacts = {
    sessionLifecycleKey: fixture.sessionBatch.sessionLifecycleKey,
    firstTurnEndSeq: turnEndSeq,
    lastTurnEndSeq: turnEndSeq,
    detectorPolicyVersion: fixture.sessionBatch.detectorPolicyVersion,
  }
  const batch = SessionBatchV2Schema.parse({
    ...fixture.sessionBatch,
    ...batchFacts,
    batchId: deriveSessionBatchIdV2(batchFacts),
    observationManifest,
    observationManifestDigest: sha256Utf8(canonicalJson(observationManifest)),
    batchManifestBaseline: {
      ...fixture.sessionBatch.batchManifestBaseline,
      ownershipCandidates: baselineCandidates,
    },
  })
  const events = [
    event('turn/start', 1 + seqOffset, { turn: 2 }),
    ...(options.between ?? []).map(item => ({ ...item, seq: item.seq + seqOffset })),
    event('turn/end', turnEndSeq, { turn: 2, reason: { kind: 'completed' } }),
  ]
  let snapshotRead = 0
  const adapter = new DshV2OwnershipObservationAdapter({
    persistence: {
      async listSnapshots() {
        const values = options.snapshots ?? [[{ header, revision: 'jsonl:8' }]]
        return values[Math.min(snapshotRead++, values.length - 1)]!
      },
      async readFrom(_sessionId, fromSeq) {
        if (options.readFromError !== undefined) throw options.readFromError
        options.onReadFrom?.(fromSeq)
        return { meta: header, events: events.filter(item => item.seq >= fromSeq) }
      },
    },
    resolveSession: key => {
      if (options.resolveSessionError !== undefined) throw options.resolveSessionError
      return options.sessionAvailable !== false && key === batch.sessionLifecycleKey
        ? { header: options.resolvedHeader ?? header }
        : undefined
    },
    manifest: {
      capture: async () => {
        if (options.manifestError !== undefined) throw options.manifestError
        return {
          observedAt: '2026-08-22T01:00:00.000Z',
          rootManifestDigest: manifestUnchanged ? batch.batchManifestBaseline.rootManifestDigest : '9'.repeat(64),
          runtimeCatalogDigest: manifestUnchanged ? batch.batchManifestBaseline.runtimeCatalogDigest : '8'.repeat(64),
          complete: true,
          ownershipCandidates: endCandidates,
        }
      },
    },
    now: () => Date.parse('2026-08-22T01:00:00.000Z'),
    ...(options.resolveTargetPathDigest === undefined
      ? {}
      : { resolveTargetPathDigest: options.resolveTargetPathDigest }),
  })
  return { adapter, batch, intent: fixture.experienceIntent }
}

async function decideWithRealAdapter(
  observed: ReturnType<typeof harness>,
) {
  const domain = createMemoryRun2skillV2Domain()
  const batch = SessionBatchV2Schema.parse({
    ...observed.batch,
    revision: observed.batch.revision + 1,
    detector: {
      result: 'READY',
      calls: [{
        stage: 'DETECTION', callId: `call_${'3'.repeat(64)}`, ordinal: 1,
        inputDigest: '4'.repeat(64), provider: observed.batch.routeSnapshot.provider,
        model: observed.batch.routeSnapshot.model, policyVersion: observed.batch.routeSnapshot.policyVersion,
        outcome: 'SUCCEEDED', outputDigest: '5'.repeat(64),
      }],
      intentIds: [observed.intent.intentId], carry: [],
    },
    state: 'COMMITTED_READY',
  })
  await domain.table('session_batches').put(batch.batchId, batch)
  await domain.table('experience_intents').put(observed.intent.intentId, observed.intent)
  const coordinator = new AgentFirstOwnershipCoordinator(domain, {
    observation: observed.adapter,
    quiescence: { validate: async () => 'VALID' },
    now: () => Date.parse('2026-08-22T01:00:00.000Z'),
  })
  await coordinator.runOnce()
  return domain.experienceIntents.get(observed.intent.intentId)
}

describe('real DSH Agent-first ownership observation adapter', () => {
  it('attributes Agent writes with the exact context-filesystem target identity', async () => {
    const targetPathDigest = sha256Utf8(canonicalJson({
      contract: 'dsh-fs-target-v1',
      targetKeyDigest: sha256Utf8('ctxfs://fixture-skill'),
    }))
    const created = { ...candidate(), targetPathDigest }
    const aliasPath = '.dsh/skills/fixture-workflow/SKILL.md'
    const { adapter, batch, intent } = harness({
      baselineCandidates: [],
      endCandidates: [created],
      resolveTargetPathDigest: async path => path === aliasPath ? targetPathDigest : undefined,
      between: [
        event('tool/call', 3, {
          turn: 2, step: 1, callId: 'call-context-fs', name: 'write',
          arguments: JSON.stringify({ file_path: aliasPath, content: exactSkillBytes }),
        }),
        toolResult(4, 'call-context-fs'),
      ],
    })

    await expect(adapter.observe({ batch, intent, inputDigest: 'd'.repeat(64) })).resolves.toMatchObject({
      status: 'OBSERVED',
      toolEvidenceComplete: true,
      agentActivity: 'WRITE_SUCCEEDED',
      changedCandidates: [{
        candidateId: created.candidateId,
        writeAttribution: 'AGENT_WRITE_SUCCEEDED',
        intentBinding: 'MATCH',
      }],
    })
  })

  it('reads only a bounded suffix for a late SessionBatch', async () => {
    let observedFromSeq = -1
    const observed = harness({
      baselineCandidates: [candidate()], endCandidates: [candidate()],
      seqOffset: 20_000,
      onReadFrom: fromSeq => { observedFromSeq = fromSeq },
    })

    await expect(observed.adapter.observe({
      batch: observed.batch, intent: observed.intent, inputDigest: 'd'.repeat(64),
    })).resolves.toMatchObject({ status: 'OBSERVED', agentActivity: 'NONE' })
    expect(observedFromSeq).toBe(observed.batch.observationManifest[0]!.turnStartSeq)
  })

  it('keeps a complete Turn with more than ten thousand assistant chunks', async () => {
    const assistantChunks = Array.from({ length: 12_000 }, (_, index) => (
      event('assistant/chunk', index + 2, { turn: 2, step: 1, delta: 'x' })
    ))
    let observedFromSeq = -1
    const observed = harness({
      baselineCandidates: [candidate()],
      endCandidates: [candidate()],
      between: assistantChunks,
      turnEndSeq: 12_002,
      onReadFrom: fromSeq => { observedFromSeq = fromSeq },
    })

    await expect(observed.adapter.observe({
      batch: observed.batch, intent: observed.intent, inputDigest: 'd'.repeat(64),
    })).resolves.toMatchObject({
      status: 'OBSERVED', toolEvidenceComplete: true, agentActivity: 'NONE',
    })
    expect(observedFromSeq).toBe(1)
  })

  it('proves no Agent Skill activity from a stable unchanged manifest and complete tool evidence', async () => {
    const ordinaryPath = 'D:\\repo\\game\\index.html'
    const { adapter, batch, intent } = harness({
      baselineCandidates: [candidate()], endCandidates: [candidate()],
      between: [
        event('assistant/message', 2, {
          turn: 2, step: 1,
          message: {
            role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
            content: [{ type: 'text', text: 'I will update the game and verify it.' }],
          },
        }),
        event('tool/call', 3, { turn: 2, step: 1, callId: 'call-1', name: 'write', arguments: JSON.stringify({ file_path: ordinaryPath, content: '<html />' }) }),
        toolResult(4, 'call-1'),
      ],
    })

    await expect(adapter.observe({ batch, intent, inputDigest: 'd'.repeat(64) })).resolves.toMatchObject({
      status: 'OBSERVED', inputDigest: 'd'.repeat(64), catalogComplete: true,
      toolEvidenceComplete: true, agentActivity: 'NONE', changedCandidates: [],
    })
  })

  it('does not treat a failed edit of a non-Markdown source file as an attempted Skill save', async () => {
    const observed = harness({
      baselineCandidates: [candidate()], endCandidates: [candidate()],
      between: [
        event('tool/call', 3, {
          turn: 2, step: 1, callId: 'call-source-edit', name: 'edit',
          arguments: JSON.stringify({
            file_path: 'D:\\repo\\normalize-query.mjs', old_string: 'same', new_string: 'same',
          }),
        }),
        toolResult(4, 'call-source-edit', true),
      ],
    })

    await expect(observed.adapter.observe({
      batch: observed.batch, intent: observed.intent, inputDigest: 'd'.repeat(64),
    })).resolves.toMatchObject({
      status: 'OBSERVED', toolEvidenceComplete: true, agentActivity: 'NONE', changedCandidates: [],
    })
    await expect(decideWithRealAdapter(observed)).resolves.toMatchObject({
      status: 'RUN2SKILL_OWNED', ownership: { reasonCode: 'NO_AGENT_SKILL_ACTIVITY' },
    })
  })

  it('ignores rc.8 inbox and automatic-title control events that cannot write Skill files', async () => {
    const observed = harness({
      baselineCandidates: [candidate()], endCandidates: [candidate()],
      between: [
        event('agent/inbox/spliced', 2, {
          target: 'next-turn', start: 0, removedCount: 0, inserted: [],
        }),
        event('session/title-llm-request', 3, {
          provider: 'fixture', model: 'fixture', messageSeqs: [1],
        }),
        event('session/title', 4, {
          title: 'Fixture title', messageSeqs: [1], source: { kind: 'provider', provider: 'fixture' },
        }),
      ],
    })

    await expect(observed.adapter.observe({
      batch: observed.batch, intent: observed.intent, inputDigest: 'd'.repeat(64),
    })).resolves.toMatchObject({
      status: 'OBSERVED', toolEvidenceComplete: true, agentActivity: 'NONE', changedCandidates: [],
    })
  })

  it('keeps standard-mode approval control events inside a complete ownership window', async () => {
    const observed = harness({
      baselineCandidates: [candidate()], endCandidates: [candidate()],
      between: [
        event('approval/asked', 2, {
          turn: 2, step: 1, approvalId: 'approval-1', toolCallId: 'call-1',
        }),
        event('approval/decided', 3, {
          turn: 2, step: 1, approvalId: 'approval-1', decision: 'approved',
        }),
      ],
    })

    await expect(observed.adapter.observe({
      batch: observed.batch, intent: observed.intent, inputDigest: 'd'.repeat(64),
    })).resolves.toMatchObject({
      status: 'OBSERVED', toolEvidenceComplete: true, agentActivity: 'NONE', changedCandidates: [],
    })
  })

  it('binds one exact successful Agent write to one matching new Skill', async () => {
    const created = candidate()
    const { adapter, batch, intent } = harness({
      baselineCandidates: [], endCandidates: [created],
      between: [
        event('tool/call', 3, { turn: 2, step: 1, callId: 'call-1', name: 'write', arguments: JSON.stringify({ file_path: skillPath, content: exactSkillBytes }) }),
        toolResult(4, 'call-1'),
        event('assistant/message', 5, {
          turn: 2, step: 1,
          message: {
            role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
            content: [{ type: 'text', text: `Saved the Skill:\n\n${exactSkillBytes}` }],
          },
        }),
      ],
    })

    const observed = await adapter.observe({ batch, intent, inputDigest: 'd'.repeat(64) })
    expect(observed).toMatchObject({
      status: 'OBSERVED', catalogComplete: true, toolEvidenceComplete: true,
      agentActivity: 'WRITE_SUCCEEDED',
      changedCandidates: [{
        candidateId: created.candidateId, exactReadbackComplete: true,
        bodyDigest: created.bodyDigest, writeAttribution: 'AGENT_WRITE_SUCCEEDED', intentBinding: 'MATCH',
      }],
    })
  })

  it('binds an exact successful same-content rewrite of an existing Skill', async () => {
    const existing = candidate()
    const observed = harness({
      baselineCandidates: [existing], endCandidates: [existing],
      between: [
        event('tool/call', 3, {
          turn: 2, step: 1, callId: 'call-rewrite', name: 'write',
          arguments: JSON.stringify({ file_path: skillPath, content: exactSkillBytes }),
        }),
        toolResult(4, 'call-rewrite'),
      ],
    })

    await expect(observed.adapter.observe({
      batch: observed.batch, intent: observed.intent, inputDigest: 'd'.repeat(64),
    })).resolves.toMatchObject({
      agentActivity: 'WRITE_SUCCEEDED',
      changedCandidates: [{
        candidateId: existing.candidateId,
        writeAttribution: 'AGENT_WRITE_SUCCEEDED', intentBinding: 'MATCH',
      }],
    })
    await expect(decideWithRealAdapter(observed)).resolves.toMatchObject({
      status: 'RESOLVED_BY_AGENT',
      ownership: { reasonCode: 'AGENT_SAVED_MATCHING_SKILL', resolvedCandidateId: existing.candidateId },
    })
  })

  it('does not let an unmatched failed mutation hide behind an exact same-content Skill rewrite', async () => {
    const customPath = 'D:\\repo\\custom-root\\existing.md'
    const existing = {
      ...candidate(exactSkillBody, 'PROJECT', customPath),
      candidateId: 'candidate-custom-existing', source: 'custom', writable: false,
    }
    const observed = harness({
      baselineCandidates: [existing], endCandidates: [existing],
      between: [
        event('tool/call', 2, {
          turn: 2, step: 1, callId: 'call-rewrite', name: 'write',
          arguments: JSON.stringify({ file_path: customPath, content: exactSkillBytes }),
        }),
        toolResult(3, 'call-rewrite'),
        event('tool/call', 4, {
          turn: 2, step: 1, callId: 'call-failed-flat', name: 'edit',
          arguments: JSON.stringify({
            file_path: 'D:\\repo\\custom-root\\new-flat.md', old_string: 'old', new_string: 'new',
          }),
        }),
        toolResult(5, 'call-failed-flat', true),
      ],
    })

    await expect(observed.adapter.observe({
      batch: observed.batch, intent: observed.intent, inputDigest: 'd'.repeat(64),
    })).resolves.toMatchObject({ agentActivity: 'WRITE_FAILED' })
    await expect(decideWithRealAdapter(observed)).resolves.toMatchObject({
      status: 'NEEDS_CONFIRMATION', ownership: { reasonCode: 'AGENT_WRITE_FAILED' },
    })
  })

  it('does not bind a matching body saved to a different persistence scope', async () => {
    const userCandidate = { ...candidate(exactSkillBody, 'USER'), candidateId: 'candidate-user' }
    const observed = harness({
      baselineCandidates: [], endCandidates: [userCandidate],
      between: [
        event('tool/call', 3, { turn: 2, step: 1, callId: 'call-1', name: 'write', arguments: JSON.stringify({ file_path: skillPath, content: exactSkillBytes }) }),
        toolResult(4, 'call-1'),
      ],
    })

    await expect(observed.adapter.observe({
      batch: observed.batch, intent: observed.intent, inputDigest: 'd'.repeat(64),
    })).resolves.toMatchObject({
      agentActivity: 'WRITE_SUCCEEDED',
      changedCandidates: [{
        candidateId: userCandidate.candidateId,
        scope: 'USER', writeAttribution: 'AGENT_WRITE_SUCCEEDED', intentBinding: 'NO_MATCH',
      }],
    })
    await expect(decideWithRealAdapter(observed)).resolves.toMatchObject({
      status: 'NEEDS_CONFIRMATION', ownership: { reasonCode: 'AGENT_WRITE_NOT_BOUND' },
    })
  })

  it.each([
    ['successful write followed by failed write', false],
    ['failed write followed by successful write', true],
  ])('fails closed on %s to the same Skill', async (_label, failedFirst) => {
    const firstFailed = failedFirst === true
    const observed = harness({
      baselineCandidates: [], endCandidates: [candidate()],
      between: [
        event('tool/call', 2, { turn: 2, step: 1, callId: 'call-1', name: 'write', arguments: JSON.stringify({ file_path: skillPath, content: exactSkillBytes }) }),
        toolResult(3, 'call-1', firstFailed),
        event('tool/call', 4, { turn: 2, step: 1, callId: 'call-2', name: 'write', arguments: JSON.stringify({ file_path: skillPath, content: exactSkillBytes }) }),
        toolResult(5, 'call-2', !firstFailed),
      ],
    })

    await expect(observed.adapter.observe({
      batch: observed.batch, intent: observed.intent, inputDigest: 'd'.repeat(64),
    })).resolves.toMatchObject({ agentActivity: 'WRITE_FAILED' })
    await expect(decideWithRealAdapter(observed)).resolves.toMatchObject({
      status: 'NEEDS_CONFIRMATION', ownership: { reasonCode: 'AGENT_WRITE_FAILED' },
    })
  })

  it.each([
    ['one failed native edit', false],
    ['a successful write followed by a failed native edit', true],
  ])('recognizes %s against an effective custom-root Skill', async (_label, includeSuccessfulWrite) => {
    const customPath = 'D:\\repo\\custom-root\\legacy.md'
    const customCandidate = {
      ...candidate(exactSkillBody, 'PROJECT', customPath),
      candidateId: 'candidate-custom', source: 'custom', writable: false,
    }
    const successfulWrite = includeSuccessfulWrite
      ? [
          event('tool/call', 2, { turn: 2, step: 1, callId: 'call-write', name: 'write', arguments: JSON.stringify({ file_path: customPath, content: exactSkillBytes }) }),
          toolResult(3, 'call-write'),
        ]
      : []
    const observed = harness({
      baselineCandidates: includeSuccessfulWrite ? [] : [customCandidate],
      endCandidates: [customCandidate],
      between: [
        ...successfulWrite,
        event('tool/call', 4, {
          turn: 2, step: 1, callId: 'call-edit', name: 'str_replace_editor',
          arguments: JSON.stringify({ path: customPath, command: 'str_replace', old_str: 'old', new_str: 'new' }),
        }),
        toolResult(5, 'call-edit', true),
      ],
    })

    await expect(observed.adapter.observe({
      batch: observed.batch, intent: observed.intent, inputDigest: 'd'.repeat(64),
    })).resolves.toMatchObject({ agentActivity: 'WRITE_FAILED' })
    await expect(decideWithRealAdapter(observed)).resolves.toMatchObject({
      status: 'NEEDS_CONFIRMATION', ownership: { reasonCode: 'AGENT_WRITE_FAILED' },
    })
  })

  it.each([
    ['edit', { file_path: 'custom-root/legacy.md', old_string: 'old', new_string: 'new' }],
    ['str_replace_editor', { path: 'custom-root/legacy.md', command: 'str_replace', old_str: 'old', new_str: 'new' }],
  ])('recognizes a failed %s using a forward-slash path relative to a Windows cwd', async (name, args) => {
    const customPath = 'D:\\repo\\custom-root\\legacy.md'
    const customCandidate = {
      ...candidate(exactSkillBody, 'PROJECT', customPath),
      candidateId: 'candidate-custom-relative', source: 'custom', writable: false,
    }
    const observed = harness({
      baselineCandidates: [customCandidate], endCandidates: [customCandidate],
      between: [
        event('tool/call', 3, {
          turn: 2, step: 1, callId: 'call-relative', name,
          arguments: JSON.stringify(args),
        }),
        toolResult(4, 'call-relative', true),
      ],
    })

    await expect(observed.adapter.observe({
      batch: observed.batch, intent: observed.intent, inputDigest: 'd'.repeat(64),
    })).resolves.toMatchObject({ agentActivity: 'WRITE_FAILED' })
    await expect(decideWithRealAdapter(observed)).resolves.toMatchObject({
      status: 'NEEDS_CONFIRMATION', ownership: { reasonCode: 'AGENT_WRITE_FAILED' },
    })
  })

  it('fails closed when a tool result precedes its matching write call', async () => {
    const observed = harness({
      baselineCandidates: [], endCandidates: [candidate()],
      between: [
        toolResult(2, 'call-1'),
        event('tool/call', 3, { turn: 2, step: 1, callId: 'call-1', name: 'write', arguments: JSON.stringify({ file_path: skillPath, content: exactSkillBytes }) }),
      ],
    })

    await expect(observed.adapter.observe({
      batch: observed.batch, intent: observed.intent, inputDigest: 'd'.repeat(64),
    })).resolves.toMatchObject({ toolEvidenceComplete: false, agentActivity: 'AMBIGUOUS' })
    await expect(decideWithRealAdapter(observed)).resolves.toMatchObject({
      status: 'NEEDS_CONFIRMATION', ownership: { reasonCode: 'TOOL_EVIDENCE_INCOMPLETE' },
    })
  })

  it('treats str_replace_editor view of an existing Skill as read-only', async () => {
    const observed = harness({
      baselineCandidates: [candidate()], endCandidates: [candidate()],
      between: [
        event('tool/call', 3, {
          turn: 2, step: 1, callId: 'call-view', name: 'str_replace_editor',
          arguments: JSON.stringify({ command: 'view', path: skillPath }),
        }),
        toolResult(4, 'call-view'),
      ],
    })

    await expect(observed.adapter.observe({
      batch: observed.batch, intent: observed.intent, inputDigest: 'd'.repeat(64),
    })).resolves.toMatchObject({ toolEvidenceComplete: true, agentActivity: 'NONE', changedCandidates: [] })
    await expect(decideWithRealAdapter(observed)).resolves.toMatchObject({
      status: 'RUN2SKILL_OWNED', ownership: { reasonCode: 'NO_AGENT_SKILL_ACTIVITY' },
    })
  })

  it.each([
    ['edit', {
      file_path: 'D:\\repo\\notes.md', old_string: 'placeholder', new_string: exactSkillBytes,
    }],
    ['str_replace_editor', {
      command: 'str_replace', path: 'D:\\repo\\notes.md', old_str: 'placeholder', new_str: exactSkillBytes,
    }],
    ['str_replace_editor', {
      command: 'insert', path: 'D:\\repo\\notes.md', insert_line: 0, new_str: exactSkillBytes,
    }],
  ])('detects a complete Skill body carried by %s mutation text', async (name, args) => {
    const observed = harness({
      baselineCandidates: [candidate()], endCandidates: [candidate()],
      between: [
        event('tool/call', 3, {
          turn: 2, step: 1, callId: 'call-body', name, arguments: JSON.stringify(args),
        }),
        toolResult(4, 'call-body'),
      ],
    })

    await expect(observed.adapter.observe({
      batch: observed.batch, intent: observed.intent, inputDigest: 'd'.repeat(64),
    })).resolves.toMatchObject({ toolEvidenceComplete: true, agentActivity: 'BODY_GENERATED' })
    await expect(decideWithRealAdapter(observed)).resolves.toMatchObject({
      status: 'NEEDS_CONFIRMATION', ownership: { reasonCode: 'AGENT_BODY_GENERATED' },
    })
  })

  it('fails closed on structurally ambiguous Skill text carried by a mutation', async () => {
    const observed = harness({
      baselineCandidates: [candidate()], endCandidates: [candidate()],
      between: [
        event('tool/call', 3, {
          turn: 2, step: 1, callId: 'call-ambiguous-body', name: 'edit',
          arguments: JSON.stringify({
            file_path: 'D:\\repo\\notes.md', old_string: 'placeholder',
            new_string: '---\nname: unfinished-workflow',
          }),
        }),
        toolResult(4, 'call-ambiguous-body'),
      ],
    })

    await expect(observed.adapter.observe({
      batch: observed.batch, intent: observed.intent, inputDigest: 'd'.repeat(64),
    })).resolves.toMatchObject({ toolEvidenceComplete: true, agentActivity: 'AMBIGUOUS' })
    await expect(decideWithRealAdapter(observed)).resolves.toMatchObject({
      status: 'NEEDS_CONFIRMATION', ownership: { reasonCode: 'AGENT_ACTIVITY_AMBIGUOUS' },
    })
  })

  it('does not bind an unrelated body when the Intent contract appears only in frontmatter', async () => {
    const fixture = createMinimalV2Fixtures()
    const metadataOnly = [
      fixture.experienceIntent.applicabilitySummary,
      ...fixture.experienceIntent.keySteps,
      ...fixture.experienceIntent.prohibitions,
    ].join(' ')
    const raw = [
      '---', 'name: fixture-workflow', 'description: Apply an unrelated workflow.',
      `metadata: ${metadataOnly}`, '---', '', '# Unrelated placeholder', '',
    ].join('\n')
    const created = candidate('# Unrelated placeholder')
    const observed = harness({
      baselineCandidates: [], endCandidates: [created],
      between: [
        event('tool/call', 3, {
          turn: 2, step: 1, callId: 'call-1', name: 'write',
          arguments: JSON.stringify({ file_path: skillPath, content: raw }),
        }),
        toolResult(4, 'call-1'),
      ],
    })

    await expect(observed.adapter.observe({
      batch: observed.batch, intent: observed.intent, inputDigest: 'd'.repeat(64),
    })).resolves.toMatchObject({
      changedCandidates: [{
        bodyDigest: created.bodyDigest,
        writeAttribution: 'AGENT_WRITE_SUCCEEDED',
        intentBinding: 'NO_MATCH',
      }],
    })
    await expect(decideWithRealAdapter(observed)).resolves.not.toMatchObject({ status: 'RESOLVED_BY_AGENT' })
  })

  it('fails closed when Agent emits a complete Skill with frontmatter larger than 4 KiB', async () => {
    const largeSkill = [
      '---', 'name: large-metadata-workflow', 'description: A complete generated Skill.',
      `metadata: ${'x'.repeat(4_200)}`, '---', '', exactSkillBody, '',
    ].join('\n')
    const observed = harness({
      baselineCandidates: [candidate()], endCandidates: [candidate()],
      between: [event('assistant/message', 3, {
        turn: 2, step: 1,
        message: {
          role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
          content: [{ type: 'text', text: largeSkill }],
        },
      })],
    })

    await expect(decideWithRealAdapter(observed)).resolves.toMatchObject({
      status: 'NEEDS_CONFIRMATION', ownership: { reasonCode: 'AGENT_BODY_GENERATED' },
    })
  })

  it('drives the real Agent-first coordinator to one owner without a second model channel', async () => {
    const ordinary = harness({
      baselineCandidates: [candidate()], endCandidates: [candidate()],
      between: [
        event('tool/call', 3, { turn: 2, step: 1, callId: 'call-1', name: 'write', arguments: JSON.stringify({ file_path: 'D:\\repo\\game.html', content: '<html />' }) }),
        toolResult(4, 'call-1'),
      ],
    })
    await expect(decideWithRealAdapter(ordinary)).resolves.toMatchObject({
      status: 'RUN2SKILL_OWNED', ownership: { reasonCode: 'NO_AGENT_SKILL_ACTIVITY' },
    })

    const agentSaved = harness({
      baselineCandidates: [], endCandidates: [candidate()],
      between: [
        event('tool/call', 3, { turn: 2, step: 1, callId: 'call-1', name: 'write', arguments: JSON.stringify({ file_path: skillPath, content: exactSkillBytes }) }),
        toolResult(4, 'call-1'),
      ],
    })
    await expect(decideWithRealAdapter(agentSaved)).resolves.toMatchObject({
      status: 'RESOLVED_BY_AGENT',
      ownership: { reasonCode: 'AGENT_SAVED_MATCHING_SKILL', resolvedCandidateId: candidate().candidateId },
    })
  })

  it('does not grant absence proof when Shell arguments contain Skill generation evidence', async () => {
    const { adapter, batch, intent } = harness({
      between: [
        event('tool/call', 3, { turn: 2, step: 1, callId: 'call-1', name: 'pwsh', arguments: JSON.stringify({ command: `Set-Content -Path ${skillPath} -Value '---'` }) }),
        toolResult(4, 'call-1'),
      ],
    })

    await expect(adapter.observe({ batch, intent, inputDigest: 'd'.repeat(64) })).resolves.toMatchObject({
      status: 'OBSERVED', toolEvidenceComplete: true, agentActivity: 'BODY_GENERATED',
    })
  })

  it('uses the complete end Catalog when a Shell call carries no Skill-generation evidence', async () => {
    const observed = harness({
      baselineCandidates: [candidate()], endCandidates: [candidate()],
      between: [
        event('tool/call', 3, {
          turn: 2, step: 1, callId: 'call-1', name: 'pwsh',
          arguments: JSON.stringify({ command: 'Set-Content $target $body' }),
        }),
        toolResult(4, 'call-1'),
      ],
    })

    await expect(decideWithRealAdapter(observed)).resolves.toMatchObject({
      status: 'RUN2SKILL_OWNED', ownership: { reasonCode: 'NO_AGENT_SKILL_ACTIVITY' },
    })
  })

  it('does not invoke the second generation channel after the Agent already emitted a complete Skill body', async () => {
    const { adapter, batch, intent } = harness({
      between: [event('assistant/message', 3, {
        turn: 2, step: 1,
        message: {
          role: 'assistant', source: { kind: 'assistant' },
          content: [{ type: 'text', text: `已生成：\n\n${exactSkillBytes}` }],
        },
      })],
    })

    await expect(adapter.observe({ batch, intent, inputDigest: 'd'.repeat(64) })).resolves.toMatchObject({
      status: 'OBSERVED', toolEvidenceComplete: true, agentActivity: 'BODY_GENERATED',
    })
  })

  it('fails closed on an unpaired tool call or a persistence revision race', async () => {
    const unpaired = harness({
      between: [event('tool/call', 3, { turn: 2, step: 1, callId: 'call-1', name: 'read', arguments: '{}' })],
    })
    await expect(unpaired.adapter.observe({
      batch: unpaired.batch, intent: unpaired.intent, inputDigest: 'd'.repeat(64),
    })).resolves.toMatchObject({ status: 'OBSERVED', toolEvidenceComplete: false })

    const raced = harness({
      snapshots: [[{ header, revision: 'jsonl:8' }], [{ header, revision: 'jsonl:9' }]],
    })
    await expect(raced.adapter.observe({
      batch: raced.batch, intent: raced.intent, inputDigest: 'd'.repeat(64),
    })).resolves.toEqual({ status: 'UNAVAILABLE', reasonCode: 'SESSION_CHANGED_DURING_CHECK' })

    const malformedAssistant = harness({
      between: [event('assistant/message', 3, {
        turn: 2, step: 1,
        message: { role: 'assistant', content: [{ type: 'text' }] },
      })],
    })
    await expect(malformedAssistant.adapter.observe({
      batch: malformedAssistant.batch, intent: malformedAssistant.intent, inputDigest: 'd'.repeat(64),
    })).resolves.toMatchObject({ status: 'OBSERVED', toolEvidenceComplete: false, agentActivity: 'AMBIGUOUS' })
  })

  it('does not mistake an ordinary Markdown divider for a generated Skill body', async () => {
    const { adapter, batch, intent } = harness({
      between: [event('assistant/message', 3, {
        turn: 2, step: 1,
        message: {
          role: 'assistant', source: { kind: 'assistant' },
          content: [{
            type: 'text',
            text: '任务完成。\n\n---\n\n我没有创建或修改任何 SKILL.md。',
          }],
        },
      })],
    })

    await expect(adapter.observe({ batch, intent, inputDigest: 'd'.repeat(64) })).resolves.toMatchObject({
      status: 'OBSERVED', toolEvidenceComplete: true, agentActivity: 'NONE',
    })
  })

  it('keeps ownership diagnostics stage-specific without exposing exception text', async () => {
    const cases = [
      {
        observed: harness({ resolveSessionError: new Error('secret resolver detail') }),
        reasonCode: 'SESSION_CONTEXT_UNAVAILABLE',
      },
      {
        observed: harness({ readFromError: new Error('secret session backend detail') }),
        reasonCode: 'SESSION_LOG_UNAVAILABLE',
      },
      {
        observed: harness({ manifestError: new Error('secret manifest detail') }),
        reasonCode: 'OWNERSHIP_ANALYSIS_UNAVAILABLE',
      },
    ] as const

    for (const { observed, reasonCode } of cases) {
      const result = await observed.adapter.observe({
        batch: observed.batch, intent: observed.intent, inputDigest: 'd'.repeat(64),
      })
      expect(result).toEqual({ status: 'UNAVAILABLE', reasonCode })
      expect(JSON.stringify(result)).not.toContain('secret')
    }
  })

  it('uses the durable Session snapshot when the optional live Host Session is gone', async () => {
    const observed = harness({ sessionAvailable: false })
    const sessionLifecycleKey = deriveSessionLifecycleKey({
      rootSessionId: header.id,
      sessionCreatedAt: header.createdAt,
      sessionCwdDigest: deriveSessionCwdDigest(header.cwd),
    })
    const batch = { ...observed.batch, sessionLifecycleKey }
    const intent = { ...observed.intent, sessionLifecycleKey }

    await expect(observed.adapter.observe({
      batch, intent, inputDigest: 'd'.repeat(64),
    })).resolves.toMatchObject({
      status: 'OBSERVED', catalogComplete: true, toolEvidenceComplete: true,
    })
  })
})
