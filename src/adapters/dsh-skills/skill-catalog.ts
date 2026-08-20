import { z } from 'zod'
import type {
  SkillCatalogPort,
  SkillCatalogSnapshotProjection,
  SkillDefinitionProjection,
} from '../../domain/learn/index.js'

const summarySchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  whenToUse: z.string().optional(),
  source: z.string().min(1),
  provider: z.string().min(1),
  path: z.string().min(1).optional(),
  invocation: z.object({
    modelInvocable: z.boolean(),
    userInvocable: z.boolean(),
  }).strict().optional(),
})

const definitionSchema = summarySchema.extend({ content: z.string() })

const snapshotSchema = z.object({
  skills: z.array(summarySchema),
  complete: z.boolean(),
})

export interface DshSkillRegistryPort<TView extends object> {
  snapshot(view: TView): Promise<unknown>
  get(name: string, view: TView): Promise<unknown>
}

/** Projects the evolving DSH registry shape into the narrow, validated plugin contract. */
export class DshSkillCatalogAdapter<TView extends object> implements SkillCatalogPort<TView> {
  constructor(private readonly registry: DshSkillRegistryPort<TView>) {}

  async snapshot(view: TView): Promise<SkillCatalogSnapshotProjection> {
    return snapshotSchema.parse(await this.registry.snapshot(view))
  }

  async get(name: string, view: TView): Promise<SkillDefinitionProjection | undefined> {
    const value = await this.registry.get(name, view)
    if (value === undefined) return undefined
    const parsed = definitionSchema.safeParse(value)
    return parsed.success ? parsed.data : undefined
  }
}
