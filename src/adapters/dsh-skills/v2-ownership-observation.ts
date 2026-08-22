import { posix, win32 } from 'node:path'
import { z } from 'zod'
import type { SessionPersistencePort, DshSessionEvent, DshSessionHeader } from '../dsh-session/types.js'
import type { OwnershipObservationPort } from '../../application/ownership/index.js'
import { canonicalJson } from '../../domain/learn/identity.js'
import { sha256Utf8 } from '../../domain/observe/hashing.js'
import { parseDshSkillFileForOwnership } from './v2-skill-file.js'
import type { ExperienceIntentV2, OwnershipEvidenceV2, SessionBatchV2 } from '../../domain/v2/index.js'

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
const SKILL_MARKER = /(?:SKILL\.md|[\\/]\.(?:dsh|agents)[\\/]skills[\\/]|[\\/]skills[\\/])/iu
const SUPPORTED_TURN_EVENTS = new Set([
  'turn/start', 'turn/end', 'step/start', 'step/end', 'user/message', 'assistant/chunk',
  'assistant/message', 'tool/call', 'tool/result', 'todo/write', 'request/header',
  'request/context', 'session/end-seed',
])
const MAX_ASSISTANT_EVIDENCE_BYTES = 32 * 1024 * 1024

export interface DshV2OwnershipObservationAdapterOptions {
  readonly persistence: SessionPersistencePort
  readonly resolveSession: (sessionLifecycleKey: string) => { readonly header: DshSessionHeader } | undefined
  readonly manifest: {
    capture(sessionLifecycleKey: string): Promise<SessionBatchV2['batchManifestBaseline']>
  }
  readonly now?: () => number
}

interface ParsedWrite {
  readonly targetPathDigest?: string
  readonly readbackBody?: string
  readonly readbackBodyDigest?: string
  readonly failed: boolean
  readonly skillMarker: boolean
}

interface ToolEvidence {
  readonly complete: boolean
  readonly activity: Extract<OwnershipEvidenceV2, { status: 'OBSERVED' }>['agentActivity']
  readonly writes: readonly ParsedWrite[]
  readonly unattributedBodyEvidence: boolean
}

function pathApi(value: string): typeof win32 | typeof posix {
  return /^[a-zA-Z]:[\\/]/u.test(value) || value.includes('\\') ? win32 : posix
}

function canonicalPath(value: string, cwd?: string): string {
  const api = pathApi(value)
  const resolved = api.isAbsolute(value) ? api.resolve(value) : api.resolve(cwd ?? '.', value)
  return api === win32 ? resolved.toLowerCase() : resolved
}

export function deriveOwnershipTargetPathDigest(path: string, cwd?: string): string {
  return sha256Utf8(canonicalJson({ path: canonicalPath(path, cwd) }))
}

function sameHeader(left: DshSessionHeader, right: DshSessionHeader): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function exactSnapshot(
  snapshots: readonly { readonly header: DshSessionHeader; readonly revision: string }[],
  header: DshSessionHeader,
) {
  const matches = snapshots.filter(snapshot => sameHeader(snapshot.header, header))
  return matches.length === 1 ? matches[0] : undefined
}

function batchWindow(events: readonly DshSessionEvent[], batch: SessionBatchV2): readonly DshSessionEvent[] | undefined {
  const ordered = [...events].sort((left, right) => left.seq - right.seq)
  if (ordered.some((event, index) => index > 0 && event.seq <= ordered[index - 1]!.seq)) return undefined
  let openStart: number | undefined
  let firstStart: number | undefined
  const ends = new Set<number>()
  for (const event of ordered) {
    if (event.type === 'turn/start') {
      if (openStart !== undefined) return undefined
      openStart = event.seq
    } else if (event.type === 'turn/end') {
      if (openStart === undefined) return undefined
      ends.add(event.seq)
      if (event.seq === batch.firstTurnEndSeq) firstStart = openStart
      openStart = undefined
    }
  }
  if (
    firstStart === undefined
    || !ends.has(batch.lastTurnEndSeq)
    || batch.observationManifest.some(item => !ends.has(item.turnEndSeq))
  ) return undefined
  const window = ordered.filter(event => event.seq >= firstStart! && event.seq <= batch.lastTurnEndSeq)
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
  const content = name === 'write'
    ? args.content
    : name === 'str_replace_editor' && args.command === 'create'
      ? args.file_text
      : undefined
  if (content !== undefined && typeof content !== 'string') return undefined
  const readback = typeof content === 'string' ? parseDshSkillFileForOwnership(content) : undefined
  return {
    targetPathDigest: deriveOwnershipTargetPathDigest(path, cwd),
    ...(readback === undefined
      ? {}
      : { readbackBody: readback.body, readbackBodyDigest: sha256Utf8(readback.body) }),
    failed,
    skillMarker: SKILL_MARKER.test(path) || (typeof content === 'string' && /(?:^|\n)name:\s*[a-z0-9-]+/iu.test(content)),
  }
}

function skillBodyEvidence(value: string): 'COMPLETE' | 'NONE' | 'AMBIGUOUS' {
  const lines = value.split('\n')
  let sawOpening = false
  for (let opening = 0; opening < lines.length; opening += 1) {
    if (lines[opening]!.replace(/\r$/u, '') !== '---') continue
    sawOpening = true
    const closing = lines.findIndex(
      (line, index) => index > opening && line.replace(/\r$/u, '') === '---',
    )
    if (closing < 0) return 'AMBIGUOUS'
    const header = lines.slice(opening + 1, closing).join('\n')
    const body = lines.slice(closing + 1).join('\n')
      .replace(/^\s*```(?:markdown|md)?\s*$/gimu, '')
      .trim()
    if (
      /^name:\s*[^\s#][^\r\n]*$/imu.test(header)
      && /^description:\s*[^\s#][^\r\n]*$/imu.test(header)
      && body.length > 0
    ) return 'COMPLETE'
    opening = closing
  }
  return sawOpening ? 'AMBIGUOUS' : 'NONE'
}

function analyzeTools(events: readonly DshSessionEvent[], cwd: string | undefined): ToolEvidence {
  const calls = new Map<string, z.infer<typeof toolCallSchema>>()
  const results = new Map<string, z.infer<typeof toolResultSchema>>()
  let activity: ToolEvidence['activity'] = 'NONE'
  let unattributedBodyEvidence = false
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const parsed = assistantMessageSchema.safeParse(event.data)
      if (!parsed.success) {
        return { complete: false, activity: 'AMBIGUOUS', writes: [], unattributedBodyEvidence: true }
      }
      const text: string[] = []
      let textBytes = 0
      for (const block of parsed.data.message.content) {
        if (typeof block !== 'object' || block === null || !('type' in block) || block.type !== 'text') continue
        const parsedText = textContentSchema.safeParse(block)
        if (!parsedText.success) {
          return { complete: false, activity: 'AMBIGUOUS', writes: [], unattributedBodyEvidence: true }
        }
        const blockBytes = Buffer.byteLength(parsedText.data.text, 'utf8')
        if (blockBytes > MAX_ASSISTANT_EVIDENCE_BYTES - textBytes) {
          return { complete: false, activity: 'AMBIGUOUS', writes: [], unattributedBodyEvidence: true }
        }
        textBytes += blockBytes
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
      calls.set(parsed.data.callId, parsed.data)
    } else if (event.type === 'tool/result') {
      const parsed = toolResultSchema.safeParse(event.data)
      if (
        !parsed.success
        || parsed.data.message.content[0]!.toolCallId !== parsed.data.message.source.callId
        || results.has(parsed.data.message.source.callId)
      ) {
        return { complete: false, activity: 'AMBIGUOUS', writes: [], unattributedBodyEvidence: true }
      }
      results.set(parsed.data.message.source.callId, parsed.data)
    }
  }
  if (calls.size !== results.size || [...calls.keys()].some(callId => !results.has(callId))) {
    return { complete: false, activity: 'AMBIGUOUS', writes: [], unattributedBodyEvidence: true }
  }

  const writes: ParsedWrite[] = []
  for (const [callId, call] of calls) {
    const result = results.get(callId)!
    if (call.turn !== result.turn || call.step !== result.step) {
      return { complete: false, activity: 'AMBIGUOUS', writes: [], unattributedBodyEvidence: true }
    }
    const failed = resultFailed(result)
    if (SAFE_TOOLS.has(call.name)) continue
    if (DIRECT_FILE_TOOLS.has(call.name)) {
      const write = directWrite(call.name, call.arguments, failed, cwd)
      if (write === undefined) {
        return { complete: false, activity: 'AMBIGUOUS', writes: [], unattributedBodyEvidence: true }
      }
      writes.push(write)
      if (write.skillMarker && activity === 'NONE') activity = failed ? 'WRITE_FAILED' : 'BODY_GENERATED'
      continue
    }
    if (SHELL_TOOLS.has(call.name)) {
      if (SKILL_MARKER.test(call.arguments)) {
        activity = 'BODY_GENERATED'
      } else {
        activity = 'AMBIGUOUS'
      }
      unattributedBodyEvidence = true
      continue
    }
    activity = 'AMBIGUOUS'
    unattributedBodyEvidence = true
  }
  if (writes.some(write => write.skillMarker && write.failed)) activity = 'WRITE_FAILED'
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

  constructor(private readonly options: DshV2OwnershipObservationAdapterOptions) {
    this.#now = options.now ?? Date.now
  }

  async observe(input: {
    readonly batch: SessionBatchV2
    readonly intent: ExperienceIntentV2
    readonly inputDigest: string
  }): Promise<OwnershipEvidenceV2> {
    try {
      const session = this.options.resolveSession(input.batch.sessionLifecycleKey)
      if (session === undefined) return { status: 'UNAVAILABLE', reasonCode: 'OBSERVATION_FAILED' }
      const beforeList = await this.options.persistence.listSnapshots()
      const before = exactSnapshot(beforeList, session.header)
      if (before === undefined) return { status: 'UNAVAILABLE', reasonCode: 'OBSERVATION_FAILED' }
      const log = await this.options.persistence.readFrom(session.header.id, 0)
      if (!sameHeader(log.meta, session.header)) return { status: 'UNAVAILABLE', reasonCode: 'OBSERVATION_FAILED' }
      const window = batchWindow(log.events, input.batch)
      if (window === undefined) return { status: 'UNAVAILABLE', reasonCode: 'OBSERVATION_FAILED' }

      const end = await this.options.manifest.capture(input.batch.sessionLifecycleKey)
      const afterList = await this.options.persistence.listSnapshots()
      const after = exactSnapshot(afterList, session.header)
      if (after === undefined || after.revision !== before.revision) {
        return { status: 'UNAVAILABLE', reasonCode: 'OBSERVATION_FAILED' }
      }

      const baselineCandidates = input.batch.batchManifestBaseline.ownershipCandidates
      const endCandidates = end.ownershipCandidates
      const catalogComplete = input.batch.batchManifestBaseline.complete
        && end.complete
        && baselineCandidates !== undefined
        && endCandidates !== undefined
      const toolEvidence = analyzeTools(window, session.header.cwd)
      const changes = catalogComplete ? changedCandidates(baselineCandidates, endCandidates) : []
      let activity = toolEvidence.activity
      const exactAttributedWrites = new Set<ParsedWrite>()
      const projected = changes.map(({ baseline, end: current }) => {
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
      return { status: 'UNAVAILABLE', reasonCode: 'OBSERVATION_FAILED' }
    }
  }
}
