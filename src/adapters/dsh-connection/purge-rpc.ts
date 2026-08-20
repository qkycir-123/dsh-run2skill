import { z } from 'zod'
import { PurgeError, type PurgeService } from '../../application/purge/index.js'
import type { ObserveRpcResult, ObserveSummaryRpcHandler } from './observe-summary-rpc.js'
import { PurgePhaseV1Schema, PurgeScopeBindingV1Schema } from '../../domain/purge/index.js'

export const PURGE_PREVIEW_ENDPOINT = 'purge/preview'
export const PURGE_CONFIRM_ENDPOINT = 'purge/confirm'
export const PURGE_STATUS_ENDPOINT = 'purge/status'
export const PURGE_RETRY_ENDPOINT = 'purge/retry'
const MAX_REQUEST_BYTES = 8 * 1024

const previewId = z.string().regex(/^purv_[a-f0-9]{64}$/)
const purgeId = z.string().regex(/^purge_[a-f0-9]{64}$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const workspaceId = z.string().min(1).max(256)
const previewRequest = z.discriminatedUnion('scope', [
  z.object({ apiVersion: z.literal(1), scope: z.literal('PROJECT'), workspaceId }).strict(),
  z.object({ apiVersion: z.literal(1), scope: z.literal('USER'), workspaceId }).strict(),
])
const confirmRequest = z.object({ apiVersion: z.literal(1), previewId, digest }).strict()
const statusRequest = z.object({ apiVersion: z.literal(1) }).strict()
const retryRequest = z.object({ apiVersion: z.literal(1), purgeId }).strict()
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const previewResponse = z.object({
  apiVersion: z.literal(1),
  previewId,
  digest,
  expiresAt: z.string().datetime({ offset: true }),
  scopeBinding: PurgeScopeBindingV1Schema,
  hideBefore: z.string().datetime({ offset: true }),
  workItemCount: count,
  lineageCount: count,
  blockedOrUnprovenCount: count,
  willDelete: z.array(z.object({ kind: z.enum(['WORK_ITEMS', 'LINEAGES']), count }).strict()).length(2),
  willKeep: z.array(z.object({
    reason: z.enum(['KEEP_NEW', 'KEEP_SCOPE', 'KEEP_UNPROVEN']), count,
  }).strict()).length(3),
  busyPublicationCount: count,
}).strict()
const receiptResponse = z.object({
  apiVersion: z.literal(1),
  purgeId,
  state: z.enum(['COMPLETED', 'IN_PROGRESS']),
  phase: PurgePhaseV1Schema.optional(),
  deletedWorkItems: count,
  deletedLineages: count,
}).strict()
const statusResponse = z.discriminatedUnion('state', [
  z.object({ apiVersion: z.literal(1), state: z.literal('IDLE') }).strict(),
  z.object({
    apiVersion: z.literal(1),
    state: z.literal('IN_PROGRESS'),
    purgeId,
    hideBefore: z.string().datetime({ offset: true }),
    startedAt: z.string().datetime({ offset: true }),
    phase: PurgePhaseV1Schema,
    deletedWorkItems: count,
    deletedLineages: count,
    lastError: z.object({
      code: z.string().regex(/^[A-Z0-9_]+$/),
      occurredAt: z.string().datetime({ offset: true }),
    }).strict().optional(),
  }).strict(),
])

function failure(code: string, details: Record<string, unknown> = {}): ObserveRpcResult<never> {
  return { ok: false, error: { code, message: code.toLowerCase().replaceAll('_', ' '), details } }
}

function requestFits(payload: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8') <= MAX_REQUEST_BYTES
  } catch {
    return false
  }
}

export interface PurgeRpcOptions {
  readonly runMutation?: <T>(operation: () => Promise<T>) => Promise<T>
}

export function createPurgeRpcHandler(
  service: PurgeService | (() => PurgeService | undefined),
  fallback?: ObserveSummaryRpcHandler,
  options: PurgeRpcOptions = {},
): ObserveSummaryRpcHandler {
  const runMutation = options.runMutation ?? (async operation => await operation())
  const serviceOf = (): PurgeService | undefined => typeof service === 'function' ? service() : service
  return async (endpoint, payload, signal) => {
    if (!requestFits(payload)) return failure('bad-request')
    const schema = endpoint === PURGE_PREVIEW_ENDPOINT
      ? previewRequest
      : endpoint === PURGE_CONFIRM_ENDPOINT
        ? confirmRequest
        : endpoint === PURGE_STATUS_ENDPOINT
          ? statusRequest
          : endpoint === PURGE_RETRY_ENDPOINT
            ? retryRequest
            : undefined
    if (schema === undefined) {
      return fallback === undefined ? failure('bad-request') : await fallback(endpoint, payload, signal)
    }
    const parsed = schema.safeParse(payload)
    if (!parsed.success) return failure('bad-request')
    if (signal.aborted) return failure('cancelled')
    const activeService = serviceOf()
    if (activeService === undefined) return failure('PURGE_STORAGE_UNAVAILABLE')
    try {
      if (endpoint === PURGE_PREVIEW_ENDPOINT) {
        const request = previewRequest.parse(payload)
        return { ok: true, value: previewResponse.parse(await activeService.preview(request.scope, request.workspaceId)) }
      }
      if (endpoint === PURGE_CONFIRM_ENDPOINT) {
        const request = confirmRequest.parse(payload)
        return { ok: true, value: receiptResponse.parse(await runMutation(async () => await activeService.confirm(request.previewId, request.digest))) }
      }
      if (endpoint === PURGE_RETRY_ENDPOINT) {
        const request = retryRequest.parse(payload)
        return { ok: true, value: receiptResponse.parse(await runMutation(async () => await activeService.retry(request.purgeId))) }
      }
      return { ok: true, value: statusResponse.parse(activeService.status()) }
    } catch (error) {
      if (error instanceof PurgeError) {
        return failure(error.code, error.code === 'PURGE_BUSY'
          ? { busyPublicationCount: error.busyPublicationCount }
          : {})
      }
      return failure('PURGE_STORAGE_UNAVAILABLE')
    }
  }
}
