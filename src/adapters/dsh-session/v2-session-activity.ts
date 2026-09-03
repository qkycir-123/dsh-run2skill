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
  snapshotEvents(): readonly DshSessionEvent[]
}

export interface DshLiveSessionRegistryPort {
  get(sessionId: string): DshLiveSessionProjection | undefined
}

export interface DshLiveAgentProjection {
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly session: DshLiveSessionProjection
  whenIdle(): Promise<void>
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
  readonly durableLatestTurnEndSeq: number
  readonly durableOpenTurn: boolean
}

interface LiveSample {
  readonly live: DshLiveSessionProjection | undefined
  readonly liveCoordinates: string
  readonly agent: DshLiveAgentProjection | undefined
  readonly agentStatus: 'idle' | 'running' | 'absent'
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

function durableTurnState(events: readonly DshSessionEvent[]): {
  readonly latestTurnEndSeq: number
  readonly openTurn: boolean
} | undefined {
  let openTurn = false
  let latestTurnEndSeq: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      if (openTurn) return undefined
      openTurn = true
    } else if (event.type === 'turn/end') {
      if (!openTurn) return undefined
      openTurn = false
      latestTurnEndSeq = event.seq
    }
  }
  return latestTurnEndSeq === undefined ? undefined : { latestTurnEndSeq, openTurn }
}

function sameLiveSample(left: LiveSample, right: LiveSample): boolean {
  return left.live === right.live
    && left.liveCoordinates === right.liveCoordinates
    && left.agent === right.agent
    && left.agentStatus === right.agentStatus
}

function unavailable(sessionLifecycleKey: string): DshSessionActivityObservation {
  return {
    complete: false,
    activeAgent: false,
    activityRevision: sha256Utf8(canonicalJson({ contract: 'dsh-session-activity-v1', sessionLifecycleKey, unavailable: true })),
    durableLatestTurnEndSeq: 0,
    durableOpenTurn: true,
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
      const turnState = durableTurnState(log.events)
      if (turnState === undefined) return failed

      const initialLive = this.#sampleLive(before.header.id, sessionLifecycleKey, log.events)
      if (initialLive === undefined) return failed
      if (initialLive.agent?.status === 'idle') await initialLive.agent.whenIdle()
      const settledLive = this.#sampleLive(before.header.id, sessionLifecycleKey, log.events)
      if (settledLive === undefined || !sameLiveSample(initialLive, settledLive)) return failed

      const afterRead = await this.#reader.listSnapshots()
      if (afterRead.status !== 'AVAILABLE') return failed
      const after = exactSnapshot(afterRead.snapshots, sessionLifecycleKey)
      if (
        after === undefined
        || after.revision !== before.revision
        || canonicalJson(after.header) !== canonicalJson(before.header)
      ) return failed

      const finalLive = this.#sampleLive(before.header.id, sessionLifecycleKey, log.events)
      if (finalLive === undefined || !sameLiveSample(settledLive, finalLive)) return failed

      const activeAgent = finalLive.agentStatus === 'running'
      return {
        complete: true,
        activeAgent,
        durableLatestTurnEndSeq: turnState.latestTurnEndSeq,
        durableOpenTurn: turnState.openTurn,
        activityRevision: sha256Utf8(canonicalJson({
          contract: 'dsh-session-activity-v1',
          sessionLifecycleKey,
          persistenceRevision: before.revision,
          durableEventCoordinates: eventCoordinates(log.events),
          durableLatestTurnEndSeq: turnState.latestTurnEndSeq,
          durableOpenTurn: turnState.openTurn,
          live: finalLive.live !== undefined,
          agentStatus: finalLive.agentStatus,
        })),
      }
    } catch {
      return failed
    }
  }

  #sampleLive(
    sessionId: string,
    sessionLifecycleKey: string,
    durableEvents: readonly DshSessionEvent[],
  ): LiveSample | undefined {
    const live = this.#sessions.get(sessionId)
    const liveEvents = live?.snapshotEvents()
    if (live !== undefined && (
      lifecycleKey(live.header) !== sessionLifecycleKey
      || liveEvents === undefined
      || !sameSessionPrefix(liveEvents, durableEvents)
    )) return undefined
    const agent = this.#agents.get(sessionId)
    if (agent !== undefined && (
      live === undefined
      || agent.id !== sessionId
      || agent.session !== live
      || lifecycleKey(agent.session.header) !== sessionLifecycleKey
      || (agent.status !== 'idle' && agent.status !== 'running')
      || typeof agent.whenIdle !== 'function'
    )) return undefined
    return {
      live,
      liveCoordinates: canonicalJson(eventCoordinates(liveEvents ?? [])),
      agent,
      agentStatus: agent?.status ?? 'absent',
    }
  }
}
