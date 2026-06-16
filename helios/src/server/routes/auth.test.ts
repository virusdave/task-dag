import cookieSigner from '@fastify/cookie'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { describeRequiresTestDb } from '../__tests__/requiresTestDb.js'

const originalEnv = { ...process.env }

// Loopback APP_BASE_URL with a base path, plus a matching redirect URI
// so getGoogleOAuthConfigurationIssue() returns null and the OAuth
// routes are "ready" without any network calls (generateAuthUrl is a
// pure string builder; the failure/self-heal branches we test all
// return before exchangeGoogleAuthorizationCode is ever called).
beforeEach(() => {
  process.env = {
    ...originalEnv,
    APP_BASE_URL: 'http://127.0.0.1:3001/catalog',
    DATABASE_URL: 'postgres://helios:helios@127.0.0.1:5432/helios_test',
    NODE_ENV: 'development',
    SESSION_COOKIE_NAME: 'helios-session',
    SESSION_COOKIE_SECRET: 'test-session-secret',
    GOOGLE_OAUTH_CLIENT_ID: 'test-client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_OAUTH_REDIRECT_URI: 'http://127.0.0.1:3001/catalog/api/auth/google/callback',
  }
})

afterEach(() => {
  process.env = { ...originalEnv }
  vi.resetModules()
})

const TXN_COOKIE = 'helios-google-oauth-txn'

function readSetCookie(response: { headers: Record<string, unknown> }): string[] {
  const raw = response.headers['set-cookie']
  if (!raw) return []
  return Array.isArray(raw) ? raw.map(String) : [String(raw)]
}

function signTransaction(state: string, returnTo: string): string {
  const signer = new cookieSigner.Signer(process.env.SESSION_COOKIE_SECRET!)
  const value = signer.sign(JSON.stringify({ returnTo, state }))
  return `${TXN_COOKIE}=${encodeURIComponent(value)}`
}

describeRequiresTestDb('google oauth start', () => {
  it('stores the validated returnTo in the signed transaction cookie and redirects to Google', async () => {
    const { buildServer } = await import('../app/buildServer.js')
    const server = await buildServer()
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/catalog/api/auth/google/start?returnTo=%2Fcatalog%2Freview%3Ftab%3Dx',
      })
      expect(response.statusCode).toBe(302)
      expect(response.headers.location).toContain('accounts.google.com')
      const setCookies = readSetCookie(response)
      const txn = setCookies.find((c) => c.startsWith(`${TXN_COOKIE}=`))
      expect(txn).toBeTruthy()
      // The signed cookie value embeds the returnTo (url-encoded JSON).
      expect(decodeURIComponent(txn!)).toContain('/catalog/review')
      expect(response.headers['cache-control']).toContain('no-store')
    } finally {
      await server.close()
    }
  })

  it('ignores an unsafe returnTo (open redirect) and still starts the flow', async () => {
    const { buildServer } = await import('../app/buildServer.js')
    const server = await buildServer()
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/catalog/api/auth/google/start?returnTo=https%3A%2F%2Fevil.com',
      })
      expect(response.statusCode).toBe(302)
      const txn = readSetCookie(response).find((c) => c.startsWith(`${TXN_COOKIE}=`))
      expect(decodeURIComponent(txn!)).not.toContain('evil.com')
    } finally {
      await server.close()
    }
  })
})

describeRequiresTestDb('google oauth callback', () => {
  it('self-heals (redirects back to start once) when the state cookie is missing on a browser navigation', async () => {
    const { buildServer } = await import('../app/buildServer.js')
    const server = await buildServer()
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/catalog/api/auth/google/callback?code=abc&state=r0.someuuid',
        headers: { accept: 'text/html' },
      })
      expect(response.statusCode).toBe(302)
      expect(response.headers.location).toBe('/catalog/api/auth/google/start?retry=1')
    } finally {
      await server.close()
    }
  })

  it('shows a friendly HTML page (no raw JSON, no loop) after the retry is already spent', async () => {
    const { buildServer } = await import('../app/buildServer.js')
    const server = await buildServer()
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/catalog/api/auth/google/callback?code=abc&state=r1.someuuid',
        headers: { accept: 'text/html' },
      })
      expect(response.statusCode).toBe(401)
      expect(response.headers['content-type']).toContain('text/html')
      expect(response.body).toContain('Try signing in again')
      expect(response.body).not.toContain('state validation failed')
    } finally {
      await server.close()
    }
  })

  it('renders a friendly page (not raw JSON) when Google reports an error', async () => {
    const { buildServer } = await import('../app/buildServer.js')
    const server = await buildServer()
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/catalog/api/auth/google/callback?error=access_denied',
        headers: { accept: 'text/html' },
      })
      expect(response.statusCode).toBe(401)
      expect(response.headers['content-type']).toContain('text/html')
      expect(response.body).toContain('Try signing in again')
    } finally {
      await server.close()
    }
  })

  it('does not auto-redirect non-browser (no text/html) callers on state failure', async () => {
    const { buildServer } = await import('../app/buildServer.js')
    const server = await buildServer()
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/catalog/api/auth/google/callback?code=abc&state=r0.someuuid',
        headers: { accept: 'application/json' },
      })
      // No transparent restart for API-style callers; friendly page only.
      expect(response.statusCode).toBe(401)
      expect(response.headers['content-type']).toContain('text/html')
    } finally {
      await server.close()
    }
  })

  it('preserves returnTo from the transaction cookie when self-healing', async () => {
    const { buildServer } = await import('../app/buildServer.js')
    const server = await buildServer()
    try {
      const response = await server.inject({
        method: 'GET',
        // state in query does NOT match the cookie's state → mismatch → self-heal.
        url: '/catalog/api/auth/google/callback?code=abc&state=r0.querystate',
        headers: {
          accept: 'text/html',
          cookie: signTransaction('r0.cookiestate', '/catalog/review'),
        },
      })
      expect(response.statusCode).toBe(302)
      expect(response.headers.location).toBe(
        '/catalog/api/auth/google/start?returnTo=%2Fcatalog%2Freview&retry=1',
      )
    } finally {
      await server.close()
    }
  })
})
