export const SKILL_RENDERER_VERSION = 'skill-renderer-v1'

export interface CanonicalSkillInput {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string | undefined
  readonly content: string
  readonly invocation: {
    readonly modelInvocable: true
    readonly userInvocable: false
  }
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/gu, '\n')
}

export function renderCanonicalSkill(input: CanonicalSkillInput): string {
  const body = normalizeNewlines(input.content).replace(/\n+$/u, '')
  const metadata = [
    '---',
    `name: ${input.name}`,
    `description: ${JSON.stringify(normalizeNewlines(input.description))}`,
    ...(input.whenToUse === undefined
      ? []
      : [`whenToUse: ${JSON.stringify(normalizeNewlines(input.whenToUse))}`]),
    `disable-model-invocation: ${String(!input.invocation.modelInvocable)}`,
    `user-invocable: ${String(input.invocation.userInvocable)}`,
    '---',
  ]
  return `${metadata.join('\n')}\n\n${body}\n`
}
