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

import { registerAgentWasteRoutes } from './agentWaste.js'
import {
  __resetBacklogReaderForTests,
  setBacklogReader,
  type BacklogReader,
} from '../agentWasteRepo.js'

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
