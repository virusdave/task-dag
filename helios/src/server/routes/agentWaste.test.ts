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
vi.mock('../agentWaste/ticketDraftModel.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agentWaste/ticketDraftModel.js')>()
  return { ...actual, callTicketDraftModel: vi.fn() }
})

import { compactWarnings, registerAgentWasteRoutes } from './agentWaste.js'
import {
  __resetBacklogReaderForTests,
  setBacklogReader,
  type BacklogReader,
} from '../agentWasteRepo.js'
import { callClusterModel, ClusterModelError } from '../agentWaste/clusterModel.js'
import type { RawClusterModelOutput } from '../agentWaste/clusterBacklog.js'
import { callTicketDraftModel, TicketDraftModelError } from '../agentWaste/ticketDraftModel.js'
import { resolveBedrockModel } from '../llm/bedrockModelConfig.js'

const callClusterModelMock = vi.mocked(callClusterModel)
const callTicketDraftModelMock = vi.mocked(callTicketDraftModel)
const resolveBedrockModelMock = vi.mocked(resolveBedrockModel)

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

describe('agent-waste ticket drafting', () => {
  const report = {
    time: '2026-07-11T00:00:00Z',
    kind: 'startup',
    id: 'repeat-canon',
    note: 'Canon was read twice',
    estimated_wasted_tokens: 500,
  }
  const requestBody = { clusterLabel: 'Repeated startup work', reports: [report] }

  function ticketReader(reports: Array<Record<string, unknown>>): BacklogReader {
    return {
      status: () => ({ available: true, detail: 'test reader' }),
      readBacklog: async () => reports as never,
    }
  }

  it('serves the bounded catalog only to admins', async () => {
    const allowed = await server.inject({ method: 'GET', url: '/api/agent-waste/repositories' })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.json().repositories).toHaveLength(9)
    expect(allowed.json().repositories.map((entry: { repository: string }) => entry.repository))
      .toContain('FreshlyBakedNYC/automation')

    mockState.allow = false
    const denied = await server.inject({ method: 'GET', url: '/api/agent-waste/repositories' })
    expect(denied.statusCode).toBe(403)
  })

  it('rejects stale reports before model resolution or invocation', async () => {
    setBacklogReader(ticketReader([]))
    const response = await server.inject({
      method: 'POST', url: '/api/agent-waste/ticket-draft', payload: requestBody,
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('agent_waste_ticket_source_mismatch')
    expect(callTicketDraftModelMock).not.toHaveBeenCalled()
  })

  it('rejects malformed requests and unavailable backlog without a model call', async () => {
    const malformed = await server.inject({
      method: 'POST', url: '/api/agent-waste/ticket-draft', payload: { clusterLabel: 'x', reports: [], surprise: true },
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json().error).toBe('invalid_request')

    __resetBacklogReaderForTests()
    const unavailable = await server.inject({
      method: 'POST', url: '/api/agent-waste/ticket-draft', payload: requestBody,
    })
    expect(unavailable.statusCode).toBe(503)
    expect(unavailable.json().error).toBe('agent_waste_unavailable')
    expect(resolveBedrockModelMock).not.toHaveBeenCalled()
    expect(callTicketDraftModelMock).not.toHaveBeenCalled()
  })

  it('returns an editable proposal with deterministic source provenance', async () => {
    setBacklogReader(ticketReader([report]))
    callTicketDraftModelMock.mockResolvedValueOnce({
      title: 'Avoid repeated canon reads',
      summary: 'Prepared workers should reuse injected canon context.',
      repository: 'virusdave/top-level',
      rationale: 'Top-level owns the agent runtime canon.',
    })
    const response = await server.inject({
      method: 'POST', url: '/api/agent-waste/ticket-draft', payload: requestBody,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.model).toBe('deepseek.v3.2')
    expect(body.filingKey).toMatch(/^[0-9a-f]{64}$/)
    expect(body.draft).toEqual({
      title: 'Avoid repeated canon reads',
      summary: 'Prepared workers should reuse injected canon context.',
      repository: 'virusdave/top-level',
    })
    expect(body.evidenceMarkdown).toContain('repeat-canon')
    expect(callTicketDraftModelMock).toHaveBeenCalledOnce()
  })

  it.each([
    ['agent_waste_ticket_input_too_large', 413],
    ['bedrock_unconfigured', 503],
    ['bedrock_unexpected_response', 502],
  ] as const)('maps %s to HTTP %s', async (code, status) => {
    setBacklogReader(ticketReader([report]))
    callTicketDraftModelMock.mockRejectedValueOnce(new TicketDraftModelError(code, 'safe failure'))
    const response = await server.inject({
      method: 'POST', url: '/api/agent-waste/ticket-draft', payload: requestBody,
    })
    expect(response.statusCode).toBe(status)
    expect(response.json().error).toBe(code)
    expect(response.json().message).not.toContain('safe failure')
  })

  it('rejects oversized verified input before model resolution', async () => {
    const oversizedReport = { ...report, note: 'x'.repeat(140 * 1024) }
    setBacklogReader(ticketReader([oversizedReport]))
    const response = await server.inject({
      method: 'POST',
      url: '/api/agent-waste/ticket-draft',
      payload: { clusterLabel: 'Large report', reports: [oversizedReport] },
    })
    expect(response.statusCode).toBe(413)
    expect(response.json().error).toBe('agent_waste_ticket_input_too_large')
    expect(resolveBedrockModelMock).not.toHaveBeenCalled()
    expect(callTicketDraftModelMock).not.toHaveBeenCalled()
  })

  it('is admin-gated before reading reports or invoking the model', async () => {
    mockState.allow = false
    const readBacklog = vi.fn(async () => [report])
    setBacklogReader({ status: () => ({ available: true, detail: 'x' }), readBacklog })
    const response = await server.inject({
      method: 'POST', url: '/api/agent-waste/ticket-draft', payload: requestBody,
    })
    expect(response.statusCode).toBe(403)
    expect(readBacklog).not.toHaveBeenCalled()
    expect(callTicketDraftModelMock).not.toHaveBeenCalled()
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

  it('clusters every observation with at most two model calls in flight', async () => {
    const many = Array.from({ length: 401 }, (_, i) => ({
      time: 't',
      kind: 'k',
      id: `id-${i}`,
      estimated_wasted_tokens: i === 400 ? 1_000 : 1,
    }))
    setBacklogReader(readerFor(many))
    let activeCalls = 0
    let maxActiveCalls = 0
    callClusterModelMock.mockImplementation(async (batch) => {
      activeCalls += 1
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls)
      await Promise.resolve()
      activeCalls -= 1
      return {
        clusters: [{
          label: `batch ${batch[0].id}`,
          primaryKey: 0,
          memberKeys: Array.from({ length: batch.length }, (_, i) => i),
        }],
      }
    })
    const res = await server.inject({ method: 'POST', url: '/api/agent-waste/clusters', payload: {} })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.clusters.flatMap((cluster: { members: Array<{ id: string }> }) => cluster.members)).toHaveLength(401)
    expect(body.refinementTotal).toBe(3)
    expect(body.refinementSucceeded).toBe(3)
    expect(body.refinementComplete).toBe(true)
    expect(body.coverageComplete).toBe(true)
    expect(body.unclustered).toEqual([])
    expect(maxActiveCalls).toBe(2)
    expect(callClusterModelMock).toHaveBeenCalledTimes(3)
    expect(callClusterModelMock.mock.calls[0][0]).toHaveLength(200)
    expect(callClusterModelMock.mock.calls[1][0]).toHaveLength(200)
    expect(callClusterModelMock.mock.calls[2][0]).toHaveLength(1)
  })

  it('retains complete baseline units when one refinement fails', async () => {
    const many = Array.from({ length: 401 }, (_, i) => ({ time: 't', kind: 'k', id: `id-${i}` }))
    setBacklogReader(readerFor(many))
    callClusterModelMock
      .mockRejectedValueOnce(new ClusterModelError('bedrock_http_error', 'HTTP 500'))
      .mockImplementation(async (batch) => ({ clusters: [{ label: 'ok', primaryKey: 0, memberKeys: Array.from({ length: batch.length }, (_, i) => i) }] }))
    const res = await server.inject({ method: 'POST', url: '/api/agent-waste/clusters', payload: {} })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ inputCount: 401, outputCount: 401, coverageComplete: true, refinementSucceeded: 2, refinementFailed: 1 })
    expect(res.json().warnings).toEqual([{ unit: 0, code: 'model_http_error', count: 1 }])
    expect(res.json().unclustered).toHaveLength(200)
  })

  it('accounts independently for oversized, failed, and successful refinement units', async () => {
    const oversized = Array.from({ length: 201 }, (_, index) => ({ time: `bulk-${index}`, kind: 'bulk', id: 'same' }))
    const singles = Array.from({ length: 201 }, (_, index) => ({ time: `solo-${index}`, kind: `solo${index}`, id: `id${index}` }))
    setBacklogReader(readerFor([...oversized, ...singles]))
    callClusterModelMock
      .mockRejectedValueOnce(new ClusterModelError('bedrock_http_error', 'HTTP 500'))
      .mockImplementation(async (batch) => ({ clusters: [{ label: 'ok', primaryKey: 0, memberKeys: Array.from({ length: batch.length }, (_, i) => i) }] }))

    const res = await server.inject({ method: 'POST', url: '/api/agent-waste/clusters', payload: {} })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      inputCount: 402,
      outputCount: 402,
      coverageComplete: true,
      refinementTotal: 3,
      refinementSucceeded: 1,
      refinementFailed: 1,
      refinementSkipped: 1,
      refinementComplete: false,
    })
    expect(res.json().warnings).toEqual([
      { unit: 0, code: 'partition_too_large', count: 1 },
      { unit: 1, code: 'model_http_error', count: 1 },
    ])
  })

  it('totally orders equal model clusters by their lowest source occurrence', async () => {
    setBacklogReader(readerFor([
      { time: 'a', kind: 'ka', id: 'a', estimated_wasted_tokens: 1 },
      { time: 'b', kind: 'kb', id: 'b', estimated_wasted_tokens: 1 },
    ]))
    callClusterModelMock.mockResolvedValueOnce({ clusters: [
      { label: 'equal', primaryKey: 1, memberKeys: [1] },
      { label: 'equal', primaryKey: 0, memberKeys: [0] },
    ] })

    const res = await server.inject({ method: 'POST', url: '/api/agent-waste/clusters', payload: {} })

    expect(res.statusCode).toBe(200)
    expect(res.json().clusters.map((cluster: { primary: { id: string } }) => cluster.primary.id)).toEqual(['a', 'b'])
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
    expect(body.clusters.flatMap((c: { members: Array<{ id: string }> }) => c.members.map((m) => m.id)).sort()).toEqual(['a', 'b', 'c'])
    expect(body.unclustered).toEqual([])
    expect(body).toMatchObject({ inputCount: 3, outputCount: 3, coverageComplete: true, refinementSucceeded: 1, refinementFailed: 0 })
    expect(callClusterModelMock).toHaveBeenCalledOnce()
  })

  it('returns the complete baseline with a warning when the model is unconfigured', async () => {
    setBacklogReader(readerFor([{ time: 't', kind: 'k', id: 'a' }]))
    callClusterModelMock.mockRejectedValueOnce(
      new ClusterModelError('bedrock_unconfigured', 'no token'),
    )
    const res = await server.inject({ method: 'POST', url: '/api/agent-waste/clusters', payload: {} })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ inputCount: 1, outputCount: 1, refinementFailed: 1, coverageComplete: true })
    expect(res.json().warnings).toEqual([{ unit: 0, code: 'model_unconfigured', count: 1 }])
  })

  it('returns the complete baseline with a warning on gateway failure', async () => {
    setBacklogReader(readerFor([{ time: 't', kind: 'k', id: 'a' }]))
    callClusterModelMock.mockRejectedValueOnce(
      new ClusterModelError('bedrock_http_error', 'HTTP 500'),
    )
    const res = await server.inject({ method: 'POST', url: '/api/agent-waste/clusters', payload: {} })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ inputCount: 1, outputCount: 1, refinementFailed: 1, coverageComplete: true })
    expect(res.json().warnings).toEqual([{ unit: 0, code: 'model_http_error', count: 1 }])
  })

  it('uses a nullable model and preserves baseline output when model lookup fails', async () => {
    setBacklogReader(readerFor([{ time: 't', kind: 'k', id: 'a' }]))
    resolveBedrockModelMock.mockRejectedValueOnce(new Error('lookup unavailable'))
    const res = await server.inject({ method: 'POST', url: '/api/agent-waste/clusters', payload: {} })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ model: null, inputCount: 1, outputCount: 1, refinementFailed: 1, coverageComplete: true })
    expect(res.json().warnings).toEqual([{ unit: 0, code: 'model_lookup_failed', count: 1 }])
    expect(callClusterModelMock).not.toHaveBeenCalled()
  })

  it('rejects incomplete model coverage and retains the whole baseline unit', async () => {
    setBacklogReader(readerFor([
      { time: 't', kind: 'same', id: 'x' },
      { time: 't', kind: 'same', id: 'x' },
    ]))
    callClusterModelMock.mockResolvedValueOnce({ clusters: [{ label: 'partial', primaryKey: 0, memberKeys: [0] }] })
    const res = await server.inject({ method: 'POST', url: '/api/agent-waste/clusters', payload: {} })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ inputCount: 2, outputCount: 2, refinementFailed: 1, coverageComplete: true })
    expect(res.json().clusters[0]).toMatchObject({ count: 2, provenance: 'deterministic' })
    expect(res.json().warnings).toEqual([{ unit: 0, code: 'coverage_invalid', count: 1 }])
  })
})

describe('cluster warning compaction', () => {
  it('orders warnings deterministically and summarizes rows beyond the 50-row cap', () => {
    const warnings = Array.from({ length: 52 }, (_, unit) => ({
      unit,
      code: 'model_http_error' as const,
      count: 1,
    })).reverse()

    const compacted = compactWarnings(warnings)

    expect(compacted).toHaveLength(50)
    expect(compacted.slice(0, 49).map((warning) => warning.unit)).toEqual(Array.from({ length: 49 }, (_, index) => index))
    expect(compacted[49]).toEqual({ unit: null, code: 'warnings_truncated', count: 3 })
  })
})
