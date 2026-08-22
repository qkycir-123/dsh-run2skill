import { describe, expect, it } from 'vitest'
import {
  DshV2OwnershipObservationAdapter,
  deriveOwnershipTargetPathDigest,
} from '../src/adapters/dsh-skills/v2-ownership-observation.js'
import { AgentFirstOwnershipCoordinator } from '../src/application/ownership/index.js'
import { sha256Utf8 } from '../src/domain/observe/hashing.js'
import { SessionBatchV2Schema } from '../src/domain/v2/index.js'
import type { DshSessionEvent, DshSessionHeader, SessionPersistenceSnapshot } from '../src/adapters/dsh-session/types.js'
import { createMinimalV2Fixtures } from './support/v2-fixtures.js'
import { createMemoryRun2skillV2Domain } from './support/memory-run2skill-v2-domain.js'

const header: DshSessionHeader = { version: 1, id: 'session-v2', createdAt: 100, cwd: 'D:\\repo' }
const skillPath = 'D:\\repo\\.dsh\\skills\\fixture-workflow\\SKILL.md'
const exactSkillBody = [
  '# Fixture workflow', '', 'Observe', '', 'Verify', '', 'Do not skip verification',
].join('\n')
const exactSkillBytes = [
  '---', 'name: fixture-workflow', 'description: Apply the fixture workflow.', '---', '',
  exactSkillBody, '',
].join('\n')

function candidate(body = exactSkillBody) {
  return {
    candidateId: 'candidate-fixture', name: 'fixture-workflow', provider: 'filesystem', source: 'project-dsh',
    scope: 'PROJECT' as const, writable: true,
    targetPathDigest: deriveOwnershipTargetPathDigest(skillPath, header.cwd),
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
}) {
  const fixture = createMinimalV2Fixtures()
  const baselineCandidates = [...(options.baselineCandidates ?? [])]
  const endCandidates = [...(options.endCandidates ?? [])]
  const manifestUnchanged = JSON.stringify(baselineCandidates) === JSON.stringify(endCandidates)
  const batch = SessionBatchV2Schema.parse({
    ...fixture.sessionBatch,
    batchManifestBaseline: {
      ...fixture.sessionBatch.batchManifestBaseline,
      ownershipCandidates: baselineCandidates,
    },
  })
  const events = [
    event('turn/start', 1, { turn: 2 }),
    ...(options.between ?? []),
    event('turn/end', 8, { turn: 2, reason: { kind: 'completed' } }),
  ]
  let snapshotRead = 0
  const adapter = new DshV2OwnershipObservationAdapter({
    persistence: {
      async listSnapshots() {
        const values = options.snapshots ?? [[{ header, revision: 'jsonl:8' }]]
        return values[Math.min(snapshotRead++, values.length - 1)]!
      },
      async readFrom() { return { meta: header, events } },
    },
    resolveSession: key => key === batch.sessionLifecycleKey ? { header } : undefined,
    manifest: {
      capture: async () => ({
        observedAt: '2026-08-22T01:00:00.000Z',
        rootManifestDigest: manifestUnchanged ? batch.batchManifestBaseline.rootManifestDigest : '9'.repeat(64),
        runtimeCatalogDigest: manifestUnchanged ? batch.batchManifestBaseline.runtimeCatalogDigest : '8'.repeat(64),
        complete: true,
        ownershipCandidates: endCandidates,
      }),
    },
    now: () => Date.parse('2026-08-22T01:00:00.000Z'),
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
    })).resolves.toEqual({ status: 'UNAVAILABLE', reasonCode: 'OBSERVATION_FAILED' })

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
})
