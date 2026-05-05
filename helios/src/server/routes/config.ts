import type { FastifyInstance } from 'fastify'

import {
  ConfigBackgroundTaskDetailResponseSchema,
  ConfigBackgroundTaskKeySchema,
  ConfigBackgroundTaskRunNowResponseSchema,
  ConfigBackgroundTaskScheduleUpdateRequestSchema,
  ConfigBackgroundTasksListResponseSchema,
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  getConfigBackgroundTaskDefinition,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { withTransaction } from '../db/tx.js'
import {
  ensureDefaultConfigSchedules,
  loadAllConfigSchedules,
  loadConfigSchedule,
  loadRecentStockSnapshots,
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
    const schedule = await loadConfigSchedule(taskKey)
    const recentSnapshots = taskKey === 'workers.scheduling.stock'
      ? await loadRecentStockSnapshots(20)
      : []
    return reply.send(
      ConfigBackgroundTaskDetailResponseSchema.parse({
        schedule,
        recentSnapshots,
      }),
    )
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

    const schedule = await loadConfigSchedule(taskKey)
    const recentSnapshots = taskKey === 'workers.scheduling.stock'
      ? await loadRecentStockSnapshots(20)
      : []
    return reply.send(
      ConfigBackgroundTaskDetailResponseSchema.parse({
        schedule,
        recentSnapshots,
      }),
    )
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
      if (taskKey !== 'workers.scheduling.stock') {
        return reply.status(400).send({
          error: `Background task ${taskKey} has no run-now wiring yet.`,
        })
      }

      const siteDealerIds = HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) => site.dealerId)
      const enqueuedAt = new Date()
      const jobId = await withTransaction(async (db) => {
        const newJobId = await enqueueJob(db, {
          concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
          dedupeKey: `config.workers.stock_refresh:manual:${enqueuedAt.toISOString().slice(0, 16)}`,
          jobType: 'config.workers.stock_refresh',
          module: 'config',
          payload: {
            requestedByUserId: user.id,
            siteDealerIds,
            trigger: 'manual_run',
          },
          requestedByUserId: user.id,
          scope: null,
        })

        await recordConfigScheduleEnqueue(db, taskKey, newJobId, enqueuedAt)
        await appendAuditEvent(db, {
          actorType: 'user',
          actorUserId: user.id,
          entityId: String(newJobId),
          entityType: 'job',
          eventType: 'config.workers.stock_refresh.requested',
          module: 'config',
          payload: {
            siteDealerIds,
            taskKey,
            trigger: 'manual_run',
          },
          requestId: null,
          scope: null,
          undoPayload: null,
        })
        return newJobId
      })

      return reply.send(ConfigBackgroundTaskRunNowResponseSchema.parse({ jobId }))
    },
  )
}
