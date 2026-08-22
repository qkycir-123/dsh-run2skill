export interface ParsedDshSkillFile {
  readonly name: string
  readonly body: string
}

/**
 * Parses only the narrow stock DSH filesystem shape needed by ownership checks.
 * Complex YAML is rejected so an uncertain name/path mapping can never grant
 * Agent ownership.
 */
export function parseDshSkillFileForOwnership(raw: string): ParsedDshSkillFile | undefined {
  const lines = raw.split('\n')
  if (lines[0]?.replace(/\r$/u, '') !== '---') return undefined
  const closing = lines.findIndex((line, index) => index > 0 && line.replace(/\r$/u, '') === '---')
  if (closing < 0) return undefined
  const nameLines = lines
    .slice(1, closing)
    .map(line => line.replace(/\r$/u, ''))
    .filter(line => /^name\s*:/u.test(line))
  if (nameLines.length !== 1) return undefined
  const nameMatch = /^name:\s*(?:([a-z0-9]+(?:-[a-z0-9]+)*)|"([a-z0-9]+(?:-[a-z0-9]+)*)"|'([a-z0-9]+(?:-[a-z0-9]+)*)')\s*$/u
    .exec(nameLines[0]!)
  const name = nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3]
  if (name === undefined) return undefined
  return { name, body: lines.slice(closing + 1).join('\n').trim() }
}
