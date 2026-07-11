// In-process route checks for GET /api/agent-waste/backlog via a bare
// Fastify instance (server.inject) — no DB, no full buildServer() boot.
//
// We mock requireSessionUser (whose real implementation reads the session
// user from Postgres) so we can deterministically exercise:
//   - admin + unavailable transport -> structured 503 agent_waste_unavailable
//   - admin + installed reader       -> 200 with observations + source
//   - non-admin                      -> 403 and the reader is NEVER consulted
// The admin-gating semantics themselves live in requireSessionUser (covered
// by the auth-gate suite); here we assert the ROUTE enforces the gate
// server-side and degrades correctly.

import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted mock state so the module-factory can reference it.
const mockState = vi.hoisted(() => ({
  allow: true as boolean,
}))

vi.mock('../auth/requireSession.js', () => ({
  requireSessionUser: vi.fn(async (_request: unknown, reply: { status: (n: number) => { send: (b: unknown) => void } }) => {
    if (!mockState.allow) {
      reply.status(403).send({ error: 'You do not have permission to perform this action.' })
      return null
    }
    return { id: 1, role: 'admin' }
  }),
}))

// The cluster route resolves an operator-overridable model (DB-backed) and
// calls the Bedrock gateway. Mock both so the route tests stay DB-/network-
// free: getPool is a stub (resolveBedrockModel is mocked so it never queries),
// resolveBedrockModel returns a fixed id, and callClusterModel is a spy we
// drive per-test. ClusterModelError is kept REAL so the route's
// `instanceof ClusterModelError` branch still works.
const clusterMockState = vi.hoisted(() => ({ model: 'deepseek.v3.2' }))

vi.mock('../db/pool.js', () => ({ getPool: () => ({}) }))
vi.mock('../config/env.js', () => ({
  getServerEnv: () => ({
    bedrockMantleBaseUrl: 'https://gateway.test/v1',
    bedrockMantleBearerToken: 'test-token',
    llmRequestTimeoutMs: 1000,
  }),
}))
vi.mock('../llm/bedrockModelConfig.js', () => ({
  resolveBedrockModel: vi.fn(async () => clusterMockState.model),
}))
vi.mock('../agentWaste/clusterModel.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agentWaste/clusterModel.js')>()
  return { ...actual, callClusterModel: vi.fn() }
})

import { registerAgentWasteRoutes } from './agentWaste.js'
import {
  __resetBacklogReaderForTests,
  setBacklogReader,
  type BacklogReader,
} from '../agentWasteRepo.js'
import { callClusterModel, ClusterModelError } from '../agentWaste/clusterModel.js'
import type { RawClusterModelOutput } from '../agentWaste/clusterBacklog.js'

const callClusterModelMock = vi.mocked(callClusterModel)

let server: FastifyInstance

beforeEach(async () => {
  mockState.allow = true
  __resetBacklogReaderForTests()
  server = Fastify()
  await registerAgentWasteRoutes(server)
  await server.ready()
})

afterEach(async () => {
  await server.close()
  __resetBacklogReaderForTests()
  vi.clearAllMocks()
})

describe('GET /api/agent-waste/backlog', () => {
  it('degrades to a structured 503 when the transport is unavailable (default reader)', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/agent-waste/backlog' })
    expect(res.statusCode).toBe(503)
    const body = res.json()
    expect(body.error).toBe('agent_waste_unavailable')
    expect(body.source.available).toBe(false)
    expect(typeof body.message).toBe('string')
  })

  it('returns 200 with observations + source once a reader is installed', async () => {
    const reader: BacklogReader = {
      status: () => ({ available: true, detail: 'test reader' }),
      readBacklog: async () => [
        { time: '2026-07-06T00:00:00Z', kind: 'tool_footgun', id: 'a', note: 'humans only' },
      ],
    }
    setBacklogReader(reader)
    const res = await server.inject({ method: 'GET', url: '/api/agent-waste/backlog' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.source).toEqual({ available: true, detail: 'test reader' })
    expect(body.observations).toHaveLength(1)
    expect(body.observations[0].id).toBe('a')
    expect(body.observations[0].note).toBe('humans only')
  })

  it('is admin-gated: a non-admin gets 403 and the reader is never consulted', async () => {
    mockState.allow = false
    const readBacklog = vi.fn(async () => [])
    setBacklogReader({ status: () => ({ available: true, detail: 'x' }), readBacklog })
    const res = await server.inject({ method: 'GET', url: '/api/agent-waste/backlog' })
    expect(res.statusCode).toBe(403)
    expect(readBacklog).not.toHaveBeenCalled()
  })
})

describe('POST /api/agent-waste/promote', () => {
  const validBody = {
    id: 'rg-short-r',
    status: 'active',
    scope: 'global',
    severity: 'low',
    max_tokens: 35,
    text: 'Use rg -n / rg -l; never rg -r.',
    trigger_ids: ['rg-short-r-rejected'],
    expires_after_days: 14,
    sourceObservationId: 'rg-short-r-rejected',
  }

  beforeEach(() => {
    // The route must never touch prod; ensure no writable clone is wired so
    // the apply path fails closed instead of attempting a real git write.
    delete process.env.HELIOS_AGENT_PAIN_POINTS_WRITE_DIR
  })

  it('is admin-gated: a non-admin gets 403', async () => {
    mockState.allow = false
    const res = await server.inject({ method: 'POST', url: '/api/agent-waste/promote', payload: validBody })
    expect(res.statusCode).toBe(403)
  })

  it('rejects an unknown field (crucially, `note` can never be supplied)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/agent-waste/promote',
      payload: { ...validBody, note: 'agent-authored free-form text' },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.ok).toBe(false)
    expect(body.code).toBe('invalid_request')
    expect(body.message).toContain('note')
  })

  it('rejects a structurally invalid body with 400 invalid_request', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/agent-waste/promote',
      payload: { id: 'Not Kebab', status: 'active' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('invalid_request')
  })

  it('degrades to 503 agent_pain_points_unavailable when no writable clone is configured', async () => {
    const res = await server.inject({ method: 'POST', url: '/api/agent-waste/promote', payload: validBody })
    expect(res.statusCode).toBe(503)
    const body = res.json()
    expect(body.ok).toBe(false)
    expect(body.code).toBe('agent_pain_points_unavailable')
  })
})

describe('POST /api/agent-waste/clusters', () => {
  function readerFor(observations: Array<Record<string, unknown>>): BacklogReader {
    return {
      status: () => ({ available: true, detail: 'test reader' }),
      readBacklog: async () => observations as never,
    }
  }

  it('is admin-gated: a non-admin gets 403 and neither model nor gateway is consulted', async () => {
    mockState.allow = false
    setBacklogReader(readerFor([{ time: 't', kind: 'k', id: 'a' }]))
    const res = await server.inject({ method: 'POST', url: '/api/agent-waste/clusters', payload: {} })
    expect(res.statusCode).toBe(403)
    expect(callClusterModelMock).not.toHaveBeenCalled()
  })

  it('degrades to a structured 503 when the backlog transport is unavailable', async () => {
    // default reader = unavailable
    const res = await server.inject({ method: 'POST', url: '/api/agent-waste/clusters', payload: {} })
    expect(res.statusCode).toBe(503)
    expect(res.json().error).toBe('agent_waste_unavailable')
    expect(callClusterModelMock).not.toHaveBeenCalled()
  })

  it('returns empty clusters (and skips the LLM call) for an empty backlog', async () => {
    setBacklogReader(readerFor([]))
    const res = await server.inject({ method: 'POST', url: '/api/agent-waste/clusters', payload: {} })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.clusters).toEqual([])
    expect(body.unclustered).toEqual([])
    expect(body.model).toBe('deepseek.v3.2')
    expect(callClusterModelMock).not.toHaveBeenCalled()
  })

  it('rejects a non-empty body with 400 (server reads the live backlog)', async () => {
    setBacklogReader(readerFor([{ time: 't', kind: 'k', id: 'a' }]))
    const res = await server.inject({
      method: 'POST',
      url: '/api/agent-waste/clusters',
      payload: { onlyRows: [1, 2] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_request')
    expect(callClusterModelMock).not.toHaveBeenCalled()
  })

  it('clusters every observation in a backlog larger than one model-call batch', async () => {
    const many = Array.from({ length: 201 }, (_, i) => ({
      time: 't',
      kind: 'k',
      id: `id-${i}`,
      estimated_wasted_tokens: i === 200 ? 1_000 : 1,
    }))
    setBacklogReader(readerFor(many))
    callClusterModelMock
      .mockResolvedValueOnce({
        clusters: [{ label: 'first batch', primaryKey: 0, memberKeys: Array.from({ length: 200 }, (_, i) => i) }],
      })
      .mockResolvedValueOnce({
        clusters: [{ label: 'second batch', primaryKey: 0, memberKeys: [0] }],
      })
    const res = await server.inject({ method: 'POST', url: '/api/agent-waste/clusters', payload: {} })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.clusters.flatMap((cluster: { members: Array<{ id: string }> }) => cluster.members)).toHaveLength(201)
    expect(body.clusters.map((cluster: { label: string }) => cluster.label)).toEqual([
      'second batch',
      'first batch',
    ])
    expect(body.unclustered).toEqual([])
    expect(callClusterModelMock).toHaveBeenCalledTimes(2)
    expect(callClusterModelMock.mock.calls[0][0]).toHaveLength(200)
    expect(callClusterModelMock.mock.calls[1][0]).toHaveLength(1)
  })

  it('fails the whole request when a later batch fails instead of returning a partial result', async () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ time: 't', kind: 'k', id: `id-${i}` }))
    setBacklogReader(readerFor(many))
    callClusterModelMock
      .mockResolvedValueOnce({
        clusters: [{ label: 'first batch', primaryKey: 0, memberKeys: [0] }],
      })
      .mockRejectedValueOnce(new ClusterModelError('bedrock_http_error', 'HTTP 500'))
    const res = await server.inject({ method: 'POST', url: '/api/agent-waste/clusters', payload: {} })
    expect(res.statusCode).toBe(502)
    expect(res.json().error).toBe('bedrock_http_error')
    expect(callClusterModelMock).toHaveBeenCalledTimes(2)
  })

  it('clusters, ranks, and returns the 200 shape on success', async () => {
    setBacklogReader(
      readerFor([
        { time: 't', kind: 'tool_footgun', id: 'a', note: 'rg -r', estimated_wasted_tokens: 10 },
        { time: 't', kind: 'tool_footgun', id: 'b', note: 'rg -r again', estimated_wasted_tokens: 5 },
        { time: 't', kind: 'startup', id: 'c', note: 'reread canon', estimated_wasted_tokens: 999 },
      ]),
    )
    const raw: RawClusterModelOutput = {
      clusters: [
        { label: 'rg -r flag', primaryKey: 0, memberKeys: [0, 1] },
        { label: 'reread canon', primaryKey: 2, memberKeys: [2] },
      ],
    }
    callClusterModelMock.mockResolvedValueOnce(raw)
    const res = await server.inject({ method: 'POST', url: '/api/agent-waste/clusters', payload: {} })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.model).toBe('deepseek.v3.2')
    // Ranked desc by aggregate tokens: singleton c (999) outranks a+b (15).
    expect(body.clusters.map((c: { label: string }) => c.label)).toEqual(['reread canon', 'rg -r flag'])
    expect(body.clusters[1].members.map((m: { id: string }) => m.id)).toEqual(['a', 'b'])
    expect(body.unclustered).toEqual([])
    expect(callClusterModelMock).toHaveBeenCalledOnce()
  })

  it('maps a missing bearer token to 503 bedrock_unconfigured', async () => {
    setBacklogReader(readerFor([{ time: 't', kind: 'k', id: 'a' }]))
    callClusterModelMock.mockRejectedValueOnce(
      new ClusterModelError('bedrock_unconfigured', 'no token'),
    )
    const res = await server.inject({ method: 'POST', url: '/api/agent-waste/clusters', payload: {} })
    expect(res.statusCode).toBe(503)
    expect(res.json().error).toBe('bedrock_unconfigured')
  })

  it('maps a gateway failure to 502', async () => {
    setBacklogReader(readerFor([{ time: 't', kind: 'k', id: 'a' }]))
    callClusterModelMock.mockRejectedValueOnce(
      new ClusterModelError('bedrock_http_error', 'HTTP 500'),
    )
    const res = await server.inject({ method: 'POST', url: '/api/agent-waste/clusters', payload: {} })
    expect(res.statusCode).toBe(502)
    expect(res.json().error).toBe('bedrock_http_error')
  })
})
