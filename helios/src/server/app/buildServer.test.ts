import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
  vi.resetModules()
})

describe('buildServer origin validation', () => {
  it('accepts the localhost Vite fallback port for mutating requests in development', async () => {
    process.env = {
      ...originalEnv,
      APP_BASE_URL: 'http://127.0.0.1:3001/catalog',
      DATABASE_URL: 'postgres://helios:helios@127.0.0.1:5432/helios_test',
      NODE_ENV: 'development',
      SESSION_COOKIE_SECRET: 'test-session-secret',
    }

    const { buildServer } = await import('./buildServer.js')
    const server = await buildServer()

    try {
      const response = await server.inject({
        headers: {
          origin: 'http://localhost:5174',
        },
        method: 'POST',
        url: '/catalog/api/session/logout',
      })

      expect(response.statusCode).toBe(204)
    } finally {
      await server.close()
    }
  })

  it('rejects unconfigured origins for mutating requests', async () => {
    process.env = {
      ...originalEnv,
      APP_BASE_URL: 'http://127.0.0.1:3001/catalog',
      DATABASE_URL: 'postgres://helios:helios@127.0.0.1:5432/helios_test',
      NODE_ENV: 'development',
      SESSION_COOKIE_SECRET: 'test-session-secret',
    }

    const { buildServer } = await import('./buildServer.js')
    const server = await buildServer()

    try {
      const response = await server.inject({
        headers: {
          origin: 'https://malicious.example.com',
        },
        method: 'POST',
        url: '/catalog/api/session/logout',
      })

      expect(response.statusCode).toBe(403)
      expect(response.json()).toEqual({ error: 'Origin validation failed.' })
    } finally {
      await server.close()
    }
  })
})
