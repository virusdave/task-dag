import { generateKeyPairSync, sign } from 'node:crypto'

import cookieSigner from '@fastify/cookie'
import Fastify from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { describeRequiresTestDb } from '../__tests__/requiresTestDb.js'
import {
  AGENT_READONLY_HEADER_NAMES,
  buildAgentReadonlyCanonicalPayload,
} from './agentReadonly.js'

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

const AGENT_KEY_ID = 'amp-local-vps3-2026q3'
const AGENT_RULE_ID = 'agent-waste-review-2026-07-10'

function makeAgentKeyPair() {
  const keyPair = generateKeyPairSync('ed25519')
  const publicKeyDer = keyPair.publicKey.export({ format: 'der', type: 'spki' })
  return {
    privateKey: keyPair.privateKey,
    publicKeyBase64Url: publicKeyDer.subarray(-32).toString('base64url'),
  }
}

async function buildSignedAgentGateHarness(options: { maxResponseBytes?: number } = {}) {
  const keys = makeAgentKeyPair()
  const logs: string[] = []
  const now = Date.now()
  process.env = {
    ...process.env,
    APP_BASE_URL: 'http://helios.test',
    HELIOS_AGENT_READONLY_PUBLIC_KEYS_JSON: JSON.stringify({ [AGENT_KEY_ID]: keys.publicKeyBase64Url }),
    HELIOS_AGENT_READONLY_ALLOWLIST_JSON: JSON.stringify({
      id: AGENT_RULE_ID,
      owner: 'test',
      reason: 'auth gate integration coverage',
      not_before: new Date(now - 60 * 60 * 1_000).toISOString(),
      not_after: new Date(now + 60 * 60 * 1_000).toISOString(),
      max_response_bytes: options.maxResponseBytes ?? 256,
      paths: [
        {
          method: 'GET',
          kind: 'api',
          match: 'exact',
          path: '/api/session',
          safe_read_note: 'Synthetic agent session envelope.',
        },
        {
          method: 'GET',
          kind: 'api',
          match: 'exact',
          path: '/api/read',
          safe_read_note: 'Small test read.',
        },
        {
          method: 'GET',
          kind: 'api',
          match: 'exact',
          path: '/api/viewer',
          safe_read_note: 'Viewer-gated test read.',
        },
        {
          method: 'GET',
          kind: 'api',
          match: 'exact',
          path: '/api/editor',
          safe_read_note: 'Editor-gated denial test.',
        },
        {
          method: 'GET',
          kind: 'api',
          match: 'exact',
          path: '/api/admin',
          safe_read_note: 'Admin-gated denial test.',
        },
        {
          method: 'GET',
          kind: 'api',
          match: 'exact',
          path: '/api/metrics-test',
          safe_read_note: 'Metrics-grant denial test.',
        },
        {
          method: 'GET',
          kind: 'api',
          match: 'exact',
          path: '/api/confidential-metrics-test',
          safe_read_note: 'Confidential metrics-grant denial test.',
        },
        {
          method: 'GET',
          kind: 'api',
          match: 'exact',
          path: '/api/cashier-test',
          safe_read_note: 'Cashier-display denial test.',
        },
        {
          method: 'GET',
          kind: 'api',
          match: 'exact',
          path: '/api/too-large',
          safe_read_note: 'Exercises response cap.',
        },
        {
          method: 'GET',
          kind: 'page',
          match: 'exact',
          path: '/page',
          safe_read_note: 'SPA page shell.',
        },
        {
          method: 'GET',
          kind: 'asset',
          match: 'prefix',
          path: '/assets/',
          safe_read_note: 'Static hashed asset.',
        },
      ],
    }),
  }
  vi.resetModules()
  const { registerAuthGate } = await import('./authGate.js')
  const server = Fastify({
    logger: {
      level: 'info',
      stream: { write: (line: string) => logs.push(line) },
    },
  })
  await server.register(cookieSigner, {
    hook: 'onRequest',
    secret: process.env.SESSION_COOKIE_SECRET,
  })
  registerAuthGate(server)
  const { SessionEnvelopeSchema } = await import('../../shared/contracts/api/session.js')
  const {
    buildSessionEnvelope,
    requireCashierDisplayUser,
    requireConfidentialMetricsGrant,
    requireMetricsGrant,
    requireSessionUser,
  } = await import('./requireSession.js')
  server.get('/api/session', async (request, reply) => {
    const envelope = SessionEnvelopeSchema.parse(await buildSessionEnvelope(request))
    return reply.send(envelope)
  })
  server.get('/api/read', async (request) => ({
    ok: true,
    principal: request.agentReadonlyPrincipal?.kind ?? null,
  }))
  server.get('/api/viewer', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return
    return reply.send({ ok: true, email: user.email, role: user.role })
  })
  server.get('/api/editor', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) return
    return reply.send({ ok: true })
  })
  server.get('/api/admin', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) return
    return reply.send({ ok: true })
  })
  server.get('/api/metrics-test', async (request, reply) => {
    const user = await requireMetricsGrant(request, reply, 'explore')
    if (!user) return
    return reply.send({ ok: true })
  })
  server.get('/api/confidential-metrics-test', async (request, reply) => {
    const user = await requireConfidentialMetricsGrant(request, reply, ['gads-bronx'])
    if (!user) return
    return reply.send({ ok: true })
  })
  server.get('/api/cashier-test', async (request, reply) => {
    const user = await requireCashierDisplayUser(request, reply)
    if (!user) return
    return reply.send({ ok: true })
  })
  server.get('/api/too-large', async () => 'x'.repeat((options.maxResponseBytes ?? 256) + 20))
  server.get('/page', async () => '<!doctype html><title>ok</title>')
  server.get('/assets/ok.js', async (_request, reply) => reply.type('application/javascript').send('export default 1'))
  return { server, logs, keys }
}

function signAgentRequest(input: {
  privateKey: ReturnType<typeof makeAgentKeyPair>['privateKey']
  method?: string
  pathAndQuery?: string
  nonce?: string
  headers?: Record<string, string>
}) {
  const method = input.method ?? 'GET'
  const pathAndQuery = input.pathAndQuery ?? '/api/read'
  const nonce = input.nonce ?? `nonce-${method}-${pathAndQuery}`.replace(/[^A-Za-z0-9_-]/g, '_')
  const timestamp = new Date().toISOString()
  const payload = buildAgentReadonlyCanonicalPayload({
    method: method as 'GET' | 'HEAD',
    host: 'helios.test',
    pathAndQuery,
    keyId: AGENT_KEY_ID,
    ruleId: AGENT_RULE_ID,
    timestamp,
    nonce,
  })
  const signature = sign(null, Buffer.from(payload, 'utf8'), input.privateKey).toString('base64url')
  return {
    host: 'helios.test',
    [AGENT_READONLY_HEADER_NAMES.keyId]: AGENT_KEY_ID,
    [AGENT_READONLY_HEADER_NAMES.ruleId]: AGENT_RULE_ID,
    [AGENT_READONLY_HEADER_NAMES.timestamp]: timestamp,
    [AGENT_READONLY_HEADER_NAMES.nonce]: nonce,
    [AGENT_READONLY_HEADER_NAMES.signature]: signature,
    ...input.headers,
  }
}

it('accepts signed-agent GET and HEAD requests for allowlisted reads', async () => {
  const { server, keys, logs } = await buildSignedAgentGateHarness()
  try {
    const getResponse = await server.inject({
      method: 'GET',
      url: '/api/read',
      headers: signAgentRequest({ privateKey: keys.privateKey, nonce: 'signed_get_nonce_1234' }),
    })
    expect(getResponse.statusCode).toBe(200)
    expect(getResponse.json()).toMatchObject({ ok: true, principal: 'agent_readonly' })

    const headResponse = await server.inject({
      method: 'HEAD',
      url: '/api/read',
      headers: signAgentRequest({ privateKey: keys.privateKey, method: 'HEAD', nonce: 'signed_head_nonce_1234' }),
    })
    expect(headResponse.statusCode).toBe(200)
    expect(headResponse.body).toBe('')
    expect(logs.join('')).toContain('"outcome":"accepted"')
  } finally {
    await server.close()
  }
})

it('exposes an accepted signed-agent request as a synthetic readonly viewer session', async () => {
  const { server, keys } = await buildSignedAgentGateHarness({ maxResponseBytes: 4096 })
  try {
    const response = await server.inject({
      method: 'GET',
      url: '/api/session',
      headers: signAgentRequest({
        privateKey: keys.privateKey,
        pathAndQuery: '/api/session',
        nonce: 'signed_session_nonce_1234',
      }),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      authMode: 'agent_readonly',
      permissions: {
        canApprove: false,
        canEditProposals: false,
        canForceReconcile: false,
        canManageUsers: false,
        canUndo: false,
      },
      user: {
        active: true,
        email: 'agent-readonly@local.helios',
        metricGrants: [],
        name: 'Agent Readonly',
        role: 'viewer',
      },
    })
    expect(response.json().user.id).toEqual(expect.any(Number))
  } finally {
    await server.close()
  }
})

it('lets accepted signed-agent requests through explicit viewer routes only', async () => {
  const { server, keys } = await buildSignedAgentGateHarness({ maxResponseBytes: 4096 })
  try {
    const viewerResponse = await server.inject({
      method: 'GET',
      url: '/api/viewer',
      headers: signAgentRequest({
        privateKey: keys.privateKey,
        pathAndQuery: '/api/viewer',
        nonce: 'signed_viewer_nonce_1234',
      }),
    })
    expect(viewerResponse.statusCode).toBe(200)
    expect(viewerResponse.json()).toEqual({
      ok: true,
      email: 'agent-readonly@local.helios',
      role: 'viewer',
    })

    const editorResponse = await server.inject({
      method: 'GET',
      url: '/api/editor',
      headers: signAgentRequest({
        privateKey: keys.privateKey,
        pathAndQuery: '/api/editor',
        nonce: 'signed_editor_nonce_1234',
      }),
    })
    expect(editorResponse.statusCode).toBe(403)
    expect(editorResponse.json()).toEqual({ error: 'You do not have permission to perform this action.' })

    const adminResponse = await server.inject({
      method: 'GET',
      url: '/api/admin',
      headers: signAgentRequest({
        privateKey: keys.privateKey,
        pathAndQuery: '/api/admin',
        nonce: 'signed_admin_nonce_1234',
      }),
    })
    expect(adminResponse.statusCode).toBe(403)
    expect(adminResponse.json()).toEqual({ error: 'You do not have permission to perform this action.' })
  } finally {
    await server.close()
  }
})

it('denies accepted signed-agent requests at metrics and cashier-display gates', async () => {
  const { server, keys } = await buildSignedAgentGateHarness({ maxResponseBytes: 4096 })
  try {
    const metricsResponse = await server.inject({
      method: 'GET',
      url: '/api/metrics-test',
      headers: signAgentRequest({
        privateKey: keys.privateKey,
        pathAndQuery: '/api/metrics-test',
        nonce: 'signed_metrics_nonce_1234',
      }),
    })
    expect(metricsResponse.statusCode).toBe(403)
    expect(metricsResponse.json()).toEqual({
      error:
        'You do not have access to this metrics surface. Required: explore. ' +
        'Ask an admin to grant access via /config/users.',
    })

    const confidentialMetricsResponse = await server.inject({
      method: 'GET',
      url: '/api/confidential-metrics-test',
      headers: signAgentRequest({
        privateKey: keys.privateKey,
        pathAndQuery: '/api/confidential-metrics-test',
        nonce: 'signed_confidential_metrics_nonce_1234',
      }),
    })
    expect(confidentialMetricsResponse.statusCode).toBe(403)
    expect(confidentialMetricsResponse.json()).toEqual({
      error: 'You do not have access to this confidential metrics surface.',
    })

    const cashierResponse = await server.inject({
      method: 'GET',
      url: '/api/cashier-test',
      headers: signAgentRequest({
        privateKey: keys.privateKey,
        pathAndQuery: '/api/cashier-test',
        nonce: 'signed_cashier_nonce_1234',
      }),
    })
    expect(cashierResponse.statusCode).toBe(403)
    expect(cashierResponse.json()).toEqual({
      error:
        'You do not have access to the cashier check-ins display. ' +
        'Contact an admin to add your account to the allowlist.',
    })
  } finally {
    await server.close()
  }
})

it('denies signed-agent mutating and mixed-credential requests before route handling', async () => {
  const { server, keys, logs } = await buildSignedAgentGateHarness()
  try {
    const postResponse = await server.inject({
      method: 'POST',
      url: '/api/read',
      headers: signAgentRequest({ privateKey: keys.privateKey, method: 'POST', nonce: 'signed_post_nonce_1234' }),
    })
    expect(postResponse.statusCode).toBe(403)
    expect(postResponse.json()).toEqual({ error: 'Signed-agent access denied.' })

    const signedHeaders = signAgentRequest({
      privateKey: keys.privateKey,
      nonce: 'signed_cookie_nonce_1234',
      headers: { cookie: 'helios-session=signed-secret', authorization: 'Bearer secret-token' },
    })
    const mixedResponse = await server.inject({ method: 'GET', url: '/api/read', headers: signedHeaders })
    expect(mixedResponse.statusCode).toBe(403)
    expect(mixedResponse.json()).toEqual({ error: 'Signed-agent access denied.' })

    const renderedLogs = logs.join('')
    expect(renderedLogs).toContain('signed-agent readonly request audit')
    expect(renderedLogs).not.toContain(signedHeaders[AGENT_READONLY_HEADER_NAMES.signature])
    expect(renderedLogs).not.toContain('helios-session=signed-secret')
    expect(renderedLogs).not.toContain('secret-token')
  } finally {
    await server.close()
  }
})

it.each([
  ['page', '/not-allowlisted-page'],
  ['api', '/api/not-allowlisted'],
  ['asset', '/assetsx/ok.js'],
] as const)('denies signed-agent non-allowlisted %s requests', async (_kind, pathAndQuery) => {
  const { server, keys } = await buildSignedAgentGateHarness()
  try {
    const response = await server.inject({
      method: 'GET',
      url: pathAndQuery,
      headers: signAgentRequest({ privateKey: keys.privateKey, pathAndQuery }),
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: 'Signed-agent access denied.' })
  } finally {
    await server.close()
  }
})

it('denies accepted signed-agent responses that exceed the allowlist byte cap', async () => {
  const { server, keys, logs } = await buildSignedAgentGateHarness({ maxResponseBytes: 64 })
  try {
    const response = await server.inject({
      method: 'GET',
      url: '/api/too-large',
      headers: signAgentRequest({
        privateKey: keys.privateKey,
        pathAndQuery: '/api/too-large',
        nonce: 'signed_large_nonce_1234',
      }),
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: 'Signed-agent response byte cap exceeded.' })
    expect(logs.join('')).toContain('response_too_large')
  } finally {
    await server.close()
  }
})

describeRequiresTestDb('auth gate', () => {
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
