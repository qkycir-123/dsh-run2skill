import { z } from 'zod'
import { LearningFailureCodeSchema } from './schemas.js'

export const LearningTerminalDetailV1Schema = z.enum([
  'MODEL_STREAM_FAILURE',
  'MODEL_FINISH_MISSING',
  'MODEL_USAGE_INVALID',
  'MODEL_ASSEMBLY_FAILED',
  'MODEL_UNEXPECTED_FINISH',
])

export type LearningTerminalDetailV1 = z.infer<typeof LearningTerminalDetailV1Schema>

export const LearningDiagnosticRecordV1Schema = z.object({
  schemaVersion: z.literal(1),
  workItemId: z.string().regex(/^wi_[a-f0-9]{64}$/),
  workItemRevision: z.number().int().positive(),
  attempt: z.number().int().min(1).max(3),
  requestOrdinal: z.union([z.literal(1), z.literal(2)]),
  callKind: z.enum(['PRIMARY', 'FORMAT_REPAIR']),
  callOutcome: z.enum(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED_OUT']),
  failureCode: LearningFailureCodeSchema,
  failureOccurredAt: z.string().datetime({ offset: true }),
  detail: LearningTerminalDetailV1Schema,
}).strict()

export type LearningDiagnosticRecordV1 = z.infer<typeof LearningDiagnosticRecordV1Schema>

export const LearningDiagnosticHealthV1Schema = z.object({
  schemaVersion: z.literal(1),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict()

export type LearningDiagnosticHealthV1 = z.infer<typeof LearningDiagnosticHealthV1Schema>
