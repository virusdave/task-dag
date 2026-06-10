import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type ConfigBackgroundTaskKey,
  type ConfigWorkerSchedule,
  type ConfigWorkerScheduleWindow,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import { getPool } from '../../server/db/pool.js'
import {
  ensureDefaultConfigSchedules,
  loadAllConfigSchedules,
  loadPendingLitalertsRefreshRows,
  recordConfigScheduleEnqueue,
} from '../../server/db/queries/configQueries.js'
import { getOptionalSweedSessionConcurrencyKey } from '../../server/jobs/concurrency.js'
import {
  enqueueJob,
  enqueueJobs,
  JOB_PRIORITY_BACKFILL,
  JOB_PRIORITY_BEST_EFFORT,
  JOB_PRIORITY_SCHEDULED_INGEST,
} from '../../server/jobs/enqueueJob.js'
import {
  enqueueMarketRefreshForProducts,
  rollingRefreshJitterSecondsForProduct,
} from '../litalerts/enqueueMarketRefresh.js'

const LITALERTS_DRAIN_BATCH_SIZE = 50
const LITALERTS_ROLLING_BATCH_SIZE = 100

// In-process TTL for the loadAllConfigSchedules cache. Schedules
// change only when an operator edits them in the Config UI, so a
// 60s lag before a new cadence kicks in is well within the
// operator's expectations. Without this cache the main worker loop
// fires two SELECTs against config_worker_schedules{,_runs} every
// 3 seconds (~57,600 redundant reads/day per worker process) — one
// of the larger contributors to baseline TigerData compute cost
// before this change.
const SCHEDULES_CACHE_TTL_MS = 60_000

interface SchedulerStateEntry {
  defaultsEnsured: boolean
  schedulesCache: ConfigWorkerSchedule[] | null
  schedulesCacheLoadedAtMs: number
}

const state: SchedulerStateEntry = {
  defaultsEnsured: false,
  schedulesCache: null,
  schedulesCacheLoadedAtMs: 0,
}

/**
 * Test-only helper: drop the in-process schedule cache so a unit
 * test can force the next tick to re-read from the DB. Not exported
 * via the package entrypoint; only the scheduler tests reach in.
 */
export function __resetSchedulerCacheForTests(): void {
  state.defaultsEnsured = false
  state.schedulesCache = null
  state.schedulesCacheLoadedAtMs = 0
}

async function loadSchedulesCached(now: Date): Promise<ConfigWorkerSchedule[]> {
  const nowMs = now.getTime()
  if (
    state.schedulesCache !== null
    && nowMs - state.schedulesCacheLoadedAtMs < SCHEDULES_CACHE_TTL_MS
  ) {
    return state.schedulesCache
  }
  const fresh = await loadAllConfigSchedules()
  state.schedulesCache = fresh
  state.schedulesCacheLoadedAtMs = nowMs
  return fresh
}

/**
 * Patch the cached schedule's `lastEnqueuedAt` to `now` so the next
 * cached tick honours the interval bucket immediately, without
 * waiting for the cache TTL to expire and re-read it from the DB.
 * Called after every successful `recordConfigScheduleEnqueue` write.
 */
function markScheduleEnqueuedInCache(taskKey: ConfigBackgroundTaskKey, now: Date): void {
  const cache = state.schedulesCache
  if (cache === null) return
  for (const schedule of cache) {
    if (schedule.taskKey === taskKey) {
      schedule.lastEnqueuedAt = now.toISOString()
      return
    }
  }
}

/**
 * Wrapper around `recordConfigScheduleEnqueue` that ALSO keeps the
 * in-process schedule cache fresh. Every call site in this file
 * uses this wrapper instead of the raw DB-write so that the cached
 * tick path never double-fires a schedule it just enqueued.
 *
 * Signature mirrors `recordConfigScheduleEnqueue` exactly so the
 * existing call sites only need a name swap.
 */
async function recordEnqueueAndPatchCache(
  db: Parameters<typeof recordConfigScheduleEnqueue>[0],
  taskKey: ConfigBackgroundTaskKey,
  jobId: number | null,
  now: Date,
): Promise<void> {
  await recordConfigScheduleEnqueue(db, taskKey, jobId, now)
  markScheduleEnqueuedInCache(taskKey, now)
}

/**
 * Idempotent recurring scheduler tick. Called from the worker loop. For each
 * implemented background task, decides whether the current wall-clock minute
 * lands inside any active window AND whether the configured interval has
 * elapsed since the last successful enqueue. When both conditions hold, an
 * idempotent dedupe-keyed job is queued.
 *
 * To keep TigerData baseline compute cost flat across the 3-second
 * worker poll loop, schedules are cached in process memory for
 * `SCHEDULES_CACHE_TTL_MS` (see the comment on that constant); the
 * cache is also patched in-place after every enqueue so the
 * interval-bucket logic always sees the just-recorded
 * `lastEnqueuedAt`.
 */
export async function tickConfigWorkersScheduler(now: Date = new Date()): Promise<void> {
  if (!state.defaultsEnsured) {
    await ensureDefaultConfigSchedules()
    state.defaultsEnsured = true
  }

  const schedules = await loadSchedulesCached(now)
  for (const schedule of schedules) {
    if (!schedule.implemented) {
      continue
    }
    const activeWindow = pickActiveWindow(schedule.windows, now)
    if (!activeWindow) {
      continue
    }
    const lastEnqueuedAtMs = schedule.lastEnqueuedAt ? Date.parse(schedule.lastEnqueuedAt) : null
    const intervalMs = activeWindow.intervalMinutes * 60 * 1000
    if (lastEnqueuedAtMs !== null && now.getTime() - lastEnqueuedAtMs < intervalMs) {
      continue
    }

    // Per-task try/catch so one sick task (e.g. a transient unique-key
    // clash in the litalerts pending queue, observed in prod 2026-05-26)
    // can't short-circuit the entire scheduler tick and starve the
    // other tasks (sweed_orders_ingest, sweed_package_snapshots,
    // stock_refresh, …). Logging + continue matches the skip-and-
    // continue principle in AGENTS.md.
    try {
      if (schedule.taskKey === 'workers.scheduling.stock') {
        await enqueueScheduledStockRefresh(schedule.taskKey, now, activeWindow.intervalMinutes)
      } else if (schedule.taskKey === 'workers.scheduling.litalerts') {
        await enqueueScheduledLitalertsRefreshBatch(schedule.taskKey, now, activeWindow.intervalMinutes)
      } else if (schedule.taskKey === 'workers.scheduling.litalerts_rolling') {
        await runScheduledLitalertsRollingTick(schedule.taskKey, now)
      } else if (schedule.taskKey === 'workers.scheduling.market_evidence_alarm') {
        await runScheduledMarketEvidenceAlarmScanTick(schedule.taskKey, now)
      } else if (schedule.taskKey === 'workers.scheduling.catalog') {
        await enqueueScheduledCatalogRefresh(schedule.taskKey, now, activeWindow.intervalMinutes)
      } else if (schedule.taskKey === 'workers.scheduling.edible_thc_clamp') {
        await enqueueScheduledEdibleThcClamp(schedule.taskKey, now, activeWindow.intervalMinutes)
      } else if (schedule.taskKey === 'workers.scheduling.litalerts_retailer_backfill') {
        await enqueueScheduledLitalertsRetailerBackfill(schedule.taskKey, now, activeWindow.intervalMinutes)
      } else if (schedule.taskKey === 'workers.scheduling.sweed_orders_ingest') {
        await enqueueScheduledSweedOrdersIngest(schedule.taskKey, now, activeWindow.intervalMinutes)
      } else if (schedule.taskKey === 'workers.scheduling.sweed_package_snapshots') {
        await enqueueScheduledSweedPackageSnapshots(schedule.taskKey, now, activeWindow.intervalMinutes)
      } else if (schedule.taskKey === 'workers.scheduling.sweed_purchases_ingest') {
        await enqueueScheduledSweedPurchasesIngest(schedule.taskKey, now, activeWindow.intervalMinutes)
      } else if (schedule.taskKey === 'workers.scheduling.weather_daily_ingest') {
        await enqueueScheduledWeatherDailyIngest(schedule.taskKey, now, activeWindow.intervalMinutes)
      } else if (schedule.taskKey === 'workers.scheduling.sweed_shifts_ingest') {
        await enqueueScheduledSweedShiftsIngest(schedule.taskKey, now, activeWindow.intervalMinutes)
      } else if (schedule.taskKey === 'workers.scheduling.enrich_customer_address') {
        await enqueueScheduledEnrichCustomerAddress(schedule.taskKey, now, activeWindow.intervalMinutes)
      } else if (schedule.taskKey === 'workers.scheduling.enrich_delivery_address') {
        await enqueueScheduledEnrichDeliveryAddress(schedule.taskKey, now, activeWindow.intervalMinutes)
      } else if (schedule.taskKey === 'workers.scheduling.enrich_visitor_scan_address') {
        await enqueueScheduledEnrichVisitorScanAddress(schedule.taskKey, now, activeWindow.intervalMinutes)
      } else if (schedule.taskKey === 'workers.scheduling.sweed_orders_raw_json_drain') {
        await enqueueScheduledSweedOrdersRawJsonDrain(schedule.taskKey, now, activeWindow.intervalMinutes)
      } else if (schedule.taskKey === 'workers.scheduling.litalerts_products_raw_json_drain') {
        await enqueueScheduledLitalertsProductsRawJsonDrain(schedule.taskKey, now, activeWindow.intervalMinutes)
      } else if (schedule.taskKey === 'workers.scheduling.fuzzy_skus_retention') {
        await enqueueScheduledFuzzySkusRetention(schedule.taskKey, now, activeWindow.intervalMinutes)
      } else if (schedule.taskKey === 'workers.scheduling.stock_snapshot_items_retention') {
        await enqueueScheduledStockSnapshotItemsRetention(schedule.taskKey, now, activeWindow.intervalMinutes)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown scheduler-task error.'
      // eslint-disable-next-line no-console
      console.error(
        `[config-workers-scheduler] task ${schedule.taskKey} enqueue failed; continuing with next task: ${message}`,
      )
    }
  }
}

/**
 * Returns the most-specific (smallest interval) active window for `now` if
 * any. When two windows overlap (e.g. operator-edited bands), the window
 * with the smaller interval wins so the cadence does not silently widen.
 */
export function pickActiveWindow(
  windows: ConfigWorkerScheduleWindow[],
  now: Date,
): ConfigWorkerScheduleWindow | null {
  const candidates = windows.filter((window) => !window.paused && isWithinWindow(window, now))
  if (candidates.length === 0) {
    return null
  }
  return candidates.reduce((best, candidate) =>
    candidate.intervalMinutes < best.intervalMinutes ? candidate : best,
  )
}

/**
 * Checks if `now` falls inside a window that may wrap across midnight. When
 * the window wraps (start > end), the weekday mask is checked against the
 * window's start day, so an 08:00 -> 02:00 Mon window covers Tue 00:00..02:00
 * if Monday's bit is set.
 */
export function isWithinWindow(window: ConfigWorkerScheduleWindow, now: Date): boolean {
  const minuteOfDay = now.getHours() * 60 + now.getMinutes()
  const todayBit = 1 << now.getDay()
  const yesterdayBit = 1 << ((now.getDay() + 6) % 7)

  if (window.windowStartMinute <= window.windowEndMinute) {
    if ((window.weekdayMask & todayBit) === 0) {
      return false
    }
    return minuteOfDay >= window.windowStartMinute && minuteOfDay < window.windowEndMinute
  }

  // Wrapping window: [start, 1440) on start-day, then [0, end) on next day.
  const inLateBlockToday = minuteOfDay >= window.windowStartMinute && (window.weekdayMask & todayBit) !== 0
  const inEarlyBlockTomorrow = minuteOfDay < window.windowEndMinute && (window.weekdayMask & yesterdayBit) !== 0
  return inLateBlockToday || inEarlyBlockTomorrow
}

async function enqueueScheduledStockRefresh(
  taskKey: ConfigBackgroundTaskKey,
  now: Date,
  intervalMinutes: number,
): Promise<void> {
  const siteDealerIds = HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) => site.dealerId)
  // Bucket dedupe key by interval so two scheduler ticks during the same
  // minute do not double-enqueue, and so the dedupe key naturally rotates
  // when the interval window advances.
  const bucketMs = intervalMinutes * 60 * 1000
  const bucketStartMs = Math.floor(now.getTime() / bucketMs) * bucketMs
  const bucketIso = new Date(bucketStartMs).toISOString()

  await withTransaction(async (db) => {
    const jobId = await enqueueJob(db, {
      priority: JOB_PRIORITY_SCHEDULED_INGEST,
      concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
      dedupeKey: `config.workers.stock_refresh:scheduled:${bucketIso}`,
      jobType: 'config.workers.stock_refresh',
      module: 'config',
      payload: {
        siteDealerIds,
        trigger: 'scheduled',
      },
      requestedByUserId: null,
      runAt: now,
      scope: null,
    })

    await recordEnqueueAndPatchCache(db, taskKey, jobId, now)
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(jobId),
      entityType: 'job',
      eventType: 'config.workers.stock_refresh.requested',
      module: 'config',
      payload: {
        intervalMinutes,
        siteDealerIds,
        taskKey,
        trigger: 'scheduled',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}

async function enqueueScheduledLitalertsRefreshBatch(
  taskKey: ConfigBackgroundTaskKey,
  now: Date,
  intervalMinutes: number,
): Promise<void> {
  const pendingRows = await loadPendingLitalertsRefreshRows(LITALERTS_DRAIN_BATCH_SIZE)
  if (pendingRows.length === 0) {
    // Still record the tick so we honor the interval bucket and do not
    // re-scan the queue every poll when it is empty.
    await withTransaction(async (db) => {
      await recordEnqueueAndPatchCache(db, taskKey, null, now)
    })
    return
  }

  // ============================================================================
  // Phase A4 (virusdave/top-level#11): one transaction per batch
  // with a single bulk enqueueJobs() call, replacing the prior
  // per-row `for (const row of pendingRows) { await
  // withTransaction(...) { enqueueJob(...) } }` pattern. The old
  // path issued at least 3 round-trips per row (BEGIN, SELECT
  // existing-dedupe, INSERT job_queue, COMMIT) × N rows × every
  // scheduler tick — one of the heaviest per-tick contributors
  // to TigerData baseline write cost.
  //
  // The new path:
  //   - one BEGIN per batch
  //   - one SELECT against job_queue.dedupe_key (any-of-array)
  //     to satisfy the dedupe contract
  //   - one INSERT…SELECT FROM jsonb_to_recordset(...) RETURNING
  //     id, dedupe_key
  //   - one recordEnqueueAndPatchCache + one appendAuditEvent
  //   - one COMMIT
  // ============================================================================
  const enqueueJobInputs = pendingRows.map((row) => ({
    concurrencyKey: null,
    // One job per pending queue row keeps the dedupe surface obvious.
    dedupeKey: `config.workers.litalerts_refresh.variant:${row.id}`,
    jobType: 'config.workers.litalerts_refresh.variant' as const,
    module: 'config' as const,
    payload: {
      productId: row.productId,
      queueRowId: row.id,
      siteDealerId: row.siteDealerId,
      sourceSnapshotId: row.sourceSnapshotId,
      trigger: 'scheduled' as const,
    },
    priority: JOB_PRIORITY_BEST_EFFORT,
    requestedByUserId: null,
    runAt: now,
    scope: null,
  }))

  const enqueuedJobIds = await withTransaction(async (db) => {
    const jobIds = await enqueueJobs(db, enqueueJobInputs)
    const lastEnqueuedJobId = jobIds[jobIds.length - 1] ?? 0
    await recordEnqueueAndPatchCache(db, taskKey, lastEnqueuedJobId, now)
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: taskKey,
      entityType: 'job',
      eventType: 'config.workers.litalerts_refresh.requested',
      module: 'config',
      payload: {
        intervalMinutes,
        enqueuedJobIds: jobIds,
        queueRowIds: pendingRows.map((row) => row.id),
        taskKey,
        trigger: 'scheduled',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
    return jobIds
  })
  // enqueuedJobIds returned for potential future logging hooks;
  // intentionally unused at the call site so the linter sees the
  // value being consumed.
  void enqueuedJobIds
}

interface RollingRefreshCandidateRow {
  product_id: number
  latest_observation_id: number | null
  // captured_at carries through from the freshness view so the
  // post-pick UPDATE can target a single hypertable chunk by
  // `(id, captured_at)` instead of fanning out across every chunk
  // looking for an `id`-only match. See the C1 epic prep notes.
  latest_observation_captured_at: Date | null
  next_refresh_at: Date | null
}

/**
 * Scans the freshness view for products whose next_refresh_at has elapsed
 * (or who have never had an observation) and re-enqueues them through the
 * canonical enqueueMarketRefreshForProducts helper. Capped at
 * LITALERTS_ROLLING_BATCH_SIZE products per tick so a single tick cannot
 * stampede the partner API; the scheduler runs every few minutes so a few
 * thousand stale products will roll over within an hour.
 *
 * On success the corresponding latest_observation rows get their
 * next_refresh_at updated to base+24h+jitter so they do not show up in
 * the candidate scan again next tick.
 *
 * Source of truth is `vw_pricing_evidence_freshness`, which now surfaces
 * both `next_refresh_at` and `captured_at` directly — earlier versions
 * of this scheduler joined back to `litalerts_competitor_observations`
 * by `id` to read `next_refresh_at`, but with the upcoming C1
 * hypertable conversion of that table an `id`-only join would fan out
 * across every chunk. Reading both fields straight from the view
 * eliminates that lookup, and the corresponding UPDATE now targets a
 * single chunk via `(id, captured_at)`.
 */
async function runScheduledLitalertsRollingTick(
  taskKey: ConfigBackgroundTaskKey,
  now: Date,
): Promise<void> {
  const candidatesResult = await getPool().query<RollingRefreshCandidateRow>(
    `
      select distinct on (product_id)
        product_id,
        latest_observation_id,
        captured_at as latest_observation_captured_at,
        next_refresh_at
      from vw_pricing_evidence_freshness vw
      where vw.latest_observation_id is null
         or vw.next_refresh_at is null
         or vw.next_refresh_at <= now()
      order by product_id
      limit $1
    `,
    [LITALERTS_ROLLING_BATCH_SIZE],
  )

  if (candidatesResult.rows.length === 0) {
    // Record the tick anyway so the interval bucket honors its own cadence.
    await withTransaction(async (db) => {
      await recordEnqueueAndPatchCache(db, taskKey, null, now)
    })
    return
  }

  const productIds = candidatesResult.rows.map((row) => row.product_id)
  const enqueueResult = await enqueueMarketRefreshForProducts(productIds, {
    trigger: { kind: 'rolling' },
    runAt: now,
  })

  // For each product we successfully enqueued AND that had a latest
  // observation, push next_refresh_at out to base+24h+jitter so we do
  // not re-pick the same row on the very next tick.
  //
  // The UPDATE targets `(id, captured_at)` so the planner can chunk-
  // prune on the hypertable's partition column. The `captured_at`
  // value comes from the freshness view, which got it from the same
  // DISTINCT ON (product_id) row whose `id` we are updating, so they
  // always match a single row. Pre-hypertable-conversion this is
  // equivalent to `WHERE id = $1` (since `id` is the unique PK
  // today); post-conversion it lets the planner pick the right chunk
  // directly instead of fanning out across all of them.
  const baseMs = now.getTime() + 24 * 60 * 60 * 1000
  for (const row of candidatesResult.rows) {
    if (row.latest_observation_id === null || row.latest_observation_captured_at === null) {
      continue
    }
    const jitterSeconds = rollingRefreshJitterSecondsForProduct(row.product_id)
    const nextRefreshAt = new Date(baseMs + jitterSeconds * 1000)
    await getPool().query(
      `
        update litalerts_competitor_observations
           set next_refresh_at = $3
         where id = $1
           and captured_at = $2
      `,
      [row.latest_observation_id, row.latest_observation_captured_at, nextRefreshAt],
    )
  }

  await withTransaction(async (db) => {
    const lastJobId = enqueueResult.enqueuedJobIds[enqueueResult.enqueuedJobIds.length - 1] ?? null
    await recordEnqueueAndPatchCache(db, taskKey, lastJobId, now)
  })
}

/**
 * Enqueue a single `config.workers.market_evidence_alarm_scan` job per
 * scheduler tick. The scanner itself is cheap and idempotent — the
 * enqueue helper it calls dedupes per (productId, enqueue_reason) for
 * 5 minutes, so back-to-back ticks are safe. Dedupe key buckets per
 * scanner tick so two scheduler instances in the same minute do not
 * double-queue.
 */
async function runScheduledMarketEvidenceAlarmScanTick(
  taskKey: ConfigBackgroundTaskKey,
  now: Date,
): Promise<void> {
  const bucketIso = new Date(Math.floor(now.getTime() / 60000) * 60000).toISOString()
  await withTransaction(async (db) => {
    const jobId = await enqueueJob(db, {
      priority: JOB_PRIORITY_SCHEDULED_INGEST,
      concurrencyKey: null,
      dedupeKey: `config.workers.market_evidence_alarm_scan:scheduled:${bucketIso}`,
      jobType: 'config.workers.market_evidence_alarm_scan',
      module: 'config',
      payload: {
        trigger: 'scheduled',
        requestedByUserId: null,
      },
      requestedByUserId: null,
      runAt: now,
      scope: null,
    })
    await recordEnqueueAndPatchCache(db, taskKey, jobId, now)
  })
}

async function enqueueScheduledCatalogRefresh(
  taskKey: ConfigBackgroundTaskKey,
  now: Date,
  intervalMinutes: number,
): Promise<void> {
  const bucketMs = intervalMinutes * 60 * 1000
  const bucketStartMs = Math.floor(now.getTime() / bucketMs) * bucketMs
  const bucketIso = new Date(bucketStartMs).toISOString()

  await withTransaction(async (db) => {
    const jobId = await enqueueJob(db, {
      priority: JOB_PRIORITY_SCHEDULED_INGEST,
      concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
      dedupeKey: `config.workers.catalog_refresh:scheduled:${bucketIso}`,
      jobType: 'config.workers.catalog_refresh',
      module: 'config',
      payload: {
        trigger: 'scheduled',
      },
      requestedByUserId: null,
      runAt: now,
      scope: null,
    })

    await recordEnqueueAndPatchCache(db, taskKey, jobId, now)
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(jobId),
      entityType: 'job',
      eventType: 'config.workers.catalog_refresh.requested',
      module: 'config',
      payload: {
        intervalMinutes,
        taskKey,
        trigger: 'scheduled',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}

async function enqueueScheduledEdibleThcClamp(
  taskKey: ConfigBackgroundTaskKey,
  now: Date,
  intervalMinutes: number,
): Promise<void> {
  const siteDealerIds = HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) => site.dealerId)
  const bucketMs = intervalMinutes * 60 * 1000
  const bucketStartMs = Math.floor(now.getTime() / bucketMs) * bucketMs
  const bucketIso = new Date(bucketStartMs).toISOString()

  await withTransaction(async (db) => {
    const jobId = await enqueueJob(db, {
      priority: JOB_PRIORITY_SCHEDULED_INGEST,
      concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
      dedupeKey: `config.workers.edible_thc_clamp:scheduled:${bucketIso}`,
      jobType: 'config.workers.edible_thc_clamp',
      module: 'config',
      payload: {
        siteDealerIds,
        trigger: 'scheduled',
      },
      requestedByUserId: null,
      runAt: now,
      scope: null,
    })

    await recordEnqueueAndPatchCache(db, taskKey, jobId, now)
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(jobId),
      entityType: 'job',
      eventType: 'config.workers.edible_thc_clamp.requested',
      module: 'config',
      payload: {
        intervalMinutes,
        siteDealerIds,
        taskKey,
        trigger: 'scheduled',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}

// F5 (virusdave/top-level#11): enqueue the bounded sweed_orders.raw_json
// drain. System pool, no Sweed session. The dedicated concurrency key
// plus the per-bucket dedupe key keep at most one drain in flight even
// if a tick overlaps a still-running invocation.
async function enqueueScheduledSweedOrdersRawJsonDrain(
  taskKey: ConfigBackgroundTaskKey,
  now: Date,
  intervalMinutes: number,
): Promise<void> {
  const bucketMs = intervalMinutes * 60 * 1000
  const bucketStartMs = Math.floor(now.getTime() / bucketMs) * bucketMs
  const bucketIso = new Date(bucketStartMs).toISOString()

  await withTransaction(async (db) => {
    const jobId = await enqueueJob(db, {
      priority: JOB_PRIORITY_SCHEDULED_INGEST,
      concurrencyKey: 'config.workers.sweed_orders_raw_json_drain',
      dedupeKey: `config.workers.sweed_orders_raw_json_drain:scheduled:${bucketIso}`,
      jobType: 'config.workers.sweed_orders_raw_json_drain',
      module: 'config',
      payload: {
        trigger: 'scheduled',
      },
      requestedByUserId: null,
      runAt: now,
      scope: null,
    })

    await recordEnqueueAndPatchCache(db, taskKey, jobId, now)
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(jobId),
      entityType: 'job',
      eventType: 'config.workers.sweed_orders_raw_json_drain.requested',
      module: 'config',
      payload: {
        intervalMinutes,
        taskKey,
        trigger: 'scheduled',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}

// F3 (virusdave/top-level#11): enqueue the bounded litalerts_products
// raw_json drain. System pool, no Sweed session. The dedicated
// concurrency key plus the per-bucket dedupe key keep at most one drain
// in flight even if a tick overlaps a still-running invocation.
async function enqueueScheduledLitalertsProductsRawJsonDrain(
  taskKey: ConfigBackgroundTaskKey,
  now: Date,
  intervalMinutes: number,
): Promise<void> {
  const bucketMs = intervalMinutes * 60 * 1000
  const bucketStartMs = Math.floor(now.getTime() / bucketMs) * bucketMs
  const bucketIso = new Date(bucketStartMs).toISOString()

  await withTransaction(async (db) => {
    const jobId = await enqueueJob(db, {
      priority: JOB_PRIORITY_BEST_EFFORT,
      concurrencyKey: 'config.workers.litalerts_products_raw_json_drain',
      dedupeKey: `config.workers.litalerts_products_raw_json_drain:scheduled:${bucketIso}`,
      jobType: 'config.workers.litalerts_products_raw_json_drain',
      module: 'config',
      payload: {
        trigger: 'scheduled',
        // Accelerate convergence of the (multi-million-row) raw_*_json
        // backlog so the F3 column-drop follow-up isn't weeks away. We
        // raise throughput by doing MORE small batches, not bigger
        // ones: batchSize stays modest (1000, well under the 2000 cap)
        // so each FOR UPDATE SKIP LOCKED transaction keeps its lock /
        // WAL / connection-hold footprint tiny, and the per-batch
        // lock_timeout=2s + statement_timeout=10s + 100ms inter-batch
        // breather + 45s wall-clock ceiling + best-effort priority +
        // off-hours (02:00-08:00) window all still apply. Net effect:
        // ~8x throughput (~40k rows/tick) with no change to any live
        // serving safeguard. ~40 batches * (small update + breather)
        // completes well within the 45s invocation cap.
        batchSize: 1000,
        maxBatches: 40,
      },
      requestedByUserId: null,
      runAt: now,
      scope: null,
    })

    await recordEnqueueAndPatchCache(db, taskKey, jobId, now)
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(jobId),
      entityType: 'job',
      eventType: 'config.workers.litalerts_products_raw_json_drain.requested',
      module: 'config',
      payload: {
        intervalMinutes,
        taskKey,
        trigger: 'scheduled',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}

// F4 (virusdave/top-level#11): enqueue the bounded fuzzy_skus retention
// delete. System pool, no Sweed session. The dedicated concurrency key
// plus the per-bucket dedupe key keep at most one delete in flight even
// if a tick overlaps a still-running invocation.
async function enqueueScheduledFuzzySkusRetention(
  taskKey: ConfigBackgroundTaskKey,
  now: Date,
  intervalMinutes: number,
): Promise<void> {
  const bucketMs = intervalMinutes * 60 * 1000
  const bucketStartMs = Math.floor(now.getTime() / bucketMs) * bucketMs
  const bucketIso = new Date(bucketStartMs).toISOString()

  await withTransaction(async (db) => {
    const jobId = await enqueueJob(db, {
      priority: JOB_PRIORITY_BEST_EFFORT,
      concurrencyKey: 'config.workers.fuzzy_skus_retention',
      dedupeKey: `config.workers.fuzzy_skus_retention:scheduled:${bucketIso}`,
      jobType: 'config.workers.fuzzy_skus_retention',
      module: 'config',
      payload: {
        trigger: 'scheduled',
      },
      requestedByUserId: null,
      runAt: now,
      scope: null,
    })

    await recordEnqueueAndPatchCache(db, taskKey, jobId, now)
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(jobId),
      entityType: 'job',
      eventType: 'config.workers.fuzzy_skus_retention.requested',
      module: 'config',
      payload: {
        intervalMinutes,
        taskKey,
        trigger: 'scheduled',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}

// F6 (virusdave/top-level#11): enqueue the bounded stock_snapshot_items
// retention delete. System pool, no Sweed session. The dedicated
// concurrency key plus the per-bucket dedupe key keep at most one delete
// in flight even if a tick overlaps a still-running invocation.
async function enqueueScheduledStockSnapshotItemsRetention(
  taskKey: ConfigBackgroundTaskKey,
  now: Date,
  intervalMinutes: number,
): Promise<void> {
  const bucketMs = intervalMinutes * 60 * 1000
  const bucketStartMs = Math.floor(now.getTime() / bucketMs) * bucketMs
  const bucketIso = new Date(bucketStartMs).toISOString()

  await withTransaction(async (db) => {
    const jobId = await enqueueJob(db, {
      priority: JOB_PRIORITY_BEST_EFFORT,
      concurrencyKey: 'config.workers.stock_snapshot_items_retention',
      dedupeKey: `config.workers.stock_snapshot_items_retention:scheduled:${bucketIso}`,
      jobType: 'config.workers.stock_snapshot_items_retention',
      module: 'config',
      payload: {
        trigger: 'scheduled',
      },
      requestedByUserId: null,
      runAt: now,
      scope: null,
    })

    await recordEnqueueAndPatchCache(db, taskKey, jobId, now)
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(jobId),
      entityType: 'job',
      eventType: 'config.workers.stock_snapshot_items_retention.requested',
      module: 'config',
      payload: {
        intervalMinutes,
        taskKey,
        trigger: 'scheduled',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}

async function enqueueScheduledLitalertsRetailerBackfill(
  taskKey: ConfigBackgroundTaskKey,
  now: Date,
  intervalMinutes: number,
): Promise<void> {
  const bucketMs = intervalMinutes * 60 * 1000
  const bucketStartMs = Math.floor(now.getTime() / bucketMs) * bucketMs
  const bucketIso = new Date(bucketStartMs).toISOString()

  await withTransaction(async (db) => {
    const jobId = await enqueueJob(db, {
      // Backfill priority: see JOB_PRIORITY_BACKFILL doc. Sits 10
      // points above routine refresh / ingest batch jobs so the
      // per-tick backfill enqueue isn't starved behind a multi-hour
      // best-effort backlog.
      priority: JOB_PRIORITY_BACKFILL,
      // Does not touch Sweed; no shared session lane needed.
      concurrencyKey: null,
      dedupeKey: `config.workers.litalerts_retailer_backfill:scheduled:${bucketIso}`,
      jobType: 'config.workers.litalerts_retailer_backfill',
      module: 'config',
      payload: {
        trigger: 'scheduled',
      },
      requestedByUserId: null,
      runAt: now,
      scope: null,
    })

    await recordEnqueueAndPatchCache(db, taskKey, jobId, now)
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(jobId),
      entityType: 'job',
      eventType: 'config.workers.litalerts_retailer_backfill.requested',
      module: 'config',
      payload: {
        intervalMinutes,
        taskKey,
        trigger: 'scheduled',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}

async function enqueueScheduledSweedOrdersIngest(
  taskKey: ConfigBackgroundTaskKey,
  now: Date,
  intervalMinutes: number,
): Promise<void> {
  const siteDealerIds = HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) => site.dealerId)
  const bucketMs = intervalMinutes * 60 * 1000
  const bucketStartMs = Math.floor(now.getTime() / bucketMs) * bucketMs
  const bucketIso = new Date(bucketStartMs).toISOString()

  await withTransaction(async (db) => {
    const jobId = await enqueueJob(db, {
      priority: JOB_PRIORITY_SCHEDULED_INGEST,
      concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
      dedupeKey: `config.workers.sweed_orders_ingest:scheduled:${bucketIso}`,
      jobType: 'config.workers.sweed_orders_ingest',
      module: 'config',
      payload: {
        siteDealerIds,
        trigger: 'scheduled',
        // Each scheduler tick backfills this many historical days
        // per dealer. At 5-min tick cadence and ~1-2 s per
        // listSaleInvoices() call (with the pageSize=50 cap), 30
        // days/tick = ~360 days/hour, so Bronx (opens 2025-07-15,
        // ~315 days) finishes in ~1 h and Midtown (opens
        // 2026-04-01, ~55 days) finishes in well under one tick.
        // Each tick takes ~30-60 s of Sweed RPC time — still well
        // under any Sweed rate ceiling. Once both dealers report
        // `min_pay_time` at their opening dates, the worker stops
        // making historical RPCs and only polls forward.
        backfillDays: 30,
      },
      requestedByUserId: null,
      runAt: now,
      scope: null,
    })

    await recordEnqueueAndPatchCache(db, taskKey, jobId, now)
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(jobId),
      entityType: 'job',
      eventType: 'config.workers.sweed_orders_ingest.requested',
      module: 'config',
      payload: {
        intervalMinutes,
        siteDealerIds,
        taskKey,
        trigger: 'scheduled',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}

async function enqueueScheduledSweedPurchasesIngest(
  taskKey: ConfigBackgroundTaskKey,
  now: Date,
  intervalMinutes: number,
): Promise<void> {
  const siteDealerIds = HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) => site.dealerId)
  const bucketMs = intervalMinutes * 60 * 1000
  const bucketStartMs = Math.floor(now.getTime() / bucketMs) * bucketMs
  const bucketIso = new Date(bucketStartMs).toISOString()

  await withTransaction(async (db) => {
    const jobId = await enqueueJob(db, {
      priority: JOB_PRIORITY_SCHEDULED_INGEST,
      concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
      dedupeKey: `config.workers.sweed_purchases_ingest:scheduled:${bucketIso}`,
      jobType: 'config.workers.sweed_purchases_ingest',
      module: 'config',
      payload: {
        siteDealerIds,
        trigger: 'scheduled',
        // PO volume per day is small (10–30 POs/dealer/day); walking
        // a 30-day chunk per tick gets each dealer back to its
        // opening date inside a few hours without any noticeable
        // Sweed RPC pressure.
        backfillDays: 30,
      },
      requestedByUserId: null,
      runAt: now,
      scope: null,
    })
    await recordEnqueueAndPatchCache(db, taskKey, jobId, now)
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(jobId),
      entityType: 'job',
      eventType: 'config.workers.sweed_purchases_ingest.requested',
      module: 'config',
      payload: {
        intervalMinutes,
        siteDealerIds,
        taskKey,
        trigger: 'scheduled',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}

async function enqueueScheduledSweedPackageSnapshots(
  taskKey: ConfigBackgroundTaskKey,
  now: Date,
  intervalMinutes: number,
): Promise<void> {
  const siteDealerIds = HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) => site.dealerId)
  const bucketMs = intervalMinutes * 60 * 1000
  const bucketStartMs = Math.floor(now.getTime() / bucketMs) * bucketMs
  const bucketIso = new Date(bucketStartMs).toISOString()

  await withTransaction(async (db) => {
    const jobId = await enqueueJob(db, {
      priority: JOB_PRIORITY_SCHEDULED_INGEST,
      concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
      dedupeKey: `config.workers.sweed_package_snapshots:scheduled:${bucketIso}`,
      jobType: 'config.workers.sweed_package_snapshots',
      module: 'config',
      payload: {
        siteDealerIds,
        trigger: 'scheduled',
      },
      requestedByUserId: null,
      runAt: now,
      scope: null,
    })

    await recordEnqueueAndPatchCache(db, taskKey, jobId, now)
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(jobId),
      entityType: 'job',
      eventType: 'config.workers.sweed_package_snapshots.requested',
      module: 'config',
      payload: {
        intervalMinutes,
        siteDealerIds,
        taskKey,
        trigger: 'scheduled',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}

async function enqueueScheduledWeatherDailyIngest(
  taskKey: ConfigBackgroundTaskKey,
  now: Date,
  intervalMinutes: number,
): Promise<void> {
  // 1440-minute (24h) bucket keeps two scheduler ticks in the same
  // minute from double-enqueueing. The dedupe key only rotates when
  // the bucket advances, but per-tick the scheduler also enforces
  // the elapsed-interval check, so this is belt-and-suspenders.
  const bucketMs = intervalMinutes * 60 * 1000
  const bucketStartMs = Math.floor(now.getTime() / bucketMs) * bucketMs
  const bucketIso = new Date(bucketStartMs).toISOString()

  await withTransaction(async (db) => {
    const jobId = await enqueueJob(db, {
      priority: JOB_PRIORITY_SCHEDULED_INGEST,
      // Open-Meteo is an HTTPS GET to a public endpoint; no Sweed
      // session needed.
      concurrencyKey: null,
      dedupeKey: `config.workers.weather_daily_ingest:scheduled:${bucketIso}`,
      jobType: 'config.workers.weather_daily_ingest',
      module: 'config',
      payload: {
        trigger: 'scheduled',
      },
      requestedByUserId: null,
      runAt: now,
      scope: null,
    })

    await recordEnqueueAndPatchCache(db, taskKey, jobId, now)
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(jobId),
      entityType: 'job',
      eventType: 'config.workers.weather_daily_ingest.requested',
      module: 'config',
      payload: {
        intervalMinutes,
        taskKey,
        trigger: 'scheduled',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}

async function enqueueScheduledSweedShiftsIngest(
  taskKey: ConfigBackgroundTaskKey,
  now: Date,
  intervalMinutes: number,
): Promise<void> {
  const siteDealerIds = HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) => site.dealerId)
  const bucketMs = intervalMinutes * 60 * 1000
  const bucketStartMs = Math.floor(now.getTime() / bucketMs) * bucketMs
  const bucketIso = new Date(bucketStartMs).toISOString()

  await withTransaction(async (db) => {
    const jobId = await enqueueJob(db, {
      priority: JOB_PRIORITY_SCHEDULED_INGEST,
      concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
      dedupeKey: `config.workers.sweed_shifts_ingest:scheduled:${bucketIso}`,
      jobType: 'config.workers.sweed_shifts_ingest',
      module: 'config',
      payload: {
        siteDealerIds,
        trigger: 'scheduled',
        // Per-tick historical-day burst. At 15-min cadence and ~1 s
        // per listSaleShifts() call (page size 50 cap, far fewer
        // rows per dealer-day than invoices), 30 days/tick = ~2880
        // days/day across both dealers, so Bronx (opens 2025-07-15,
        // ~315 days) finishes its initial backfill in <1 day and
        // Midtown (opens 2026-04-01, ~55 days) in <1 tick. Once
        // both dealers' min_open_time is reached the worker only
        // polls forward.
        backfillDays: 30,
      },
      requestedByUserId: null,
      runAt: now,
      scope: null,
    })

    await recordEnqueueAndPatchCache(db, taskKey, jobId, now)
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(jobId),
      entityType: 'job',
      eventType: 'config.workers.sweed_shifts_ingest.requested',
      module: 'config',
      payload: {
        intervalMinutes,
        siteDealerIds,
        taskKey,
        trigger: 'scheduled',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}

async function enqueueScheduledEnrichCustomerAddress(
  taskKey: ConfigBackgroundTaskKey,
  now: Date,
  intervalMinutes: number,
): Promise<void> {
  const siteDealerIds = HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) => site.dealerId)
  const bucketMs = intervalMinutes * 60 * 1000
  const bucketStartMs = Math.floor(now.getTime() / bucketMs) * bucketMs
  const bucketIso = new Date(bucketStartMs).toISOString()

  await withTransaction(async (db) => {
    const jobId = await enqueueJob(db, {
      // Backfill priority: see JOB_PRIORITY_BACKFILL doc. Sits 10
      // points above routine refresh / ingest batch jobs so the
      // per-tick enrichment enqueue isn't starved behind the
      // sweed-pool's multi-hour best-effort backlog (catalog_refresh,
      // stock_refresh, sweed_package_snapshots, etc).
      priority: JOB_PRIORITY_BACKFILL,
      concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
      dedupeKey: `config.workers.enrich_customer_address:scheduled:${bucketIso}`,
      jobType: 'config.workers.enrich_customer_address',
      module: 'config',
      payload: {
        siteDealerIds,
        trigger: 'scheduled',
        // 60 store.customer.get RPCs/tick * 12 ticks/h = ~720
        // customers/h per dealer. The trailing-90-day non-guest
        // customer counts on the two operating sites are well
        // under 24h of catch-up at that rate.
        batchSize: 60,
      },
      requestedByUserId: null,
      runAt: now,
      scope: null,
    })

    await recordEnqueueAndPatchCache(db, taskKey, jobId, now)
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(jobId),
      entityType: 'job',
      eventType: 'config.workers.enrich_customer_address.requested',
      module: 'config',
      payload: {
        intervalMinutes,
        siteDealerIds,
        taskKey,
        trigger: 'scheduled',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}

async function enqueueScheduledEnrichDeliveryAddress(
  taskKey: ConfigBackgroundTaskKey,
  now: Date,
  intervalMinutes: number,
): Promise<void> {
  // Bucket dedupe by interval so two scheduler ticks in the same
  // minute don't double-enqueue, matching the sibling weather /
  // sweed_shifts / sweed_orders patterns.
  const bucketMs = intervalMinutes * 60 * 1000
  const bucketStartMs = Math.floor(now.getTime() / bucketMs) * bucketMs
  const bucketIso = new Date(bucketStartMs).toISOString()

  await withTransaction(async (db) => {
    const jobId = await enqueueJob(db, {
      // Backfill priority: see JOB_PRIORITY_BACKFILL doc. Sits 10
      // points above routine refresh / ingest batch jobs so the
      // per-tick enrichment enqueue isn't starved behind the
      // sweed-pool's multi-hour best-effort backlog (catalog_refresh,
      // stock_refresh, sweed_package_snapshots, etc).
      priority: JOB_PRIORITY_BACKFILL,
      concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
      dedupeKey: `config.workers.enrich_delivery_address:scheduled:${bucketIso}`,
      jobType: 'config.workers.enrich_delivery_address',
      module: 'config',
      payload: {
        trigger: 'scheduled',
        batchSize: 60,
      },
      requestedByUserId: null,
      runAt: now,
      scope: null,
    })

    await recordEnqueueAndPatchCache(db, taskKey, jobId, now)
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(jobId),
      entityType: 'job',
      eventType: 'config.workers.enrich_delivery_address.requested',
      module: 'config',
      payload: {
        intervalMinutes,
        taskKey,
        trigger: 'scheduled',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}

/**
 * Per-tick enqueue for the visitor-scan address-enrichment worker.
 * Backfill-priority dedupe-keyed by interval bucket so a paused
 * tick that catches up doesn't double-fire.
 */
async function enqueueScheduledEnrichVisitorScanAddress(
  taskKey: ConfigBackgroundTaskKey,
  now: Date,
  intervalMinutes: number,
): Promise<void> {
  const bucketMs = intervalMinutes * 60 * 1000
  const bucketStartMs = Math.floor(now.getTime() / bucketMs) * bucketMs
  const bucketIso = new Date(bucketStartMs).toISOString()

  await withTransaction(async (db) => {
    const jobId = await enqueueJob(db, {
      priority: JOB_PRIORITY_BACKFILL,
      // No Sweed RPC — no concurrency-key needed.
      concurrencyKey: null,
      dedupeKey: `config.workers.enrich_visitor_scan_address:scheduled:${bucketIso}`,
      jobType: 'config.workers.enrich_visitor_scan_address',
      module: 'config',
      payload: {
        trigger: 'scheduled',
        batchSize: 5000,
      },
      requestedByUserId: null,
      runAt: now,
      scope: null,
    })

    await recordEnqueueAndPatchCache(db, taskKey, jobId, now)
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(jobId),
      entityType: 'job',
      eventType: 'config.workers.enrich_visitor_scan_address.requested',
      module: 'config',
      payload: {
        intervalMinutes,
        taskKey,
        trigger: 'scheduled',
        batchSize: 5000,
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}
