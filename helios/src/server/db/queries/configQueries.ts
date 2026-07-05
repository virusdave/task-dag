import type { QueryResultRow } from 'pg'

import {
  CATALOG_DEFAULT_SCHEDULE_WINDOWS,
  CONFIG_BACKGROUND_TASKS,
  EDIBLE_THC_CLAMP_DEFAULT_SCHEDULE_WINDOWS,
  ENRICH_CUSTOMER_ADDRESS_DEFAULT_SCHEDULE_WINDOWS,
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  LITALERTS_DEFAULT_SCHEDULE_WINDOWS,
  LITALERTS_RETAILER_BACKFILL_DEFAULT_SCHEDULE_WINDOWS,
  LITALERTS_RETAILER_GEO_REFRESH_DEFAULT_SCHEDULE_WINDOWS,
  LITALERTS_ROLLING_DEFAULT_SCHEDULE_WINDOWS,
  MARKET_EVIDENCE_ALARM_DEFAULT_SCHEDULE_WINDOWS,
  STOCK_DEFAULT_SCHEDULE_WINDOWS,
  SWEED_ORDERS_INGEST_DEFAULT_SCHEDULE_WINDOWS,
  SWEED_PACKAGE_SNAPSHOTS_DEFAULT_SCHEDULE_WINDOWS,
  SWEED_PURCHASES_INGEST_DEFAULT_SCHEDULE_WINDOWS,
  WEATHER_DAILY_INGEST_DEFAULT_SCHEDULE_WINDOWS,
  SWEED_SHIFTS_INGEST_DEFAULT_SCHEDULE_WINDOWS,
  ENRICH_DELIVERY_ADDRESS_DEFAULT_SCHEDULE_WINDOWS,
  ENRICH_VISITOR_SCAN_ADDRESS_DEFAULT_SCHEDULE_WINDOWS,
  SWEED_ORDERS_RAW_JSON_DRAIN_DEFAULT_SCHEDULE_WINDOWS,
  LITALERTS_PRODUCTS_RAW_JSON_DRAIN_DEFAULT_SCHEDULE_WINDOWS,
  FUZZY_SKUS_RETENTION_DEFAULT_SCHEDULE_WINDOWS,
  STOCK_SNAPSHOT_ITEMS_RETENTION_DEFAULT_SCHEDULE_WINDOWS,
  GADS_LP_ROLLUP_REFRESH_DEFAULT_SCHEDULE_WINDOWS,
  FAQ_HYBRID_SYNC_DEFAULT_SCHEDULE_WINDOWS,
  INVENTORY_LIFECYCLE_ADVANCE_DEFAULT_SCHEDULE_WINDOWS,
  getConfigBackgroundTaskDefinition,
  type ConfigBackgroundTaskKey,
  type ConfigWorkerSchedule,
  type ConfigWorkerScheduleWindow,
  type RecentSweedOrdersIngestRun,
  type SweedOrdersIngestDealerStatus,
} from '../../../shared/contracts/index.js'
import { getPool, type Queryable } from '../pool.js'

interface ScheduleRow extends QueryResultRow {
  id: number
  task_key: string
  weekday_mask: number
  window_start_minute: number
  window_end_minute: number
  interval_minutes: number
  paused: boolean
  notes: string | null
}

interface ScheduleRunRow extends QueryResultRow {
  task_key: string
  last_enqueued_at: Date | null
  last_enqueued_job_id: number | null
}

function rowToWindow(row: ScheduleRow): ConfigWorkerScheduleWindow {
  return {
    id: row.id,
    weekdayMask: row.weekday_mask,
    windowStartMinute: row.window_start_minute,
    windowEndMinute: row.window_end_minute,
    intervalMinutes: row.interval_minutes,
    paused: row.paused,
    notes: row.notes,
  }
}

export async function loadAllConfigSchedules(db: Queryable = getPool()): Promise<ConfigWorkerSchedule[]> {
  const [scheduleResult, runsResult] = await Promise.all([
    db.query<ScheduleRow>(
      `
        select id, task_key, weekday_mask, window_start_minute, window_end_minute,
               interval_minutes, paused, notes
        from config_worker_schedules
        order by task_key asc, window_start_minute asc, id asc
      `,
    ),
    db.query<ScheduleRunRow>(
      `
        select task_key, last_enqueued_at, last_enqueued_job_id
        from config_worker_schedule_runs
      `,
    ),
  ])

  const windowsByTaskKey = new Map<string, ConfigWorkerScheduleWindow[]>()
  for (const row of scheduleResult.rows) {
    const list = windowsByTaskKey.get(row.task_key) ?? []
    list.push(rowToWindow(row))
    windowsByTaskKey.set(row.task_key, list)
  }
  const runsByTaskKey = new Map<string, ScheduleRunRow>(runsResult.rows.map((row) => [row.task_key, row]))

  return CONFIG_BACKGROUND_TASKS.map((definition) => {
    const runRow = runsByTaskKey.get(definition.key) ?? null
    return {
      taskKey: definition.key,
      taskLabel: definition.label,
      taskSummary: definition.summary,
      implemented: definition.implemented,
      windows: windowsByTaskKey.get(definition.key) ?? [],
      lastEnqueuedAt: runRow?.last_enqueued_at ? runRow.last_enqueued_at.toISOString() : null,
      lastEnqueuedJobId: runRow?.last_enqueued_job_id ?? null,
    }
  })
}

export async function loadConfigSchedule(
  taskKey: ConfigBackgroundTaskKey,
  db: Queryable = getPool(),
): Promise<ConfigWorkerSchedule> {
  const all = await loadAllConfigSchedules(db)
  const matching = all.find((entry) => entry.taskKey === taskKey)
  if (!matching) {
    throw new Error(`Unknown config background task: ${taskKey}`)
  }
  return matching
}

/**
 * Replaces the entire window set for a task. Existing windows are deleted and
 * the requested set is reinserted in one transaction. Caller is expected to
 * already wrap this in `withTransaction` for atomicity with audit append.
 */
export async function replaceConfigScheduleWindows(
  db: Queryable,
  taskKey: ConfigBackgroundTaskKey,
  windows: ReadonlyArray<Omit<ConfigWorkerScheduleWindow, 'id'>>,
  updatedByUserId: number | null,
): Promise<void> {
  await db.query(`delete from config_worker_schedules where task_key = $1`, [taskKey])
  for (const window of windows) {
    await db.query(
      `
        insert into config_worker_schedules (
          task_key, weekday_mask, window_start_minute, window_end_minute,
          interval_minutes, paused, notes, updated_by_user_id
        ) values ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        taskKey,
        window.weekdayMask,
        window.windowStartMinute,
        window.windowEndMinute,
        window.intervalMinutes,
        window.paused,
        window.notes,
        updatedByUserId,
      ],
    )
  }
}

/**
 * Ensures every implemented task_key has at least one window persisted by
 * inserting the documented defaults the first time we see an empty schedule.
 * Operators can then edit the rows; we never overwrite an existing row.
 */
const DEFAULT_WINDOWS_BY_TASK_KEY: Partial<
  Record<ConfigBackgroundTaskKey, ReadonlyArray<Omit<ConfigWorkerScheduleWindow, 'id'>>>
> = {
  'workers.scheduling.stock': STOCK_DEFAULT_SCHEDULE_WINDOWS,
  'workers.scheduling.litalerts': LITALERTS_DEFAULT_SCHEDULE_WINDOWS,
  'workers.scheduling.litalerts_retailer_backfill': LITALERTS_RETAILER_BACKFILL_DEFAULT_SCHEDULE_WINDOWS,
  'workers.scheduling.litalerts_retailer_geo_refresh': LITALERTS_RETAILER_GEO_REFRESH_DEFAULT_SCHEDULE_WINDOWS,
  'workers.scheduling.litalerts_rolling': LITALERTS_ROLLING_DEFAULT_SCHEDULE_WINDOWS,
  'workers.scheduling.market_evidence_alarm': MARKET_EVIDENCE_ALARM_DEFAULT_SCHEDULE_WINDOWS,
  'workers.scheduling.catalog': CATALOG_DEFAULT_SCHEDULE_WINDOWS,
  'workers.scheduling.edible_thc_clamp': EDIBLE_THC_CLAMP_DEFAULT_SCHEDULE_WINDOWS,
  'workers.scheduling.sweed_orders_ingest': SWEED_ORDERS_INGEST_DEFAULT_SCHEDULE_WINDOWS,
  'workers.scheduling.sweed_package_snapshots': SWEED_PACKAGE_SNAPSHOTS_DEFAULT_SCHEDULE_WINDOWS,
  'workers.scheduling.sweed_purchases_ingest': SWEED_PURCHASES_INGEST_DEFAULT_SCHEDULE_WINDOWS,
  'workers.scheduling.weather_daily_ingest': WEATHER_DAILY_INGEST_DEFAULT_SCHEDULE_WINDOWS,
  'workers.scheduling.sweed_shifts_ingest': SWEED_SHIFTS_INGEST_DEFAULT_SCHEDULE_WINDOWS,
  'workers.scheduling.enrich_customer_address': ENRICH_CUSTOMER_ADDRESS_DEFAULT_SCHEDULE_WINDOWS,
  'workers.scheduling.enrich_delivery_address': ENRICH_DELIVERY_ADDRESS_DEFAULT_SCHEDULE_WINDOWS,
  'workers.scheduling.enrich_visitor_scan_address': ENRICH_VISITOR_SCAN_ADDRESS_DEFAULT_SCHEDULE_WINDOWS,
  'workers.scheduling.sweed_orders_raw_json_drain': SWEED_ORDERS_RAW_JSON_DRAIN_DEFAULT_SCHEDULE_WINDOWS,
  'workers.scheduling.litalerts_products_raw_json_drain': LITALERTS_PRODUCTS_RAW_JSON_DRAIN_DEFAULT_SCHEDULE_WINDOWS,
  'workers.scheduling.fuzzy_skus_retention': FUZZY_SKUS_RETENTION_DEFAULT_SCHEDULE_WINDOWS,
  'workers.scheduling.stock_snapshot_items_retention': STOCK_SNAPSHOT_ITEMS_RETENTION_DEFAULT_SCHEDULE_WINDOWS,
  'workers.scheduling.gads_lp_rollup_refresh': GADS_LP_ROLLUP_REFRESH_DEFAULT_SCHEDULE_WINDOWS,
  'workers.scheduling.faq_hybrid_sync': FAQ_HYBRID_SYNC_DEFAULT_SCHEDULE_WINDOWS,
  'workers.scheduling.inventory_lifecycle_advance': INVENTORY_LIFECYCLE_ADVANCE_DEFAULT_SCHEDULE_WINDOWS,
}

export async function ensureDefaultConfigSchedules(db: Queryable = getPool()): Promise<void> {
  for (const definition of CONFIG_BACKGROUND_TASKS) {
    if (!definition.implemented) {
      continue
    }
    const defaults = DEFAULT_WINDOWS_BY_TASK_KEY[definition.key]
    if (!defaults || defaults.length === 0) {
      continue
    }
    const result = await db.query<{ count: string }>(
      `select count(*)::text as count from config_worker_schedules where task_key = $1`,
      [definition.key],
    )
    const count = Number(result.rows[0]?.count ?? '0')
    if (count > 0) {
      continue
    }
    for (const window of defaults) {
      await db.query(
        `
          insert into config_worker_schedules (
            task_key, weekday_mask, window_start_minute, window_end_minute,
            interval_minutes, paused, notes
          ) values ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          definition.key,
          window.weekdayMask,
          window.windowStartMinute,
          window.windowEndMinute,
          window.intervalMinutes,
          window.paused,
          window.notes,
        ],
      )
    }
  }
}

export async function recordConfigScheduleEnqueue(
  db: Queryable,
  taskKey: ConfigBackgroundTaskKey,
  jobId: number | null,
  enqueuedAt: Date,
): Promise<void> {
  await db.query(
    `
      insert into config_worker_schedule_runs (task_key, last_enqueued_at, last_enqueued_job_id)
      values ($1, $2, $3)
      on conflict (task_key) do update
        set last_enqueued_at = excluded.last_enqueued_at,
            last_enqueued_job_id = excluded.last_enqueued_job_id
    `,
    [taskKey, enqueuedAt, jobId],
  )
  // No-op typed access to keep the helper used.
  void getConfigBackgroundTaskDefinition(taskKey)
}

export interface RecentSnapshotRow {
  id: number
  siteDealerId: number
  siteKey: string
  siteLabel: string
  status: 'running' | 'succeeded' | 'failed'
  startedAt: string
  finishedAt: string | null
  variantCount: number | null
  inStockVariantCount: number | null
  newlyInStockVariantCount: number | null
  newlyOutOfStockVariantCount: number | null
  litalertsRefreshEnqueuedCount: number | null
  jobId: number | null
  error: string | null
}

interface SnapshotDbRow extends QueryResultRow {
  id: number
  site_dealer_id: number
  site_key: string
  site_label: string
  status: 'running' | 'succeeded' | 'failed'
  started_at: Date
  finished_at: Date | null
  variant_count: number | null
  in_stock_variant_count: number | null
  newly_in_stock_variant_count: number | null
  newly_out_of_stock_variant_count: number | null
  litalerts_refresh_enqueued_count: number | null
  job_id: number | null
  error: string | null
}

export async function loadRecentStockSnapshots(
  limit: number,
  db: Queryable = getPool(),
): Promise<RecentSnapshotRow[]> {
  const result = await db.query<SnapshotDbRow>(
    `
      select id, site_dealer_id, site_key, site_label, status, started_at, finished_at,
             variant_count, in_stock_variant_count, newly_in_stock_variant_count,
             newly_out_of_stock_variant_count, litalerts_refresh_enqueued_count,
             job_id, error
      from stock_snapshots
      order by started_at desc, id desc
      limit $1
    `,
    [limit],
  )
  return result.rows.map((row) => ({
    id: row.id,
    siteDealerId: row.site_dealer_id,
    siteKey: row.site_key,
    siteLabel: row.site_label,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    variantCount: row.variant_count,
    inStockVariantCount: row.in_stock_variant_count,
    newlyInStockVariantCount: row.newly_in_stock_variant_count,
    newlyOutOfStockVariantCount: row.newly_out_of_stock_variant_count,
    litalertsRefreshEnqueuedCount: row.litalerts_refresh_enqueued_count,
    jobId: row.job_id,
    error: row.error,
  }))
}

export interface PendingLitalertsRefreshRow {
  id: number
  productId: number
  siteDealerId: number | null
  reason: 'variant_in_stock_transition' | 'manual' | 'daily_full_sweep'
  sourceSnapshotId: number | null
  enqueuedAt: string
  notes: string | null
}

interface PendingLitalertsRefreshDbRow extends QueryResultRow {
  id: number
  product_id: number
  site_dealer_id: number | null
  reason: 'variant_in_stock_transition' | 'manual' | 'daily_full_sweep'
  source_snapshot_id: number | null
  enqueued_at: Date
  notes: string | null
}

export async function loadPendingLitalertsRefreshRows(
  limit: number,
  db: Queryable = getPool(),
): Promise<PendingLitalertsRefreshRow[]> {
  const result = await db.query<PendingLitalertsRefreshDbRow>(
    `
      select id, product_id, site_dealer_id, reason, source_snapshot_id,
             enqueued_at, notes
      from pending_litalerts_refresh_queue
      where status = 'pending'
      order by enqueued_at asc, id asc
      limit $1
    `,
    [limit],
  )
  return result.rows.map((row) => ({
    id: row.id,
    productId: row.product_id,
    siteDealerId: row.site_dealer_id,
    reason: row.reason,
    sourceSnapshotId: row.source_snapshot_id,
    enqueuedAt: row.enqueued_at.toISOString(),
    notes: row.notes,
  }))
}

export interface RecentLitalertsObservationRow {
  id: number
  queueRowId: number | null
  productId: number
  siteDealerId: number | null
  sourceSnapshotId: number | null
  jobId: number | null
  status: 'succeeded' | 'failed'
  brandId: number | null
  brandName: string | null
  groupId: number | null
  groupName: string | null
  categoryName: string | null
  searchTermLabel: string | null
  availability: string | null
  listingCount: number
  pricingEligibleListingCount: number
  nearListingCount: number
  midListingCount: number
  farListingCount: number
  notes: string | null
  error: string | null
  capturedAt: string
}

interface RecentLitalertsObservationDbRow extends QueryResultRow {
  id: number
  queue_row_id: number | null
  product_id: number
  site_dealer_id: number | null
  source_snapshot_id: number | null
  job_id: number | null
  status: 'succeeded' | 'failed'
  brand_id: number | null
  brand_name: string | null
  group_id: number | null
  group_name: string | null
  category_name: string | null
  search_term_label: string | null
  availability: string | null
  listing_count: number
  pricing_eligible_listing_count: number
  near_listing_count: number
  mid_listing_count: number
  far_listing_count: number
  notes: string | null
  error: string | null
  captured_at: Date
}

export async function loadRecentLitalertsObservations(
  limit: number,
  db: Queryable = getPool(),
): Promise<RecentLitalertsObservationRow[]> {
  const result = await db.query<RecentLitalertsObservationDbRow>(
    `
      select id, queue_row_id, product_id, site_dealer_id, source_snapshot_id, job_id,
             status, brand_id, brand_name, group_id, group_name, category_name,
             search_term_label, availability, listing_count, pricing_eligible_listing_count,
             near_listing_count, mid_listing_count, far_listing_count, notes, error,
             captured_at
      from litalerts_competitor_observations
      order by captured_at desc, id desc
      limit $1
    `,
    [limit],
  )
  return result.rows.map((row) => ({
    id: row.id,
    queueRowId: row.queue_row_id,
    productId: row.product_id,
    siteDealerId: row.site_dealer_id,
    sourceSnapshotId: row.source_snapshot_id,
    jobId: row.job_id,
    status: row.status,
    brandId: row.brand_id,
    brandName: row.brand_name,
    groupId: row.group_id,
    groupName: row.group_name,
    categoryName: row.category_name,
    searchTermLabel: row.search_term_label,
    availability: row.availability,
    listingCount: row.listing_count,
    pricingEligibleListingCount: row.pricing_eligible_listing_count,
    nearListingCount: row.near_listing_count,
    midListingCount: row.mid_listing_count,
    farListingCount: row.far_listing_count,
    notes: row.notes,
    error: row.error,
    capturedAt: row.captured_at.toISOString(),
  }))
}

export async function countPendingLitalertsRefreshRows(db: Queryable = getPool()): Promise<number> {
  const result = await db.query<{ count: string }>(
    `select count(*)::text as count from pending_litalerts_refresh_queue where status = 'pending'`,
  )
  return Number(result.rows[0]?.count ?? '0')
}

export type PricingEvidenceFreshness = 'fresh' | 'stale' | 'very_stale' | 'expired' | 'absent'
export type PricingEvidenceAlarmClass = 'in_stock' | 'pending_purchase' | 'brand_match'

export interface PricingEvidenceFreshnessRow {
  catalogGroupId: number
  productId: number
  brandName: string | null
  productName: string | null
  productTab: string | null
  livePrice: string | null
  latestObservationId: number | null
  capturedAt: string | null
  expiresAt: string | null
  ageDays: number | null
  freshness: PricingEvidenceFreshness
  listingCount: number
  pricingEligibleListingCount: number
  isInStock: boolean
  isInPendingPurchase: boolean
  isBrandOfPendingPurchase: boolean
  alarmClass: PricingEvidenceAlarmClass | null
}

interface PricingEvidenceFreshnessDbRow extends QueryResultRow {
  catalog_group_id: string | number
  product_id: string | number
  brand_name: string | null
  product_name: string | null
  product_tab: string | null
  live_price: string | null
  latest_observation_id: string | number | null
  captured_at: Date | null
  expires_at: Date | null
  age_days: string | null
  freshness: PricingEvidenceFreshness
  listing_count: number
  pricing_eligible_listing_count: number
  is_in_stock: boolean
  is_in_pending_purchase: boolean
  is_brand_of_pending_purchase: boolean
  alarm_class: PricingEvidenceAlarmClass | null
}

export async function getPricingEvidenceFreshness(
  db: Queryable,
  productIds: readonly number[],
): Promise<PricingEvidenceFreshnessRow[]> {
  if (productIds.length === 0) {
    return []
  }
  const result = await db.query<PricingEvidenceFreshnessDbRow>(
    `
      select catalog_group_id, product_id, brand_name, product_name, product_tab,
             live_price, latest_observation_id, captured_at, expires_at, age_days,
             freshness, listing_count, pricing_eligible_listing_count,
             is_in_stock, is_in_pending_purchase, is_brand_of_pending_purchase,
             alarm_class
        from vw_pricing_evidence_freshness
       where product_id = any($1::bigint[])
    `,
    [productIds],
  )
  return result.rows.map((row) => ({
    catalogGroupId: Number(row.catalog_group_id),
    productId: Number(row.product_id),
    brandName: row.brand_name,
    productName: row.product_name,
    productTab: row.product_tab,
    livePrice: row.live_price,
    latestObservationId: row.latest_observation_id === null ? null : Number(row.latest_observation_id),
    capturedAt: row.captured_at ? row.captured_at.toISOString() : null,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    ageDays: row.age_days === null ? null : Number(row.age_days),
    freshness: row.freshness,
    listingCount: row.listing_count,
    pricingEligibleListingCount: row.pricing_eligible_listing_count,
    isInStock: row.is_in_stock,
    isInPendingPurchase: row.is_in_pending_purchase,
    isBrandOfPendingPurchase: row.is_brand_of_pending_purchase,
    alarmClass: row.alarm_class,
  }))
}

export interface RecentCatalogTaxonomySnapshotRow {
  id: number
  stateDealerId: number
  jobId: number | null
  status: 'running' | 'succeeded' | 'failed'
  trigger: string
  startedAt: string
  finishedAt: string | null
  productCount: number | null
  groupCount: number | null
  categoryCount: number | null
  strainCount: number | null
  prevalenceCount: number | null
  sizeCount: number | null
  distributorCount: number | null
  brandCount: number | null
  subcategoryCount: number | null
  error: string | null
}

interface CatalogTaxonomySnapshotDbRow extends QueryResultRow {
  id: number
  state_dealer_id: number
  job_id: number | null
  status: 'running' | 'succeeded' | 'failed'
  trigger: string
  started_at: Date
  finished_at: Date | null
  product_count: number | null
  group_count: number | null
  category_count: number | null
  strain_count: number | null
  prevalence_count: number | null
  size_count: number | null
  distributor_count: number | null
  brand_count: number | null
  subcategory_count: number | null
  error: string | null
}

export async function loadRecentCatalogTaxonomySnapshots(
  limit: number,
  db: Queryable = getPool(),
): Promise<RecentCatalogTaxonomySnapshotRow[]> {
  const result = await db.query<CatalogTaxonomySnapshotDbRow>(
    `
      select id, state_dealer_id, job_id, status, trigger, started_at, finished_at,
             product_count, group_count, category_count, strain_count, prevalence_count,
             size_count, distributor_count, brand_count, subcategory_count, error
      from catalog_taxonomy_snapshots
      order by started_at desc, id desc
      limit $1
    `,
    [limit],
  )
  return result.rows.map((row) => ({
    id: row.id,
    stateDealerId: row.state_dealer_id,
    jobId: row.job_id,
    status: row.status,
    trigger: row.trigger,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    productCount: row.product_count,
    groupCount: row.group_count,
    categoryCount: row.category_count,
    strainCount: row.strain_count,
    prevalenceCount: row.prevalence_count,
    sizeCount: row.size_count,
    distributorCount: row.distributor_count,
    brandCount: row.brand_count,
    subcategoryCount: row.subcategory_count,
    error: row.error,
  }))
}

interface SweedOrdersIngestDealerRow extends QueryResultRow {
  dealer_id: number | string
  highwater_pay_time: Date
  min_pay_time: Date
  backfill_cursor_day: Date | null
  last_polled_at: Date
  last_seen_count: number
  last_inserted_count: number
  consecutive_empty_polls: number
  notes: string | null
  order_row_count: number | string
  earliest_pay_time: Date | null
  latest_pay_time: Date | null
}

/**
 * Per-dealer Sweed orders ingest status: joins sweed_orders_ingest_highwater
 * with sweed_orders to surface (a) the per-dealer cursor + last-poll counters
 * the worker maintains and (b) the row-count / earliest-pay-time / latest-pay-time
 * sanity checks an operator needs to confirm the ingest is healthy.
 *
 * Site labels (Bronx, Midtown) are decorated from HELIOS_PENDING_PURCHASE_SITE_DEALERS
 * so the operator sees a friendly name without an extra DB hop.
 */
export async function loadSweedOrdersIngestDealerStatus(
  db: Queryable = getPool(),
): Promise<SweedOrdersIngestDealerStatus[]> {
  const result = await db.query<SweedOrdersIngestDealerRow>(
    `
      select hw.dealer_id,
             hw.highwater_pay_time,
             hw.min_pay_time,
             hw.backfill_cursor_day,
             hw.last_polled_at,
             hw.last_seen_count,
             hw.last_inserted_count,
             hw.consecutive_empty_polls,
             hw.notes,
             coalesce(orders.order_row_count, 0) as order_row_count,
             orders.earliest_pay_time,
             orders.latest_pay_time
      from sweed_orders_ingest_highwater hw
      left join (
        select dealer_id,
               count(*)::bigint as order_row_count,
               min(pay_time) as earliest_pay_time,
               max(pay_time) as latest_pay_time
          from sweed_orders
         group by dealer_id
      ) orders on orders.dealer_id = hw.dealer_id
      order by hw.dealer_id
    `,
  )
  return result.rows.map((row) => {
    const dealerId = Number(row.dealer_id)
    const site = HELIOS_PENDING_PURCHASE_SITE_DEALERS.find((entry) => entry.dealerId === dealerId) ?? null
    return {
      dealerId,
      siteKey: site?.siteKey ?? null,
      siteLabel: site?.siteLabel ?? null,
      highwaterPayTime: row.highwater_pay_time.toISOString(),
      minPayTime: row.min_pay_time.toISOString(),
      backfillCursorDay: row.backfill_cursor_day ? row.backfill_cursor_day.toISOString() : null,
      lastPolledAt: row.last_polled_at.toISOString(),
      lastSeenCount: row.last_seen_count,
      lastInsertedCount: row.last_inserted_count,
      consecutiveEmptyPolls: row.consecutive_empty_polls,
      notes: row.notes,
      orderRowCount: Number(row.order_row_count),
      earliestOrderPayTime: row.earliest_pay_time ? row.earliest_pay_time.toISOString() : null,
      latestOrderPayTime: row.latest_pay_time ? row.latest_pay_time.toISOString() : null,
    }
  })
}

interface SweedOrdersIngestRunDbRow extends QueryResultRow {
  id: number | string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'dead_letter'
  run_at: Date
  started_at: Date | null
  finished_at: Date | null
  attempt_count: number
  payload_json: { trigger?: string | null } | null
  last_error: string | null
}

/**
 * Most-recent N runs of the Sweed orders ingest worker, newest first.
 * Used by the operator detail page to show ingest health at a glance.
 */
export async function loadRecentSweedOrdersIngestRuns(
  limit: number,
  db: Queryable = getPool(),
): Promise<RecentSweedOrdersIngestRun[]> {
  const result = await db.query<SweedOrdersIngestRunDbRow>(
    `
      select id, status, run_at, started_at, finished_at, attempt_count,
             payload_json, last_error
        from job_queue
       where job_type = 'config.workers.sweed_orders_ingest'
       order by id desc
       limit $1
    `,
    [limit],
  )
  return result.rows.map((row) => ({
    jobId: Number(row.id),
    status: row.status,
    runAt: row.run_at.toISOString(),
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    attemptCount: row.attempt_count,
    trigger: typeof row.payload_json?.trigger === 'string' ? row.payload_json.trigger : null,
    error: row.last_error,
  }))
}
