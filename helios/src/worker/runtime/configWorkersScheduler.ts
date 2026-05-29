import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type ConfigBackgroundTaskKey,
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
import { enqueueJob, JOB_PRIORITY_BACKFILL, JOB_PRIORITY_BEST_EFFORT } from '../../server/jobs/enqueueJob.js'
import {
  enqueueMarketRefreshForProducts,
  rollingRefreshJitterSecondsForProduct,
} from '../litalerts/enqueueMarketRefresh.js'

const LITALERTS_DRAIN_BATCH_SIZE = 50
const LITALERTS_ROLLING_BATCH_SIZE = 100

interface SchedulerStateEntry {
  defaultsEnsured: boolean
}

const state: SchedulerStateEntry = {
  defaultsEnsured: false,
}

/**
 * Idempotent recurring scheduler tick. Called from the worker loop. For each
 * implemented background task, decides whether the current wall-clock minute
 * lands inside any active window AND whether the configured interval has
 * elapsed since the last successful enqueue. When both conditions hold, an
 * idempotent dedupe-keyed job is queued.
 */
export async function tickConfigWorkersScheduler(now: Date = new Date()): Promise<void> {
  if (!state.defaultsEnsured) {
    await ensureDefaultConfigSchedules()
    state.defaultsEnsured = true
  }

  const schedules = await loadAllConfigSchedules()
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
      priority: JOB_PRIORITY_BEST_EFFORT,
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

    await recordConfigScheduleEnqueue(db, taskKey, jobId, now)
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
      await recordConfigScheduleEnqueue(db, taskKey, null, now)
    })
    return
  }

  const enqueuedJobIds: number[] = []

  for (const row of pendingRows) {
    const jobId = await withTransaction(async (db) => {
      return enqueueJob(db, {
        // Lit Alerts refresh does not touch Sweed; no shared session lane.
        concurrencyKey: null,
        // One job per pending queue row keeps the dedupe surface obvious.
        dedupeKey: `config.workers.litalerts_refresh.variant:${row.id}`,
        jobType: 'config.workers.litalerts_refresh.variant',
        module: 'config',
        payload: {
          productId: row.productId,
          queueRowId: row.id,
          siteDealerId: row.siteDealerId,
          sourceSnapshotId: row.sourceSnapshotId,
          trigger: 'scheduled',
        },
        priority: JOB_PRIORITY_BEST_EFFORT,
        requestedByUserId: null,
        runAt: now,
        scope: null,
      })
    })
    enqueuedJobIds.push(jobId)
  }

  const lastEnqueuedJobId = enqueuedJobIds[enqueuedJobIds.length - 1] ?? 0

  await withTransaction(async (db) => {
    await recordConfigScheduleEnqueue(db, taskKey, lastEnqueuedJobId, now)
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: taskKey,
      entityType: 'job',
      eventType: 'config.workers.litalerts_refresh.requested',
      module: 'config',
      payload: {
        intervalMinutes,
        enqueuedJobIds,
        queueRowIds: pendingRows.map((row) => row.id),
        taskKey,
        trigger: 'scheduled',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}

interface RollingRefreshCandidateRow {
  product_id: number
  latest_observation_id: number | null
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
 */
async function runScheduledLitalertsRollingTick(
  taskKey: ConfigBackgroundTaskKey,
  now: Date,
): Promise<void> {
  const candidatesResult = await getPool().query<RollingRefreshCandidateRow>(
    `
      with candidates as (
        select
          vw.product_id,
          vw.latest_observation_id,
          obs.next_refresh_at
        from vw_pricing_evidence_freshness vw
        left join litalerts_competitor_observations obs
          on obs.id = vw.latest_observation_id
        where vw.latest_observation_id is null
           or obs.next_refresh_at is null
           or obs.next_refresh_at <= now()
      )
      select distinct on (product_id)
        product_id, latest_observation_id, next_refresh_at
      from candidates
      order by product_id
      limit $1
    `,
    [LITALERTS_ROLLING_BATCH_SIZE],
  )

  if (candidatesResult.rows.length === 0) {
    // Record the tick anyway so the interval bucket honors its own cadence.
    await withTransaction(async (db) => {
      await recordConfigScheduleEnqueue(db, taskKey, null, now)
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
  const baseMs = now.getTime() + 24 * 60 * 60 * 1000
  for (const row of candidatesResult.rows) {
    if (row.latest_observation_id === null) {
      continue
    }
    const jitterSeconds = rollingRefreshJitterSecondsForProduct(row.product_id)
    const nextRefreshAt = new Date(baseMs + jitterSeconds * 1000)
    await getPool().query(
      `
        update litalerts_competitor_observations
           set next_refresh_at = $2
         where id = $1
      `,
      [row.latest_observation_id, nextRefreshAt],
    )
  }

  await withTransaction(async (db) => {
    const lastJobId = enqueueResult.enqueuedJobIds[enqueueResult.enqueuedJobIds.length - 1] ?? null
    await recordConfigScheduleEnqueue(db, taskKey, lastJobId, now)
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
      priority: JOB_PRIORITY_BEST_EFFORT,
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
    await recordConfigScheduleEnqueue(db, taskKey, jobId, now)
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
      priority: JOB_PRIORITY_BEST_EFFORT,
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

    await recordConfigScheduleEnqueue(db, taskKey, jobId, now)
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
      priority: JOB_PRIORITY_BEST_EFFORT,
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

    await recordConfigScheduleEnqueue(db, taskKey, jobId, now)
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

    await recordConfigScheduleEnqueue(db, taskKey, jobId, now)
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
      priority: JOB_PRIORITY_BEST_EFFORT,
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

    await recordConfigScheduleEnqueue(db, taskKey, jobId, now)
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
      priority: JOB_PRIORITY_BEST_EFFORT,
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

    await recordConfigScheduleEnqueue(db, taskKey, jobId, now)
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
      priority: JOB_PRIORITY_BEST_EFFORT,
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

    await recordConfigScheduleEnqueue(db, taskKey, jobId, now)
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
      priority: JOB_PRIORITY_BEST_EFFORT,
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

    await recordConfigScheduleEnqueue(db, taskKey, jobId, now)
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

    await recordConfigScheduleEnqueue(db, taskKey, jobId, now)
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

    await recordConfigScheduleEnqueue(db, taskKey, jobId, now)
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

    await recordConfigScheduleEnqueue(db, taskKey, jobId, now)
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
