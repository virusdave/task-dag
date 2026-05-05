import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type ConfigBackgroundTaskKey,
  type ConfigWorkerScheduleWindow,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import {
  ensureDefaultConfigSchedules,
  loadAllConfigSchedules,
  loadPendingLitalertsRefreshRows,
  recordConfigScheduleEnqueue,
} from '../../server/db/queries/configQueries.js'
import { getOptionalSweedSessionConcurrencyKey } from '../../server/jobs/concurrency.js'
import { enqueueJob } from '../../server/jobs/enqueueJob.js'

const LITALERTS_DRAIN_BATCH_SIZE = 50

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

    if (schedule.taskKey === 'workers.scheduling.stock') {
      await enqueueScheduledStockRefresh(schedule.taskKey, now, activeWindow.intervalMinutes)
    } else if (schedule.taskKey === 'workers.scheduling.litalerts') {
      await enqueueScheduledLitalertsRefreshBatch(schedule.taskKey, now, activeWindow.intervalMinutes)
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
