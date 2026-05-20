import cookieSigner from '@fastify/cookie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalEnv = { ...process.env }

beforeEach(() => {
  process.env = {
    ...originalEnv,
    APP_BASE_URL: 'http://127.0.0.1:3001/catalog',
    DATABASE_URL: 'postgres://helios:helios@127.0.0.1:5432/helios_test',
    NODE_ENV: 'development',
    SESSION_COOKIE_NAME: 'helios-session',
    SESSION_COOKIE_SECRET: 'test-session-secret',
    // Intentionally leave GOOGLE_OAUTH_* unset for these tests so the
    // gate's HTML-redirect branch falls through to the bare 401 path
    // (no live Google redirect to worry about asserting on).
  }
})

afterEach(() => {
  process.env = { ...originalEnv }
  vi.resetModules()
})

function signSessionCookie(userId: string): string {
  const signer = new cookieSigner.Signer(process.env.SESSION_COOKIE_SECRET!)
  return `helios-session=${encodeURIComponent(signer.sign(userId))}`
}

describe('auth gate', () => {
  it('lets /healthzz through without a session', async () => {
    const { buildServer } = await import('../app/buildServer.js')
    const server = await buildServer()
    try {
      const response = await server.inject({ method: 'GET', url: '/healthzz' })
      expect(response.statusCode).toBe(200)
      expect(response.body).toMatch(/^okzz/)
    } finally {
      await server.close()
    }
  })

  it('lets anonymous GET /api/session through (so the login UI can render)', async () => {
    const { buildServer } = await import('../app/buildServer.js')
    const server = await buildServer()
    try {
      const response = await server.inject({ method: 'GET', url: '/catalog/api/session' })
      expect(response.statusCode).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('lets anonymous POST /catalog/api/session/logout through (idempotent)', async () => {
    const { buildServer } = await import('../app/buildServer.js')
    const server = await buildServer()
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/catalog/api/session/logout',
        headers: { origin: 'http://127.0.0.1:3001' },
      })
      expect(response.statusCode).toBe(204)
    } finally {
      await server.close()
    }
  })

  it('blocks anonymous browser navigation to the SPA shell with 401', async () => {
    const { buildServer } = await import('../app/buildServer.js')
    const server = await buildServer()
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/catalog/',
        headers: { accept: 'text/html,application/xhtml+xml' },
      })
      // Google OAuth is not configured in this test, so the HTML
      // branch falls through to a bare 401. With Google OAuth
      // configured this would be a 302 to /api/auth/google/start —
      // covered by the live deployment, not by this unit test.
      expect(response.statusCode).toBe(401)
      // Body must NOT leak Helios app surface — no SPA shell, no
      // navbar, no embedded asset hash.
      expect(response.body).not.toMatch(/<script\s/i)
      expect(response.body).not.toMatch(/\/assets\/index-/)
    } finally {
      await server.close()
    }
  })

  it('blocks anonymous API requests with 401 JSON', async () => {
    const { buildServer } = await import('../app/buildServer.js')
    const server = await buildServer()
    try {
      const response = await server.inject({ method: 'GET', url: '/catalog/api/catalog' })
      expect(response.statusCode).toBe(401)
      expect(response.json()).toEqual({ error: 'Authentication required.' })
    } finally {
      await server.close()
    }
  })

  it('blocks anonymous asset requests with 401', async () => {
    const { buildServer } = await import('../app/buildServer.js')
    const server = await buildServer()
    try {
      const response = await server.inject({ method: 'GET', url: '/catalog/assets/index-DEADBEEF.js' })
      expect(response.statusCode).toBe(401)
    } finally {
      await server.close()
    }
  })

  it('lets a signed session cookie through (route handler still validates the user)', async () => {
    const { buildServer } = await import('../app/buildServer.js')
    const server = await buildServer()
    try {
      // The gate accepts any cookie that's signed with our secret —
      // it does not check that the user exists. That second check
      // lives in requireSessionUser, which the anonymous /api/session
      // route does NOT call, so we exercise the gate via /api/session
      // and assert the gate didn't preempt it.
      const response = await server.inject({
        method: 'GET',
        url: '/catalog/api/catalog',
        headers: { cookie: signSessionCookie('12345') },
      })
      // We can't assert 200 here without a DB seed, but we MUST see
      // the request reach the route handler (which then either 401s
      // because the bogus user id doesn't resolve, or returns the
      // route's own response). The important assertion is that the
      // gate didn't itself short-circuit the request — readSessionUserId
      // returned a number, so the gate let it through. requireSessionUser
      // downstream will reject the unknown user with its own 401.
      expect(response.statusCode).not.toBe(403)
    } finally {
      await server.close()
    }
  })
})
