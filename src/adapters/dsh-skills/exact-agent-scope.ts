import type { CaptureWorkItemV1 } from '../../domain/observe/schemas.js'
import {
  deriveSessionCwdDigest,
  deriveSessionLifecycleKey,
} from '../../domain/observe/signal-key.js'
import { normalize, resolve } from 'node:path'

export interface AgentScopeProjection {
  readonly id: string
  readonly session: {
    readonly header: {
      readonly id: string
      readonly createdAt: number
      readonly cwd?: string | undefined
      readonly agentPreset?: string | undefined
    }
    readonly events?: readonly {
      readonly type: string
      readonly data?: unknown
    }[] | undefined
  }
}

export type AgentScopeResolution<TAgent> =
  | {
    readonly status: 'AVAILABLE'
    readonly agent: TAgent
    readonly cwd: string | undefined
    readonly lifecycleKey: string
  }
  | { readonly status: 'UNAVAILABLE' }

interface ScopeEntry<TAgent> {
  readonly agent: TAgent
  readonly cwd: string | undefined
}

export class ExactAgentScopeRegistry<TAgent extends object> {
  private readonly scopes = new Map<string, ScopeEntry<TAgent>>()

  register(agent: TAgent & AgentScopeProjection): () => void {
    const { header } = agent.session
    if (agent.id.length === 0 || header.id !== agent.id) {
      throw new TypeError('Agent and Session identity must match')
    }
    const sessionCwdDigest = deriveSessionCwdDigest(header.cwd)
    const lifecycleKey = deriveSessionLifecycleKey({
      rootSessionId: agent.id,
      sessionCreatedAt: header.createdAt,
      sessionCwdDigest,
    })
    const entry = { agent, cwd: header.cwd }
    this.scopes.set(lifecycleKey, entry)
    return () => {
      if (this.scopes.get(lifecycleKey) === entry) this.scopes.delete(lifecycleKey)
    }
  }

  resolve(item: CaptureWorkItemV1): AgentScopeResolution<TAgent> {
    const lifecycleKey = deriveSessionLifecycleKey({
      rootSessionId: item.signalKey.rootSessionId,
      sessionCreatedAt: item.signalKey.sessionCreatedAt,
      sessionCwdDigest: item.signalKey.sessionCwdDigest,
    })
    const entry = this.scopes.get(lifecycleKey)
    return entry === undefined
      ? { status: 'UNAVAILABLE' }
      : { status: 'AVAILABLE', lifecycleKey, ...entry }
  }

  resolveLifecycleKey(lifecycleKey: string): AgentScopeResolution<TAgent> {
    const entry = this.scopes.get(lifecycleKey)
    return entry === undefined
      ? { status: 'UNAVAILABLE' }
      : { status: 'AVAILABLE', lifecycleKey, ...entry }
  }

  resolveUniqueCwd(cwd: string): AgentScopeResolution<TAgent> {
    const expected = normalize(resolve(cwd))
    const matches = [...this.scopes.entries()].filter(([, entry]) => {
      if (entry.cwd === undefined) return false
      const actual = normalize(resolve(entry.cwd))
      return process.platform === 'win32'
        ? actual.toLowerCase() === expected.toLowerCase()
        : actual === expected
    })
    if (matches.length !== 1) return { status: 'UNAVAILABLE' }
    const [lifecycleKey, entry] = matches[0]!
    return { status: 'AVAILABLE', lifecycleKey, ...entry }
  }

  clear(): void {
    this.scopes.clear()
  }
}
