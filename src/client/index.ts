import {
  applyObserveSummaryClient,
  type ObserveSummaryClientContext,
} from './observe-header-action.js'
import {
  applyAutomaticLearningSettingsClient,
  type AutomaticLearningSettingsClientContext,
} from './automatic-learning-settings.js'

export * from './automatic-learning-settings.js'
export {
  ObserveHeaderAction,
  ObserveStatusPill,
  Run2skillHeaderAction,
  applyObserveSummaryClient,
  describeObserveState,
} from './observe-header-action.js'
export * from './observe-summary-poller.js'
export * from './proposal-inbox.js'
export * from './proposal-inbox-view.js'
export * from './purge-settings.js'
export * from './status-copy.js'

export const name = 'run2skill-client'
export const inject = ['connection', 'slots', 'workspaces', 'remote', 'settingsScope'] as const

export function apply(
  context: ObserveSummaryClientContext & AutomaticLearningSettingsClientContext,
): void {
  applyObserveSummaryClient(context)
  applyAutomaticLearningSettingsClient(context)
}
