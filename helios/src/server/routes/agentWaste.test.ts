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
