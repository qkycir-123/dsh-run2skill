import type {
  DshSessionEvent,
  DshSessionHeader,
  DshSessionPersistencePort,
  DshSessionReadHandlePort,
  SessionLogReadResult,
  SessionPersistencePort,
  SessionPersistenceSnapshot,
  SnapshotReadResult,
} from './types.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validHeader(value: unknown): value is DshSessionHeader {
  if (!isRecord(value)) return false
  return isNonNegativeSafeInteger(value['version'])
    && typeof value['id'] === 'string'
    && value['id'].length > 0
    && isNonNegativeSafeInteger(value['createdAt'])
    && (value['cwd'] === undefined || typeof value['cwd'] === 'string')
    && (value['parentSession'] === undefined
      || (typeof value['parentSession'] === 'string' && value['parentSession'].length > 0))
    && (value['origin'] === undefined || value['origin'] === 'subagent')
    && (value['delegationDepth'] === undefined
      || isNonNegativeSafeInteger(value['delegationDepth']))
    && (value['agentPreset'] === undefined
      || (typeof value['agentPreset'] === 'string' && value['agentPreset'].length > 0))
}

function validEvent(value: unknown): value is DshSessionEvent {
  return isRecord(value)
    && typeof value['type'] === 'string'
    && value['type'].length > 0
    && isNonNegativeSafeInteger(value['seq'])
    && isNonNegativeSafeInteger(value['time'])
    && Object.hasOwn(value, 'data')
}

function validEvents(value: unknown): value is readonly DshSessionEvent[] {
  if (!Array.isArray(value)) return false
  for (let index = 0; index < value.length; index += 1) {
    if (!validEvent(value[index])) return false
  }
  return true
}

function cloneHeader(header: DshSessionHeader): DshSessionHeader {
  return structuredClone(header)
}

function cloneEvents(events: readonly DshSessionEvent[]): readonly DshSessionEvent[] {
  return structuredClone(events)
}

function validSnapshot(snapshot: unknown): snapshot is SessionPersistenceSnapshot {
  return isRecord(snapshot)
    && typeof snapshot['revision'] === 'string'
    && snapshot['revision'].length > 0
    && validHeader(snapshot['header'])
}

export class DshSessionGapReader {
  constructor(private readonly persistence: DshSessionPersistencePort | SessionPersistencePort) {}

  async listSnapshots(signal?: AbortSignal): Promise<SnapshotReadResult> {
    try {
      const snapshots = 'list' in this.persistence
        ? await this.persistence.list(signal === undefined ? undefined : { signal })
        : await this.persistence.listSnapshots(signal)
      if (!Array.isArray(snapshots) || snapshots.some((snapshot) => !validSnapshot(snapshot))) {
        return { status: 'UNAVAILABLE', healthCode: 'SESSION_SNAPSHOTS_UNAVAILABLE' }
      }
      return {
        status: 'AVAILABLE',
        snapshots: snapshots.map((snapshot) => ({
          header: cloneHeader(snapshot.header),
          revision: snapshot.revision,
        })),
      }
    } catch {
      return { status: 'UNAVAILABLE', healthCode: 'SESSION_SNAPSHOTS_UNAVAILABLE' }
    }
  }

  async readFrom(
    sessionId: string,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<SessionLogReadResult> {
    const unavailable: SessionLogReadResult = {
      status: 'UNAVAILABLE',
      healthCode: 'SESSION_LOG_UNAVAILABLE',
      sessionId,
      fromSeq,
    }
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) return unavailable
    let handle: DshSessionReadHandlePort | undefined
    let result: SessionLogReadResult = unavailable
    try {
      if (!('open' in this.persistence)) {
        const legacy = await this.persistence.readFrom(sessionId, fromSeq, signal)
        if (
          isRecord(legacy)
          && validHeader(legacy['meta'])
          && legacy.meta.id === sessionId
          && validEvents(legacy.events)
        ) {
          return {
            status: 'AVAILABLE',
            header: cloneHeader(legacy.meta),
            events: cloneEvents(legacy.events),
          }
        }
        return unavailable
      }
      handle = await this.persistence.open(
        sessionId,
        'read',
        signal === undefined ? undefined : { signal },
      )
      const read = await handle.read(
        fromSeq,
        undefined,
        signal === undefined ? undefined : { signal },
      )
      if (
        !validHeader(handle.header)
        || handle.header.id !== sessionId
        || !isRecord(read)
        || (read['eventState'] !== 'detached' && read['eventState'] !== 'shared-frozen')
        || !validEvents(read['events'])
      ) {
        result = unavailable
      } else {
        result = {
          status: 'AVAILABLE',
          header: cloneHeader(handle.header),
          events: cloneEvents(read.events),
        }
      }
    } catch {
      result = unavailable
    }
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        return unavailable
      }
    }
    return result
  }
}

/** Converts the lifecycle-owned DSH service into run2skill's detached reader port. */
export class DshSessionPersistenceAdapter implements SessionPersistencePort {
  readonly #reader: DshSessionGapReader

  constructor(persistence: DshSessionPersistencePort) {
    this.#reader = new DshSessionGapReader(persistence)
  }

  async listSnapshots(signal?: AbortSignal): Promise<readonly SessionPersistenceSnapshot[]> {
    const result = await this.#reader.listSnapshots(signal)
    if (result.status === 'UNAVAILABLE') throw new Error(result.healthCode)
    return result.snapshots
  }

  async readFrom(
    sessionId: string,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ readonly meta: DshSessionHeader; readonly events: readonly DshSessionEvent[] }> {
    const result = await this.#reader.readFrom(sessionId, fromSeq, signal)
    if (result.status === 'UNAVAILABLE') throw new Error(result.healthCode)
    return { meta: result.header, events: result.events }
  }
}
