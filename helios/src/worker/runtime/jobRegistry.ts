import {
  CatalogMaintenanceUploadGroupImageJobPayloadSchema,
  CatalogInventoryZeroTradeSamplesJobPayloadSchema,
  CatalogInventoryStageTradeSamplesJobPayloadSchema,
  CatalogPendingPurchasesApplyJobPayloadSchema,
  CatalogPendingPurchasesQueueRepriceJobPayloadSchema,
  CatalogPendingPurchasesGenerateJobPayloadSchema,
  CatalogPendingPurchasesImportJobPayloadSchema,
  CatalogPendingPurchasesExtractHintFactsJobPayloadSchema,
  CatalogPendingPurchasesRefineJobPayloadSchema,
  CatalogReviewRerunRowJobPayloadSchema,
  CatalogSyncDiscoverOrphanGroupsJobPayloadSchema,
  CatalogSyncFullSummaryJobPayloadSchema,
  ConfigWorkersCatalogRefreshJobPayloadSchema,
  ConfigWorkersEdibleThcClampJobPayloadSchema,
  ConfigWorkersSweedOrdersRawJsonDrainJobPayloadSchema,
  ConfigWorkersLitalertsProductsRawJsonDrainJobPayloadSchema,
  ConfigWorkersFuzzySkusRetentionJobPayloadSchema,
  ConfigWorkersStockSnapshotItemsRetentionJobPayloadSchema,
  ConfigWorkersGadsLpRollupRefreshJobPayloadSchema,
  ConfigWorkersFaqHybridSyncJobPayloadSchema,
  ConfigWorkersLitalertsRefreshVariantJobPayloadSchema,
  ConfigWorkersLitalertsRetailerBackfillJobPayloadSchema,
  ConfigWorkersLitalertsRetailerGeoRefreshJobPayloadSchema,
  ConfigWorkersMarketEvidenceAlarmScanJobPayloadSchema,
  InventoryLifecycleAdvanceJobPayloadSchema,
  ConfigWorkersEnrichCustomerAddressJobPayloadSchema,
  ConfigWorkersStockRefreshJobPayloadSchema,
  ConfigWorkersSweedOrdersIngestJobPayloadSchema,
  ConfigWorkersSweedPackageSnapshotsJobPayloadSchema,
  ConfigWorkersSweedPurchasesIngestJobPayloadSchema,
  ConfigWorkersWeatherDailyIngestJobPayloadSchema,
  ConfigWorkersSweedShiftsIngestJobPayloadSchema,
  ConfigWorkersEnrichDeliveryAddressJobPayloadSchema,
  ConfigWorkersEnrichVisitorScanAddressJobPayloadSchema,
  ConfigWorkersLinkVisitorScanToSweedJobPayloadSchema,
  ConfigWorkersRefreshSweedCustomerSegmentsJobPayloadSchema,
  ConfigWorkersRefreshSweedSegmentMembersJobPayloadSchema,
  ConfigWorkersRefreshStaffDirectoryJobPayloadSchema,
  ConfigWorkersGeoSegmentRuleEvalJobPayloadSchema,
  CatalogSyncGroupDetailJobPayloadSchema,
  DbMigrationApplyJobPayloadSchema,
  LlmDebugRerunJobPayloadSchema,
  ProposalGenerateDescriptionBatchJobPayloadSchema,
  ProposalGeneratePricingBatchJobPayloadSchema,
  ProposalImportReviewJsonJobPayloadSchema,
  ReconcileGroupJobPayloadSchema,
  ScreensBannerBulkToggleJobPayloadSchema,
  ScreensBannerDuplicateJobPayloadSchema,
  ScreensBannerRefreshJobPayloadSchema,
  ScreensBannerHealthMaintenanceJobPayloadSchema,
  ScreensBronxMidtownImageCloneJobPayloadSchema,
  ScreensEnableHealthyBannersJobPayloadSchema,
  ScreensImageBannerSyncJobPayloadSchema,
  ScreensMidtownPricedToMovePromoRebindJobPayloadSchema,
  SchedulingExtractConstraintsJobPayloadSchema,
  SchedulingGenerateCandidatesJobPayloadSchema,
  UndoExecuteJobPayloadSchema,
  type JobType,
} from '../../shared/contracts/domain/jobs.js'
import type { HeliosModuleCode, HeliosModuleScope } from '../../shared/contracts/index.js'
import { runGenerateDescriptionBatchJob } from '../jobs/generateDescriptionBatchJob.js'
import { runGeneratePricingBatchJob } from '../jobs/generatePricingBatchJob.js'
import { runCatalogMaintenanceUploadGroupImageJob } from '../jobs/catalogMaintenanceUploadGroupImageJob.js'
import { runCatalogInventoryZeroTradeSamplesJob } from '../jobs/catalogInventoryZeroTradeSamplesJob.js'
import { runCatalogInventoryStageTradeSamplesJob } from '../jobs/catalogInventoryStageTradeSamplesJob.js'
import { runCatalogPendingPurchasesApplyJob } from '../jobs/applyPendingPurchaseRequestJob.js'
import { runCatalogPendingPurchasesQueueRepriceJob } from '../jobs/queuePendingPurchaseRepriceJob.js'
import { runCatalogPendingPurchasesGenerateJob } from '../jobs/generatePendingPurchasePacketJob.js'
import { runCatalogReviewRerunRowJob } from '../jobs/catalogReviewRerunRowJob.js'
import { runCatalogPendingPurchasesImportJob } from '../jobs/importPendingPurchasePacketJob.js'
import { runCatalogPendingPurchasesExtractHintFactsJob } from '../jobs/extractPendingPurchaseHintFactsJob.js'
import { runCatalogPendingPurchasesRefineJob } from '../jobs/refinePendingPurchasePacketJob.js'
import { runConfigWorkersCatalogRefreshJob } from '../jobs/configWorkersCatalogRefreshJob.js'
import { runConfigWorkersEdibleThcClampJob } from '../jobs/configWorkersEdibleThcClampJob.js'
import { runConfigWorkersSweedOrdersRawJsonDrainJob } from '../jobs/configWorkersSweedOrdersRawJsonDrainJob.js'
import { runConfigWorkersLitalertsProductsRawJsonDrainJob } from '../jobs/configWorkersLitalertsProductsRawJsonDrainJob.js'
import { runConfigWorkersFuzzySkusRetentionJob } from '../jobs/configWorkersFuzzySkusRetentionJob.js'
import { runConfigWorkersStockSnapshotItemsRetentionJob } from '../jobs/configWorkersStockSnapshotItemsRetentionJob.js'
import { runRefreshGadsLpRollupJob } from '../jobs/refreshGadsLpRollupJob.js'
import { runFaqHybridSyncJob } from '../jobs/faqHybridSyncJob.js'
import { runConfigWorkersLitalertsRefreshVariantJob } from '../jobs/configWorkersLitalertsRefreshJob.js'
import { runConfigWorkersLitalertsRetailerBackfillJob } from '../jobs/configWorkersLitalertsRetailerBackfillJob.js'
import { runConfigWorkersLitalertsRetailerGeoRefreshJob } from '../jobs/configWorkersLitalertsRetailerGeoRefreshJob.js'
import { runConfigWorkersMarketEvidenceAlarmScanJob } from '../jobs/configWorkersMarketEvidenceAlarmScanJob.js'
import { runInventoryLifecycleAdvanceJob } from '../jobs/inventoryLifecycleAdvanceJob.js'
import { runConfigWorkersStockRefreshJob } from '../jobs/configWorkersStockRefreshJob.js'
import { runEnrichCustomerAddressJob } from '../jobs/enrichCustomerAddressJob.js'
import { runConfigWorkersSweedOrdersIngestJob } from '../jobs/configWorkersSweedOrdersIngestJob.js'
import { runConfigWorkersSweedPackageSnapshotsJob } from '../jobs/configWorkersSweedPackageSnapshotsJob.js'
import { runConfigWorkersSweedPurchasesIngestJob } from '../jobs/configWorkersSweedPurchasesIngestJob.js'
import { runIngestWeatherDailyJob } from '../jobs/ingestWeatherDailyJob.js'
import { runConfigWorkersSweedShiftsIngestJob } from '../jobs/configWorkersSweedShiftsIngestJob.js'
import { runConfigWorkersEnrichDeliveryAddressJob } from '../jobs/enrichDeliveryAddressJob.js'
import { runConfigWorkersEnrichVisitorScanAddressJob } from '../jobs/enrichVisitorScanAddressJob.js'
import { runConfigWorkersLinkVisitorScanToSweedJob } from '../jobs/linkVisitorScanToSweedJob.js'
import { runConfigWorkersRefreshSweedCustomerSegmentsJob } from '../jobs/refreshSweedCustomerSegmentsJob.js'
import { runConfigWorkersRefreshSweedSegmentMembersJob } from '../jobs/refreshSweedSegmentMembersJob.js'
import { runConfigWorkersGeoSegmentRuleEvalJob } from '../jobs/geoSegmentRuleEvalJob.js'
import { runProposalImportReviewJsonJob } from '../jobs/importReviewJsonJob.js'
import { getPool } from '../../server/db/pool.js'
import {
  markStaffDirectoryRefreshSucceeded,
  upsertStaffDirectoryCache,
} from '../../server/db/queries/staffQueries.js'
import { withTransaction } from '../../server/db/tx.js'
import { fetchStateStaffDirectory } from '../../server/staff/fetchStateStaff.js'
import { runLlmDebugRerunJob } from '../jobs/llmDebugRerunJob.js'
import { runReconcileGroupJob } from '../jobs/reconcileGroupJob.js'
import { runScreensBannerBulkToggleJob } from '../jobs/screensBannerBulkToggleJob.js'
import { runScreensBannerRefreshJob } from '../jobs/screensBannerRefreshJob.js'
import { runScreensBannerHealthMaintenanceJob } from '../jobs/screensBannerHealthMaintenanceJob.js'
import { runScreensBronxMidtownImageCloneJob } from '../jobs/screensBronxMidtownImageCloneJob.js'
import { runScreensEnableHealthyBannersJob } from '../jobs/screensEnableHealthyBannersJob.js'
import { runScreensImageBannerSyncJob } from '../jobs/screensImageBannerSyncJob.js'
import { runScreensBannerDuplicateJob } from '../jobs/screensBannerDuplicateJob.js'
import { runScreensMidtownPricedToMovePromoRebindJob } from '../jobs/screensMidtownPricedToMovePromoRebindJob.js'
import { runSchedulingExtractConstraintsJob } from '../jobs/schedulingExtractConstraintsJob.js'
import { runSchedulingGenerateCandidatesJob } from '../jobs/schedulingGenerateCandidatesJob.js'
import { runCatalogSyncDiscoverOrphanGroupsJob } from '../jobs/catalogSyncDiscoverOrphanGroupsJob.js'
import { runCatalogSyncGroupDetailJob } from '../jobs/syncGroupDetailJob.js'
import { runCatalogSyncFullSummaryJob } from '../jobs/syncFullSummaryJob.js'
import { runDbMigrationApplyJob } from '../jobs/dbMigrationApplyJob.js'
import { runUndoExecuteJob } from '../jobs/undoExecuteJob.js'
import { withJobAuthContext } from '../sweed/authLog.js'
import { withSweedSession } from '../sweed/session.js'

export interface JobHandlerContext {
  id: number
  leaseToken?: string
  jobType: JobType
  module: HeliosModuleCode
  payload: unknown
  scope: HeliosModuleScope | null
}

type JobHandler = (context: JobHandlerContext) => Promise<void>

const handlers: Record<JobType, JobHandler> = {
  'catalog.inventory.stage_trade_samples': async (context) => {
    await runCatalogInventoryStageTradeSamplesJob(context, CatalogInventoryStageTradeSamplesJobPayloadSchema.parse(context.payload))
  },
  'catalog.inventory.zero_trade_samples': async (context) => {
    await runCatalogInventoryZeroTradeSamplesJob(context, CatalogInventoryZeroTradeSamplesJobPayloadSchema.parse(context.payload))
  },
  'catalog.maintenance.upload_group_image': async (context) => {
    await runCatalogMaintenanceUploadGroupImageJob(
      context,
      CatalogMaintenanceUploadGroupImageJobPayloadSchema.parse(context.payload),
    )
  },
  'catalog.pending_purchases.apply': async (context) => {
    await runCatalogPendingPurchasesApplyJob(context, CatalogPendingPurchasesApplyJobPayloadSchema.parse(context.payload))
  },
  'catalog.pending_purchases.queue_reprice': async (context) => {
    await runCatalogPendingPurchasesQueueRepriceJob(
      context,
      CatalogPendingPurchasesQueueRepriceJobPayloadSchema.parse(context.payload),
    )
  },
  'catalog.pending_purchases.generate': async (context) => {
    await runCatalogPendingPurchasesGenerateJob(context, CatalogPendingPurchasesGenerateJobPayloadSchema.parse(context.payload))
  },
  'catalog.pending_purchases.import_json': async (context) => {
    await runCatalogPendingPurchasesImportJob(context, CatalogPendingPurchasesImportJobPayloadSchema.parse(context.payload))
  },
  'catalog.pending_purchases.extract_hint_facts': async (context) => {
    await runCatalogPendingPurchasesExtractHintFactsJob(
      context,
      CatalogPendingPurchasesExtractHintFactsJobPayloadSchema.parse(context.payload),
    )
  },
  'catalog.pending_purchases.refine': async (context) => {
    await runCatalogPendingPurchasesRefineJob(
      context,
      CatalogPendingPurchasesRefineJobPayloadSchema.parse(context.payload),
    )
  },
  'catalog.sync.full_summary': async (context) => {
    await runCatalogSyncFullSummaryJob(CatalogSyncFullSummaryJobPayloadSchema.parse(context.payload))
  },
  'catalog.sync.group_detail': async (context) => {
    await runCatalogSyncGroupDetailJob(CatalogSyncGroupDetailJobPayloadSchema.parse(context.payload))
  },
  'catalog.sync.discover_orphan_groups': async (context) => {
    await runCatalogSyncDiscoverOrphanGroupsJob(
      context,
      CatalogSyncDiscoverOrphanGroupsJobPayloadSchema.parse(context.payload),
    )
  },
  'catalog.review.rerun_row': async (context) => {
    await runCatalogReviewRerunRowJob(context, CatalogReviewRerunRowJobPayloadSchema.parse(context.payload))
  },
  'llm.debug.rerun': async (context) => {
    await runLlmDebugRerunJob(context, LlmDebugRerunJobPayloadSchema.parse(context.payload))
  },
  'proposal.generate.description_batch': async (context) => {
    await runGenerateDescriptionBatchJob(context, ProposalGenerateDescriptionBatchJobPayloadSchema.parse(context.payload))
  },
  'proposal.generate.pricing_batch': async (context) => {
    await runGeneratePricingBatchJob(context, ProposalGeneratePricingBatchJobPayloadSchema.parse(context.payload))
  },
  'proposal.import.review_json': async (context) => {
    await runProposalImportReviewJsonJob(context, ProposalImportReviewJsonJobPayloadSchema.parse(context.payload))
  },
  'reconcile.group': async (context) => {
    await runReconcileGroupJob(context, ReconcileGroupJobPayloadSchema.parse(context.payload))
  },
  'screens.banner_bulk_toggle': async (context) => {
    await runScreensBannerBulkToggleJob(context, ScreensBannerBulkToggleJobPayloadSchema.parse(context.payload))
  },
  'screens.banner_refresh': async (context) => {
    await runScreensBannerRefreshJob(context, ScreensBannerRefreshJobPayloadSchema.parse(context.payload))
  },
  'screens.banner_health_maintenance': async (context) => {
    await runScreensBannerHealthMaintenanceJob(
      context,
      ScreensBannerHealthMaintenanceJobPayloadSchema.parse(context.payload),
    )
  },
  'screens.enable_healthy_banners': async (context) => {
    await runScreensEnableHealthyBannersJob(context, ScreensEnableHealthyBannersJobPayloadSchema.parse(context.payload))
  },
  'screens.bronx_midtown_image_clone': async (context) => {
    await runScreensBronxMidtownImageCloneJob(context, ScreensBronxMidtownImageCloneJobPayloadSchema.parse(context.payload))
  },
  'screens.midtown_priced_to_move_promo_rebind': async (context) => {
    await runScreensMidtownPricedToMovePromoRebindJob(
      context,
      ScreensMidtownPricedToMovePromoRebindJobPayloadSchema.parse(context.payload),
    )
  },
  'screens.image_banner_sync': async (context) => {
    await runScreensImageBannerSyncJob(context, ScreensImageBannerSyncJobPayloadSchema.parse(context.payload))
  },
  'screens.banner_duplicate': async (context) => {
    await runScreensBannerDuplicateJob(context, ScreensBannerDuplicateJobPayloadSchema.parse(context.payload))
  },
  'scheduling.extract_constraints': async (context) => {
    await runSchedulingExtractConstraintsJob(context, SchedulingExtractConstraintsJobPayloadSchema.parse(context.payload))
  },
  'scheduling.generate_candidates': async (context) => {
    await runSchedulingGenerateCandidatesJob(context, SchedulingGenerateCandidatesJobPayloadSchema.parse(context.payload))
  },
  'undo.execute': async (context) => {
    await runUndoExecuteJob(context, UndoExecuteJobPayloadSchema.parse(context.payload))
  },
  'config.workers.stock_refresh': async (context) => {
    await runConfigWorkersStockRefreshJob(
      context,
      ConfigWorkersStockRefreshJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.litalerts_refresh.variant': async (context) => {
    await runConfigWorkersLitalertsRefreshVariantJob(
      context,
      ConfigWorkersLitalertsRefreshVariantJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.catalog_refresh': async (context) => {
    await runConfigWorkersCatalogRefreshJob(
      context,
      ConfigWorkersCatalogRefreshJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.market_evidence_alarm_scan': async (context) => {
    await runConfigWorkersMarketEvidenceAlarmScanJob(
      context,
      ConfigWorkersMarketEvidenceAlarmScanJobPayloadSchema.parse(context.payload),
    )
  },
  'inventory.lifecycle.advance': async (context) => {
    await runInventoryLifecycleAdvanceJob(
      context,
      InventoryLifecycleAdvanceJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.edible_thc_clamp': async (context) => {
    await runConfigWorkersEdibleThcClampJob(
      context,
      ConfigWorkersEdibleThcClampJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.sweed_orders_raw_json_drain': async (context) => {
    await runConfigWorkersSweedOrdersRawJsonDrainJob(
      context,
      ConfigWorkersSweedOrdersRawJsonDrainJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.litalerts_products_raw_json_drain': async (context) => {
    await runConfigWorkersLitalertsProductsRawJsonDrainJob(
      context,
      ConfigWorkersLitalertsProductsRawJsonDrainJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.fuzzy_skus_retention': async (context) => {
    await runConfigWorkersFuzzySkusRetentionJob(
      context,
      ConfigWorkersFuzzySkusRetentionJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.stock_snapshot_items_retention': async (context) => {
    await runConfigWorkersStockSnapshotItemsRetentionJob(
      context,
      ConfigWorkersStockSnapshotItemsRetentionJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.gads_lp_rollup_refresh': async (context) => {
    await runRefreshGadsLpRollupJob(
      context,
      ConfigWorkersGadsLpRollupRefreshJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.faq_hybrid_sync': async (context) => {
    await runFaqHybridSyncJob(
      context,
      ConfigWorkersFaqHybridSyncJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.litalerts_retailer_backfill': async (context) => {
    await runConfigWorkersLitalertsRetailerBackfillJob(
      context,
      ConfigWorkersLitalertsRetailerBackfillJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.litalerts_retailer_geo_refresh': async (context) => {
    await runConfigWorkersLitalertsRetailerGeoRefreshJob(
      context,
      ConfigWorkersLitalertsRetailerGeoRefreshJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.sweed_orders_ingest': async (context) => {
    await runConfigWorkersSweedOrdersIngestJob(
      context,
      ConfigWorkersSweedOrdersIngestJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.sweed_package_snapshots': async (context) => {
    await runConfigWorkersSweedPackageSnapshotsJob(
      context,
      ConfigWorkersSweedPackageSnapshotsJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.sweed_purchases_ingest': async (context) => {
    await runConfigWorkersSweedPurchasesIngestJob(
      context,
      ConfigWorkersSweedPurchasesIngestJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.weather_daily_ingest': async (context) => {
    await runIngestWeatherDailyJob(
      context,
      ConfigWorkersWeatherDailyIngestJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.sweed_shifts_ingest': async (context) => {
    await runConfigWorkersSweedShiftsIngestJob(
      context,
      ConfigWorkersSweedShiftsIngestJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.enrich_customer_address': async (context) => {
    await runEnrichCustomerAddressJob(
      context,
      ConfigWorkersEnrichCustomerAddressJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.enrich_delivery_address': async (context) => {
    await runConfigWorkersEnrichDeliveryAddressJob(
      context,
      ConfigWorkersEnrichDeliveryAddressJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.enrich_visitor_scan_address': async (context) => {
    await runConfigWorkersEnrichVisitorScanAddressJob(
      context,
      ConfigWorkersEnrichVisitorScanAddressJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.link_visitor_scan_to_sweed': async (context) => {
    await runConfigWorkersLinkVisitorScanToSweedJob(
      context,
      ConfigWorkersLinkVisitorScanToSweedJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.refresh_sweed_customer_segments': async (context) => {
    await runConfigWorkersRefreshSweedCustomerSegmentsJob(
      context,
      ConfigWorkersRefreshSweedCustomerSegmentsJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.refresh_sweed_segment_members': async (context) => {
    await runConfigWorkersRefreshSweedSegmentMembersJob(
      context,
      ConfigWorkersRefreshSweedSegmentMembersJobPayloadSchema.parse(context.payload),
    )
  },
  'config.workers.refresh_staff_directory': async (context) => {
    const payload = ConfigWorkersRefreshStaffDirectoryJobPayloadSchema.parse(context.payload)
    const rows = await fetchStateStaffDirectory()
    await withTransaction(async (db) => {
      await upsertStaffDirectoryCache(db, rows)
      await markStaffDirectoryRefreshSucceeded(db, `job:${context.id}`)
    })
    console.log(
      `[refresh-staff-directory] job=${context.id} cached ${rows.length} staff (trigger=${payload.trigger})`,
    )
  },
  'config.workers.geo_segment_rule_eval': async (context) => {
    await runConfigWorkersGeoSegmentRuleEvalJob(
      context,
      ConfigWorkersGeoSegmentRuleEvalJobPayloadSchema.parse(context.payload),
    )
  },
  'db.migration.apply': async (context) => {
    await runDbMigrationApplyJob(context, DbMigrationApplyJobPayloadSchema.parse(context.payload))
  },
}

/**
 * Jobs whose handler is guaranteed to call the Sweed JSON-RPC API.
 *
 * Each such job runs inside its own fresh `withSweedSession()` so it
 * owns a private auth token (and therefore a private server-side
 * dealer context) for its entire lifetime. This eliminates the
 * dealer-context race we used to hit when multiple concurrent jobs
 * shared one SWEED_AUTH_TOKEN — the failure mode that surfaced as
 * `store.screen.carousel.banner.list failed: Action does not exist
 * or you do not have permission` on screen-banner-bounce runs.
 *
 * Jobs that only sometimes touch Sweed (e.g. forceLiveRefresh paths
 * in proposal/llm.debug jobs, or undo.execute on Sweed-flavored
 * undo records) are intentionally NOT in this set; they fall through
 * to the legacy shared-token mutex on their occasional Sweed calls.
 */
const SWEED_BACKED_JOB_TYPES: ReadonlySet<JobType> = new Set<JobType>([
  'catalog.inventory.stage_trade_samples',
  'catalog.inventory.zero_trade_samples',
  'catalog.maintenance.upload_group_image',
  'catalog.pending_purchases.apply',
  'catalog.pending_purchases.generate',
  'catalog.sync.full_summary',
  'catalog.sync.group_detail',
  'catalog.sync.discover_orphan_groups',
  'config.workers.catalog_refresh',
  'config.workers.edible_thc_clamp',
  'config.workers.enrich_customer_address',
  'config.workers.stock_refresh',
  'config.workers.sweed_orders_ingest',
  'config.workers.sweed_package_snapshots',
  'config.workers.sweed_purchases_ingest',
  'config.workers.sweed_shifts_ingest',
  'config.workers.enrich_delivery_address',
  'config.workers.link_visitor_scan_to_sweed',
  'config.workers.refresh_sweed_customer_segments',
  'config.workers.refresh_sweed_segment_members',
  'config.workers.refresh_staff_directory',
  'reconcile.group',
  'screens.banner_bulk_toggle',
  'screens.banner_refresh',
  'screens.banner_health_maintenance',
  'screens.bronx_midtown_image_clone',
  'screens.enable_healthy_banners',
  'screens.image_banner_sync',
  'screens.banner_duplicate',
  'screens.midtown_priced_to_move_promo_rebind',
])

export async function runJob(context: JobHandlerContext): Promise<void> {
  const handler = handlers[context.jobType]
  // Tag the AsyncLocalStorage cell that `recordAuthEvent` reads, so
  // any Sweed auth-log row this job appends gets stamped with the
  // job id + type. Jobs that never touch Sweed still get tagged —
  // the overhead is one ALS hop — so the row, if a downstream
  // utility ever logs one, still correlates.
  return withJobAuthContext({ jobId: context.id, jobType: context.jobType }, async () => {
    if (SWEED_BACKED_JOB_TYPES.has(context.jobType)) {
      await withSweedSession(() => handler(context))
      return
    }
    await handler(context)
  })
}

export async function markJobSucceeded(jobId: number, leaseToken: string): Promise<void> {
  await getPool().query(
    `
      update job_queue
      set status = 'succeeded',
          lease_token = null,
          leased_until = null,
          finished_at = now(),
          updated_at = now()
      where id = $1 and lease_token = $2
    `,
    [jobId, leaseToken],
  )
}

export async function renewJobLease(jobId: number, leaseToken: string): Promise<void> {
  await getPool().query(
    `
      update job_queue
      set leased_until = now() + interval '5 minutes',
          updated_at = now()
      where id = $1
        and lease_token = $2
        and status = 'running'
    `,
    [jobId, leaseToken],
  )
}

export async function markJobFailed(jobId: number, leaseToken: string, errorMessage: string): Promise<void> {
  await getPool().query(
    `
      update job_queue
      set status = 'failed',
          lease_token = null,
          leased_until = null,
          finished_at = now(),
          last_error = $3,
          updated_at = now()
      where id = $1 and lease_token = $2
    `,
    [jobId, leaseToken, errorMessage],
  )
}

export async function markJobForRetry(
  jobId: number,
  leaseToken: string,
  errorMessage: string,
  retryAt: Date,
): Promise<void> {
  await getPool().query(
    `
      update job_queue
      set status = 'queued',
          lease_token = null,
          leased_until = null,
          started_at = null,
          finished_at = null,
          run_at = $3,
          last_error = $4,
          updated_at = now()
      where id = $1 and lease_token = $2
    `,
    [jobId, leaseToken, retryAt, errorMessage],
  )
}

export async function markJobDeferred(
  jobId: number,
  leaseToken: string,
  errorMessage: string,
  retryAt: Date,
): Promise<void> {
  await getPool().query(
    `
      update job_queue
      set status = 'queued',
          lease_token = null,
          leased_until = null,
          started_at = null,
          finished_at = null,
          run_at = $3,
          last_error = $4,
          attempt_count = greatest(job_queue.attempt_count - 1, 0),
          updated_at = now()
      where id = $1 and lease_token = $2
    `,
    [jobId, leaseToken, retryAt, errorMessage],
  )
}

export async function markJobDeadLetter(jobId: number, leaseToken: string, errorMessage: string): Promise<void> {
  await getPool().query(
    `
      update job_queue
      set status = 'dead_letter',
          lease_token = null,
          leased_until = null,
          finished_at = now(),
          last_error = $3,
          updated_at = now()
      where id = $1 and lease_token = $2
    `,
    [jobId, leaseToken, errorMessage],
  )
}
