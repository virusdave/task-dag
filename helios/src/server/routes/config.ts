import type { FastifyInstance } from 'fastify'

import {
  ConfigBackgroundTaskDetailResponseSchema,
  ConfigBackgroundTaskKeySchema,
  ConfigBackgroundTaskRunNowResponseSchema,
  ConfigBackgroundTaskScheduleUpdateRequestSchema,
  ConfigBackgroundTasksListResponseSchema,
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  getConfigBackgroundTaskDefinition,
  type ConfigBackgroundTaskKey,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { withTransaction } from '../db/tx.js'
import {
  countPendingLitalertsRefreshRows,
  ensureDefaultConfigSchedules,
  loadAllConfigSchedules,
  loadConfigSchedule,
  loadPendingLitalertsRefreshRows,
  loadRecentCatalogTaxonomySnapshots,
  loadRecentLitalertsObservations,
  loadRecentStockSnapshots,
  loadRecentSweedOrdersIngestRuns,
  loadSweedOrdersIngestDealerStatus,
  recordConfigScheduleEnqueue,
  replaceConfigScheduleWindows,
} from '../db/queries/configQueries.js'
import { getOptionalSweedSessionConcurrencyKey } from '../jobs/concurrency.js'
import { enqueueJob } from '../jobs/enqueueJob.js'

export async function registerConfigRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/config/workers/schedules', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    await ensureDefaultConfigSchedules()
    const schedules = await loadAllConfigSchedules()
    return reply.send(ConfigBackgroundTasksListResponseSchema.parse({ schedules }))
  })

  server.get<{ Params: { taskKey: string } }>('/api/config/workers/schedules/:taskKey', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const taskKey = ConfigBackgroundTaskKeySchema.parse(request.params.taskKey)
    await ensureDefaultConfigSchedules()
    return reply.send(await buildTaskDetailResponse(taskKey))
  })

  server.put<{ Params: { taskKey: string } }>('/api/config/workers/schedules/:taskKey', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) {
      return
    }
    const taskKey = ConfigBackgroundTaskKeySchema.parse(request.params.taskKey)
    const body = ConfigBackgroundTaskScheduleUpdateRequestSchema.parse({
      ...(request.body as Record<string, unknown>),
      taskKey,
    })
    if (body.taskKey !== taskKey) {
      throw new Error('Path taskKey does not match body taskKey.')
    }

    await withTransaction(async (db) => {
      await replaceConfigScheduleWindows(
        db,
        taskKey,
        body.windows.map((window) => ({
          weekdayMask: window.weekdayMask,
          windowStartMinute: window.windowStartMinute,
          windowEndMinute: window.windowEndMinute,
          intervalMinutes: window.intervalMinutes,
          paused: window.paused,
          notes: window.notes,
        })),
        user.id,
      )
      await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: taskKey,
        entityType: 'job',
        eventType: 'config.workers.schedule_updated',
        module: 'config',
        payload: {
          taskKey,
          windowCount: body.windows.length,
          windows: body.windows,
        },
        requestId: null,
        scope: null,
        undoPayload: null,
      })
    })

    return reply.send(await buildTaskDetailResponse(taskKey))
  })

  server.post<{ Params: { taskKey: string } }>(
    '/api/config/workers/schedules/:taskKey/run-now',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'admin')
      if (!user) {
        return
      }
      const taskKey = ConfigBackgroundTaskKeySchema.parse(request.params.taskKey)
      const definition = getConfigBackgroundTaskDefinition(taskKey)
      if (!definition.implemented) {
        return reply.status(400).send({
          error: `Background task ${taskKey} is not implemented yet; cannot run on demand.`,
        })
      }

      if (taskKey === 'workers.scheduling.stock') {
        const jobId = await runNowStockRefresh(user.id)
        return reply.send(ConfigBackgroundTaskRunNowResponseSchema.parse({ jobId }))
      }
      if (taskKey === 'workers.scheduling.litalerts') {
        const jobId = await runNowLitalertsRefresh(user.id)
        if (jobId === null) {
          return reply.status(400).send({
            error: 'No pending Lit Alerts refresh queue rows to drain right now.',
          })
        }
        return reply.send(ConfigBackgroundTaskRunNowResponseSchema.parse({ jobId }))
      }
      if (taskKey === 'workers.scheduling.catalog') {
        const jobId = await runNowCatalogRefresh(user.id)
        return reply.send(ConfigBackgroundTaskRunNowResponseSchema.parse({ jobId }))
      }
      if (taskKey === 'workers.scheduling.edible_thc_clamp') {
        const jobId = await runNowEdibleThcClamp(user.id)
        return reply.send(ConfigBackgroundTaskRunNowResponseSchema.parse({ jobId }))
      }
      if (taskKey === 'workers.scheduling.sweed_orders_ingest') {
        const jobId = await runNowSweedOrdersIngest(user.id)
        return reply.send(ConfigBackgroundTaskRunNowResponseSchema.parse({ jobId }))
      }
      if (taskKey === 'workers.scheduling.sweed_shifts_ingest') {
        const jobId = await runNowSweedShiftsIngest(user.id)
        return reply.send(ConfigBackgroundTaskRunNowResponseSchema.parse({ jobId }))
      }
      if (taskKey === 'workers.scheduling.enrich_customer_address') {
        const jobId = await runNowEnrichCustomerAddress(user.id)
        return reply.send(ConfigBackgroundTaskRunNowResponseSchema.parse({ jobId }))
      }

      return reply.status(400).send({
        error: `Background task ${taskKey} has no run-now wiring yet.`,
      })
    },
  )
}

async function buildTaskDetailResponse(taskKey: ConfigBackgroundTaskKey) {
  const schedule = await loadConfigSchedule(taskKey)
  const recentSnapshots = taskKey === 'workers.scheduling.stock'
    ? await loadRecentStockSnapshots(20)
    : []
  const litalerts = taskKey === 'workers.scheduling.litalerts'
    ? await buildLitalertsTaskDetail()
    : null
  const catalog = taskKey === 'workers.scheduling.catalog'
    ? await buildCatalogTaskDetail()
    : null
  const sweedOrdersIngest = taskKey === 'workers.scheduling.sweed_orders_ingest'
    ? await buildSweedOrdersIngestTaskDetail()
    : null
  return ConfigBackgroundTaskDetailResponseSchema.parse({
    schedule,
    recentSnapshots,
    litalerts,
    catalog,
    sweedOrdersIngest,
  })
}

async function buildSweedOrdersIngestTaskDetail() {
  const [dealers, recentRuns] = await Promise.all([
    loadSweedOrdersIngestDealerStatus(),
    loadRecentSweedOrdersIngestRuns(20),
  ])
  return { dealers, recentRuns }
}

async function runNowStockRefresh(userId: number): Promise<number> {
  const siteDealerIds = HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) => site.dealerId)
  const enqueuedAt = new Date()
  return withTransaction(async (db) => {
    const newJobId = await enqueueJob(db, {
      concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
      dedupeKey: `config.workers.stock_refresh:manual:${enqueuedAt.toISOString().slice(0, 16)}`,
      jobType: 'config.workers.stock_refresh',
      module: 'config',
      payload: {
        requestedByUserId: userId,
        siteDealerIds,
        trigger: 'manual_run',
      },
      requestedByUserId: userId,
      scope: null,
    })

    await recordConfigScheduleEnqueue(db, 'workers.scheduling.stock', newJobId, enqueuedAt)
    await appendAuditEvent(db, {
      actorType: 'user',
      actorUserId: userId,
      entityId: String(newJobId),
      entityType: 'job',
      eventType: 'config.workers.stock_refresh.requested',
      module: 'config',
      payload: {
        siteDealerIds,
        taskKey: 'workers.scheduling.stock',
        trigger: 'manual_run',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
    return newJobId
  })
}

async function runNowLitalertsRefresh(userId: number): Promise<number | null> {
  const pendingRows = await loadPendingLitalertsRefreshRows(50)
  if (pendingRows.length === 0) {
    return null
  }
  const enqueuedAt = new Date()
  const enqueuedJobIds: number[] = []

  for (const row of pendingRows) {
    const jobId = await withTransaction(async (db) => {
      return enqueueJob(db, {
        concurrencyKey: null,
        dedupeKey: `config.workers.litalerts_refresh.variant:${row.id}`,
        jobType: 'config.workers.litalerts_refresh.variant',
        module: 'config',
        payload: {
          productId: row.productId,
          queueRowId: row.id,
          siteDealerId: row.siteDealerId,
          sourceSnapshotId: row.sourceSnapshotId,
          requestedByUserId: userId,
          trigger: 'manual_run',
        },
        requestedByUserId: userId,
        runAt: enqueuedAt,
        scope: null,
      })
    })
    enqueuedJobIds.push(jobId)
  }

  const lastJobId = enqueuedJobIds[enqueuedJobIds.length - 1] ?? null

  await withTransaction(async (db) => {
    await recordConfigScheduleEnqueue(db, 'workers.scheduling.litalerts', lastJobId, enqueuedAt)
    await appendAuditEvent(db, {
      actorType: 'user',
      actorUserId: userId,
      entityId: 'workers.scheduling.litalerts',
      entityType: 'job',
      eventType: 'config.workers.litalerts_refresh.requested',
      module: 'config',
      payload: {
        enqueuedJobIds,
        queueRowIds: pendingRows.map((row) => row.id),
        taskKey: 'workers.scheduling.litalerts',
        trigger: 'manual_run',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })

  return lastJobId
}

async function buildLitalertsTaskDetail() {
  const [pendingQueueDepth, pendingQueueSample, recentObservations] = await Promise.all([
    countPendingLitalertsRefreshRows(),
    loadPendingLitalertsRefreshRows(20),
    loadRecentLitalertsObservations(20),
  ])
  return {
    pendingQueueDepth,
    pendingQueueSample,
    recentObservations,
  }
}

async function runNowCatalogRefresh(userId: number): Promise<number> {
  const enqueuedAt = new Date()
  return withTransaction(async (db) => {
    const newJobId = await enqueueJob(db, {
      concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
      dedupeKey: `config.workers.catalog_refresh:manual:${enqueuedAt.toISOString().slice(0, 16)}`,
      jobType: 'config.workers.catalog_refresh',
      module: 'config',
      payload: {
        requestedByUserId: userId,
        trigger: 'manual_run',
      },
      requestedByUserId: userId,
      runAt: enqueuedAt,
      scope: null,
    })

    await recordConfigScheduleEnqueue(db, 'workers.scheduling.catalog', newJobId, enqueuedAt)
    await appendAuditEvent(db, {
      actorType: 'user',
      actorUserId: userId,
      entityId: String(newJobId),
      entityType: 'job',
      eventType: 'config.workers.catalog_refresh.requested',
      module: 'config',
      payload: {
        taskKey: 'workers.scheduling.catalog',
        trigger: 'manual_run',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
    return newJobId
  })
}

async function buildCatalogTaskDetail() {
  const recentSnapshots = await loadRecentCatalogTaxonomySnapshots(20)
  return { recentSnapshots }
}

async function runNowSweedOrdersIngest(userId: number): Promise<number> {
  const siteDealerIds = HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) => site.dealerId)
  const enqueuedAt = new Date()
  return withTransaction(async (db) => {
    const newJobId = await enqueueJob(db, {
      concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
      dedupeKey: `config.workers.sweed_orders_ingest:manual:${enqueuedAt.toISOString().slice(0, 19)}`,
      jobType: 'config.workers.sweed_orders_ingest',
      module: 'config',
      payload: {
        requestedByUserId: userId,
        siteDealerIds,
        trigger: 'manual_run',
        // Manual runs default to a single-day backfill burst on top
        // of the forward poll — the scheduled tick handles the steady-
        // state cadence, this is just for "fetch what's new right now".
        backfillDays: 1,
      },
      requestedByUserId: userId,
      runAt: enqueuedAt,
      scope: null,
    })

    await recordConfigScheduleEnqueue(db, 'workers.scheduling.sweed_orders_ingest', newJobId, enqueuedAt)
    await appendAuditEvent(db, {
      actorType: 'user',
      actorUserId: userId,
      entityId: String(newJobId),
      entityType: 'job',
      eventType: 'config.workers.sweed_orders_ingest.requested',
      module: 'config',
      payload: {
        siteDealerIds,
        taskKey: 'workers.scheduling.sweed_orders_ingest',
        trigger: 'manual_run',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
    return newJobId
  })
}

async function runNowSweedShiftsIngest(userId: number): Promise<number> {
  const siteDealerIds = HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) => site.dealerId)
  const enqueuedAt = new Date()
  return withTransaction(async (db) => {
    const newJobId = await enqueueJob(db, {
      concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
      dedupeKey: `config.workers.sweed_shifts_ingest:manual:${enqueuedAt.toISOString().slice(0, 19)}`,
      jobType: 'config.workers.sweed_shifts_ingest',
      module: 'config',
      payload: {
        requestedByUserId: userId,
        siteDealerIds,
        trigger: 'manual_run',
        // Manual runs default to a single-day backfill burst on top
        // of the forward poll — the scheduled tick handles the steady-
        // state cadence + the 30-day catch-up window, this is just
        // for "fetch what's new right now".
        backfillDays: 1,
      },
      requestedByUserId: userId,
      runAt: enqueuedAt,
      scope: null,
    })

    await recordConfigScheduleEnqueue(db, 'workers.scheduling.sweed_shifts_ingest', newJobId, enqueuedAt)
    await appendAuditEvent(db, {
      actorType: 'user',
      actorUserId: userId,
      entityId: String(newJobId),
      entityType: 'job',
      eventType: 'config.workers.sweed_shifts_ingest.requested',
      module: 'config',
      payload: {
        siteDealerIds,
        taskKey: 'workers.scheduling.sweed_shifts_ingest',
        trigger: 'manual_run',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
    return newJobId
  })
}

async function runNowEdibleThcClamp(userId: number): Promise<number> {
  const siteDealerIds = HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) => site.dealerId)
  const enqueuedAt = new Date()
  return withTransaction(async (db) => {
    const newJobId = await enqueueJob(db, {
      concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
      dedupeKey: `config.workers.edible_thc_clamp:manual:${enqueuedAt.toISOString().slice(0, 16)}`,
      jobType: 'config.workers.edible_thc_clamp',
      module: 'config',
      payload: {
        requestedByUserId: userId,
        siteDealerIds,
        trigger: 'manual_run',
      },
      requestedByUserId: userId,
      runAt: enqueuedAt,
      scope: null,
    })

    await recordConfigScheduleEnqueue(db, 'workers.scheduling.edible_thc_clamp', newJobId, enqueuedAt)
    await appendAuditEvent(db, {
      actorType: 'user',
      actorUserId: userId,
      entityId: String(newJobId),
      entityType: 'job',
      eventType: 'config.workers.edible_thc_clamp.requested',
      module: 'config',
      payload: {
        siteDealerIds,
        taskKey: 'workers.scheduling.edible_thc_clamp',
        trigger: 'manual_run',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
    return newJobId
  })
}

async function runNowEnrichCustomerAddress(userId: number): Promise<number> {
  const siteDealerIds = HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) => site.dealerId)
  const enqueuedAt = new Date()
  return withTransaction(async (db) => {
    const newJobId = await enqueueJob(db, {
      concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
      dedupeKey: `config.workers.enrich_customer_address:manual:${enqueuedAt.toISOString().slice(0, 19)}`,
      jobType: 'config.workers.enrich_customer_address',
      module: 'config',
      payload: {
        requestedByUserId: userId,
        siteDealerIds,
        trigger: 'manual_run',
        batchSize: 60,
      },
      requestedByUserId: userId,
      runAt: enqueuedAt,
      scope: null,
    })

    await recordConfigScheduleEnqueue(db, 'workers.scheduling.enrich_customer_address', newJobId, enqueuedAt)
    await appendAuditEvent(db, {
      actorType: 'user',
      actorUserId: userId,
      entityId: String(newJobId),
      entityType: 'job',
      eventType: 'config.workers.enrich_customer_address.requested',
      module: 'config',
      payload: {
        siteDealerIds,
        taskKey: 'workers.scheduling.enrich_customer_address',
        trigger: 'manual_run',
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
    return newJobId
  })
}
