import { describe, expect, it } from 'vitest'
import { ExactAgentScopeRegistry } from '../src/adapters/dsh-skills/index.js'
import { deriveSessionCwdDigest } from '../src/domain/observe/signal-key.js'
import { makeWorkItem } from './support/work-item-fixture.js'

function agent(id: string, createdAt: number, cwd: string) {
  return { id, session: { header: { id, createdAt, cwd } } }
}

describe('ExactAgentScopeRegistry', () => {
  it('resolves only the exact lifecycle and preserves the borrowed Agent object', () => {
    const registry = new ExactAgentScopeRegistry<object>()
    const first = agent('session-1', 100, 'D:\\repo')
    const reused = agent('session-1', 200, 'D:\\repo')
    registry.register(first)
    registry.register(reused)

    const item = makeWorkItem({
      signalKey: {
        ...makeWorkItem().signalKey,
        sessionCwdDigest: deriveSessionCwdDigest('D:\\repo'),
      },
    })
    expect(registry.resolve(item)).toMatchObject({ status: 'AVAILABLE', agent: first, cwd: 'D:\\repo' })

    const reusedItem = makeWorkItem({
      signalKey: {
        ...item.signalKey,
        sessionCreatedAt: 200,
      },
    })
    expect(registry.resolve(reusedItem)).toMatchObject({ status: 'AVAILABLE', agent: reused })
  })

  it('fails closed for missing, mismatched, oversized, and released scopes', () => {
    const registry = new ExactAgentScopeRegistry<object>()
    expect(registry.resolve(makeWorkItem())).toEqual({ status: 'UNAVAILABLE' })

    expect(() => registry.register(agent('session-1', 100, 'x'.repeat(40_000)))).toThrow()
    expect(() => registry.register({
      id: 'session-1',
      session: { header: { id: 'different', createdAt: 100, cwd: 'D:\\repo' } },
    })).toThrow()

    const exact = agent('session-1', 100, 'D:\\repo')
    const release = registry.register(exact)
    const item = makeWorkItem({
      signalKey: {
        ...makeWorkItem().signalKey,
        sessionCwdDigest: deriveSessionCwdDigest('D:\\repo'),
      },
    })
    release()
    expect(registry.resolve(item)).toEqual({ status: 'UNAVAILABLE' })
  })
})
