import { z } from 'zod'

import { JsonValueSchema } from '../common/json.js'
import { HeliosModuleCodeSchema, HeliosModuleScopeSchema } from './modules.js'
import { ScopeKindSchema, ScopeRefSchema } from './scopeRef.js'
import {
  ScreensBannerBulkToggleJobPayloadSchema,
  ScreensBannerDuplicateJobPayloadSchema,
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
  'catalog.pending_purchases.extract_hint_facts',
  'proposal.import.review_json',
  'proposal.generate.description_batch',
  'proposal.generate.pricing_batch',
  'reconcile.group',
  'screens.banner_bulk_toggle',
  'screens.banner_refresh',
  'screens.banner_health_maintenance',
  'screens.enable_healthy_banners',
  'screens.bronx_midtown_image_clone',
  'screens.midtown_priced_to_move_promo_rebind',
  'screens.image_banner_sync',
  'screens.banner_duplicate',
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
  'config.workers.litalerts_retailer_geo_refresh',
  'config.workers.enrich_customer_address',
  'config.workers.sweed_orders_ingest',
  'config.workers.sweed_package_snapshots',
  'config.workers.sweed_purchases_ingest',
  'config.workers.weather_daily_ingest',
  'config.workers.sweed_shifts_ingest',
  'config.workers.enrich_delivery_address',
  'config.workers.enrich_visitor_scan_address',
  'config.workers.link_visitor_scan_to_sweed',
  'config.workers.refresh_sweed_customer_segments',
  'config.workers.refresh_sweed_segment_members',
  'config.workers.geo_segment_rule_eval',
  'config.workers.sweed_orders_raw_json_drain',
  'config.workers.litalerts_products_raw_json_drain',
  'config.workers.fuzzy_skus_retention',
  'config.workers.stock_snapshot_items_retention',
  'config.workers.gads_lp_rollup_refresh',
  'config.workers.faq_hybrid_sync',
  'catalog.maintenance.upload_group_image',
  'inventory.lifecycle.advance',
])
export type JobType = z.infer<typeof JobTypeSchema>

export const JobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'dead_letter'])
export type JobStatus = z.infer<typeof JobStatusSchema>

/**
 * Worker execution pool a job is bound to. Mirrors the values in
 * `worker/runtime/jobPools.ts#JOB_EXECUTION_POOLS`; kept here in
 * `shared/` so the SPA can render the pool × priority-band queue
 * matrix without dragging in worker-internal imports.
 */
export const JobExecutionPoolSchema = z.enum(['sweed', 'ads', 'scheduling', 'system'])
export type JobExecutionPool = z.infer<typeof JobExecutionPoolSchema>

/**
 * Priority bands surfaced to the operator. Each band is a half-open
 * range `[minPriority, nextBand.minPriority)`. We classify by range
 * rather than exact equality so an operator manually nudging a
 * single row's priority still lands in the right band.
 *
 * Order (low → high): `best_effort`, `backfill`, `interactive`,
 * `live_requested`, `urgent`.
 */
export const JobPriorityBandSchema = z.enum([
  'best_effort',
  'backfill',
  'interactive',
  'live_requested',
  'urgent',
])
export type JobPriorityBand = z.infer<typeof JobPriorityBandSchema>

export interface JobPriorityBandDefinition {
  code: JobPriorityBand
  label: string
  /** Inclusive lower bound. */
  minPriority: number
  /** Operator-facing sort order (1 = highest). */
  sortOrder: number
  /** Oldest-ready wait threshold (s) where the cell turns warning. */
  warnAfterSeconds: number
  /** Oldest-ready wait threshold (s) where the cell turns danger. */
  dangerAfterSeconds: number
}

/**
 * Authoritative band table. Order is high-priority-first; the lease
 * order in `worker/runtime/leaseJobs.ts` already sorts by `priority
 * desc`, so this matches the order rows actually come out.
 */
export const JOB_PRIORITY_BANDS: readonly JobPriorityBandDefinition[] = [
  { code: 'urgent', label: 'Urgent', minPriority: 1000, sortOrder: 1, warnAfterSeconds: 15, dangerAfterSeconds: 60 },
  { code: 'live_requested', label: 'Live requested', minPriority: 500, sortOrder: 2, warnAfterSeconds: 60, dangerAfterSeconds: 300 },
  { code: 'interactive', label: 'Interactive', minPriority: 100, sortOrder: 3, warnAfterSeconds: 120, dangerAfterSeconds: 600 },
  { code: 'backfill', label: 'Backfill', minPriority: 10, sortOrder: 4, warnAfterSeconds: 30 * 60, dangerAfterSeconds: 2 * 60 * 60 },
  { code: 'best_effort', label: 'Best effort', minPriority: 0, sortOrder: 5, warnAfterSeconds: 60 * 60, dangerAfterSeconds: 6 * 60 * 60 },
] as const

export function classifyJobPriorityBand(priority: number): JobPriorityBand {
  for (const band of JOB_PRIORITY_BANDS) {
    if (priority >= band.minPriority) {
      return band.code
    }
  }
  return 'best_effort'
}

export function getJobPriorityBandDefinition(band: JobPriorityBand): JobPriorityBandDefinition {
  const def = JOB_PRIORITY_BANDS.find((entry) => entry.code === band)
  if (!def) {
    throw new Error(`Unknown job priority band: ${band}`)
  }
  return def
}

export const JOB_EXECUTION_POOL_LABELS: Record<JobExecutionPool, string> = {
  sweed: 'Sweed',
  ads: 'Ads',
  scheduling: 'Scheduling',
  system: 'System',
}

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

// Hint-fact extraction pass (child epic #54, task C3). Runs the
// intent-classify + cited-fact extraction over the documents of a hint
// bundle, persisting hint_intent / extraction_status / extracted_facts on
// each row so the classifier (C4) can read precomputed facts. Optionally
// scoped to a single document; `force` re-extracts already-extracted docs.
// job_queue.payload is a trust boundary, so enforce the public-id grammar.
export const CatalogPendingPurchasesExtractHintFactsJobPayloadSchema = z.object({
  hintBundleId: z
    .string()
    .trim()
    .regex(/^pphint_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[0-9a-f]{6}$/, 'invalid hint bundle id'),
  hintDocumentId: z
    .string()
    .trim()
    .regex(/^pphdoc_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[0-9a-f]{6}$/, 'invalid hint document id')
    .nullable()
    .optional(),
  force: z.boolean().optional(),
  trigger: z.enum(['document_added', 'manual_reextract']).optional(),
  requestedByUserId: z.number().int().positive().nullable().optional(),
})
export type CatalogPendingPurchasesExtractHintFactsJobPayload = z.infer<
  typeof CatalogPendingPurchasesExtractHintFactsJobPayloadSchema
>

export const CatalogPendingPurchasesGenerateJobPayloadSchema = z.object({
  fromDate: z.iso.date(),
  // Optional single-PO scope: only the outstanding purchase order whose Sweed
  // name/number (or numeric id) matches is processed when this is set.
  purchaseOrderNumber: z.string().trim().min(1).nullable().optional(),
  requestedByUserId: z.number().int().positive().nullable().optional(),
  siteDealerIds: z.array(z.number().int().positive()).default([]),
  toDate: z.iso.date(),
  // Optional prospective-classifier hint bundle (child epic #54, C2). Carried
  // through from the generate route (validated there); the classifier (C4)
  // consumes it. The generator does not read it yet in C2. job_queue.payload
  // is also a trust boundary, so enforce the public-id grammar here too.
  hintBundleId: z
    .string()
    .trim()
    .regex(/^pphint_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[0-9a-f]{6}$/, 'invalid hint bundle id')
    .nullable()
    .optional(),
})
export type CatalogPendingPurchasesGenerateJobPayload = z.infer<typeof CatalogPendingPurchasesGenerateJobPayloadSchema>

export const CatalogPendingPurchasesApplyJobPayloadSchema = z.object({
  pendingPurchaseApplyRequestId: z.number().int().positive(),
  requestedByUserId: z.number().int().positive().nullable().optional(),
  // C7 optional post-apply refresh: when true, the apply job drops every
  // product it CREATED this run onto the Lit Alerts market-data refresh queue
  // (best-effort) so the pricing reviewer has fresh competitor evidence for the
  // brand-new SKUs. Default false keeps current behavior.
  enqueueMarketRefreshForCreatedProducts: z.boolean().default(false),
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
      'purchase-lifecycle',
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
 * Periodic purchase inventory pricing-safety lifecycle automation +
 * monitoring sweep (automation#54, L3). Each tick (1) polls the async
 * gates of active lifecycle runs and advances them through the existing
 * idempotent `reprice` one-step advancer (market gate → create pricing
 * batch → poll batch generation → verify live==approved price), (2)
 * re-reads live Sweed lots for active quarantine-path runs and pages on
 * any breach (a not-yet-priced expected lot back in a FOR SALE room), and
 * (3) pages on market-data / price-apply timeouts and newly-blocked runs.
 * The job never approves prices, never starts/receives/releases stock —
 * those stay operator-gated; it only polls gates, surfaces evidence, and
 * alerts.
 */
export const InventoryLifecycleAdvanceJobPayloadSchema = z.object({
  trigger: z.enum(['scheduled', 'manual']),
  requestedByUserId: z.number().int().positive().nullable(),
})
export type InventoryLifecycleAdvanceJobPayload = z.infer<
  typeof InventoryLifecycleAdvanceJobPayloadSchema
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

// F5 (virusdave/top-level#11): drain sweed_orders.raw_json for orders
// older than `cutoffDays` in bounded DB batches. Each batch is its own
// short transaction; one job invocation does at most
// `maxBatches * batchSize` rows so it never holds long locks or floods
// WAL. See configWorkersSweedOrdersRawJsonDrainJob.ts.
export const ConfigWorkersSweedOrdersRawJsonDrainJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  trigger: z.enum(['manual_run', 'scheduled']).default('scheduled'),
  cutoffDays: z.number().int().min(30).max(365).default(30),
  batchSize: z.number().int().min(1).max(2000).default(500),
  maxBatches: z.number().int().min(1).max(40).default(10),
})
export type ConfigWorkersSweedOrdersRawJsonDrainJobPayload = z.infer<
  typeof ConfigWorkersSweedOrdersRawJsonDrainJobPayloadSchema
>

// F3 (virusdave/top-level#11): drain litalerts_products.raw_config_json
// / raw_product_json for observations older than `cutoffDays` in bounded
// DB batches. Each batch is its own short transaction; one invocation
// does at most `maxBatches * batchSize` rows so it never holds long
// locks or floods WAL. The cutoff floor is 7 days (the plan's documented
// window). See configWorkersLitalertsProductsRawJsonDrainJob.ts.
export const ConfigWorkersLitalertsProductsRawJsonDrainJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  trigger: z.enum(['manual_run', 'scheduled']).default('scheduled'),
  cutoffDays: z.number().int().min(7).max(365).default(7),
  batchSize: z.number().int().min(1).max(2000).default(500),
  maxBatches: z.number().int().min(1).max(40).default(10),
})
export type ConfigWorkersLitalertsProductsRawJsonDrainJobPayload = z.infer<
  typeof ConfigWorkersLitalertsProductsRawJsonDrainJobPayloadSchema
>

// F4 (virusdave/top-level#11): enforce the documented fuzzy_skus
// retention by deleting rows older than `retentionDays` in bounded DB
// batches (skipping rows still referenced by catalog_market_matches).
// Each batch is its own short transaction; one invocation does at most
// `maxBatches * batchSize` rows so it never holds long locks or floods
// WAL. See configWorkersFuzzySkusRetentionJob.ts.
export const ConfigWorkersFuzzySkusRetentionJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  trigger: z.enum(['manual_run', 'scheduled']).default('scheduled'),
  retentionDays: z.number().int().min(7).max(365).default(30),
  batchSize: z.number().int().min(1).max(5000).default(1000),
  maxBatches: z.number().int().min(1).max(60).default(20),
})
export type ConfigWorkersFuzzySkusRetentionJobPayload = z.infer<
  typeof ConfigWorkersFuzzySkusRetentionJobPayloadSchema
>

// F6 (virusdave/top-level#11): delete the items of stock snapshots older
// than `retentionDays` in bounded DB batches (the stock_snapshots header
// rows are kept — they're referenced by many other tables). Each batch
// is its own short transaction; one invocation does at most
// `maxBatches * batchSize` rows so it never holds long locks or floods
// WAL. The 90-day default covers the ≤12-week /metrics windows. See
// configWorkersStockSnapshotItemsRetentionJob.ts.
export const ConfigWorkersStockSnapshotItemsRetentionJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  trigger: z.enum(['manual_run', 'scheduled']).default('scheduled'),
  retentionDays: z.number().int().min(30).max(730).default(90),
  batchSize: z.number().int().min(1).max(5000).default(2000),
  maxBatches: z.number().int().min(1).max(60).default(20),
})
export type ConfigWorkersStockSnapshotItemsRetentionJobPayload = z.infer<
  typeof ConfigWorkersStockSnapshotItemsRetentionJobPayloadSchema
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
 * Weekly refresh of the geocoded `litalerts_retailer_locations` table
 * (issue #56). Pulls `/v1/retailers?state=<stateCode>`, upserts each row
 * (refreshing `last_seen_at`), and geocodes new / address-changed rows
 * via the shared 1-RPS Census geocoder. Durable replacement for the
 * hand-run `scripts/backfill-litalerts-retailer-geo.mts` one-off; keeps
 * newly-opened dispensaries from silently going missing from the
 * competitor-distance / pricing path.
 */
export const ConfigWorkersLitalertsRetailerGeoRefreshJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  trigger: z.enum(['manual_run', 'scheduled']).default('scheduled'),
  stateCode: z.string().trim().min(2).max(2).default('NY'),
})
export type ConfigWorkersLitalertsRetailerGeoRefreshJobPayload = z.infer<
  typeof ConfigWorkersLitalertsRetailerGeoRefreshJobPayloadSchema
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
 * Sweed purchases ingest worker payload — see the Catalog →
 * Purchase Sell-Through page family. One scheduler tick = one job
 * per dealer. The handler forward-polls `store.purchase.order.list`
 * for the recent overlap window, then `store.purchase.order.get`
 * for each non-pending PO. Pending POs (orderStatusId = 2) are
 * intentionally skipped — they're owned by the catalog enrichment
 * workflow (pending_purchase_*). Each line item is direct-matched
 * to a sweed_package_snapshots row via externalTrackCode (Metrc tag)
 * so the sell-through page can join purchase line items to
 * sweed_orders.raw_json.items[] and compute realised cost-of-sold.
 */
export const ConfigWorkersSweedPurchasesIngestJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  siteDealerIds: z.array(z.number().int().positive()).default([]),
  trigger: z.enum(['manual_run', 'scheduled']).default('scheduled'),
  /** How many days of historical backfill to walk in this single job. */
  backfillDays: z.number().int().min(0).max(60).default(1),
})
export type ConfigWorkersSweedPurchasesIngestJobPayload = z.infer<
  typeof ConfigWorkersSweedPurchasesIngestJobPayloadSchema
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

/**
 * Visitor-scan home-address enrichment worker payload.
 *
 * Drives the per-tick batch backfill of `visitor_scans.address_id`
 * and a subsequent drain of the Census geocoder queue. Same pattern
 * as `enrich_delivery_address`, but for the VeriScan-ingestion side
 * (`visitor_scans` rather than `sweed_orders`):
 *
 *   1. Link up to `batchSize` (default 5000) visitor_scans rows
 *      that have address text but no `address_id` to a row in the
 *      shared `addresses` table (creating one if needed). New
 *      addresses arrive with `geocode_status='pending'`.
 *
 *   2. Drain up to `batchSize` rows from the Census geocoder queue
 *      (`addresses.geocode_status='pending'`).
 *
 * Default `batchSize=5000` per operator direction so the backfill
 * burns through the ~55k unlinked-with-text scans within a few
 * scheduler ticks. The drain step is naturally rate-limited by the
 * shared Census client (~1 RPS) — `batchSize` is an upper bound on
 * how many rows one tick CAN write, not a guarantee.
 */
export const ConfigWorkersEnrichVisitorScanAddressJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  trigger: z.enum(['manual_run', 'scheduled', 'webhook_followup']).default('scheduled'),
  batchSize: z.number().int().min(1).max(10_000).default(5000),
})
export type ConfigWorkersEnrichVisitorScanAddressJobPayload = z.infer<
  typeof ConfigWorkersEnrichVisitorScanAddressJobPayloadSchema
>

/**
 * Per-scan Sweed CRM linking job.
 *
 * Enqueued by the VeriScan webhook handler immediately after a
 * successful visitor_scans insert (and on operator manual retry).
 * Runs inside its own `withSweedSession` claim (SWEED_BACKED_JOB_TYPES)
 * and:
 *
 *   - Reads the scan's id_num (driver's-license document number);
 *   - Calls `store.customer.list { documentNumber, page, pageSize }`
 *     against the dealer pinned to the scan's site_slug;
 *   - Writes the resolved sweed_customer_id back to
 *     visitor_scan_links, transitioning link_status to 'linked'
 *     or 'no_match' / 'insufficient_data';
 *   - On RPC failure, marks the row 'failed', bumps
 *     probe_failed_count + next_probe_at by a 5s × 2^retryAttempt
 *     backoff, and self-re-enqueues another job at `runAt = next_probe_at`
 *     until `retryAttempt` exceeds `MAX_RETRY_ATTEMPTS` (the link
 *     row stays 'failed' for the periodic safety-net to eventually
 *     retry on a slower cadence).
 *
 * One job per scan keeps the lifecycle observable: each scan's
 * lookup is its own row in `job_queue` with payload `{ scanId }`,
 * dedup-keyed by scanId+retryAttempt so duplicate-delivery webhooks
 * don't pile up parallel probes.
 */
export const ConfigWorkersLinkVisitorScanToSweedJobPayloadSchema = z.object({
  scanId: z.number().int().positive(),
  // 0 = first attempt; bumped by the job on each self-re-enqueue.
  retryAttempt: z.number().int().min(0).default(0),
  // Free-form trigger tag for the audit trail.
  trigger: z
    .enum(['webhook_followup', 'manual_retry', 'scheduled_safety_net'])
    .default('webhook_followup'),
})
export type ConfigWorkersLinkVisitorScanToSweedJobPayload = z.infer<
  typeof ConfigWorkersLinkVisitorScanToSweedJobPayloadSchema
>

/**
 * Refresh the cached Sweed marketing-segment membership for one
 * linked customer (virusdave/top-level#12).
 *
 * Runs in the Sweed pool inside its own withSweedSession. Calls
 * `store.customer.segment.list { id: sweedCustomerId }` and
 * snapshot-replaces the customer's rows in `sweed_customer_segments`,
 * then opportunistically refreshes the global
 * `sweed_marketing_segments` catalog if it's stale. Enqueued by the
 * operator "Refresh segments" button on the details page (deduped per
 * customer). The per-scan link worker refreshes membership inline on
 * link success, so this job exists mainly for the manual re-pull.
 */
export const ConfigWorkersRefreshSweedCustomerSegmentsJobPayloadSchema = z.object({
  sweedCustomerId: z.number().int().positive(),
  // For the audit trail / dedup observability.
  trigger: z.enum(['manual_refresh', 'link_followup']).default('manual_refresh'),
})
export type ConfigWorkersRefreshSweedCustomerSegmentsJobPayload = z.infer<
  typeof ConfigWorkersRefreshSweedCustomerSegmentsJobPayloadSchema
>

// Per-segment bulk membership refresh (the Helios segment details page's
// "Refresh membership cache" button). Pulls one segment's full member list
// from Sweed and snapshot-replaces its cached rows. Operator-triggered.
export const ConfigWorkersRefreshSweedSegmentMembersJobPayloadSchema = z.object({
  segmentId: z.number().int().positive(),
  // manual_refresh: single-segment "Refresh membership cache" button.
  // manual_refresh_all: one fan-out leg of the "Refresh all segment
  // caches" batch trigger (same per-segment job, deduped per segment).
  trigger: z.enum(['manual_refresh', 'manual_refresh_all']).default('manual_refresh'),
})
export type ConfigWorkersRefreshSweedSegmentMembersJobPayload = z.infer<
  typeof ConfigWorkersRefreshSweedSegmentMembersJobPayloadSchema
>

/**
 * Per-scan geographic-segment rule evaluation
 * (virusdave/top-level Bronx geo-segment work, phase 2).
 *
 * Enqueued (best-effort, deduped per scan) from BOTH ends of the
 * scan-enrichment pipeline, because a scan's Sweed link and its home
 * address geocode complete in either order:
 *
 *   - `linkVisitorScanToSweedJob` enqueues it after a scan links to a
 *     Sweed customer; and
 *   - `enrichVisitorScanAddressJob` enqueues it for the scans on an
 *     address that just reached geocode `ok`.
 *
 * The handler is DB-only on the common path: it loads the scan's link
 * + geocode + person context, loads the small set of enabled
 * `geo_segment_rules` for the scan's site and `first_scan` trigger,
 * and only opens a Sweed session (to call
 * `store.marketing.segment.result.add`) when a rule actually matches a
 * customer not yet recorded as applied in `geo_segment_rule_applications`.
 * Missing prerequisites (not yet linked / not yet geocoded) are NOT
 * errors — the other hook re-enqueues when its half completes.
 *
 * See helios/src/worker/jobs/geoSegmentRuleEvalJob.ts and
 * migration 079.
 */
export const ConfigWorkersGeoSegmentRuleEvalJobPayloadSchema = z.object({
  scanId: z.number().int().positive(),
  // What re-triggered this evaluation, for the audit trail / dedup
  // observability. All paths converge on the same DB evaluation:
  //   - scan_linked       : the scan just linked to a Sweed customer
  //   - address_geocoded  : the scan's home address just reached geocode ok
  //   - address_attached  : the scan was just attached to an address that
  //                         was ALREADY geocoded ok (no fresh geocode event)
  //   - manual            : operator / backfill re-trigger
  trigger: z
    .enum(['scan_linked', 'address_geocoded', 'address_attached', 'manual'])
    .default('scan_linked'),
})
export type ConfigWorkersGeoSegmentRuleEvalJobPayload = z.infer<
  typeof ConfigWorkersGeoSegmentRuleEvalJobPayloadSchema
>

/**
 * GAds → Landing-pages rollup refresh payload (P2; parent epic
 * virusdave/top-level#18, child FreshlyBakedNYC/automation#47).
 *
 * One scheduler tick = one job (60-min cadence). The handler recomputes
 * the bounded NY-local horizon of `gads_lp_rollup` from the append-only
 * `lp_events` sink and updates the singleton refresh-state row. The
 * default scheduler enqueue leaves `horizonDays` unset (the helper
 * defaults to 90 per the operator's bounded-horizon decree); an
 * operator manual /config enqueue may widen it for a one-off rebuild.
 *
 * See helios/src/worker/jobs/refreshGadsLpRollupJob.ts and migration
 * 087_gads_lp_rollup.sql.
 */
export const ConfigWorkersGadsLpRollupRefreshJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  trigger: z.enum(['manual_run', 'scheduled']).default('scheduled'),
  /** NY-local recompute horizon in days. Defaults to 90 in the handler. */
  horizonDays: z.number().int().min(1).max(365).optional(),
})
export type ConfigWorkersGadsLpRollupRefreshJobPayload = z.infer<
  typeof ConfigWorkersGadsLpRollupRefreshJobPayloadSchema
>

export const ConfigWorkersFaqHybridSyncJobPayloadSchema = z.object({
  requestedByUserId: z.number().int().positive().nullable().optional(),
  trigger: z.enum(['manual_run', 'scheduled']).default('scheduled'),
})
export type ConfigWorkersFaqHybridSyncJobPayload = z.infer<
  typeof ConfigWorkersFaqHybridSyncJobPayloadSchema
>

export {
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
}

export const JobPayloadSchema = JsonValueSchema
export type JobPayload = z.infer<typeof JobPayloadSchema>
