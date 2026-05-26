import { z } from 'zod'

import { JsonValueSchema } from '../common/json.js'
import { HeliosModuleCodeSchema, HeliosModuleScopeSchema } from './modules.js'
import { ScopeKindSchema, ScopeRefSchema } from './scopeRef.js'
import {
  ScreensBannerRefreshJobPayloadSchema,
  ScreensBannerHealthMaintenanceJobPayloadSchema,
  ScreensBronxMidtownImageCloneJobPayloadSchema,
  ScreensEnableHealthyBannersJobPayloadSchema,
  ScreensImageBannerSyncJobPayloadSchema,
  ScreensMidtownPricedToMovePromoRebindJobPayloadSchema,
} from './screens.js'
import {
  SchedulingExtractConstraintsJobPayloadSchema,
  SchedulingGenerateCandidatesJobPayloadSchema,
} from './scheduling.js'

export const JobTypeSchema = z.enum([
  'catalog.sync.full_summary',
  'catalog.sync.group_detail',
  'catalog.sync.discover_orphan_groups',
  'catalog.pending_purchases.generate',
  'catalog.pending_purchases.apply',
  'catalog.pending_purchases.import_json',
  'proposal.import.review_json',
  'proposal.generate.description_batch',
  'proposal.generate.pricing_batch',
  'reconcile.group',
  'screens.banner_refresh',
  'screens.banner_health_maintenance',
  'screens.enable_healthy_banners',
  'screens.bronx_midtown_image_clone',
  'screens.midtown_priced_to_move_promo_rebind',
  'screens.image_banner_sync',
  'scheduling.extract_constraints',
  'scheduling.generate_candidates',
  'undo.execute',
  'llm.debug.rerun',
  'catalog.review.rerun_row',
  'config.workers.stock_refresh',
  'config.workers.litalerts_refresh.variant',
  'config.workers.catalog_refresh',
  'config.workers.market_evidence_alarm_scan',
  'config.workers.edible_thc_clamp',
  'config.workers.litalerts_retailer_backfill',
  'config.workers.enrich_customer_address',
  'config.workers.sweed_orders_ingest',
  'config.workers.sweed_package_snapshots',
  'config.workers.weather_daily_ingest',
  'config.workers.sweed_shifts_ingest',
  'config.workers.enrich_delivery_address',
  'catalog.maintenance.upload_group_image',
])
export type JobType = z.infer<typeof JobTypeSchema>

export const JobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'dead_letter'])
export type JobStatus = z.infer<typeof JobStatusSchema>

export const JobModuleMetadataSchema = z.object({
  module: HeliosModuleCodeSchema,
  scope: HeliosModuleScopeSchema.nullable(),
})
export type JobModuleMetadata = z.infer<typeof JobModuleMetadataSchema>

export const JobProgressSchema = z
  .object({
    completed: z.number().int().min(0).nullable(),
    message: z.string().trim().min(1),
    phase: z.string().trim().min(1),
    phaseCount: z.number().int().min(1),
    phaseIndex: z.number().int().min(1),
    total: z.number().int().positive().nullable(),
  })
  .refine((value) => value.phaseIndex <= value.phaseCount, {
    message: 'phaseIndex must be less than or equal to phaseCount.',
    path: ['phaseIndex'],
  })
export type JobProgress = z.infer<typeof JobProgressSchema>

export const JobLogEntrySchema = z.object({
  createdAt: z.iso.datetime(),
  message: z.string().trim().min(1),
})
export type JobLogEntry = z.infer<typeof JobLogEntrySchema>

export const JobLinkedRecordRefsSchema = z.object({
  llmRunId: z.number().int().positive().nullable(),
  pendingPurchaseApplyRequestId: z.number().int().positive().nullable(),
  pendingPurchasePacketId: z.number().int().positive().nullable(),
  proposalBatchId: z.number().int().positive().nullable(),
  undoEventId: z.number().int().positive().nullable(),
  writeOperationId: z.number().int().positive().nullable(),
})
export type JobLinkedRecordRefs = z.infer<typeof JobLinkedRecordRefsSchema>

export const CatalogSyncFullSummaryJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  trigger: z
    .enum(['manual_refresh', 'scheduled', 'catalog_maintenance_fix_cache'])
    .default('manual_refresh'),
})
export type CatalogSyncFullSummaryJobPayload = z.infer<typeof CatalogSyncFullSummaryJobPayloadSchema>

export const CatalogSyncGroupDetailJobPayloadSchema = z.object({
  catalogGroupId: z.number().int().positive(),
  forceLiveRefresh: z.boolean().optional().default(false),
  requestedByUserId: z.number().int().positive().nullable().optional(),
  trigger: z
    .enum([
      'full_summary',
      'manual_refresh',
      'reconcile_post_write',
      'scheduled',
      'catalog_maintenance_edit',
      'catalog_maintenance_fix_cache',
      'discovered_orphan_group',
    ])
    .default('manual_refresh'),
})
export type CatalogSyncGroupDetailJobPayload = z.infer<typeof CatalogSyncGroupDetailJobPayloadSchema>

export const CatalogSyncDiscoverOrphanGroupsJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  siteDealerIds: z.array(z.number().int().positive()).default([]),
  trigger: z
    .enum(['manual_refresh', 'scheduled', 'catalog_maintenance_fix_cache'])
    .default('manual_refresh'),
})
export type CatalogSyncDiscoverOrphanGroupsJobPayload = z.infer<
  typeof CatalogSyncDiscoverOrphanGroupsJobPayloadSchema
>

export const ProposalImportReviewJsonJobPayloadSchema = z.object({
  filePath: z.string().trim().min(1),
  requestedByUserId: z.number().int().positive().nullable().optional(),
})
export type ProposalImportReviewJsonJobPayload = z.infer<typeof ProposalImportReviewJsonJobPayloadSchema>

export const CatalogPendingPurchasesImportJobPayloadSchema = z.object({
  filePath: z.string().trim().min(1),
  requestedByUserId: z.number().int().positive().nullable().optional(),
})
export type CatalogPendingPurchasesImportJobPayload = z.infer<typeof CatalogPendingPurchasesImportJobPayloadSchema>

export const CatalogPendingPurchasesGenerateJobPayloadSchema = z.object({
  fromDate: z.iso.date(),
  requestedByUserId: z.number().int().positive().nullable().optional(),
  siteDealerIds: z.array(z.number().int().positive()).default([]),
  toDate: z.iso.date(),
})
export type CatalogPendingPurchasesGenerateJobPayload = z.infer<typeof CatalogPendingPurchasesGenerateJobPayloadSchema>

export const CatalogPendingPurchasesApplyJobPayloadSchema = z.object({
  pendingPurchaseApplyRequestId: z.number().int().positive(),
  requestedByUserId: z.number().int().positive().nullable().optional(),
})
export type CatalogPendingPurchasesApplyJobPayload = z.infer<typeof CatalogPendingPurchasesApplyJobPayloadSchema>

const ProposalBatchGenerationTriggerSchema = z.enum(['debug_promote', 'ui_generate'])

export const ProposalGenerateDescriptionBatchJobPayloadSchema = z.object({
  forceLiveRefresh: z.boolean().default(false),
  proposalBatchId: z.number().int().positive(),
  requestedByUserId: z.number().int().positive().nullable().optional(),
  trigger: ProposalBatchGenerationTriggerSchema.default('ui_generate'),
})
export type ProposalGenerateDescriptionBatchJobPayload = z.infer<typeof ProposalGenerateDescriptionBatchJobPayloadSchema>

export const ProposalGeneratePricingBatchJobPayloadSchema = z.object({
  forceLiveRefresh: z.boolean().default(false),
  proposalBatchId: z.number().int().positive(),
  requestedByUserId: z.number().int().positive().nullable().optional(),
  trigger: ProposalBatchGenerationTriggerSchema.default('ui_generate'),
})
export type ProposalGeneratePricingBatchJobPayload = z.infer<typeof ProposalGeneratePricingBatchJobPayloadSchema>

export const ReconcileGroupJobPayloadSchema = z.object({
  catalogGroupId: z.number().int().positive(),
  expectedDesiredProjectionHash: z.string().trim().min(1).nullable(),
  trigger: z.enum(['admin_force', 'approval', 'drift_sync', 'manual_refresh', 'retry', 'undo']).default('approval'),
  triggerAuditEventId: z.number().int().positive().nullable().optional(),
})
export type ReconcileGroupJobPayload = z.infer<typeof ReconcileGroupJobPayloadSchema>

export const UndoExecuteJobPayloadSchema = z.object({
  undoEventId: z.number().int().positive(),
})
export type UndoExecuteJobPayload = z.infer<typeof UndoExecuteJobPayloadSchema>

export const LlmDebugRerunJobPayloadSchema = z.object({
  catalogGroupId: z.number().int().positive(),
  forceLiveRefresh: z.boolean().default(false),
  llmRunId: z.number().int().positive(),
  purpose: z.enum(['description', 'pricing', 'debug']),
  requestedByUserId: z.number().int().positive(),
})
export type LlmDebugRerunJobPayload = z.infer<typeof LlmDebugRerunJobPayloadSchema>

export const ConfigWorkersStockRefreshJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  siteDealerIds: z.array(z.number().int().positive()).default([]),
  trigger: z
    .enum(['manual_run', 'scheduled', 'catalog_maintenance_fix_cache'])
    .default('scheduled'),
})
export type ConfigWorkersStockRefreshJobPayload = z.infer<typeof ConfigWorkersStockRefreshJobPayloadSchema>

export const ConfigWorkersLitalertsRefreshVariantJobPayloadSchema = z.object({
  queueRowId: z.number().int().positive(),
  productId: z.number().int().positive(),
  siteDealerId: z.number().int().positive().nullable().optional(),
  sourceSnapshotId: z.number().int().positive().nullable().optional(),
  requestedByUserId: z.number().int().positive().nullable().optional(),
  trigger: z
    .enum([
      // Legacy trigger values from the pre-market-data-sweep scheduler.
      'manual_run',
      'scheduled',
      // New market-data-sweep enqueue reason kinds. The string mirrors the
      // `enqueue_reason` constraint on pending_litalerts_refresh_queue plus
      // the `MarketRefreshTrigger` union in worker/litalerts/enqueueMarketRefresh.ts.
      'rolling',
      'proposal-source',
      'pending-purchase',
      'brand-alarm',
      'in-stock-alarm',
      'manual',
    ])
    .default('scheduled'),
})
export type ConfigWorkersLitalertsRefreshVariantJobPayload = z.infer<
  typeof ConfigWorkersLitalertsRefreshVariantJobPayloadSchema
>

export const ConfigWorkersCatalogRefreshJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  trigger: z.enum(['manual_run', 'scheduled']).default('scheduled'),
})
export type ConfigWorkersCatalogRefreshJobPayload = z.infer<
  typeof ConfigWorkersCatalogRefreshJobPayloadSchema
>

/**
 * Periodic alarm scanner over `vw_pricing_evidence_freshness`. Scans for
 * products whose alarm_class is non-null and whose competitor evidence is
 * missing / expired / about to expire, then re-enqueues a market-data
 * refresh at the alarm priority (0). One job per scheduler tick; the
 * scheduler runs every 15 minutes by default.
 */
export const ConfigWorkersMarketEvidenceAlarmScanJobPayloadSchema = z.object({
  trigger: z.enum(['scheduled', 'manual']),
  requestedByUserId: z.number().int().positive().nullable(),
})
export type ConfigWorkersMarketEvidenceAlarmScanJobPayload = z.infer<
  typeof ConfigWorkersMarketEvidenceAlarmScanJobPayloadSchema
>

/**
 * Periodic edible THC clamp sweep. Walks Bronx + Midtown (the two
 * pending-purchase site dealers) for category 7459 ("Edibles") and
 * rewrites each in-stock variant's `extendedLabData.totalTHC` so the
 * `contentPerProduct` is clamped at 100 mg/package (and
 * `contentPerUnit` is scaled accordingly). The job logic dedupes per
 * item against the current Sweed lab data, so repeated 15-minute ticks
 * are cheap noops once the catalog has been corrected.
 */
export const ConfigWorkersEdibleThcClampJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  siteDealerIds: z.array(z.number().int().positive()).default([]),
  trigger: z.enum(['manual_run', 'scheduled']).default('scheduled'),
})
export type ConfigWorkersEdibleThcClampJobPayload = z.infer<
  typeof ConfigWorkersEdibleThcClampJobPayloadSchema
>

/**
 * Daily slow refresh of Lit Alerts /v1/retailers/{id}/products for
 * every NY competitor inside our pricing distance bands (≤50mi).
 * Resume-aware: the worker skips retailers with a product row newer
 * than `skipIfIngestedWithinHours`, so the daily tick naturally
 * focuses on retailers that 5xx'd / timed-out on the prior pass.
 * Sub-exponential backoff on 5xx + deferred-retry passes drain
 * transient upstream storms without abandoning failed retailers.
 */
export const ConfigWorkersLitalertsRetailerBackfillJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  trigger: z.enum(['manual_run', 'scheduled']).default('scheduled'),
  stateCode: z.string().trim().min(2).max(2).default('NY'),
  concurrency: z.number().int().min(1).max(64).default(8),
  maxDistanceMiles: z.number().min(0).max(500).default(50),
  skipIfIngestedWithinHours: z.number().min(0).max(168).default(12),
})
export type ConfigWorkersLitalertsRetailerBackfillJobPayload = z.infer<
  typeof ConfigWorkersLitalertsRetailerBackfillJobPayloadSchema
>

/**
 * Periodic Sweed orders ingest worker payload.
 *
 * One job is enqueued per scheduler tick (~every 5 min). The handler
 * iterates the listed site dealers and, for each one:
 *
 *   1. Forward-polls `store.sale.invoice.list` from `highwater -
 *      OVERLAP` to `now`, inserts new rows into `sweed_orders` via
 *      `on conflict do nothing`, advances the highwater to
 *      `max(pay_time)` of the inserted batch.
 *   2. If the per-dealer `backfill_cursor_day` is non-null, fetches
 *      one historical day's invoices oldest-first toward the
 *      `min_pay_time` (the store-opening date), and decrements the
 *      cursor by one day. When the cursor reaches `min_pay_time` it
 *      is set to null and backfill stops.
 *
 * Operators can override `backfillDays` to do a multi-day catch-up
 * burst from a manual /config enqueue.
 *
 * See FreshlyBakedNYC/automation#22 for the full epic.
 */
export const ConfigWorkersSweedOrdersIngestJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  siteDealerIds: z.array(z.number().int().positive()).default([]),
  trigger: z.enum(['manual_run', 'scheduled']).default('scheduled'),
  /** How many days of historical backfill to attempt in this single job. */
  backfillDays: z.number().int().min(0).max(60).default(1),
})
export type ConfigWorkersSweedOrdersIngestJobPayload = z.infer<
  typeof ConfigWorkersSweedOrdersIngestJobPayloadSchema
>

/**
 * Sweed per-package snapshot worker payload.
 *
 * One scheduler tick = one job per dealer. The handler pages through
 * `store.inventory.item.list.grouped` (with `isOnStock: false` so
 * sold-through packages remain visible for historical-cost joins) and
 * writes a new row into `sweed_package_snapshots` whenever the
 * observed shape changes (cost, qty, lab, expiration, location),
 * else bumps `observed_at_max`.
 *
 * No highwater / cursor — the grouped feed is full-scan per tick.
 * The 02:00–08:00 ET quiet window keeps the Sweed RPC budget free
 * for overnight historical-backfill jobs (#22).
 *
 * See FreshlyBakedNYC/automation#24.
 */
export const ConfigWorkersSweedPackageSnapshotsJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  siteDealerIds: z.array(z.number().int().positive()).default([]),
  trigger: z.enum(['manual_run', 'scheduled']).default('scheduled'),
})
export type ConfigWorkersSweedPackageSnapshotsJobPayload = z.infer<
  typeof ConfigWorkersSweedPackageSnapshotsJobPayloadSchema
>

/**
 * Daily weather ingest payload (Open-Meteo Historical Weather API).
 *
 * One scheduler tick = one job. The handler iterates over the two
 * operating sites (ZIPs 10019 / 10458), each call covering a trailing
 * window plus an optional one-shot historical backfill driven by
 * `backfillStartIsoDate`. Per-site rows are upserted into
 * `weather_daily` keyed on `(site_zip, date)`; re-fetches are
 * idempotent and intentionally let Open-Meteo's slow-arriving
 * reanalysis corrections overwrite older values for the trailing
 * window.
 *
 * See FreshlyBakedNYC/automation#26 (follow-on under #22's umbrella).
 */
export const ConfigWorkersWeatherDailyIngestJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  trigger: z.enum(['manual_run', 'scheduled']).default('scheduled'),
  /**
   * How many trailing days each tick should re-pull from Open-Meteo.
   * 7 covers Open-Meteo's typical ERA5 reanalysis lag without a
   * separate "did the value change" pass.
   */
  trailingDays: z.number().int().min(1).max(60).default(7),
  /**
   * Optional one-shot historical backfill anchor. When set, the
   * worker also pulls `[backfillStartIsoDate, today]` for each site
   * on this tick. The default scheduler enqueue does NOT set this —
   * the worker self-derives a cold-start backfill on first run based
   * on the presence/absence of rows in `weather_daily`. Operators
   * may set this from a manual /config enqueue to force a re-pull
   * of a specific historical range.
   */
  backfillStartIsoDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
})
export type ConfigWorkersWeatherDailyIngestJobPayload = z.infer<
  typeof ConfigWorkersWeatherDailyIngestJobPayloadSchema
>

/**
 * Periodic Sweed shifts ingest worker payload.
 *
 * Shape mirrors `ConfigWorkersSweedOrdersIngestJobPayload`: the
 * handler iterates `siteDealerIds` (defaulting to the operator's
 * site list when empty), does a forward poll on
 * `store.sale.shift.list` from the per-dealer highwater, then walks
 * `backfillDays` historical days backward toward the dealer's
 * store-opening date.
 *
 * See FreshlyBakedNYC/automation#27 — follow-on under #22 and
 * remaining blocker for the cashier-throughput stub in #21 P5.
 */
export const ConfigWorkersSweedShiftsIngestJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  siteDealerIds: z.array(z.number().int().positive()).default([]),
  trigger: z.enum(['manual_run', 'scheduled']).default('scheduled'),
  /** How many days of historical backfill to attempt in this single job. */
  backfillDays: z.number().int().min(0).max(60).default(1),
})
export type ConfigWorkersSweedShiftsIngestJobPayload = z.infer<
  typeof ConfigWorkersSweedShiftsIngestJobPayloadSchema
>

/**
 * Customer-of-record address enrichment payload (A5 of
 * FreshlyBakedNYC/automation#25).
 *
 * Each scheduler tick enqueues one job whose handler:
 *
 *   1. Selects up to `batchSize` distinct (dealer_id, customer_id)
 *      pairs from `sweed_orders` that do NOT yet have a primary row
 *      in `sweed_customer_addresses` AND have not been recorded as a
 *      "no address" sentinel, ordered by most-recent observed
 *      `pay_time` first so freshly active customers are enriched
 *      before long-dormant ones.
 *   2. Calls `store.customer.get` per row via the Sweed pool session.
 *   3. Upserts the returned postal address through the shared
 *      `addresses` helper, then INSERTs the
 *      `(dealer_id, customer_id, address_id, kind='primary')` join
 *      row. When Sweed returns the customer record but has no address
 *      sub-object, the worker writes a sentinel join row pointing at
 *      the shared "__sentinel:no_address__" address so the same
 *      customer is not re-polled forever.
 *   4. Transport / auth errors are logged-and-skipped so the row
 *      stays eligible for retry on the next tick.
 */
export const ConfigWorkersEnrichCustomerAddressJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  siteDealerIds: z.array(z.number().int().positive()).default([]),
  trigger: z.enum(['manual_run', 'scheduled']).default('scheduled'),
  /** Per-tick RPC budget. 60 keeps us well under any Sweed ceiling. */
  batchSize: z.number().int().min(1).max(500).default(60),
})
export type ConfigWorkersEnrichCustomerAddressJobPayload = z.infer<
  typeof ConfigWorkersEnrichCustomerAddressJobPayloadSchema
>

/**
 * Worker-side resilient image upload for the catalog-maintenance
 * "Images & Barcodes" page. The Fastify route stashes the uploaded
 * bytes via `PendingImageUploadStore` and enqueues this job. The
 * worker leases a token from the Sweed session pool (see
 * SWEED_BACKED_JOB_TYPES + withSweedSession), runs blob.add → PUT
 * bytes → group.get → group.edit → group.get verify, flags the
 * group for reanalysis, and deletes the staged bytes on success.
 *
 * `stagedRef` is opaque to the worker — it's whatever
 * PendingImageUploadStore returned for the bytes. The store today is
 * local-filesystem at /var/lib/helios/pending-image-uploads; an S3
 * backend is planned (Phase 7 in EPIC_PLAN.md).
 */
export const CatalogMaintenanceUploadGroupImageJobPayloadSchema = z.object({
  stagedRef: z.string().trim().min(1),
  catalogGroupId: z.number().int().positive(),
  sweedGroupId: z.number().int().positive(),
  requestedByUserId: z.number().int().positive().nullable(),
})
export type CatalogMaintenanceUploadGroupImageJobPayload = z.infer<
  typeof CatalogMaintenanceUploadGroupImageJobPayloadSchema
>

export const CatalogReviewRerunRowJobPayloadSchema = z.object({
  scopeKind: ScopeKindSchema,
  scopeRef: ScopeRefSchema,
  reason: z.string().trim().min(1).max(1000).optional(),
  requestedByUserId: z.number().int().positive().nullable().optional(),
})
export type CatalogReviewRerunRowJobPayload = z.infer<typeof CatalogReviewRerunRowJobPayloadSchema>

/**
 * Delivery-address enrichment worker payload
 * (FreshlyBakedNYC/automation#25 task A4).
 *
 * One scheduler tick = one job. Two-phase per tick:
 *
 *   1. Walks delivery-typed sweed_orders rows that still need a
 *      delivery address, calls `store.sale.invoice.get` per row,
 *      upserts into `addresses`, and links to the order. Subject
 *      to a 60-second ingest-grace so we don't fight the
 *      same-cycle sweed_orders_ingest worker.
 *   2. Drains the addresses geocode-pending queue via the US
 *      Census geocoder (~1 RPS internal rate limit).
 *
 * `batchSize` caps both phases at the same number of rows so one
 * tick stays bounded.
 */
export const ConfigWorkersEnrichDeliveryAddressJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  trigger: z.enum(['manual_run', 'scheduled']).default('scheduled'),
  batchSize: z.number().int().min(1).max(500).default(60),
})
export type ConfigWorkersEnrichDeliveryAddressJobPayload = z.infer<
  typeof ConfigWorkersEnrichDeliveryAddressJobPayloadSchema
>

export {
  ScreensBannerRefreshJobPayloadSchema,
  ScreensBannerHealthMaintenanceJobPayloadSchema,
  ScreensBronxMidtownImageCloneJobPayloadSchema,
  ScreensEnableHealthyBannersJobPayloadSchema,
  ScreensImageBannerSyncJobPayloadSchema,
  ScreensMidtownPricedToMovePromoRebindJobPayloadSchema,
  SchedulingExtractConstraintsJobPayloadSchema,
  SchedulingGenerateCandidatesJobPayloadSchema,
}

export const JobPayloadSchema = JsonValueSchema
export type JobPayload = z.infer<typeof JobPayloadSchema>
