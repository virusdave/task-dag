import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getAnalyticsMock = vi.hoisted(() => vi.fn())
const enqueueJobMock = vi.hoisted(() => vi.fn(async () => 71))
const db = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('../auth/requireSession.js', () => ({
  requireMetricsGrant: vi.fn(async () => ({
    active: true,
    email: 'viewer@example.com',
    id: 42,
    metricGrants: ['staff'],
    name: 'Viewer',
    role: 'viewer',
  })),
}))
vi.mock('../budtenderAnalytics/budtenderAnalyticsQueries.js', () => ({
  BUDTENDER_ANALYTICS_DEFAULT_WINDOW_DAYS: 90,
  getBudtenderAnalyticsWithStaffCacheState: getAnalyticsMock,
}))
vi.mock('../db/pool.js', () => ({ getPool: vi.fn(() => db) }))
vi.mock('../jobs/enqueueJob.js', () => ({
  enqueueJob: enqueueJobMock,
  JOB_PRIORITY_BEST_EFFORT: 0,
}))

import { registerBudtenderAnalyticsRoutes } from './budtenderAnalytics.js'

const analytics = {
  range: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-20T00:00:00.000Z' },
  generatedAt: '2026-07-20T00:00:00.000Z',
  sites: [],
  totals: {
    attributedTransactions: 0,
    unassignedTransactions: 0,
    attributedSales: 0,
    activeCashiers: 0,
    avgOrderValue: null,
    discountRate: null,
  },
  daily: [],
  cashiers: [],
  missingDataCards: [],
}

describe('budtender analytics staff refresh', () => {
  let server: FastifyInstance

  beforeEach(async () => {
    vi.clearAllMocks()
    server = Fastify()
    await registerBudtenderAnalyticsRoutes(server)
  })

  afterEach(async () => {
    await server.close()
  })

  it('queues stale staff work through the deduped Sweed worker boundary', async () => {
    getAnalyticsMock.mockResolvedValue({
      analytics,
      staffRefreshTrigger: 'budtender_cashier_missing',
    })

    const response = await server.inject({ method: 'GET', url: '/api/budtender-analytics' })

    expect(response.statusCode).toBe(200)
    expect(enqueueJobMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        concurrencyKey: null,
        dedupeKey: 'config.workers.refresh_staff_directory',
        jobType: 'config.workers.refresh_staff_directory',
        payload: { trigger: 'budtender_cashier_missing' },
      }),
    )
  })

  it('still returns cached analytics when the best-effort enqueue fails', async () => {
    getAnalyticsMock.mockResolvedValue({
      analytics,
      staffRefreshTrigger: 'budtender_cache_stale',
    })
    enqueueJobMock.mockRejectedValueOnce(new Error('queue unavailable'))

    const response = await server.inject({ method: 'GET', url: '/api/budtender-analytics' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ cashiers: [], totals: { activeCashiers: 0 } })
  })
})
