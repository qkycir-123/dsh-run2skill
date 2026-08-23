import { z } from 'zod'
import { canonicalJson } from '../learn/identity.js'
import { sha256Utf8 } from '../observe/hashing.js'

export const RECENT_SKILL_ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000
export const MAX_RECENT_SKILL_ACTIVITIES = 256

const isoDateTime = z.string().datetime({ offset: true })
const workItemId = z.string().regex(/^wi_[a-f0-9]{64}$/)
const skillName = z.string().min(1).max(128).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)

export function deriveRecentSkillActivityId(input: {
  readonly workItemId: string
  readonly attemptId: string
}): `activity_${string}` {
  return `activity_${sha256Utf8(canonicalJson(input))}`
}

export const RecentSkillActivityV1Schema = z.object({
  schemaVersion: z.literal(1),
  activityId: z.string().regex(/^activity_[a-f0-9]{64}$/),
  workItemId,
  skillName,
  operation: z.enum(['CREATED', 'UPDATED']),
  scope: z.enum(['PROJECT', 'USER']),
  occurredAt: isoDateTime,
}).strict()

export type RecentSkillActivityV1 = z.infer<typeof RecentSkillActivityV1Schema>

export const RecentSkillActivityIndexV1Schema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(RecentSkillActivityV1Schema).max(MAX_RECENT_SKILL_ACTIVITIES),
}).strict().superRefine((value, context) => {
  const ids = value.items.map(item => item.activityId)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['items'], message: 'Activity ids must be unique' })
  }
  for (let index = 1; index < value.items.length; index += 1) {
    const previous = value.items[index - 1]!
    const current = value.items[index]!
    if (
      Date.parse(previous.occurredAt) < Date.parse(current.occurredAt)
      || (
        previous.occurredAt === current.occurredAt
        && previous.activityId.localeCompare(current.activityId) > 0
      )
    ) {
      context.addIssue({ code: 'custom', path: ['items', index], message: 'Activities must use canonical newest-first order' })
    }
  }
})

export type RecentSkillActivityIndexV1 = z.infer<typeof RecentSkillActivityIndexV1Schema>

export function emptyRecentSkillActivityIndex(): RecentSkillActivityIndexV1 {
  return { schemaVersion: 1, items: [] }
}
