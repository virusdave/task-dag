import type { JobType } from '../../shared/contracts/domain/jobs.js'

/**
 * Worker execution pools.
 *
 * The pool axis is orthogonal to the `module` axis. Module is used for nav,
 * audit, and ownership; the execution pool is the process-isolation axis.
 *
 * - `sweed` is a singleton-able pool. Every Sweed-touching job belongs here so
 *   the dedicated Sweed worker process is the only thing initializing the
 *   shared Sweed UI session, on top of the database-level
 *   `concurrency_key='sweed-session'` lane.
 * - `ads` is reserved for Google Ads / Mantle / communications work folded in
 *   from the existing `automation/ads/` Python scripts.
 * - `scheduling` is reserved for scheduling extract / generate compute that
 *   should be restartable without bouncing Sweed or system jobs.
 * - `system` is the catch-all for jobs without strong isolation requirements
 *   (LLM batches, imports, reconciliation, schedulers, utilities).
 */
export const JOB_EXECUTION_POOLS = ['sweed', 'ads', 'scheduling', 'system'] as const
export type JobExecutionPool = (typeof JOB_EXECUTION_POOLS)[number]

export interface JobPoolMetadata {
  pool: JobExecutionPool
  requiresSweedSession: boolean
}

/**
 * Per-`JobType` declaration of execution pool and Sweed-session requirement.
 *
 * Adding a new `JobType` to `JobTypeSchema` will fail the `typecheck` pass on
 * the `Record<JobType, ...>` type below until it is classified here. That is
 * intentional: every job needs an explicit pool decision.
 */
export const JOB_EXECUTION_POOL_BY_TYPE: Record<JobType, JobPoolMetadata> = {
  // --- sweed pool: anything that touches the shared Sweed UI session ---
  'catalog.maintenance.upload_group_image': { pool: 'sweed', requiresSweedSession: true },
  'catalog.sync.full_summary': { pool: 'sweed', requiresSweedSession: true },
  'catalog.sync.group_detail': { pool: 'sweed', requiresSweedSession: true },
  'catalog.sync.discover_orphan_groups': { pool: 'sweed', requiresSweedSession: true },
  'catalog.pending_purchases.generate': { pool: 'sweed', requiresSweedSession: true },
  'catalog.pending_purchases.apply': { pool: 'sweed', requiresSweedSession: true },
  'config.workers.stock_refresh': { pool: 'sweed', requiresSweedSession: true },
  'config.workers.catalog_refresh': { pool: 'sweed', requiresSweedSession: true },
  'config.workers.edible_thc_clamp': { pool: 'sweed', requiresSweedSession: true },
  'config.workers.enrich_customer_address': { pool: 'sweed', requiresSweedSession: true },
  'config.workers.sweed_orders_ingest': { pool: 'sweed', requiresSweedSession: true },
  'config.workers.sweed_package_snapshots': { pool: 'sweed', requiresSweedSession: true },
  'config.workers.sweed_purchases_ingest': { pool: 'sweed', requiresSweedSession: true },
  'config.workers.sweed_shifts_ingest': { pool: 'sweed', requiresSweedSession: true },
  'config.workers.enrich_delivery_address': { pool: 'sweed', requiresSweedSession: true },
  'config.workers.link_visitor_scan_to_sweed': { pool: 'sweed', requiresSweedSession: true },
  'config.workers.refresh_sweed_customer_segments': { pool: 'sweed', requiresSweedSession: true },
  'config.workers.refresh_sweed_segment_members': { pool: 'sweed', requiresSweedSession: true },
  'reconcile.group': { pool: 'sweed', requiresSweedSession: true },
  'screens.banner_bulk_toggle': { pool: 'sweed', requiresSweedSession: true },
  'screens.banner_refresh': { pool: 'sweed', requiresSweedSession: true },
  'screens.banner_health_maintenance': { pool: 'sweed', requiresSweedSession: true },
  'screens.enable_healthy_banners': { pool: 'sweed', requiresSweedSession: true },
  'screens.bronx_midtown_image_clone': { pool: 'sweed', requiresSweedSession: true },
  'screens.midtown_priced_to_move_promo_rebind': { pool: 'sweed', requiresSweedSession: true },
  'screens.image_banner_sync': { pool: 'sweed', requiresSweedSession: true },
  'screens.banner_duplicate': { pool: 'sweed', requiresSweedSession: true },
  'undo.execute': { pool: 'sweed', requiresSweedSession: true },

  // --- scheduling pool ---
  'scheduling.extract_constraints': { pool: 'scheduling', requiresSweedSession: false },
  'scheduling.generate_candidates': { pool: 'scheduling', requiresSweedSession: false },

  // --- system pool: HTTP-only, LLM, imports, schedulers, utilities ---
  'catalog.pending_purchases.import_json': { pool: 'system', requiresSweedSession: false },
  // Hint-fact extraction (C3): Postgres + optional Mantle/Bedrock only; it
  // must NOT occupy the Sweed session pool.
  'catalog.pending_purchases.extract_hint_facts': { pool: 'system', requiresSweedSession: false },
  'catalog.review.rerun_row': { pool: 'system', requiresSweedSession: false },
  'config.workers.litalerts_refresh.variant': { pool: 'system', requiresSweedSession: false },
  'config.workers.litalerts_retailer_backfill': { pool: 'system', requiresSweedSession: false },
  'config.workers.litalerts_retailer_geo_refresh': { pool: 'system', requiresSweedSession: false },
  'config.workers.market_evidence_alarm_scan': { pool: 'system', requiresSweedSession: false },
  'config.workers.weather_daily_ingest': { pool: 'system', requiresSweedSession: false },
  'config.workers.sweed_orders_raw_json_drain': { pool: 'system', requiresSweedSession: false },
  'config.workers.litalerts_products_raw_json_drain': { pool: 'system', requiresSweedSession: false },
  'config.workers.fuzzy_skus_retention': { pool: 'system', requiresSweedSession: false },
  'config.workers.stock_snapshot_items_retention': { pool: 'system', requiresSweedSession: false },
  'config.workers.gads_lp_rollup_refresh': { pool: 'system', requiresSweedSession: false },
  'config.workers.faq_hybrid_sync': { pool: 'system', requiresSweedSession: false },
  // Purchase inventory lifecycle advance + monitor (automation#54, L3):
  // DB-only on the common path; it opens its OWN `withSweedSession` only
  // to read live prices (when advancing a ready pricing batch) and live
  // lots (the quarantine-breach monitor). Like geo_segment_rule_eval, it
  // therefore lives in the system pool and is NOT a `requiresSweedSession`
  // job — keeping the singleton Sweed worker free of the routine no-op
  // gate polling.
  'inventory.lifecycle.advance': { pool: 'system', requiresSweedSession: false },
  // Visitor-scan address enrichment hits only Postgres + Census
  // (no Sweed), so it lives in the system pool — keeps the Sweed
  // pool free for catalog / orders / shifts / etc.
  'config.workers.enrich_visitor_scan_address': { pool: 'system', requiresSweedSession: false },
  // Geographic segment-rule evaluation is DB-only on the common path
  // (most scans match no rule); it opens its OWN private Sweed session
  // via `withSweedSession` only when a rule actually matches a customer,
  // so it lives in the system pool and is NOT a `requiresSweedSession`
  // job — keeping the singleton Sweed worker free of the per-scan
  // no-op evaluations.
  'config.workers.geo_segment_rule_eval': { pool: 'system', requiresSweedSession: false },
  'llm.debug.rerun': { pool: 'system', requiresSweedSession: false },
  'proposal.generate.description_batch': { pool: 'system', requiresSweedSession: false },
  'proposal.generate.pricing_batch': { pool: 'system', requiresSweedSession: false },
  'proposal.import.review_json': { pool: 'system', requiresSweedSession: false },
  // Worker-driven pending-migration apply (automation#62, leaf 4): Postgres +
  // an out-of-process `psql` child only, never Sweed. Enqueued at
  // JOB_PRIORITY_URGENT so the fast-lane loop picks it up near-instantly.
  'db.migration.apply': { pool: 'system', requiresSweedSession: false },
}

/**
 * Selector value used by the `WORKER_POOL` env var. `all` runs every pool in
 * one process and is the default so the operator-facing dev loop is unchanged.
 */
export type WorkerPoolSelector = 'all' | JobExecutionPool

const ALL_JOB_TYPES = Object.keys(JOB_EXECUTION_POOL_BY_TYPE) as JobType[]

const JOB_TYPES_BY_POOL: Record<JobExecutionPool, JobType[]> = (() => {
  const result: Record<JobExecutionPool, JobType[]> = {
    sweed: [],
    ads: [],
    scheduling: [],
    system: [],
  }
  for (const jobType of ALL_JOB_TYPES) {
    const meta = JOB_EXECUTION_POOL_BY_TYPE[jobType]
    result[meta.pool].push(jobType)
  }
  return result
})()

/**
 * Returns the list of `JobType` values a worker should lease for the given
 * selector. `all` returns every job type; a specific pool returns only its
 * job types.
 */
export function getJobTypesForPoolSelector(selector: WorkerPoolSelector): JobType[] {
  if (selector === 'all') {
    return [...ALL_JOB_TYPES]
  }
  return [...JOB_TYPES_BY_POOL[selector]]
}

/**
 * Whether the config-workers scheduler tick should run in this worker process
 * for the given pool selector. The scheduler enqueues work; running it from
 * multiple worker processes would duplicate enqueues. It runs in `all` (single
 * process dev) and `system` (the long-lived utilities pool).
 */
export function shouldRunConfigWorkersSchedulerTickForPoolSelector(
  selector: WorkerPoolSelector,
): boolean {
  return selector === 'all' || selector === 'system'
}
