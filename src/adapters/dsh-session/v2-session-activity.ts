import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import { deriveSessionCwdDigest, deriveSessionLifecycleKey } from '../../domain/observe/signal-key.js'
import { DshSessionGapReader } from './gap-reader.js'
import { classifySessionRoot } from './observation.js'
import type {
  DshSessionEvent,
  DshSessionHeader,
  SessionPersistencePort,
  SessionPersistenceSnapshot,
} from './types.js'

export interface DshLiveSessionProjection {
  readonly header: DshSessionHeader
  readonly events: readonly DshSessionEvent[]
}

export interface DshLiveSessionRegistryPort {
  get(sessionId: string): DshLiveSessionProjection | undefined
}

export interface DshLiveAgentProjection {
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly session: DshLiveSessionProjection
}

export interface DshLiveAgentRegistryPort {
  get(sessionId: string): DshLiveAgentProjection | undefined
}

export interface DshSessionActivityAdapterOptions {
  readonly persistence: SessionPersistencePort
  readonly sessions: DshLiveSessionRegistryPort
  readonly agents: DshLiveAgentRegistryPort
}

export interface DshSessionActivityObservation {
  readonly complete: boolean
  readonly activeAgent: boolean
  readonly activityRevision: string
}

function lifecycleKey(header: DshSessionHeader): string | undefined {
  if (classifySessionRoot(header).status !== 'ROOT') return undefined
  return deriveSessionLifecycleKey({
    rootSessionId: header.id,
    sessionCreatedAt: header.createdAt,
    sessionCwdDigest: deriveSessionCwdDigest(header.cwd),
  })
}

function exactSnapshot(
  snapshots: readonly SessionPersistenceSnapshot[],
  sessionLifecycleKey: string,
): SessionPersistenceSnapshot | undefined {
  const matches = snapshots.filter(snapshot => lifecycleKey(snapshot.header) === sessionLifecycleKey)
  return matches.length === 1 ? matches[0] : undefined
}

function eventCoordinates(events: readonly DshSessionEvent[]) {
  return events.map(event => ({ type: event.type, seq: event.seq, time: event.time }))
}

function sameSessionPrefix(
  live: readonly DshSessionEvent[],
  durable: readonly DshSessionEvent[],
): boolean {
  return canonicalJson(eventCoordinates(live)) === canonicalJson(eventCoordinates(durable))
}

function unavailable(sessionLifecycleKey: string): DshSessionActivityObservation {
  return {
    complete: false,
    activeAgent: false,
    activityRevision: sha256Utf8(canonicalJson({ contract: 'dsh-session-activity-v1', sessionLifecycleKey, unavailable: true })),
  }
}

/**
 * Reads one stable durable Session snapshot and joins it to the exact live
 * Session/Agent identities. Any mixed snapshot or unflushed live tail is
 * incomplete, so a quiescence fence cannot be issued from partial facts.
 */
export class DshSessionActivityAdapter {
  readonly #reader: DshSessionGapReader
  readonly #sessions: DshLiveSessionRegistryPort
  readonly #agents: DshLiveAgentRegistryPort

  constructor(options: DshSessionActivityAdapterOptions) {
    this.#reader = new DshSessionGapReader(options.persistence)
    this.#sessions = options.sessions
    this.#agents = options.agents
  }

  async observe(sessionLifecycleKey: string): Promise<DshSessionActivityObservation> {
    const failed = unavailable(sessionLifecycleKey)
    try {
      const beforeRead = await this.#reader.listSnapshots()
      if (beforeRead.status !== 'AVAILABLE') return failed
      const before = exactSnapshot(beforeRead.snapshots, sessionLifecycleKey)
      if (before === undefined) return failed

      const log = await this.#reader.readFrom(before.header.id, 0)
      if (
        log.status !== 'AVAILABLE'
        || lifecycleKey(log.header) !== sessionLifecycleKey
        || canonicalJson(log.header) !== canonicalJson(before.header)
      ) return failed

      const live = this.#sessions.get(before.header.id)
      if (live !== undefined && (
        lifecycleKey(live.header) !== sessionLifecycleKey
        || !sameSessionPrefix(live.events, log.events)
      )) return failed

      const agent = this.#agents.get(before.header.id)
      if (agent !== undefined && (
        live === undefined
        || agent.id !== before.header.id
        || agent.session !== live
        || lifecycleKey(agent.session.header) !== sessionLifecycleKey
        || (agent.status !== 'idle' && agent.status !== 'running')
      )) return failed

      const afterRead = await this.#reader.listSnapshots()
      if (afterRead.status !== 'AVAILABLE') return failed
      const after = exactSnapshot(afterRead.snapshots, sessionLifecycleKey)
      if (
        after === undefined
        || after.revision !== before.revision
        || canonicalJson(after.header) !== canonicalJson(before.header)
      ) return failed

      const activeAgent = agent?.status === 'running'
      return {
        complete: true,
        activeAgent,
        activityRevision: sha256Utf8(canonicalJson({
          contract: 'dsh-session-activity-v1',
          sessionLifecycleKey,
          persistenceRevision: before.revision,
          durableEventCoordinates: eventCoordinates(log.events),
          live: live !== undefined,
          agentStatus: agent?.status ?? 'absent',
        })),
      }
    } catch {
      return failed
    }
  }
}
