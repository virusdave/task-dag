/**
 * Task DAG API Routes for Fastify
 */

import type { FastifyInstance } from 'fastify';
import * as taskDagRepo from '../taskDagRepo.js';

export async function registerTaskDagRoutes(server: FastifyInstance) {
  // GET /api/tasks/epics - List all epics
  server.get('/api/tasks/epics', async (_request, reply) => {
    try {
      const epics = await taskDagRepo.getEpics();
      return reply.send(epics);
    } catch (error) {
      server.log.error(error, 'Error fetching epics');
      return reply.status(500).send({ error: 'Failed to fetch epics' });
    }
  });

  // GET /api/tasks/epics/:id/dag - Get DAG for an epic
  server.get<{ Params: { id: string } }>('/api/tasks/epics/:id/dag', async (request, reply) => {
    try {
      const { id } = request.params;
      
      // Support both issue number and ref/sha
      const ref = id.match(/^\d+$/) ? `refs/heads/tasks/pending/${id}` : id;
      
      const dag = await taskDagRepo.getEpicDag(ref);
      return reply.send(dag);
    } catch (error) {
      server.log.error(error, 'Error fetching epic DAG');
      return reply.status(500).send({ error: 'Failed to fetch epic DAG' });
    }
  });

  // GET /api/tasks/frontier - List frontier tasks
  server.get<{ Querystring: { issue?: string; status?: string } }>('/api/tasks/frontier', async (request, reply) => {
    try {
      const filter: { issue?: number; status?: string } = {};
      
      if (request.query.issue) {
        filter.issue = parseInt(request.query.issue, 10);
      }
      if (request.query.status) {
        filter.status = request.query.status;
      }
      
      const tasks = await taskDagRepo.getFrontier(filter);
      return reply.send(tasks);
    } catch (error) {
      server.log.error(error, 'Error fetching frontier');
      return reply.status(500).send({ error: 'Failed to fetch frontier tasks' });
    }
  });

  // GET /api/tasks/task/:sha - Get task details
  server.get<{ Params: { sha: string } }>('/api/tasks/task/:sha', async (request, reply) => {
    try {
      const { sha } = request.params;
      const task = await taskDagRepo.getTaskDetail(sha);
      
      if (!task) {
        return reply.status(404).send({ error: 'Task not found' });
      }
      
      return reply.send(task);
    } catch (error) {
      server.log.error(error, 'Error fetching task');
      return reply.status(500).send({ error: 'Failed to fetch task' });
    }
  });

  // GET /api/tasks/validate - Validate DAG structure
  server.get('/api/tasks/validate', async (_request, reply) => {
    try {
      const result = await taskDagRepo.validateDag();
      return reply.send(result);
    } catch (error) {
      server.log.error(error, 'Error validating DAG');
      return reply.status(500).send({ error: 'Failed to validate DAG' });
    }
  });

  // GET /api/tasks/activity - Activity dashboard data
  server.get('/api/tasks/activity', async (_request, reply) => {
    try {
      const epics = await taskDagRepo.getEpics();
      const frontier = await taskDagRepo.getFrontier();
      
      const activity = {
        totalEpics: epics.length,
        totalFrontier: frontier.length,
        activeTasks: frontier.filter(t => t.isActive).length,
        completedToday: 0, // TODO: calculate from commit history
        epicSummaries: epics.map(e => ({
          title: e.title,
          issueNumber: e.issueNumber,
          frontierCount: e.frontierCount,
          completionPct: e.completionPct,
        })),
      };
      
      return reply.send(activity);
    } catch (error) {
      server.log.error(error, 'Error fetching activity');
      return reply.status(500).send({ error: 'Failed to fetch activity data' });
    }
  });
}
