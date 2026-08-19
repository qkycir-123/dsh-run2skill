import { describe, expect, it, vi } from 'vitest'
import {
  RestrictedLearningClient,
  type DshGenerateOptions,
  type DshLlmPort,
  type DshStreamChunk,
  type LearningCallLedger,
} from '../src/adapters/dsh-llm/restricted-learning-client.js'

const digest = (character: string) => character.repeat(64)

function validModelOutput() {
  return {
    experiences: [{
      type: 'WORKFLOW',
      lesson: 'Run the focused verification before the full suite.',
      persistenceScope: 'PROJECT',
      evidenceStrength: 'HIGH',
      supportingEvidence: [{ messageSeq: 11, excerptDigest: digest('a') }],
    }],
    proposal: {
      policyVersion: 'learning-v1',
      name: 'focused-verification',
      description: 'Run focused checks before the full suite.',
      whenToUse: 'Use after changing a narrow implementation unit.',
      content: '# Focused verification\n\nRun the focused test, then the full suite.',
      invocation: { modelInvocable: true, userInvocable: false },
      persistenceScope: 'PROJECT',
      curation: { decision: 'CREATE', rationale: 'No existing Skill covers this workflow.' },
    },
  } as const
}

function responseChunks(text: string): DshStreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class RecordingLlm implements DshLlmPort {
  readonly calls: DshGenerateOptions[] = []

  constructor(
    private readonly responses: readonly (readonly DshStreamChunk[])[],
    private readonly contextWindow = 32_000,
  ) {}

  async resolveModelInfo() {
    return { context: { contextWindow: this.contextWindow } }
  }

  createUserMessage(text: string) {
    return {
      id: `msg_${this.calls.length}`,
      role: 'user' as const,
      content: [{ type: 'text' as const, text }],
      source: { kind: 'user' as const },
    }
  }

  async * stream(options: DshGenerateOptions): AsyncIterable<DshStreamChunk> {
    this.calls.push(options)
    for (const chunk of this.responses[this.calls.length - 1] ?? []) yield chunk
  }
}

class RecordingLedger implements LearningCallLedger {
  readonly reservations: Array<'PRIMARY' | 'FORMAT_REPAIR'> = []
  readonly calls: Array<{
    requestOrdinal: 1 | 2
    kind: 'PRIMARY' | 'FORMAT_REPAIR'
    inputTokens?: number
    outputTokens?: number
    outcome: 'SUCCEEDED' | 'FAILED' | 'ABORTED' | 'TIMED_OUT'
  }> = []

  async reserve(kind: 'PRIMARY' | 'FORMAT_REPAIR') {
    this.reservations.push(kind)
    return { requestOrdinal: this.reservations.length as 1 | 2 }
  }

  async record(call: (typeof this.calls)[number]) {
    this.calls.push(call)
  }
}

function request(llm: DshLlmPort, ledger: LearningCallLedger, signal?: AbortSignal) {
  return new RestrictedLearningClient(llm).learn({
    route: { provider: 'session-provider', model: 'session-model' },
    envelope: JSON.stringify({
      policyVersion: 'learning-v1',
      workItemId: `wi_${digest('b')}`,
      trigger: { turn: 2, turnEndSeq: 12, evidenceDigests: [digest('a')] },
      blocks: [],
    }),
    workItemId: `wi_${digest('b')}`,
    catalogObservationDigest: digest('c'),
    shortlistDigests: [digest('d')],
    ledger,
    ...(signal === undefined ? {} : { signal }),
  })
}

describe('RestrictedLearningClient', () => {
  it('uses the inherited route with one canonical message and no tools or Agent options', async () => {
    const llm = new RecordingLlm([responseChunks(JSON.stringify(validModelOutput()))])
    const ledger = new RecordingLedger()

    const result = await request(llm, ledger)

    expect(result.status).toBe('SUCCEEDED')
    if (result.status !== 'SUCCEEDED') return
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0]).toMatchObject({
      provider: 'session-provider',
      model: 'session-model',
      maxTokens: 4096,
      messages: [{ role: 'user', source: { kind: 'user' } }],
    })
    expect(llm.calls[0]).not.toHaveProperty('tools')
    expect(llm.calls[0]).not.toHaveProperty('purpose')
    expect(llm.calls[0]).not.toHaveProperty('reasoningEffort')
    expect(ledger.reservations).toEqual(['PRIMARY'])
    expect(ledger.calls).toEqual([{
      requestOrdinal: 1,
      kind: 'PRIMARY',
      inputTokens: 20,
      outputTokens: 10,
      outcome: 'SUCCEEDED',
    }])
    expect(result.experiences[0]?.experienceId).toMatch(/^exp_[a-f0-9]{64}$/)
    expect(result.proposal.learningProposalId).toMatch(/^lp_[a-f0-9]{64}$/)
    expect(result.proposal.supportingExperienceIds).toEqual([
      result.experiences[0]?.experienceId,
    ])
    expect(result.proposal.catalogObservationDigest).toBe(digest('c'))
    expect(result.proposal.shortlistDigests).toEqual([digest('d')])
  })

  it('assembles multiple text blocks in first-seen order and ignores reasoning blocks', async () => {
    const json = JSON.stringify(validModelOutput())
    const split = Math.floor(json.length / 2)
    const chunks: DshStreamChunk[] = [
      { type: 'text-delta', index: 4, text: json.slice(0, split) },
      { type: 'reasoning-delta', index: 1, text: 'untrusted chain of thought' },
      { type: 'text-delta', index: 2, text: json.slice(split) },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const result = await request(new RecordingLlm([chunks]), new RecordingLedger())
    expect(result.status).toBe('SUCCEEDED')
  })

  it('uses the authoritative first block-end value and ignores later stragglers', async () => {
    const json = JSON.stringify(validModelOutput())
    const chunks: DshStreamChunk[] = [
      { type: 'text-delta', index: 0, text: '{"wrong":' },
      { type: 'block-end', index: 0, block: { type: 'text', text: json } },
      { type: 'text-delta', index: 0, text: 'garbage' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'garbage' } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const result = await request(new RecordingLlm([chunks]), new RecordingLedger())
    expect(result.status).toBe('SUCCEEDED')
  })

  it('permits exactly one format-only repair on the same route', async () => {
    const llm = new RecordingLlm([
      responseChunks('{"experiences":'),
      responseChunks(JSON.stringify(validModelOutput())),
    ])
    const ledger = new RecordingLedger()

    const result = await request(llm, ledger)

    expect(result.status).toBe('SUCCEEDED')
    expect(llm.calls).toHaveLength(2)
    expect(llm.calls.map(call => [call.provider, call.model])).toEqual([
      ['session-provider', 'session-model'],
      ['session-provider', 'session-model'],
    ])
    expect(ledger.reservations).toEqual(['PRIMARY', 'FORMAT_REPAIR'])
    expect(llm.calls[1]?.messages).toHaveLength(1)
    expect(llm.calls[1]?.messages[0]?.content[0]?.text).toContain('format only')
  })

  it('rejects unknown model fields and never makes a third call', async () => {
    const invalid = { ...validModelOutput(), absolutePath: 'D:\\private\\SKILL.md' }
    const llm = new RecordingLlm([
      responseChunks(JSON.stringify(invalid)),
      responseChunks(JSON.stringify(invalid)),
      responseChunks(JSON.stringify(validModelOutput())),
    ])

    const result = await request(llm, new RecordingLedger())

    expect(result).toEqual({ status: 'FAILED', failureCode: 'INVALID_STRUCTURED_OUTPUT' })
    expect(llm.calls).toHaveLength(2)
  })

  it('filters the first response before placing it in a repair request', async () => {
    const credentialField = ['client', 'Secret'].join('')
    const llm = new RecordingLlm([
      responseChunks(`{"${credentialField}":"synthetic-value",`),
      responseChunks(JSON.stringify(validModelOutput())),
    ])

    await request(llm, new RecordingLedger())

    const repair = llm.calls[1]?.messages[0]?.content[0]?.text ?? ''
    expect(repair).toContain('[REDACTED]')
    expect(repair).not.toContain('synthetic-value')
  })

  it('aborts immediately when streamed text exceeds 32 KiB', async () => {
    const llm = new RecordingLlm([[
      { type: 'text-delta', index: 0, text: 'x'.repeat(32 * 1024 + 1) },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]])
    const ledger = new RecordingLedger()

    const result = await request(llm, ledger)

    expect(result).toEqual({ status: 'FAILED', failureCode: 'MODEL_OUTPUT_LIMIT_EXCEEDED' })
    expect(llm.calls[0]?.signal.aborted).toBe(true)
    expect(ledger.calls[0]?.outcome).toBe('ABORTED')
  })

  it.each([
    { chunks: responseChunks('{}').filter(chunk => chunk.type !== 'usage'), label: 'usage' },
    { chunks: responseChunks('{}').filter(chunk => chunk.type !== 'finish'), label: 'finish' },
    {
      chunks: responseChunks('{}').map(chunk => chunk.type === 'finish'
        ? { type: 'finish' as const, reason: { kind: 'max-tokens' as const } }
        : chunk),
      label: 'stop',
    },
    {
      chunks: [
        { type: 'block-start' as const, index: 0, blockType: 'unknown' },
        { type: 'usage' as const, usage: { inputTokens: 1, outputTokens: 2 } },
        { type: 'finish' as const, reason: { kind: 'stop' } },
      ],
      label: 'block assembly',
    },
  ])('fails closed when terminal $label is invalid', async ({ chunks }) => {
    const ledger = new RecordingLedger()
    const result = await request(new RecordingLlm([chunks]), ledger)
    expect(result).toEqual({ status: 'FAILED', failureCode: 'MODEL_TERMINAL_FAILURE' })
    expect(ledger.calls[0]?.outcome).toBe('FAILED')
  })

  it('does not reserve or call when model context metadata is unavailable', async () => {
    const llm: DshLlmPort = {
      async resolveModelInfo() { return {} },
      createUserMessage: text => ({
        id: 'msg', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' },
      }),
      async * stream() {
        yield* [] as DshStreamChunk[]
        throw new Error('must not call')
      },
    }
    const ledger = new RecordingLedger()
    expect(await request(llm, ledger)).toEqual({
      status: 'FAILED', failureCode: 'MODEL_INFO_UNAVAILABLE',
    })
    expect(ledger.reservations).toEqual([])
  })

  it('does not reserve or call when the fixed prompt and envelope exceed route context', async () => {
    const llm = new RecordingLlm([], 7_200)
    const ledger = new RecordingLedger()
    expect(await request(llm, ledger)).toEqual({
      status: 'FAILED', failureCode: 'ENVELOPE_UNBUILDABLE',
    })
    expect(ledger.reservations).toEqual([])
  })

  it('does not call the model if durable request reservation fails', async () => {
    const llm = new RecordingLlm([responseChunks(JSON.stringify(validModelOutput()))])
    const ledger: LearningCallLedger = {
      async reserve() { throw new Error('durable budget unavailable') },
      async record() { throw new Error('must not record') },
    }
    await expect(request(llm, ledger)).rejects.toThrow('durable budget unavailable')
    expect(llm.calls).toHaveLength(0)
  })

  it('maps caller cancellation to MODEL_ABORTED and records the call', async () => {
    const started = Promise.withResolvers<void>()
    const llm: DshLlmPort = {
      async resolveModelInfo() { return { context: { contextWindow: 32_000 } } },
      createUserMessage: text => ({
        id: 'msg', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' },
      }),
      async * stream(options) {
        started.resolve()
        await new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => { reject(options.signal.reason) }, { once: true })
        })
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const ledger = new RecordingLedger()
    const controller = new AbortController()
    const pending = request(llm, ledger, controller.signal)
    await started.promise
    controller.abort(new Error('caller cancelled'))

    expect(await pending).toEqual({ status: 'FAILED', failureCode: 'MODEL_ABORTED' })
    expect(ledger.calls[0]?.outcome).toBe('ABORTED')
  })

  it('maps the fixed 60 second call timeout to MODEL_TIMEOUT', async () => {
    vi.useFakeTimers()
    try {
      const llm: DshLlmPort = {
        async resolveModelInfo() { return { context: { contextWindow: 32_000 } } },
        createUserMessage: text => ({
          id: 'msg', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' },
        }),
        async * stream(options) {
          await new Promise<void>((_resolve, reject) => {
            options.signal.addEventListener('abort', () => { reject(options.signal.reason) }, { once: true })
          })
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
      const ledger = new RecordingLedger()
      const pending = request(llm, ledger)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(await pending).toEqual({ status: 'FAILED', failureCode: 'MODEL_TIMEOUT' })
      expect(ledger.calls[0]?.outcome).toBe('TIMED_OUT')
    } finally {
      vi.useRealTimers()
    }
  })
})
