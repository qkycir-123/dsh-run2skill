import type {
  DshSessionEvent,
  DshSessionHeader,
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
  constructor(private readonly persistence: SessionPersistencePort) {}

  async listSnapshots(signal?: AbortSignal): Promise<SnapshotReadResult> {
    try {
      const snapshots = await this.persistence.listSnapshots(signal)
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
    try {
      const result = await this.persistence.readFrom(sessionId, fromSeq, signal)
      if (
        !isRecord(result)
        || !validHeader(result['meta'])
        || result.meta.id !== sessionId
        || !validEvents(result.events)
      ) {
        return unavailable
      }
      return {
        status: 'AVAILABLE',
        header: cloneHeader(result.meta),
        events: cloneEvents(result.events),
      }
    } catch {
      return unavailable
    }
  }
}
