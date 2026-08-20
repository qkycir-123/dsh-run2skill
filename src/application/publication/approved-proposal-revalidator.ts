import type { CaptureWorkItemV1 } from '../../domain/observe/schemas.js'
import type {
  ProposalBuildFailureCode,
  ProposalBuildResult,
  RootContractRevalidationResult,
} from '../curation/index.js'
import type { PublicationRevalidationPort, PublicationRevalidationResult } from './approval-publication-saga.js'

const REFRESH_FAILURES = new Set<ProposalBuildFailureCode>([
  'CATALOG_CHANGED',
  'CURATION_CONFLICT',
  'TARGET_ALREADY_EXISTS',
  'APPROVAL_FACTS_CHANGED',
])

export class ApprovedProposalRevalidator<TView extends object> implements PublicationRevalidationPort {
  constructor(
    private readonly builder: {
      revalidateApproved(item: CaptureWorkItemV1, view: TView): Promise<ProposalBuildResult>
      revalidateApprovedRootContract(
        item: CaptureWorkItemV1,
        view: TView,
      ): Promise<RootContractRevalidationResult>
    },
    private readonly resolveView: (item: CaptureWorkItemV1) => TView | undefined,
  ) {}

  async revalidate(item: CaptureWorkItemV1): Promise<PublicationRevalidationResult> {
    const view = this.resolveView(item)
    if (view === undefined) {
      return { status: 'PUBLISH_FAILED', code: 'AGENT_SCOPE_UNAVAILABLE', retryable: true }
    }
    const result = await this.builder.revalidateApproved(item, view)
    if (result.status === 'READY') return { status: 'VALID' }
    return REFRESH_FAILURES.has(result.failureCode)
      ? { status: 'NEEDS_REFRESH', code: result.failureCode }
      : { status: 'NEEDS_ATTENTION', code: result.failureCode }
  }

  async revalidateRootContract(item: CaptureWorkItemV1): Promise<PublicationRevalidationResult> {
    const view = this.resolveView(item)
    if (view === undefined) {
      return { status: 'PUBLISH_FAILED', code: 'AGENT_SCOPE_UNAVAILABLE', retryable: true }
    }
    const result = await this.builder.revalidateApprovedRootContract(item, view)
    if (result.status === 'VALID') return result
    return REFRESH_FAILURES.has(result.failureCode)
      ? { status: 'NEEDS_REFRESH', code: result.failureCode }
      : { status: 'NEEDS_ATTENTION', code: result.failureCode }
  }
}
