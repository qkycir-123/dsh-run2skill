import { applyRun2skillClient, type Run2skillClientContext } from './run2skill-settings-page.js'

export * from './automatic-learning-settings.js'
export * from './observe-summary-poller.js'
export * from './proposal-inbox.js'
export * from './proposal-inbox-view.js'
export * from './purge-settings.js'
export * from './run2skill-settings-page.js'
export * from './status-copy.js'

export const name = 'run2skill-client'
export const inject = [
  'connection',
  'slots',
  'workspaces',
  'sessions',
  'remote',
  'settingsScope',
] as const

export function apply(context: Run2skillClientContext): void {
  applyRun2skillClient(context)
}
