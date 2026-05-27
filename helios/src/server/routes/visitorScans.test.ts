// In-process webhook smoke checks via server.inject(). Covers the
// auth gate decisions that don't touch the database (so we don't
// need a live postgres in CI):
//
//   - 503 when VERISCAN_WEBHOOK_TOKEN is unset on the server
//     (fail-closed)
//   - 401 when the request has no Authorization header
//   - 401 when the bearer scheme is wrong or the value mismatches
//   - 400 when the envelope is missing Type / EventId / Data.HashId
//
// The "happy path returns 200" + "replay is idempotent" assertions
// live in docs/runbooks/visitor-scans-veriscan-webhook-smoke-test.md
// because they require a real Postgres.

import { afterEach, describe, expect, it, vi } from 'vitest'

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

const VALID_ENVELOPE = {
  Type: 'CreateCard',
  EventId: 1,
  WebHookId: 1,
  Created: '2026-05-27T00:00:00Z',
  Sent: '2026-05-27T00:00:00Z',
  Data: {
    HashId: '11111111-2222-3333-4444-555555555555',
    Scanned: '2026-05-27T00:00:00Z',
    FirstName: 'Smoke',
    LastName: 'Test',
    State: 'NY',
    PostalCode: '10451',
  },
}

async function buildIsolatedServer() {
  // Each test must do its own dynamic import AFTER setting env so
  // the cached server env picks up the per-case VERISCAN_WEBHOOK_TOKEN
  // — `vi.resetModules()` in afterEach guarantees the singleton is
  // fresh on the next import.
  const { buildServer } = await import('../app/buildServer.js')
  return buildServer()
}

describe('veriscan webhook auth gate', () => {
  it('returns 503 when VERISCAN_WEBHOOK_TOKEN is unset', async () => {
    process.env = { ...originalEnv, ...BASE_ENV }
    delete process.env.VERISCAN_WEBHOOK_TOKEN

    const server = await buildIsolatedServer()
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/wh/bx/veriscan/checkin',
        headers: { authorization: 'Bearer whatever', 'content-type': 'application/json' },
        payload: VALID_ENVELOPE,
      })
      expect(response.statusCode).toBe(503)
    } finally {
      await server.close()
    }
  })

  it('returns 401 when the Authorization header is missing', async () => {
    process.env = {
      ...originalEnv,
      ...BASE_ENV,
      VERISCAN_WEBHOOK_TOKEN: 'expected-token-abc123',
    }

    const server = await buildIsolatedServer()
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/wh/bx/veriscan/checkin',
        headers: { 'content-type': 'application/json' },
        payload: VALID_ENVELOPE,
      })
      expect(response.statusCode).toBe(401)
      expect(response.body).toBe('')
    } finally {
      await server.close()
    }
  })

  it('returns 401 when the bearer scheme is malformed', async () => {
    process.env = {
      ...originalEnv,
      ...BASE_ENV,
      VERISCAN_WEBHOOK_TOKEN: 'expected-token-abc123',
    }

    const server = await buildIsolatedServer()
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/wh/bx/veriscan/checkin',
        headers: { authorization: 'Token expected-token-abc123', 'content-type': 'application/json' },
        payload: VALID_ENVELOPE,
      })
      expect(response.statusCode).toBe(401)
    } finally {
      await server.close()
    }
  })

  it('returns 401 when the bearer value does not match', async () => {
    process.env = {
      ...originalEnv,
      ...BASE_ENV,
      VERISCAN_WEBHOOK_TOKEN: 'expected-token-abc123',
    }

    const server = await buildIsolatedServer()
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/wh/bx/veriscan/checkin',
        headers: { authorization: 'Bearer not-the-right-token', 'content-type': 'application/json' },
        payload: VALID_ENVELOPE,
      })
      expect(response.statusCode).toBe(401)
    } finally {
      await server.close()
    }
  })

  it('accepts case-insensitive Bearer and rejects the envelope on missing HashId', async () => {
    process.env = {
      ...originalEnv,
      ...BASE_ENV,
      VERISCAN_WEBHOOK_TOKEN: 'expected-token-abc123',
    }

    const server = await buildIsolatedServer()
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/wh/mh/veriscan/checkin',
        headers: { authorization: 'bearer expected-token-abc123', 'content-type': 'application/json' },
        payload: {
          ...VALID_ENVELOPE,
          Data: { ...VALID_ENVELOPE.Data, HashId: undefined },
        },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: expect.stringMatching(/envelope/i) })
    } finally {
      await server.close()
    }
  })
})
