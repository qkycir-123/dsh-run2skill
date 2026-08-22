import { describe, expect, it } from 'vitest'
import { DshSessionActivityAdapter } from '../src/adapters/dsh-session/v2-session-activity.js'
import { deriveSessionCwdDigest, deriveSessionLifecycleKey } from '../src/domain/observe/signal-key.js'
import type {
  DshSessionEvent,
  DshSessionHeader,
  SessionPersistenceSnapshot,
} from '../src/adapters/dsh-session/types.js'

const header: DshSessionHeader = {
  version: 1,
  id: 'session-1',
  createdAt: 1_725_000_000_000,
  cwd: 'D:\\workspace',
}
const events: DshSessionEvent[] = [
  { type: 'turn/start', seq: 0, time: 1_725_000_001_000, data: { turn: 0 } },
  { type: 'turn/end', seq: 1, time: 1_725_000_002_000, data: { turn: 0 } },
]
const lifecycleKey = deriveSessionLifecycleKey({
  rootSessionId: header.id,
  sessionCreatedAt: header.createdAt,
  sessionCwdDigest: deriveSessionCwdDigest(header.cwd),
})

function harness(options: {
  readonly status?: 'idle' | 'running'
  readonly liveEvents?: readonly DshSessionEvent[]
  readonly snapshots?: readonly SessionPersistenceSnapshot[][]
} = {}) {
  let snapshotRead = 0
  const live = {
    header,
    events: options.liveEvents ?? events,
  }
  const agent = {
    id: header.id,
    status: options.status ?? 'idle',
    session: live,
  }
  return new DshSessionActivityAdapter({
    persistence: {
      async listSnapshots() {
        const configured = options.snapshots ?? [[{ header, revision: 'jsonl:2' }]]
        return configured[Math.min(snapshotRead++, configured.length - 1)]!
      },
      async readFrom() { return { meta: header, events } },
    },
    sessions: { get: id => id === header.id ? live : undefined },
    agents: { get: id => id === header.id ? agent : undefined },
  })
}

describe('real DSH Session activity adapter', () => {
  it('returns a stable complete idle observation for the exact durable lifecycle', async () => {
    const adapter = harness()

    const first = await adapter.observe(lifecycleKey)
    const second = await adapter.observe(lifecycleKey)

    expect(first).toMatchObject({ complete: true, activeAgent: false })
    expect(first.activityRevision).toMatch(/^[a-f0-9]{64}$/)
    expect(second).toEqual(first)
  })

  it('reports the exact live Agent running state in the activity revision', async () => {
    const idle = await harness({ status: 'idle' }).observe(lifecycleKey)
    const running = await harness({ status: 'running' }).observe(lifecycleKey)

    expect(running).toMatchObject({ complete: true, activeAgent: true })
    expect(running.activityRevision).not.toBe(idle.activityRevision)
  })

  it('fails closed when persistence changes during the observation', async () => {
    const adapter = harness({
      snapshots: [
        [{ header, revision: 'jsonl:2' }],
        [{ header, revision: 'jsonl:3' }],
      ],
    })

    await expect(adapter.observe(lifecycleKey)).resolves.toMatchObject({
      complete: false,
      activeAgent: false,
    })
  })

  it('fails closed when the live Session is ahead of the durable log', async () => {
    const liveEvents = [
      ...events,
      { type: 'turn/start', seq: 2, time: 1_725_000_003_000, data: { turn: 1 } },
    ]

    await expect(harness({ liveEvents }).observe(lifecycleKey)).resolves.toMatchObject({
      complete: false,
      activeAgent: false,
    })
  })

  it('fails closed when the lifecycle cannot be resolved uniquely', async () => {
    const adapter = harness({ snapshots: [[]] })

    await expect(adapter.observe(lifecycleKey)).resolves.toMatchObject({
      complete: false,
      activeAgent: false,
    })
  })
})
