// In-process ingest smoke checks via server.inject(). Covers the
// auth + validation decisions that don't touch the database (so we
// don't need a live postgres in CI):
//
//   - 503 when LP_EVENTS_INGEST_TOKEN is unset on the server
//     (fail-closed)
//   - 401 when the request has no / a malformed / a mismatched bearer
//   - 400 when the batch body fails the frozen contract
//
// The "happy path returns 200 + idempotent replay" assertions require
// a real Postgres and live in the P1 ingest runbook.

import { afterEach, expect, it, vi } from 'vitest'

import { describeRequiresTestDb } from '../__tests__/requiresTestDb.js'

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
  vi.resetModules()
})

const BASE_ENV = {
  APP_BASE_URL: 'http://127.0.0.1:3001/',
  DATABASE_URL: 'postgres://helios:helios@127.0.0.1:5432/helios_test',
  NODE_ENV: 'development',
  SESSION_COOKIE_SECRET: 'test-session-secret',
}

const VALID_BATCH = {
  schema: 'freshlybaked.lp.events-batch.v1',
  replica_id: 'mss-replica-a',
  sent_at: '2026-06-11T00:00:00.000Z',
  events: [
    {
      event_id: 'evt-1',
      event_type: 'lp_impression',
      event_ts: '2026-06-11T00:00:00.000Z',
      replica_id: 'mss-replica-a',
      bundle_id: 'lpb_2026-06-11_000000_abcdef',
      policy_id: 'pol-1',
      site: 'freshlybaked.nyc',
    },
  ],
}

async function buildIsolatedServer() {
  const { buildServer } = await import('../app/buildServer.js')
  return buildServer()
}

describeRequiresTestDb('lp-events ingest auth + validation gate', () => {
  it('returns 503 when LP_EVENTS_INGEST_TOKEN is unset', async () => {
    process.env = { ...originalEnv, ...BASE_ENV }
    delete process.env.LP_EVENTS_INGEST_TOKEN

    const server = await buildIsolatedServer()
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/lp-events/batch',
        headers: { authorization: 'Bearer whatever', 'content-type': 'application/json' },
        payload: VALID_BATCH,
      })
      expect(response.statusCode).toBe(503)
    } finally {
      await server.close()
    }
  })

  it('returns 401 when the Authorization header is missing', async () => {
    process.env = { ...originalEnv, ...BASE_ENV, LP_EVENTS_INGEST_TOKEN: 'expected-token-abc123' }

    const server = await buildIsolatedServer()
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/lp-events/batch',
        headers: { 'content-type': 'application/json' },
        payload: VALID_BATCH,
      })
      expect(response.statusCode).toBe(401)
      expect(response.body).toBe('')
    } finally {
      await server.close()
    }
  })

  it('returns 401 when the bearer scheme is malformed', async () => {
    process.env = { ...originalEnv, ...BASE_ENV, LP_EVENTS_INGEST_TOKEN: 'expected-token-abc123' }

    const server = await buildIsolatedServer()
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/lp-events/batch',
        headers: { authorization: 'Token expected-token-abc123', 'content-type': 'application/json' },
        payload: VALID_BATCH,
      })
      expect(response.statusCode).toBe(401)
    } finally {
      await server.close()
    }
  })

  it('returns 401 when the bearer value does not match', async () => {
    process.env = { ...originalEnv, ...BASE_ENV, LP_EVENTS_INGEST_TOKEN: 'expected-token-abc123' }

    const server = await buildIsolatedServer()
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/lp-events/batch',
        headers: { authorization: 'Bearer not-the-right-token', 'content-type': 'application/json' },
        payload: VALID_BATCH,
      })
      expect(response.statusCode).toBe(401)
    } finally {
      await server.close()
    }
  })

  it('returns 400 (case-insensitive Bearer accepted) when the batch fails the contract', async () => {
    process.env = { ...originalEnv, ...BASE_ENV, LP_EVENTS_INGEST_TOKEN: 'expected-token-abc123' }

    const server = await buildIsolatedServer()
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/lp-events/batch',
        headers: { authorization: 'bearer expected-token-abc123', 'content-type': 'application/json' },
        payload: { ...VALID_BATCH, events: [] },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: expect.stringMatching(/batch/i) })
    } finally {
      await server.close()
    }
  })
})
