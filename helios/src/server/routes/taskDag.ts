/**
 * Task DAG API routes (Fastify).
 *
 * All endpoints degrade gracefully: when the task-DAG git source is
 * unavailable they return a structured 503 (`task_dag_unavailable`) with
 * the source status instead of a raw 500, so the client can render a
 * friendly "task data unavailable" state. This matters because
 * /tasks/frontier is the app landing page.
 */

import type { FastifyInstance, FastifyReply } from 'fastify'
import * as taskDagRepo from '../taskDagRepo.js'
import { TaskDagRepositoryNotFoundError, TaskDagUnavailableError } from '../taskDagRepo.js'

function handleError(
  server: FastifyInstance,
  reply: FastifyReply,
  error: unknown,
  context: string,
): FastifyReply {
  if (error instanceof TaskDagUnavailableError) {
    return reply.status(503).send({
      error: 'task_dag_unavailable',
      message: 'Task DAG data is temporarily unavailable.',
      source: error.status,
    })
  }
  if (error instanceof TaskDagRepositoryNotFoundError) {
    return reply.status(404).send({ error: error.message })
  }
  server.log.error(error, context)
  return reply.status(500).send({ error: context })
}

export async function registerTaskDagRoutes(server: FastifyInstance) {
  // GET /api/tasks/epics - list all epics
  server.get('/api/tasks/epics', async (_request, reply) => {
    try {
      return reply.send(await taskDagRepo.getEpics())
    } catch (error) {
      return handleError(server, reply, error, 'Failed to fetch epics')
    }
  })

  server.get<{ Params: { repository: string; id: string } }>(
    '/api/tasks/repositories/:repository/epics/:id/dag',
    async (request, reply) => {
      try {
        return reply.send(await taskDagRepo.getEpicDag(request.params.id, request.params.repository))
      } catch (error) {
        if (error instanceof Error && /not found/i.test(error.message)) return reply.status(404).send({ error: error.message })
        return handleError(server, reply, error, 'Failed to fetch epic DAG')
      }
    },
  )

  // GET /api/tasks/frontier - grouped frontier view
  server.get<{ Querystring: { issue?: string; status?: string; repository?: string } }>(
    '/api/tasks/frontier',
    async (request, reply) => {
      try {
        const filter: { issue?: number; status?: string; repository?: string } = {}
        if (request.query.issue) {
          const n = parseInt(request.query.issue, 10)
          if (Number.isFinite(n)) filter.issue = n
        }
        if (request.query.status) filter.status = request.query.status
        if (request.query.repository) filter.repository = request.query.repository
        return reply.send(await taskDagRepo.getFrontierView(filter))
      } catch (error) {
        return handleError(server, reply, error, 'Failed to fetch frontier tasks')
      }
    },
  )

  server.get<{ Params: { repository: string; sha: string } }>(
    '/api/tasks/repositories/:repository/tasks/:sha',
    async (request, reply) => {
      try {
        const detail = await taskDagRepo.getTaskDetail(request.params.sha, request.params.repository)
        if (!detail) return reply.status(404).send({ error: 'Task not found' })
        return reply.send(detail)
      } catch (error) {
        return handleError(server, reply, error, 'Failed to fetch task')
      }
    },
  )

  // GET /api/tasks/validate - validate DAG structure
  server.get('/api/tasks/validate', async (_request, reply) => {
    try {
      return reply.send(await taskDagRepo.validateDag())
    } catch (error) {
      return handleError(server, reply, error, 'Failed to validate DAG')
    }
  })

  // GET /api/tasks/activity - dashboard counters
  server.get('/api/tasks/activity', async (_request, reply) => {
    try {
      return reply.send(await taskDagRepo.getActivity())
    } catch (error) {
      return handleError(server, reply, error, 'Failed to fetch activity data')
    }
  })
}
