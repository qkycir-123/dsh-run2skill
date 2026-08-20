import { isAbsolute } from 'node:path'
import { z } from 'zod'

const isoDateTime = z.string().datetime({ offset: true })
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/)
const path = z.string().min(1).max(32 * 1024).refine(isAbsolute, 'Purge paths must be absolute')
const safeNonNegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const ProjectPurgeScopeBindingV1Schema = z.object({
  scope: z.literal('PROJECT'),
  workspaceId: z.string().min(1).max(256),
  canonicalWorkspacePath: path,
  workspaceObservedAt: isoDateTime,
  canonicalRootPath: path,
  rootContractVersion: z.literal('stock-dsh-web-default-roots-v1'),
  resolverVersion: z.literal('stock-root-resolver-v2'),
  resolutionContractDigest: sha256Hex,
}).strict()

export const UserPurgeScopeBindingV1Schema = z.object({ scope: z.literal('USER') }).strict()

export const PurgeScopeBindingV1Schema = z.discriminatedUnion('scope', [
  ProjectPurgeScopeBindingV1Schema,
  UserPurgeScopeBindingV1Schema,
])

export const PurgePhaseV1Schema = z.enum([
  'HIDING',
  'DELETING_LINEAGES',
  'DELETING_WORK_ITEMS',
  'VERIFYING',
])

export const PurgeJournalV1Schema = z.object({
  schemaVersion: z.literal(1),
  purgeId: z.string().regex(/^purge_[a-f0-9]{64}$/),
  scopeBinding: PurgeScopeBindingV1Schema,
  hideBefore: isoDateTime,
  candidateDigest: sha256Hex,
  startedAt: isoDateTime,
  phase: PurgePhaseV1Schema,
  deletedWorkItems: safeNonNegativeInteger,
  deletedLineages: safeNonNegativeInteger,
  lastError: z.object({
    code: z.string().regex(/^[A-Z0-9_]+$/),
    occurredAt: isoDateTime,
  }).strict().optional(),
}).strict()

export type ProjectPurgeScopeBindingV1 = z.infer<typeof ProjectPurgeScopeBindingV1Schema>
export type UserPurgeScopeBindingV1 = z.infer<typeof UserPurgeScopeBindingV1Schema>
export type PurgeScopeBindingV1 = z.infer<typeof PurgeScopeBindingV1Schema>
export type PurgePhaseV1 = z.infer<typeof PurgePhaseV1Schema>
export type PurgeJournalV1 = z.infer<typeof PurgeJournalV1Schema>
