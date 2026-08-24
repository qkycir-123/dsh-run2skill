import { describe, expect, it, vi } from 'vitest'
import {
  DshV2StageLlmClient,
} from '../src/adapters/dsh-llm/v2-stage-client.js'
import type {
  DshGenerateOptions,
  DshLlmPort,
  DshStreamChunk,
} from '../src/adapters/dsh-llm/restricted-learning-client.js'
import type { BatchDetectorInput } from '../src/application/detection/index.js'

const digest = (character: string): string => character.repeat(64)

function chunks(text: string, finish = 'stop'): DshStreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: finish } },
  ]
}

class RecordingLlm implements DshLlmPort {
  readonly calls: DshGenerateOptions[] = []

  constructor(private readonly responses: readonly (readonly DshStreamChunk[] | Error)[]) {}

  async resolveModelInfo() { return { context: { contextWindow: 32_000 } } }

  async * stream(options: DshGenerateOptions): AsyncIterable<DshStreamChunk> {
    this.calls.push(options)
    const response = this.responses[this.calls.length - 1] ?? []
    if (response instanceof Error) throw response
    for (const chunk of response) yield chunk
  }
}

const route = {
  provider: 'deepseek-official',
  model: 'deepseek-chat',
  policyVersion: 'route-v1',
  maxInputBytes: 128 * 1024,
  maxOutputBytes: 64 * 1024,
  detectionReasoningEffort: 'off',
} as const

function detectorInput(): BatchDetectorInput {
  return {
    batchId: `batch_${digest('a')}`,
    sessionLifecycleKey: `sl_${digest('b')}`,
    triggerReasons: ['THRESHOLD'],
    route,
    observations: [{
      observationId: `obs_${digest('c')}`,
      turnEndSeq: 5,
      directUserEvidence: [{
        source: 'USER_DIRECT', messageSeq: 4, excerpt: '先分析再实现', excerptDigest: digest('d'),
        redactionKinds: [], truncated: false,
      }],
      assistantOutcomeSummary: '实现和测试均成功。',
      toolOutcomeSummary: [{ toolName: 'shell', outcome: 'SUCCEEDED', contentDigest: digest('f') }],
      completeness: 'COMPLETE',
      evidenceDigest: digest('e'),
    }],
    carry: [],
  }
}

describe('DshV2StageLlmClient', () => {
  it('uses the frozen batch route and a detector-only, data-bound JSON contract', async () => {
    const output = { result: 'NONE' }
    const llm = new RecordingLlm([chunks(JSON.stringify(output))])
    const client = new DshV2StageLlmClient(llm)

    await expect(client.detect(detectorInput())).resolves.toEqual(output)
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0]).toMatchObject({
      provider: route.provider,
      model: route.model,
      reasoningEffort: 'off',
      maxTokens: 4096,
      messages: [{ role: 'user', source: { kind: 'user' } }],
    })
    expect(llm.calls[0]?.system).toContain('NONE | DEFER | READY')
    expect(llm.calls[0]?.system).toContain('untrusted data')
    expect(llm.calls[0]?.system).toContain('use only observations[].evidenceDigest')
    expect(llm.calls[0]?.system).toContain('Never use directUserEvidence[].excerptDigest')
    expect(llm.calls[0]?.system).toContain('Keep the complete JSON under 4096 UTF-8 bytes')
    expect(llm.calls[0]?.system).toContain('Do not reason aloud')
    expect(llm.calls[0]?.system).not.toContain('Skill Markdown')
    expect(llm.calls[0]?.messages[0]?.content[0]?.text).toContain('"batchId"')
  })

  it('requires a completed explicit save request to become READY instead of waiting for another turn', async () => {
    const output = { result: 'NONE' }
    const llm = new RecordingLlm([chunks(JSON.stringify(output))])
    const client = new DshV2StageLlmClient(llm)

    await client.detect({ ...detectorInput(), triggerReasons: ['EXPLICIT'] })

    expect(llm.calls[0]?.system).toContain('A completed EXPLICIT save request must be READY')
    expect(llm.calls[0]?.system).toContain('Do not DEFER merely because Run2Skill has not created the Skill yet')
  })

  it('keeps recall, coverage, and generation as separate calls and schemas', async () => {
    const outputs = [
      { classifications: [{ candidateId: `cand_${digest('1')}`, classification: 'POSSIBLE' }] },
      { decisions: [{ candidateId: `cand_${digest('1')}`, decision: 'PARTIAL', reason: 'Only part is covered.' }] },
      { name: 'safe-workflow', description: 'A safe workflow.', whenToUse: 'Use for this task.', content: '# Safe workflow\n\nDo the work.' },
    ]
    const llm = new RecordingLlm(outputs.map(output => chunks(JSON.stringify(output))))
    const client = new DshV2StageLlmClient(llm)
    const intent = {
      intentId: `intent_${digest('2')}`,
      persistenceScope: 'PROJECT' as const,
      experienceType: 'WORKFLOW' as const,
      applicabilitySummary: 'Apply the safe workflow.',
      keySteps: ['Analyze', 'Implement', 'Test'],
      prohibitions: ['Do not skip tests'],
    }

    await expect(client.classifyCatalog({
      intent,
      summaries: [{
        candidateId: `cand_${digest('1')}`, name: 'existing', description: 'Existing workflow',
        provider: 'filesystem', source: 'project', scope: 'PROJECT', writable: true,
        rootIdentityDigest: digest('3'),
      }],
      pageOrdinal: 1,
      inputDigest: digest('4'),
      route,
    })).resolves.toEqual(outputs[0])
    await expect(client.classifyCoverage({
      intent,
      candidates: [{ candidateId: `cand_${digest('1')}`, content: '# Existing\n' }],
      pageOrdinal: 1,
      inputDigest: digest('5'),
      route,
    })).resolves.toEqual(outputs[1])
    await expect(client.generate({
      action: 'MERGE', intent, targetCandidateId: `cand_${digest('1')}`,
      baseSkill: '# Existing\n', inputDigest: digest('6'), route,
    })).resolves.toEqual(outputs[2])

    expect(llm.calls).toHaveLength(3)
    expect(llm.calls.map(call => call.system)).toEqual(expect.arrayContaining([
      expect.stringContaining('RELEVANT | POSSIBLE | UNRELATED'),
      expect.stringContaining('UNRELATED | COVERED | PARTIAL | AMBIGUOUS'),
      expect.stringContaining('Skill Markdown'),
    ]))
    expect(llm.calls[0]?.system).not.toContain('complete Markdown with a heading')
    expect(llm.calls[1]?.system).not.toContain('complete Markdown with a heading')
    expect(llm.calls.every(call => !('reasoningEffort' in call))).toBe(true)
  })

  it('accepts one fenced JSON object while ignoring reasoning blocks', async () => {
    const output = { result: 'NONE' }
    const text = `\`\`\`json\n${JSON.stringify(output)}\n\`\`\``
    const response: DshStreamChunk[] = [
      { type: 'reasoning-delta', index: 9, text: 'private reasoning' },
      ...chunks(text),
    ]
    await expect(new DshV2StageLlmClient(new RecordingLlm([response])).detect(detectorInput()))
      .resolves.toEqual(output)
  })

  it('fails closed when the stream has no authoritative usage or finish', async () => {
    const noTerminal: DshStreamChunk[] = [
      { type: 'text-delta', index: 0, text: '{"result":"NONE"}' },
    ]
    const client = new DshV2StageLlmClient(new RecordingLlm([noTerminal]))

    await expect(client.detect(detectorInput())).rejects.toEqual(
      expect.objectContaining({ code: 'MODEL_TERMINAL_INVALID' }),
    )
  })

  it('fails closed on truncation and stream failure without an implicit replay', async () => {
    const llm = new RecordingLlm([
      chunks('{"result":"NONE"}', 'length'),
      new Error('provider unavailable'),
    ])
    const client = new DshV2StageLlmClient(llm)

    await expect(client.detect(detectorInput())).rejects.toEqual(
      expect.objectContaining({ code: 'MODEL_OUTPUT_TRUNCATED' }),
    )
    await expect(client.detect(detectorInput())).rejects.toEqual(
      expect.objectContaining({ code: 'MODEL_STREAM_FAILED' }),
    )
    expect(llm.calls).toHaveLength(2)
  })

  it('allows one slow detector call to finish within the two-minute background budget', async () => {
    vi.useFakeTimers()
    try {
      const slowLlm: DshLlmPort = {
        resolveModelInfo: async () => ({ context: { contextWindow: 32_000 } }),
        stream: async function * () {
          await new Promise(resolve => setTimeout(resolve, 90_000))
          yield * chunks('{"result":"NONE"}')
        },
      }
      const pending = new DshV2StageLlmClient(slowLlm).detect(detectorInput())
      let settled = false
      void pending.finally(() => { settled = true })

      await vi.advanceTimersByTimeAsync(60_000)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(30_000)
      await expect(pending).resolves.toEqual({ result: 'NONE' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns malformed JSON as untrusted output so the stage worker can record INVALID_OUTPUT', async () => {
    const client = new DshV2StageLlmClient(new RecordingLlm([chunks('{"result":')]))
    await expect(client.detect(detectorInput())).resolves.toBe('{"result":')
  })

  it('enforces the frozen route input and output byte budgets before accepting model output', async () => {
    const inputLlm = new RecordingLlm([chunks('{"result":"NONE"}')])
    const inputClient = new DshV2StageLlmClient(inputLlm)
    await expect(inputClient.detect({
      ...detectorInput(), route: { ...route, maxInputBytes: 1 },
    })).rejects.toEqual(expect.objectContaining({ code: 'INPUT_BUDGET_EXCEEDED' }))
    expect(inputLlm.calls).toHaveLength(0)

    const outputClient = new DshV2StageLlmClient(new RecordingLlm([chunks('{"result":"NONE"}')]))
    await expect(outputClient.detect({
      ...detectorInput(), route: { ...route, maxOutputBytes: 8 },
    })).rejects.toEqual(expect.objectContaining({ code: 'MODEL_OUTPUT_LIMIT_EXCEEDED' }))
  })

  it('does not request more output tokens than the frozen route budget permits', async () => {
    const llm = new RecordingLlm([chunks('{"result":"NONE"}')])
    const client = new DshV2StageLlmClient(llm)

    await client.detect({
      ...detectorInput(),
      route: { ...route, maxOutputBytes: 2_048 },
    })

    expect(llm.calls[0]?.maxTokens).toBe(512)
  })
})
