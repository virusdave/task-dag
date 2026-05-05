import type { QueryResultRow } from 'pg'

import {
  CONFIG_BACKGROUND_TASKS,
  LITALERTS_DEFAULT_SCHEDULE_WINDOWS,
  STOCK_DEFAULT_SCHEDULE_WINDOWS,
  getConfigBackgroundTaskDefinition,
  type ConfigBackgroundTaskKey,
  type ConfigWorkerSchedule,
  type ConfigWorkerScheduleWindow,
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
