import { V2CompatibleProposalPresenter } from '../adapters/dsh-connection/v2-proposal-presenter.js'
import { DshV2ProposalFileSystemAdapter } from '../adapters/dsh-publication/v2-proposal-filesystem.js'
import { DshV2StockPublicationBindingResolver } from '../adapters/dsh-publication/v2-stock-publication-binding.js'
import type { DshSkillRegistryPort } from '../adapters/dsh-skills/skill-catalog.js'
import {
  DshV2CatalogAdapter,
  type DshV2CatalogAdapterOptions,
  type V2StockWritableRootBinding,
} from '../adapters/dsh-skills/v2-catalog-adapter.js'
import type { StockSkillRuntimeConfiguration, StockWorkspaceContractBinding } from '../adapters/dsh-skills/stock-root-contract.js'
import type { Run2skillV2Domain } from '../adapters/dsh-storage/v2-types.js'
import {
  V2ProposalPublicationCoordinator,
  type V2ProposalPublicationInput,
} from '../application/publication/index.js'
import {
  V2ProposalCatalogRevalidator,
  V2ProposalRefreshCoordinator,
  V2ProposalReviewCoordinator,
} from '../application/review/index.js'

export interface V2ProposalHostSession<TView extends object> {
  readonly view: TView
  readonly configuration: StockSkillRuntimeConfiguration
  readonly workspaceBinding?: StockWorkspaceContractBinding | undefined
}

export interface V2ProposalHostServicesOptions<TView extends object> {
  readonly registry: DshSkillRegistryPort<TView>
  readonly resolveSession: (sessionLifecycleKey: string) => V2ProposalHostSession<TView> | undefined
  readonly resolveStockWritableRoot: (
    summary: Parameters<NonNullable<DshV2CatalogAdapterOptions<TView>['resolveStockWritableRoot']>>[0],
    view: TView,
  ) => V2StockWritableRootBinding | undefined
  readonly sessionCoordinate: (
    input: V2ProposalPublicationInput,
  ) => { readonly rootSessionId: string; readonly sessionCreatedAt: number; readonly turn: number; readonly turnEndSeq: number } | undefined
  readonly refreshView?: (view: TView) => TView
  readonly now?: () => string
}

/** The real DSH adapters shared by Proposal review, revalidation and publication. */
export class V2ProposalHostServices<TView extends object> {
  readonly reviews: V2ProposalReviewCoordinator
  readonly publications: V2ProposalPublicationCoordinator
  readonly refreshes: V2ProposalRefreshCoordinator
  readonly presenter: V2CompatibleProposalPresenter<TView>

  constructor(
    readonly domain: Run2skillV2Domain,
    options: V2ProposalHostServicesOptions<TView>,
  ) {
    const catalog = new DshV2CatalogAdapter(domain, {
      registry: options.registry,
      resolveView: lifecycleKey => options.resolveSession(lifecycleKey)?.view,
      resolveStockWritableRoot: options.resolveStockWritableRoot,
    })
    const revalidator = new V2ProposalCatalogRevalidator(catalog.generation, catalog.publicationRecovery)
    const bindings = new DshV2StockPublicationBindingResolver({
      resolveSession: options.resolveSession,
    })
    const filesystem = new DshV2ProposalFileSystemAdapter({
      bindings,
      registry: options.registry,
      ...(options.refreshView === undefined ? {} : { refreshView: options.refreshView }),
    })
    this.reviews = new V2ProposalReviewCoordinator(domain, {
      revalidate: input => revalidator.revalidate(input),
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    this.publications = new V2ProposalPublicationCoordinator(domain, {
      revalidate: input => revalidator.revalidate(input),
      recover: input => filesystem.recover(input),
      publish: input => filesystem.publish(input),
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    this.presenter = new V2CompatibleProposalPresenter({
      bindings,
      sessionCoordinate: options.sessionCoordinate,
      observation: observationId => domain.table('turn_observations').get(observationId),
    })
    this.refreshes = new V2ProposalRefreshCoordinator(
      domain,
      options.now === undefined ? {} : { now: options.now },
    )
  }
}
