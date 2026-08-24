import { posix, win32 } from 'node:path'
import { z } from 'zod'
import type { SessionPersistencePort, DshSessionEvent, DshSessionHeader } from '../dsh-session/types.js'
import type { OwnershipObservationPort } from '../../application/ownership/index.js'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import { deriveSessionCwdDigest, deriveSessionLifecycleKey } from '../../domain/observe/signal-key.js'
import { parseDshSkillFileForOwnership } from './v2-skill-file.js'
import type { ExperienceIntentV2, OwnershipEvidenceV2, SessionBatchV2 } from '../../domain/v2/index.js'
import { parseDshContextFileSystem } from '../dsh-filesystem/context-filesystem.js'

type OwnershipCandidate = NonNullable<SessionBatchV2['batchManifestBaseline']['ownershipCandidates']>[number]

const toolCallSchema = z.object({
  turn: z.number().int().nonnegative().safe(),
  step: z.number().int().nonnegative().safe(),
  callId: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  arguments: z.string().max(1024 * 1024),
}).passthrough()

const toolResultSchema = z.object({
  turn: z.number().int().nonnegative().safe(),
  step: z.number().int().nonnegative().safe(),
  message: z.object({
    role: z.literal('user'),
    source: z.object({
      kind: z.literal('tool'),
      callId: z.string().min(1).max(256),
    }).passthrough(),
    content: z.array(z.object({
      type: z.literal('tool-result'),
      toolCallId: z.string().min(1).max(256),
      isError: z.boolean().optional(),
      content: z.array(z.unknown()).max(1024),
    }).passthrough()).length(1),
  }).passthrough(),
  error: z.unknown().optional(),
}).passthrough()

const assistantMessageSchema = z.object({
  turn: z.number().int().nonnegative().safe(),
  step: z.number().int().nonnegative().safe(),
  message: z.object({
    role: z.literal('assistant'),
    content: z.array(z.unknown()).max(4096),
  }).passthrough(),
}).passthrough()

const textContentSchema = z.object({
  type: z.literal('text'),
  text: z.string().max(1024 * 1024),
}).passthrough()

const SAFE_TOOLS = new Set([
  'get_goal', 'glob', 'grep', 'job_list', 'job_output', 'list_agents', 'lsp', 'read', 'read_image',
  'session_event_read', 'session_event_search', 'session_event_trace', 'session_search', 'session_trace',
  'skill', 'terminal_list', 'terminal_read', 'todo_write', 'web_fetch', 'web_search',
])
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'terminal_open', 'terminal_send'])
const DIRECT_FILE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
const STR_REPLACE_EDITOR_WRITE_COMMANDS = new Set(['create', 'str_replace', 'insert'])
const SKILL_MARKER = /(?:SKILL\.md|[\\/]\.(?:dsh|agents)[\\/]skills[\\/]|[\\/]skills[\\/])/iu
const SUPPORTED_TURN_EVENTS = new Set([
  // DSH rc.8 emits these control-plane records inside the Turn envelope.
  // They only manage the Agent inbox or the log-backed Session title and
  // cannot mutate files; the tool/call + tool/result pairs below remain the
  // authoritative evidence for filesystem activity.
  'agent/inbox/spliced', 'session/title', 'session/title-llm-request',
  'approval/asked', 'approval/decided',
  'turn/start', 'turn/end', 'step/start', 'step/end', 'user/message', 'assistant/chunk',
  'assistant/message', 'tool/call', 'tool/result', 'todo/write', 'request/header',
  'request/context', 'session/end-seed',
])

interface OwnershipObservationPolicy {
  readonly readLookbehindSeqs: number
  readonly maxReadEvents: number
  readonly maxWindowEvents: number
  readonly maxEvidenceBytes: number
  readonly maxAnalysisMs: number
}

const DEFAULT_OWNERSHIP_OBSERVATION_POLICY: OwnershipObservationPolicy = Object.freeze({
  readLookbehindSeqs: 10_000,
  maxReadEvents: 20_000,
  maxWindowEvents: 10_000,
  maxEvidenceBytes: 64 * 1024 * 1024,
  maxAnalysisMs: 500,
})

export interface DshV2OwnershipObservationAdapterOptions {
  readonly persistence: SessionPersistencePort
  readonly resolveSession: (sessionLifecycleKey: string) => {
    readonly header: DshSessionHeader
    readonly filesystem?: unknown
  } | undefined
  readonly manifest: {
    capture(sessionLifecycleKey: string): Promise<SessionBatchV2['batchManifestBaseline']>
  }
  readonly now?: () => number
  readonly internalPolicy?: Partial<OwnershipObservationPolicy>
  readonly resolveTargetPathDigest?: (path: string, cwd?: string) => Promise<string | undefined>
}

interface ParsedWrite {
  readonly targetPath?: string
  readonly targetPathDigest?: string
  readonly readbackBody?: string
  readonly readbackBodyDigest?: string
  readonly failed: boolean
  readonly skillMarker: boolean
  readonly ambiguousBodyEvidence: boolean
}

interface ToolEvidence {
  readonly complete: boolean
  readonly activity: Extract<OwnershipEvidenceV2, { status: 'OBSERVED' }>['agentActivity']
  readonly writes: readonly ParsedWrite[]
  readonly unattributedBodyEvidence: boolean
}

function isWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/u.test(value) || value.includes('\\')
}

function pathApi(value: string, cwd?: string): typeof win32 | typeof posix {
  if (isWindowsPath(value)) return win32
  if (posix.isAbsolute(value)) return posix
  return cwd !== undefined && isWindowsPath(cwd) ? win32 : posix
}

function canonicalPath(value: string, cwd?: string): string {
  const api = pathApi(value, cwd)
  const resolved = api.isAbsolute(value) ? api.resolve(value) : api.resolve(cwd ?? '.', value)
  return api === win32 ? resolved.toLowerCase() : resolved
}

export function deriveOwnershipTargetPathDigest(path: string, cwd?: string): string {
  return sha256Utf8(canonicalJson({ path: canonicalPath(path, cwd) }))
}

function deriveContextTargetPathDigest(targetKey: string): string {
  return sha256Utf8(canonicalJson({
    contract: 'dsh-fs-target-v1',
    targetKeyDigest: sha256Utf8(targetKey),
  }))
}

function sameHeader(left: DshSessionHeader, right: DshSessionHeader): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function exactSnapshot(
  snapshots: readonly { readonly header: DshSessionHeader; readonly revision: string }[],
  sessionLifecycleKey: string,
  resolvedHeader?: DshSessionHeader,
) {
  const matches = snapshots.filter(snapshot => resolvedHeader === undefined
    ? deriveSessionLifecycleKey({
        rootSessionId: snapshot.header.id,
        sessionCreatedAt: snapshot.header.createdAt,
        sessionCwdDigest: deriveSessionCwdDigest(snapshot.header.cwd),
      }) === sessionLifecycleKey
    : snapshot.header.id === resolvedHeader.id
      && snapshot.header.createdAt === resolvedHeader.createdAt
      && snapshot.header.cwd === resolvedHeader.cwd)
  return matches.length === 1 ? matches[0] : undefined
}

function batchWindow(
  events: readonly DshSessionEvent[],
  batch: SessionBatchV2,
  policy: OwnershipObservationPolicy,
  deadline: number,
): readonly DshSessionEvent[] | undefined {
  if (events.length > policy.maxReadEvents) return undefined
  for (let index = 1; index < events.length; index += 1) {
    if (Date.now() > deadline || events[index]!.seq <= events[index - 1]!.seq) return undefined
  }
  const firstEndIndex = events.findIndex(event => (
    event.seq === batch.firstTurnEndSeq && event.type === 'turn/end'
  ))
  const lastEndIndex = events.findIndex(event => (
    event.seq === batch.lastTurnEndSeq && event.type === 'turn/end'
  ))
  if (firstEndIndex < 0 || lastEndIndex < firstEndIndex) return undefined
  let firstStartIndex: number | undefined
  for (let index = firstEndIndex - 1; index >= 0; index -= 1) {
    if (Date.now() > deadline) return undefined
    const event = events[index]!
    if (event.type === 'turn/end') return undefined
    if (event.type === 'turn/start') {
      firstStartIndex = index
      break
    }
  }
  if (firstStartIndex === undefined) return undefined
  const window = events.slice(firstStartIndex, lastEndIndex + 1)
  if (window.length > policy.maxWindowEvents) return undefined
  let openStart: number | undefined
  const ends = new Set<number>()
  for (const event of window) {
    if (Date.now() > deadline) return undefined
    if (event.type === 'turn/start') {
      if (openStart !== undefined) return undefined
      openStart = event.seq
    } else if (event.type === 'turn/end') {
      if (openStart === undefined) return undefined
      ends.add(event.seq)
      openStart = undefined
    }
  }
  if (
    openStart !== undefined
    || !ends.has(batch.firstTurnEndSeq)
    || !ends.has(batch.lastTurnEndSeq)
    || batch.observationManifest.some(item => !ends.has(item.turnEndSeq))
  ) return undefined
  if (window.some(event => !SUPPORTED_TURN_EVENTS.has(event.type) && event.ignorable !== true)) return undefined
  return window
}

function resultFailed(raw: z.infer<typeof toolResultSchema>): boolean {
  if (raw.error !== undefined) return true
  return raw.message.content[0]!.isError === true
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function directWrite(
  name: string,
  rawArguments: string,
  failed: boolean,
  cwd: string | undefined,
): ParsedWrite | undefined {
  const args = parseJsonObject(rawArguments)
  if (args === undefined) return undefined
  const path = name === 'str_replace_editor' ? args.path : args.file_path
  if (typeof path !== 'string' || path.trim().length === 0) return undefined
  const fullContent = name === 'write'
    ? args.content
    : name === 'str_replace_editor' && args.command === 'create'
      ? args.file_text
      : undefined
  const mutationText = name === 'edit'
    ? args.new_string
    : name === 'str_replace_editor' && (args.command === 'str_replace' || args.command === 'insert')
      ? args.new_str
      : undefined
  const requiresFullContent = name === 'write'
    || (name === 'str_replace_editor' && args.command === 'create')
  const requiresMutationText = name === 'edit'
    || (name === 'str_replace_editor' && (args.command === 'str_replace' || args.command === 'insert'))
  if (requiresFullContent && typeof fullContent !== 'string') return undefined
  if (requiresMutationText && typeof mutationText !== 'string') return undefined
  const readback = typeof fullContent === 'string' ? parseDshSkillFileForOwnership(fullContent) : undefined
  const authoredText = typeof fullContent === 'string' ? fullContent : mutationText
  const authoredBodyEvidence = typeof authoredText === 'string' ? skillBodyEvidence(authoredText) : 'NONE'
  return {
    targetPath: path,
    targetPathDigest: deriveOwnershipTargetPathDigest(path, cwd),
    ...(readback === undefined
      ? {}
      : { readbackBody: readback.body, readbackBodyDigest: sha256Utf8(readback.body) }),
    failed,
    skillMarker: SKILL_MARKER.test(path)
      || (typeof fullContent === 'string' && /(?:^|\n)name:\s*[a-z0-9-]+/iu.test(fullContent))
      || authoredBodyEvidence === 'COMPLETE',
    ambiguousBodyEvidence: authoredBodyEvidence === 'AMBIGUOUS',
  }
}

function skillBodyEvidence(value: string): 'COMPLETE' | 'NONE' | 'AMBIGUOUS' {
  const lines = value.split('\n')
  let sawSkillShape = false
  for (let opening = 0; opening < lines.length; opening += 1) {
    if (lines[opening]!.replace(/\r$/u, '') !== '---') continue
    const closing = lines.findIndex(
      (line, index) => index > opening && line.replace(/\r$/u, '') === '---',
    )
    if (closing < 0) {
      const tail = lines.slice(opening + 1).join('\n')
      if (/^(?:name|description):/imu.test(tail)) sawSkillShape = true
      continue
    }
    const header = lines.slice(opening + 1, closing).join('\n')
    const body = lines.slice(closing + 1).join('\n')
      .replace(/^\s*```(?:markdown|md)?\s*$/gimu, '')
      .trim()
    const hasName = /^name:\s*[^\s#][^\r\n]*$/imu.test(header)
    const hasDescription = /^description:\s*[^\s#][^\r\n]*$/imu.test(header)
    if (
      hasName
      && hasDescription
      && body.length > 0
    ) return 'COMPLETE'
    if (hasName || hasDescription) sawSkillShape = true
    opening = closing
  }
  return sawSkillShape ? 'AMBIGUOUS' : 'NONE'
}

function shellSkillEvidence(rawArguments: string): 'COMPLETE' | 'NONE' | 'AMBIGUOUS' {
  if (SKILL_MARKER.test(rawArguments)) return 'COMPLETE'
  const args = parseJsonObject(rawArguments)
  if (args === undefined) return 'AMBIGUOUS'
  let result: 'NONE' | 'AMBIGUOUS' = 'NONE'
  for (const value of Object.values(args)) {
    if (typeof value !== 'string') continue
    const evidence = skillBodyEvidence(value)
    if (evidence === 'COMPLETE') return evidence
    if (evidence === 'AMBIGUOUS') result = evidence
  }
  return result
}

async function analyzeTools(
  events: readonly DshSessionEvent[],
  cwd: string | undefined,
  knownSkillTargetDigests: ReadonlySet<string>,
  policy: OwnershipObservationPolicy,
  deadline: number,
  resolveTargetPathDigest?: (path: string, cwd?: string) => Promise<string | undefined>,
): Promise<ToolEvidence> {
  const calls = new Map<string, { readonly seq: number; readonly data: z.infer<typeof toolCallSchema> }>()
  const results = new Map<string, { readonly seq: number; readonly data: z.infer<typeof toolResultSchema> }>()
  let activity: ToolEvidence['activity'] = 'NONE'
  let unattributedBodyEvidence = false
  let evidenceBytes = 0
  for (const event of events) {
    if (Date.now() > deadline) {
      return { complete: false, activity: 'AMBIGUOUS', writes: [], unattributedBodyEvidence: true }
    }
    if (event.type === 'assistant/message') {
      const parsed = assistantMessageSchema.safeParse(event.data)
      if (!parsed.success) {
        return { complete: false, activity: 'AMBIGUOUS', writes: [], unattributedBodyEvidence: true }
      }
      const text: string[] = []
      for (const block of parsed.data.message.content) {
        if (typeof block !== 'object' || block === null || !('type' in block) || block.type !== 'text') continue
        const parsedText = textContentSchema.safeParse(block)
        if (!parsedText.success) {
          return { complete: false, activity: 'AMBIGUOUS', writes: [], unattributedBodyEvidence: true }
        }
        const blockBytes = Buffer.byteLength(parsedText.data.text, 'utf8')
        if (blockBytes > policy.maxEvidenceBytes - evidenceBytes) {
          return { complete: false, activity: 'AMBIGUOUS', writes: [], unattributedBodyEvidence: true }
        }
        evidenceBytes += blockBytes
        text.push(parsedText.data.text)
      }
      const bodyEvidence = skillBodyEvidence(text.join('\n'))
      if (bodyEvidence === 'COMPLETE') {
        activity = 'BODY_GENERATED'
      } else if (bodyEvidence === 'AMBIGUOUS') {
        activity = 'AMBIGUOUS'
        unattributedBodyEvidence = true
      }
    } else if (event.type === 'tool/call') {
      const parsed = toolCallSchema.safeParse(event.data)
      if (!parsed.success || calls.has(parsed.data.callId)) {
        return { complete: false, activity: 'AMBIGUOUS', writes: [], unattributedBodyEvidence: true }
      }
      const argumentBytes = Buffer.byteLength(parsed.data.arguments, 'utf8')
      if (argumentBytes > policy.maxEvidenceBytes - evidenceBytes) {
        return { complete: false, activity: 'AMBIGUOUS', writes: [], unattributedBodyEvidence: true }
      }
      evidenceBytes += argumentBytes
      calls.set(parsed.data.callId, { seq: event.seq, data: parsed.data })
    } else if (event.type === 'tool/result') {
      const parsed = toolResultSchema.safeParse(event.data)
      if (
        !parsed.success
        || parsed.data.message.content[0]!.toolCallId !== parsed.data.message.source.callId
        || results.has(parsed.data.message.source.callId)
      ) {
        return { complete: false, activity: 'AMBIGUOUS', writes: [], unattributedBodyEvidence: true }
      }
      results.set(parsed.data.message.source.callId, { seq: event.seq, data: parsed.data })
    }
  }
  if (calls.size !== results.size || [...calls.keys()].some(callId => !results.has(callId))) {
    return { complete: false, activity: 'AMBIGUOUS', writes: [], unattributedBodyEvidence: true }
  }

  const writes: ParsedWrite[] = []
  for (const [callId, observedCall] of calls) {
    if (Date.now() > deadline) {
      return { complete: false, activity: 'AMBIGUOUS', writes: [], unattributedBodyEvidence: true }
    }
    const observedResult = results.get(callId)!
    const call = observedCall.data
    const result = observedResult.data
    if (
      observedResult.seq <= observedCall.seq
      || call.turn !== result.turn
      || call.step !== result.step
    ) {
      return { complete: false, activity: 'AMBIGUOUS', writes: [], unattributedBodyEvidence: true }
    }
    const failed = resultFailed(result)
    if (SAFE_TOOLS.has(call.name)) continue
    if (DIRECT_FILE_TOOLS.has(call.name)) {
      if (call.name === 'str_replace_editor') {
        const args = parseJsonObject(call.arguments)
        if (args?.command === 'view') continue
        if (typeof args?.command !== 'string' || !STR_REPLACE_EDITOR_WRITE_COMMANDS.has(args.command)) {
          return { complete: false, activity: 'AMBIGUOUS', writes: [], unattributedBodyEvidence: true }
        }
      }
      let parsedWrite = directWrite(call.name, call.arguments, failed, cwd)
      if (parsedWrite === undefined) {
        return { complete: false, activity: 'AMBIGUOUS', writes: [], unattributedBodyEvidence: true }
      }
      if (resolveTargetPathDigest !== undefined) {
        const targetPathDigest = parsedWrite.targetPath === undefined
          ? undefined
          : await resolveTargetPathDigest(parsedWrite.targetPath, cwd)
        if (targetPathDigest === undefined || Date.now() > deadline) {
          return { complete: false, activity: 'AMBIGUOUS', writes: [], unattributedBodyEvidence: true }
        }
        parsedWrite = { ...parsedWrite, targetPathDigest }
      }
      const write = !parsedWrite.skillMarker
        && parsedWrite.targetPathDigest !== undefined
        && knownSkillTargetDigests.has(parsedWrite.targetPathDigest)
        ? { ...parsedWrite, skillMarker: true }
        : parsedWrite
      writes.push(write)
      if (write.ambiguousBodyEvidence) {
        activity = 'AMBIGUOUS'
        unattributedBodyEvidence = true
      } else if (write.skillMarker && activity === 'NONE') {
        activity = failed ? 'WRITE_FAILED' : 'BODY_GENERATED'
      }
      continue
    }
    if (SHELL_TOOLS.has(call.name)) {
      const evidence = shellSkillEvidence(call.arguments)
      if (evidence === 'COMPLETE') {
        activity = 'BODY_GENERATED'
        unattributedBodyEvidence = true
      } else if (evidence === 'AMBIGUOUS') {
        activity = 'AMBIGUOUS'
        unattributedBodyEvidence = true
      }
      continue
    }
    activity = 'AMBIGUOUS'
    unattributedBodyEvidence = true
  }
  // Candidate/root membership is intentionally path-free. An unmatched failed
  // mutation therefore cannot prove it was outside a custom or bundled Skill
  // root, so fail closed instead of allowing a second generation channel.
  if (writes.some(write => write.failed)) activity = 'WRITE_FAILED'
  return { complete: true, activity, writes, unattributedBodyEvidence }
}

function changedCandidates(
  baseline: readonly OwnershipCandidate[],
  end: readonly OwnershipCandidate[],
): readonly { readonly baseline?: OwnershipCandidate; readonly end?: OwnershipCandidate }[] {
  const before = new Map(baseline.map(candidate => [candidate.candidateId, candidate]))
  const after = new Map(end.map(candidate => [candidate.candidateId, candidate]))
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort((left, right) => left.localeCompare(right))
    .flatMap((candidateId) => {
      const previous = before.get(candidateId)
      const current = after.get(candidateId)
      return previous !== undefined && current !== undefined && canonicalJson(previous) === canonicalJson(current)
        ? []
        : [{ ...(previous === undefined ? {} : { baseline: previous }), ...(current === undefined ? {} : { end: current }) }]
    })
}

function containsIntentContract(content: string, intent: ExperienceIntentV2): boolean {
  const normalize = (value: string) => value.toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim()
  const body = normalize(content)
  return [intent.applicabilitySummary, ...intent.keySteps, ...intent.prohibitions]
    .every(fragment => body.includes(normalize(fragment)))
}

/**
 * Projects stable durable DSH Session/tool facts plus two complete path-free
 * Catalog manifests into the Agent-first ownership evidence contract.
 */
export class DshV2OwnershipObservationAdapter implements OwnershipObservationPort {
  readonly #now: () => number
  readonly #policy: OwnershipObservationPolicy

  constructor(private readonly options: DshV2OwnershipObservationAdapterOptions) {
    this.#now = options.now ?? Date.now
    this.#policy = { ...DEFAULT_OWNERSHIP_OBSERVATION_POLICY, ...options.internalPolicy }
    if (!Object.values(this.#policy).every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new TypeError('Invalid ownership observation policy')
    }
  }

  async observe(input: {
    readonly batch: SessionBatchV2
    readonly intent: ExperienceIntentV2
    readonly inputDigest: string
  }): Promise<OwnershipEvidenceV2> {
    let failureCode: Extract<OwnershipEvidenceV2, { status: 'UNAVAILABLE' }>['reasonCode'] = 'SESSION_CONTEXT_UNAVAILABLE'
    try {
      const session = this.options.resolveSession(input.batch.sessionLifecycleKey)
      failureCode = 'SESSION_SNAPSHOT_UNAVAILABLE'
      const beforeList = await this.options.persistence.listSnapshots()
      const before = exactSnapshot(beforeList, input.batch.sessionLifecycleKey, session?.header)
      if (before === undefined) return { status: 'UNAVAILABLE', reasonCode: 'SESSION_SNAPSHOT_UNAVAILABLE' }
      const fromSeq = Math.max(0, input.batch.firstTurnEndSeq - this.#policy.readLookbehindSeqs)
      failureCode = 'SESSION_LOG_UNAVAILABLE'
      const log = await this.options.persistence.readFrom(before.header.id, fromSeq)
      if (!sameHeader(log.meta, before.header)) {
        return { status: 'UNAVAILABLE', reasonCode: 'SESSION_LOG_UNAVAILABLE' }
      }
      failureCode = 'SESSION_WINDOW_INCOMPLETE'
      const window = batchWindow(
        log.events, input.batch, this.#policy, Date.now() + this.#policy.maxAnalysisMs,
      )
      if (window === undefined) return { status: 'UNAVAILABLE', reasonCode: 'SESSION_WINDOW_INCOMPLETE' }

      failureCode = 'OWNERSHIP_ANALYSIS_UNAVAILABLE'
      const end = await this.options.manifest.capture(input.batch.sessionLifecycleKey)
      failureCode = 'SESSION_SNAPSHOT_UNAVAILABLE'
      const afterList = await this.options.persistence.listSnapshots()
      const after = exactSnapshot(afterList, input.batch.sessionLifecycleKey, session?.header)
      if (after === undefined) {
        return { status: 'UNAVAILABLE', reasonCode: 'SESSION_SNAPSHOT_UNAVAILABLE' }
      }
      if (!sameHeader(after.header, before.header) || after.revision !== before.revision) {
        return { status: 'UNAVAILABLE', reasonCode: 'SESSION_CHANGED_DURING_CHECK' }
      }

      failureCode = 'OWNERSHIP_ANALYSIS_UNAVAILABLE'
      const baselineCandidates = input.batch.batchManifestBaseline.ownershipCandidates
      const endCandidates = end.ownershipCandidates
      const catalogComplete = input.batch.batchManifestBaseline.complete
        && end.complete
        && baselineCandidates !== undefined
        && endCandidates !== undefined
      const knownSkillTargetDigests = new Set(
        [...(baselineCandidates ?? []), ...(endCandidates ?? [])]
          .flatMap(candidate => candidate.targetPathDigest === undefined ? [] : [candidate.targetPathDigest]),
      )
      const contextFilesystem = session?.filesystem === undefined
        ? undefined
        : parseDshContextFileSystem(session.filesystem)
      const resolveTargetPathDigest = this.options.resolveTargetPathDigest
        ?? (session?.filesystem === undefined
          ? undefined
          : async (path: string, cwd?: string) => {
              if (contextFilesystem === undefined) return undefined
              try {
                const target = await contextFilesystem.resolve(path, { cwd })
                return deriveContextTargetPathDigest(target.targetKey)
              } catch {
                return undefined
              }
            })
      const toolEvidence = await analyzeTools(
        window,
        before.header.cwd,
        knownSkillTargetDigests,
        this.#policy,
        Date.now() + this.#policy.maxAnalysisMs,
        resolveTargetPathDigest,
      )
      const changes = catalogComplete ? changedCandidates(baselineCandidates, endCandidates) : []
      const changedCandidateIds = new Set(changes.map(({ baseline, end: current }) => (
        current ?? baseline!
      ).candidateId))
      const baselineByCandidateId = new Map(
        (baselineCandidates ?? []).map(candidate => [candidate.candidateId, candidate]),
      )
      const stableExactRewrites = catalogComplete
        ? endCandidates
            .filter(current => (
              !changedCandidateIds.has(current.candidateId)
              && current.targetPathDigest !== undefined
              && toolEvidence.writes.some(write => (
                !write.failed
                && write.targetPathDigest === current.targetPathDigest
                && write.readbackBodyDigest === current.bodyDigest
              ))
            ))
            .map(current => ({ baseline: baselineByCandidateId.get(current.candidateId), end: current }))
        : []
      let activity = toolEvidence.activity
      const exactAttributedWrites = new Set<ParsedWrite>()
      const projected = [...changes, ...stableExactRewrites].map(({ baseline, end: current }) => {
        const facts = current ?? baseline!
        const matchingWrites = current?.targetPathDigest === undefined
          ? []
          : toolEvidence.writes.filter(write => write.targetPathDigest === current.targetPathDigest)
        const successful = matchingWrites.filter(write => !write.failed)
        const exactWrite = current === undefined
          ? undefined
          : successful.find(write => write.readbackBodyDigest === current.bodyDigest)
        if (exactWrite !== undefined) exactAttributedWrites.add(exactWrite)
        const writeAttribution = successful.length === 1
          ? 'AGENT_WRITE_SUCCEEDED' as const
          : 'UNKNOWN' as const
        const exactWriteBody = exactWrite?.readbackBody
        const intentBinding = exactWriteBody === undefined
          ? 'UNKNOWN' as const
          : current?.scope === input.intent.persistenceScope
            && containsIntentContract(exactWriteBody, input.intent)
            ? 'MATCH' as const
            : 'NO_MATCH' as const
        return {
          candidateId: facts.candidateId,
          provider: facts.provider,
          source: facts.source,
          scope: facts.scope,
          writable: facts.writable,
          exactReadbackComplete: current !== undefined,
          ...(current === undefined ? {} : { bodyDigest: current.bodyDigest }),
          writeAttribution,
          intentBinding,
        }
      })
      const relevantSuccessfulWrites = toolEvidence.writes.filter(write => write.skillMarker && !write.failed)
      if (
        activity === 'BODY_GENERATED'
        && !toolEvidence.unattributedBodyEvidence
        && relevantSuccessfulWrites.length > 0
        && relevantSuccessfulWrites.every(write => exactAttributedWrites.has(write))
      ) activity = 'WRITE_SUCCEEDED'
      return {
        status: 'OBSERVED',
        inputDigest: input.inputDigest,
        observedAfterTurnEndSeq: input.batch.lastTurnEndSeq,
        observedAt: new Date(this.#now()).toISOString(),
        endManifest: {
          rootManifestDigest: end.rootManifestDigest,
          runtimeCatalogDigest: end.runtimeCatalogDigest,
          complete: end.complete,
        },
        catalogComplete,
        toolEvidenceComplete: toolEvidence.complete,
        agentActivity: activity,
        changedCandidates: projected,
      }
    } catch {
      return { status: 'UNAVAILABLE', reasonCode: failureCode }
    }
  }
}
