import { z } from 'zod'

const safeCount = z.number().refine(
  value => Number.isSafeInteger(value) && value >= 0,
  'Expected a non-negative safe integer',
)

export const ObserveSummaryV1Schema = z.object({
  apiVersion: z.literal(1),
  status: z.enum(['READY', 'RECOVERING', 'DEGRADED', 'INCOMPATIBLE']),
  capturedCount: safeCount,
  blockedCaptureCount: safeCount,
  unsaved: z.object({
    completeness: z.enum(['KNOWN', 'UNKNOWN']),
    knownCount: safeCount,
  }).strict(),
  recoveryLag: z.boolean(),
  lastRecoveryProgressAt: z.string().datetime({ offset: true }).optional(),
  lastHealthCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
}).strict()

export type ObserveSummaryV1 = z.infer<typeof ObserveSummaryV1Schema>
