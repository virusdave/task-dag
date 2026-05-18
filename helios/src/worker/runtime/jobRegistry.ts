import {
  CatalogMaintenanceUploadGroupImageJobPayloadSchema,
  CatalogPendingPurchasesApplyJobPayloadSchema,
  CatalogPendingPurchasesGenerateJobPayloadSchema,
  CatalogPendingPurchasesImportJobPayloadSchema,
  CatalogReviewRerunRowJobPayloadSchema,
  CatalogSyncDiscoverOrphanGroupsJobPayloadSchema,
  CatalogSyncFullSummaryJobPayloadSchema,
  ConfigWorkersCatalogRefreshJobPayloadSchema,
  ConfigWorkersLitalertsRefreshVariantJobPayloadSchema,
  ConfigWorkersMarketEvidenceAlarmScanJobPayloadSchema,
  ConfigWorkersStockRefreshJobPayloadSchema,
  CatalogSyncGroupDetailJobPayloadSchema,
  LlmDebugRerunJobPayloadSchema,
  ProposalGenerateDescriptionBatchJobPayloadSchema,
  ProposalGeneratePricingBatchJobPayloadSchema,
  ProposalImportReviewJsonJobPayloadSchema,
  ReconcileGroupJobPayloadSchema,
  ScreensBannerRefreshJobPayloadSchema,
  ScreensBannerHealthMaintenanceJobPayloadSchema,
  ScreensBronxMidtownImageCloneJobPayloadSchema,
  ScreensEnableHealthyBannersJobPayloadSchema,
  ScreensImageBannerSyncJobPayloadSchema,
  ScreensMidtownFreshAndIntensePromoRebindJobPayloadSchema,
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
import { runCatalogPendingPurchasesApplyJob } from '../jobs/applyPendingPurchaseRequestJob.js'
import { runCatalogPendingPurchasesGenerateJob } from '../jobs/generatePendingPurchasePacketJob.js'
import { runCatalogReviewRerunRowJob } from '../jobs/catalogReviewRerunRowJob.js'
import { runCatalogPendingPurchasesImportJob } from '../jobs/importPendingPurchasePacketJob.js'
import { runConfigWorkersCatalogRefreshJob } from '../jobs/configWorkersCatalogRefreshJob.js'
import { runConfigWorkersLitalertsRefreshVariantJob } from '../jobs/configWorkersLitalertsRefreshJob.js'
import { runConfigWorkersMarketEvidenceAlarmScanJob } from '../jobs/configWorkersMarketEvidenceAlarmScanJob.js'
import { runConfigWorkersStockRefreshJob } from '../jobs/configWorkersStockRefreshJob.js'
import { runProposalImportReviewJsonJob } from '../jobs/importReviewJsonJob.js'
import { getPool } from '../../server/db/pool.js'
import { runLlmDebugRerunJob } from '../jobs/llmDebugRerunJob.js'
import { runReconcileGroupJob } from '../jobs/reconcileGroupJob.js'
import { runScreensBannerRefreshJob } from '../jobs/screensBannerRefreshJob.js'
import { runScreensBannerHealthMaintenanceJob } from '../jobs/screensBannerHealthMaintenanceJob.js'
import { runScreensBronxMidtownImageCloneJob } from '../jobs/screensBronxMidtownImageCloneJob.js'
import { runScreensEnableHealthyBannersJob } from '../jobs/screensEnableHealthyBannersJob.js'
import { runScreensImageBannerSyncJob } from '../jobs/screensImageBannerSyncJob.js'
import { runScreensMidtownFreshAndIntensePromoRebindJob } from '../jobs/screensMidtownFreshAndIntensePromoRebindJob.js'
import { runScreensMidtownPricedToMovePromoRebindJob } from '../jobs/screensMidtownPricedToMovePromoRebindJob.js'
import { runSchedulingExtractConstraintsJob } from '../jobs/schedulingExtractConstraintsJob.js'
import { runSchedulingGenerateCandidatesJob } from '../jobs/schedulingGenerateCandidatesJob.js'
import { runCatalogSyncDiscoverOrphanGroupsJob } from '../jobs/catalogSyncDiscoverOrphanGroupsJob.js'
import { runCatalogSyncGroupDetailJob } from '../jobs/syncGroupDetailJob.js'
import { runCatalogSyncFullSummaryJob } from '../jobs/syncFullSummaryJob.js'
import { runUndoExecuteJob } from '../jobs/undoExecuteJob.js'
import { withJobAuthContext } from '../sweed/authLog.js'
import { withSweedSession } from '../sweed/session.js'

export interface JobHandlerContext {
  id: number
  jobType: JobType
  module: HeliosModuleCode
  payload: unknown
  scope: HeliosModuleScope | null
}

type JobHandler = (context: JobHandlerContext) => Promise<void>

const handlers: Record<JobType, JobHandler> = {
  'catalog.maintenance.upload_group_image': async (context) => {
    await runCatalogMaintenanceUploadGroupImageJob(
      context,
      CatalogMaintenanceUploadGroupImageJobPayloadSchema.parse(context.payload),
    )
  },
  'catalog.pending_purchases.apply': async (context) => {
    await runCatalogPendingPurchasesApplyJob(context, CatalogPendingPurchasesApplyJobPayloadSchema.parse(context.payload))
  },
  'catalog.pending_purchases.generate': async (context) => {
    await runCatalogPendingPurchasesGenerateJob(context, CatalogPendingPurchasesGenerateJobPayloadSchema.parse(context.payload))
  },
  'catalog.pending_purchases.import_json': async (context) => {
    await runCatalogPendingPurchasesImportJob(context, CatalogPendingPurchasesImportJobPayloadSchema.parse(context.payload))
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
  'screens.midtown_fresh_and_intense_promo_rebind': async (context) => {
    await runScreensMidtownFreshAndIntensePromoRebindJob(
      context,
      ScreensMidtownFreshAndIntensePromoRebindJobPayloadSchema.parse(context.payload),
    )
  },
  'screens.image_banner_sync': async (context) => {
    await runScreensImageBannerSyncJob(context, ScreensImageBannerSyncJobPayloadSchema.parse(context.payload))
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
  'catalog.maintenance.upload_group_image',
  'catalog.pending_purchases.apply',
  'catalog.pending_purchases.generate',
  'catalog.sync.full_summary',
  'catalog.sync.group_detail',
  'catalog.sync.discover_orphan_groups',
  'config.workers.catalog_refresh',
  'config.workers.stock_refresh',
  'reconcile.group',
  'screens.banner_refresh',
  'screens.banner_health_maintenance',
  'screens.bronx_midtown_image_clone',
  'screens.enable_healthy_banners',
  'screens.image_banner_sync',
  'screens.midtown_fresh_and_intense_promo_rebind',
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
