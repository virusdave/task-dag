// In-process auth checks for GET /api/gads/landing-pages via a bare Fastify
// instance. Mocks keep this DB-free while pinning the route's grant derivation:
// per-site grants stay isolated, gads-all is its own grant, and unauthorized
// responses do not reveal concrete site/grant names.

import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MetricGrantKey } from '../../shared/contracts/index.js'

const mockState = vi.hoisted(() => ({
  grants: [] as MetricGrantKey[],
}))

vi.mock('../auth/requireSession.js', () => ({
  requireConfidentialMetricsGrant: vi.fn(
    async (
      _request: unknown,
      reply: { status: (n: number) => { send: (b: unknown) => void } },
      anyOf: ReadonlyArray<MetricGrantKey>,
    ) => {
      if (anyOf.some((grant) => mockState.grants.includes(grant))) {
        return {
          active: true,
          email: 'viewer@example.com',
          id: 1,
          metricGrants: mockState.grants,
          name: 'Viewer',
          role: 'viewer',
        }
      }
      reply.status(403).send({ error: 'You do not have access to this confidential metrics surface.' })
      return null
    },
  ),
}))

vi.mock('../db/queries/gadsLandingPagesQueries.js', () => ({
  getGadsLandingPages: vi.fn(async (args: { scope: 'bronx' | 'midtown' | 'all' }) => ({
    scope: args.scope,
    range: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-02T00:00:00.000Z' },
    generatedAt: '2026-07-02T00:00:00.000Z',
    sites: args.scope === 'all' ? ['bronx', 'midtown'] : [args.scope],
    freshness: {
      status: 'ok',
      badge: 'fresh',
      stale: false,
      message: 'Rollup data is fresh.',
      lastStartedAt: '2026-07-02T00:00:00.000Z',
      lastCompletedAt: '2026-07-02T00:00:01.000Z',
      sourceMinAt: null,
      sourceMaxAt: null,
      rowsWritten: 0,
    },
    attributionStatus: 'not-wired',
    kpis: {
      assignments: 0,
      conversionRate: null,
      redirectRate: null,
      impressionRate: null,
      adSpend: null,
      attributedRevenue: null,
      roas: null,
      cpa: null,
    },
    funnel: [],
    siteBreakdown: [],
    variants: [],
    dataQuality: {
      assignmentsMissingId: 0,
      unattributedStageEvents: 0,
      lowSampleThreshold: 25,
    },
  })),
}))

import { registerGadsLandingPagesRoutes } from './gadsLandingPages.js'
import { requireConfidentialMetricsGrant } from '../auth/requireSession.js'
import { getGadsLandingPages } from '../db/queries/gadsLandingPagesQueries.js'

const requireConfidentialMetricsGrantMock = vi.mocked(requireConfidentialMetricsGrant)
const getGadsLandingPagesMock = vi.mocked(getGadsLandingPages)

let server: FastifyInstance

beforeEach(async () => {
  mockState.grants = []
  server = Fastify()
  await registerGadsLandingPagesRoutes(server)
  await server.ready()
})

afterEach(async () => {
  await server.close()
  vi.clearAllMocks()
})

describe('GET /api/gads/landing-pages grant isolation', () => {
  it('allows gads-all to read a per-site scope', async () => {
    mockState.grants = ['gads-all']

    const res = await server.inject({ method: 'GET', url: '/api/gads/gads-bronx/landing-pages' })

    expect(res.statusCode).toBe(200)
    expect(requireConfidentialMetricsGrantMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      ['gads-bronx', 'gads-all'],
    )
    expect(getGadsLandingPagesMock).toHaveBeenCalledWith(expect.objectContaining({ scope: 'bronx' }))
  })

  it('denies the wrong per-site grant before reading data and without naming scopes', async () => {
    mockState.grants = ['gads-midtown']

    const res = await server.inject({ method: 'GET', url: '/api/gads/gads-bronx/landing-pages' })

    expect(res.statusCode).toBe(403)
    expect(getGadsLandingPagesMock).not.toHaveBeenCalled()
    expect(res.body).not.toMatch(/gads-|bronx|midtown/i)
  })

  it('does not synthesize gads-all from holding every per-site grant', async () => {
    mockState.grants = ['gads-bronx', 'gads-midtown']

    const res = await server.inject({ method: 'GET', url: '/api/gads/gads-all/landing-pages' })

    expect(res.statusCode).toBe(403)
    expect(requireConfidentialMetricsGrantMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      ['gads-all'],
    )
    expect(getGadsLandingPagesMock).not.toHaveBeenCalled()
    expect(res.body).not.toMatch(/gads-|bronx|midtown/i)
  })

  it('ignores a query-string site and derives scope from the path only', async () => {
    mockState.grants = ['gads-bronx']

    const res = await server.inject({
      method: 'GET',
      url: '/api/gads/gads-bronx/landing-pages?site=all',
    })

    expect(res.statusCode).toBe(200)
    expect(getGadsLandingPagesMock).toHaveBeenCalledWith(expect.objectContaining({ scope: 'bronx' }))
  })
})
