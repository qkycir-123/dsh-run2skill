import { writeFileSync } from 'node:fs'

export const inject = ['storageDomain', 'workspaceRegistry', 'skills']

export function apply(_ctx, config = {}) {
  if (typeof config.marker === 'string') {
    writeFileSync(config.marker, `${JSON.stringify({
      host: 'v1',
      storageDomain: _ctx.storageDomain !== undefined,
      workspaceRegistry: _ctx.workspaceRegistry !== undefined,
      skills: _ctx.skills !== undefined,
      userSkillRoot: config.userSkillRoot,
    })}\n`)
  }
}
