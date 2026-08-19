import { describe, expect, it, vi } from 'vitest'
import { DshWorkspaceBindingResolver } from '../src/adapters/dsh-workspace/binding.js'

describe('DshWorkspaceBindingResolver', () => {
  it('returns the stable workspace id and canonical path', async () => {
    const resolveByPath = vi.fn(async () => ({ id: 'workspace-1', path: 'D:/canonical/demo' }))
    const resolver = new DshWorkspaceBindingResolver({ resolveByPath })

    await expect(resolver.resolve('D:/work/demo')).resolves.toEqual({
      status: 'BOUND',
      workspaceId: 'workspace-1',
      canonicalPath: 'D:/canonical/demo',
    })
    expect(resolveByPath).toHaveBeenCalledWith('D:/work/demo')
  })

  it('distinguishes an unregistered directory from an unavailable registry', async () => {
    const missing = new DshWorkspaceBindingResolver({ resolveByPath: async () => undefined })
    const unavailable = new DshWorkspaceBindingResolver({
      resolveByPath: async () => { throw new Error('synthetic private backend detail') },
    })

    await expect(missing.resolve('D:/work/demo')).resolves.toEqual({ status: 'UNREGISTERED' })
    await expect(unavailable.resolve('D:/work/demo')).resolves.toEqual({ status: 'UNAVAILABLE' })
  })

  it('fails closed on malformed workspace projections', async () => {
    const resolver = new DshWorkspaceBindingResolver({
      resolveByPath: async () => ({ id: '', path: 'D:/canonical/demo' }),
    })

    await expect(resolver.resolve('D:/work/demo')).resolves.toEqual({ status: 'UNAVAILABLE' })
  })

  it('fails closed on a canonical path outside the durable envelope', async () => {
    const resolver = new DshWorkspaceBindingResolver({
      resolveByPath: async () => ({ id: 'workspace-1', path: `D:/${'x'.repeat(32_768)}` }),
    })

    await expect(resolver.resolve('D:/work/demo')).resolves.toEqual({ status: 'UNAVAILABLE' })
  })
})
