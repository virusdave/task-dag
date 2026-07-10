import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { joinBasePath } from '../../shared/config/appBasePath.js'
import { normalizeReturnTo } from '../../shared/config/returnTo.js'
import { getServerEnv, isGoogleOAuthReady, type ServerEnv } from '../config/env.js'
import {
  createAgentReadonlyVerifier,
  isSignedAgentReadonlyRequest,
  type AgentReadonlyConfig,
  type AgentReadonlyVerificationResult,
} from './agentReadonly.js'
import { readSessionUserId } from './sessionCookie.js'

// Paths that are always reachable without a session. These are the
// endpoints that participate in *establishing* a session (Google OAuth
// dance, local dev login) or in inspecting/tearing down the current
// session (the SPA's anonymous /api/session call drives the login
// page itself; logout is idempotent and must work even if the cookie
// is already gone).
//
// Everything else — every other API route, every SPA navigation, every
// hashed asset bundle, every static file — is gated. Unauthenticated
// HTML navigations get redirected into the login flow; everything else
// gets a flat 401 with no body content beyond the error string. The
// goal is that an anonymous visitor sees nothing about Helios beyond
// the URL and the name itself.
interface LoginFlowEndpoint {
  method: 'GET' | 'POST'
  appRelativePath: string
}

const LOGIN_FLOW_ENDPOINTS: readonly LoginFlowEndpoint[] = [
  { method: 'GET', appRelativePath: '/api/auth/google/start' },
  { method: 'GET', appRelativePath: '/api/auth/google/callback' },
  { method: 'POST', appRelativePath: '/api/auth/dev-login' },
  // The SPA login screen calls /api/session anonymously to discover
  // which sign-in options are configured (Google OAuth vs. local-dev).
  // The session envelope for anonymous callers contains no app data
  // beyond auth-flow flags.
  { method: 'GET', appRelativePath: '/api/session' },
  // Logout must be callable when there is no session (it's a no-op
  // cookie clear) so a stale browser tab can always recover.
  { method: 'POST', appRelativePath: '/api/session/logout' },
  // Public bulk-flower menu projection. Read-only, no cost / GM /
  // provenance — see registerWhiteglovePricingRoutes for the
  // projection. Consumed by the mostly-static-sites
  // freshlybaked.nyc/white-glove/bulk-flower page.
  { method: 'GET', appRelativePath: '/api/whiteglove/public/bulk-flower' },
  // Public "Meet The Team" projection: approved staff only, with
  // only firstName + photoUrl exposed. Consumed by the
  // mostly-static-sites freshlybaked.nyc/about-us page. The
  // editorial layer (approve/reject) lives behind the Utilities →
  // Staff page in Helios.
  { method: 'GET', appRelativePath: '/api/staff/public/team' },
  // Public Customer-Sentiment Capture submission endpoints (issue
  // #13, A1). Called by the mostly-static-sites public landing page
  // on behalf of an unauthenticated customer. Server-level kill
  // switch lives in env.reviewsCaptureV1Enabled
  // (HELIOS_REVIEWS_CAPTURE_V1=1); per-site kill switch lives in
  // site_review_settings.review_drawing_enabled. The drawing-entry
  // endpoint is matched as a prefix below via isLoginFlowRequest so
  // any UUID submissionId is allowed without needing per-id
  // allowlisting.
  { method: 'POST', appRelativePath: '/v1/reviews/submit' },
  // Unified-landing-engine event ingest (parent virusdave/top-level#13
  // / child FreshlyBakedNYC/automation#42, P1). Called service-to-
  // service by the mostly-static-sites landing runtime's batch
  // flusher; it does its own constant-time `Authorization: Bearer`
  // check against LP_EVENTS_INGEST_TOKEN inside the handler (see
  // routes/lpEvents.ts), so it must bypass the SPA session gate.
  { method: 'POST', appRelativePath: '/v1/lp-events/batch' },
]

// Public POST endpoints whose appPath starts with one of these
// prefixes are allowed through the auth gate. Used for routes whose
// path includes a customer-supplied identifier (e.g. the submission
// uuid) that we can't enumerate up front.
const LOGIN_FLOW_PREFIXES: ReadonlyArray<{ method: 'GET' | 'POST'; prefix: string; suffix: string }> = [
  { method: 'POST', prefix: '/v1/reviews/', suffix: '/drawing-entry' },
]

let cachedAgentReadonlyConfig: AgentReadonlyConfig | null = null
let cachedAgentReadonlyVerifier: ReturnType<typeof createAgentReadonlyVerifier> | null = null

export function registerAuthGate(server: FastifyInstance): void {
  server.addHook('onRequest', async (request, reply) => {
    const env = getServerEnv()
    const pathOnly = stripQuery(request.url)
    const appPath = stripAppBasePath(pathOnly, env.appBasePath)

    if (isSignedAgentReadonlyRequest(request.headers)) {
      const verification = getAgentReadonlyVerifier(env.agentReadonly).verify({
        method: request.method,
        host: request.headers.host,
        pathAndQuery: `${appPath}${extractQuery(request.url)}`,
        headers: request.headers,
      })
      if (!verification.ok) {
        auditDeniedSignedAgentRequest(request, verification)
        return reply.status(verification.statusCode).send({ error: 'Signed-agent access denied.' })
      }
      attachAgentReadonlyPrincipal(request, verification)
      return
    }

    // /healthzz is registered at the absolute root (not under the
    // appBasePath) for infrastructure probes and must never require
    // authentication.
    if (pathOnly === '/healthzz') {
      return
    }

    // VeriScan webhook receivers (POST /wh/{bx,mh}/veriscan/checkin)
    // are also mounted at the absolute server root and must never
    // require the SPA session cookie. They do their own
    // `Authorization: Bearer` constant-time check against
    // VERISCAN_WEBHOOK_TOKEN inside the handler — see
    // routes/visitorScans.ts and
    // virusdave/top-level#9 / FreshlyBakedNYC/automation#31.
    if (request.method === 'POST' && pathOnly.startsWith('/wh/')) {
      return
    }

    if (isLoginFlowRequest(request.method, appPath)) {
      return
    }

    if (hasSignedSessionCookie(request)) {
      // Signed cookie present and valid (i.e. produced by our server
      // with the current SESSION_COOKIE_SECRET). The route handlers
      // still independently verify the user exists and is active via
      // requireSessionUser — the gate only needs to keep total
      // strangers from seeing app surface, and a forged cookie would
      // require knowing the cookie secret, which is itself a complete
      // compromise.
      return
    }

    return respondUnauthenticated(request, reply, env, appPath)
  })

  server.addHook('onSend', async (request, reply, payload) => {
    const principal = request.agentReadonlyPrincipal
    if (!principal) {
      return payload
    }
    if (request.method === 'HEAD' || payload === null || payload === undefined) {
      request.agentReadonlyAudit = {
        ...request.agentReadonlyAudit,
        outcome: 'accepted',
        method: principal.method,
        pathAndQuery: principal.pathAndQuery,
        statusCode: reply.statusCode,
        responseBytes: 0,
      }
      return payload
    }
    if (isStreamPayload(payload)) {
      request.agentReadonlyAudit = {
        ...request.agentReadonlyAudit,
        outcome: 'denied',
        reason: 'response_too_large',
        method: principal.method,
        pathAndQuery: principal.pathAndQuery,
        statusCode: 403,
        responseBytes: principal.maxResponseBytes + 1,
      }
      reply.status(403).type('application/json; charset=utf-8')
      return JSON.stringify({ error: 'Signed-agent response byte cap exceeded.' })
    }

    const responseBytes = Buffer.isBuffer(payload)
      ? payload.byteLength
      : Buffer.byteLength(String(payload), 'utf8')
    if (responseBytes > principal.maxResponseBytes) {
      request.agentReadonlyAudit = {
        ...request.agentReadonlyAudit,
        outcome: 'denied',
        reason: 'response_too_large',
        method: principal.method,
        pathAndQuery: principal.pathAndQuery,
        statusCode: 403,
        responseBytes,
      }
      reply.status(403).type('application/json; charset=utf-8')
      return JSON.stringify({ error: 'Signed-agent response byte cap exceeded.' })
    }

    request.agentReadonlyAudit = {
      ...request.agentReadonlyAudit,
      outcome: 'accepted',
      method: principal.method,
      pathAndQuery: principal.pathAndQuery,
      statusCode: reply.statusCode,
      responseBytes,
    }
    return payload
  })

  server.addHook('onResponse', async (request, reply) => {
    const audit = request.agentReadonlyAudit
    if (!audit) {
      return
    }
    const logFields = {
      outcome: audit.outcome,
      reason: audit.reason,
      keyId: audit.keyId,
      ruleId: audit.ruleId,
      method: audit.method,
      pathAndQuery: audit.pathAndQuery,
      pathKind: audit.pathKind,
      statusCode: audit.statusCode ?? reply.statusCode,
      responseBytes: audit.responseBytes,
      maxResponseBytes: audit.maxResponseBytes,
      nonce: audit.nonce,
      remoteAddress: request.ip,
      forwardedFor: request.headers['x-forwarded-for'],
      forwardedHost: request.headers['x-forwarded-host'],
      userAgent: request.headers['user-agent'],
    }
    const message = 'signed-agent readonly request audit'
    if (audit.outcome === 'accepted') {
      request.log.info(logFields, message)
    } else {
      request.log.warn(logFields, message)
    }
  })
}

function getAgentReadonlyVerifier(config: AgentReadonlyConfig): ReturnType<typeof createAgentReadonlyVerifier> {
  if (cachedAgentReadonlyConfig !== config || cachedAgentReadonlyVerifier === null) {
    cachedAgentReadonlyConfig = config
    cachedAgentReadonlyVerifier = createAgentReadonlyVerifier(config)
  }
  return cachedAgentReadonlyVerifier
}

function auditDeniedSignedAgentRequest(
  request: FastifyRequest,
  result: Extract<AgentReadonlyVerificationResult, { ok: false }>,
): void {
  request.agentReadonlyAudit = {
    outcome: 'denied',
    reason: result.reason,
    keyId: result.keyId,
    ruleId: result.ruleId,
    method: result.method ?? request.method,
    pathAndQuery: result.pathAndQuery ?? request.url,
    statusCode: result.statusCode,
  }
}

function attachAgentReadonlyPrincipal(
  request: FastifyRequest,
  result: Extract<AgentReadonlyVerificationResult, { ok: true }>,
): void {
  request.agentReadonlyPrincipal = {
    kind: 'agent_readonly',
    keyId: result.keyId,
    ruleId: result.ruleId,
    method: result.method,
    pathAndQuery: result.pathAndQuery,
    pathKind: result.pathRule.kind,
    pathMatch: result.pathRule.match,
    pathRule: result.pathRule.path,
    safeReadNote: result.pathRule.safeReadNote,
    maxResponseBytes: result.maxResponseBytes,
  }
  request.agentReadonlyAudit = {
    outcome: 'accepted',
    keyId: result.keyId,
    ruleId: result.ruleId,
    method: result.method,
    pathAndQuery: result.pathAndQuery,
    pathKind: result.pathRule.kind,
    maxResponseBytes: result.maxResponseBytes,
    nonce: result.nonce,
  }
}

function isStreamPayload(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && 'pipe' in payload && typeof payload.pipe === 'function'
}

function isLoginFlowRequest(method: string, appPath: string): boolean {
  if (
    LOGIN_FLOW_ENDPOINTS.some(
      (endpoint) => endpoint.method === method && endpoint.appRelativePath === appPath,
    )
  ) {
    return true
  }
  return LOGIN_FLOW_PREFIXES.some(
    (rule) =>
      rule.method === method &&
      appPath.startsWith(rule.prefix) &&
      appPath.endsWith(rule.suffix) &&
      appPath.length > rule.prefix.length + rule.suffix.length,
  )
}

function hasSignedSessionCookie(request: FastifyRequest): boolean {
  return readSessionUserId(request) !== null
}

function respondUnauthenticated(
  request: FastifyRequest,
  reply: FastifyReply,
  env: ServerEnv,
  appPath: string,
): FastifyReply {
  // API endpoints always get a flat 401 — never an HTML body and never
  // a redirect. SPA fetches and external API clients both want a clean
  // status code they can react to.
  if (appPath === '/api' || appPath.startsWith('/api/')) {
    return reply.status(401).send({ error: 'Authentication required.' })
  }

  const acceptsHtml = String(request.headers.accept ?? '')
    .toLowerCase()
    .includes('text/html')

  // Non-browser GETs (curl, monitoring probes, asset prefetches from
  // a logged-out tab, etc.) get 401 rather than a redirect chain.
  if (!acceptsHtml || request.method !== 'GET') {
    return reply.status(401).send({ error: 'Authentication required.' })
  }

  // Browser navigation: bounce into the login flow. We deliberately
  // do NOT serve a Helios-branded login shell here — the user asked
  // for *nothing* about Helios to be visible to anonymous visitors
  // beyond the name and the URL, so the response body is either a
  // 302 to Google's OAuth consent screen (production), or, when no
  // Google OAuth is configured (dev), a minimal self-contained page
  // describing how to obtain a session locally.
  if (isGoogleOAuthReady(env)) {
    // Preserve the page the user was actually trying to reach so the
    // OAuth callback can return them there instead of dumping everyone
    // on the app root. `appPath` here is already app-base-relative and
    // query-stripped; re-attach the original query string and validate
    // the whole thing (normalizeReturnTo rejects anything that isn't a
    // safe same-app page path, e.g. /api/*). Fragments are never sent
    // to the server, so they can't be preserved here.
    const returnTo = normalizeReturnTo(`${appPath}${extractQuery(request.url)}`)
    const startPath = joinBasePath(env.appBasePath, '/api/auth/google/start')
    const startUrl =
      returnTo && returnTo !== '/' ? `${startPath}?returnTo=${encodeURIComponent(returnTo)}` : startPath
    return reply.redirect(startUrl)
  }

  return reply
    .status(401)
    .header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
    .type('text/html; charset=utf-8')
    .send(renderDevSignInNotice())
}

function renderDevSignInNotice(): string {
  // Intentionally bare. No Helios branding, no navbar, no app surface.
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<title>Sign in required</title>',
    '<meta name="robots" content="noindex,nofollow">',
    '</head><body>',
    '<p>Sign in required.</p>',
    '<p>This deployment is not configured for Google OAuth. Obtain a session via <code>POST /api/auth/dev-login</code> from a loopback client.</p>',
    '</body></html>',
    '',
  ].join('\n')
}

function stripQuery(url: string): string {
  const queryIndex = url.indexOf('?')
  return queryIndex === -1 ? url : url.slice(0, queryIndex)
}

function extractQuery(url: string): string {
  const queryIndex = url.indexOf('?')
  return queryIndex === -1 ? '' : url.slice(queryIndex)
}

function stripAppBasePath(path: string, basePath: string): string {
  if (basePath === '/' || basePath === '') {
    return path
  }
  if (path === basePath) {
    return '/'
  }
  if (path.startsWith(basePath + '/')) {
    return path.slice(basePath.length)
  }
  // Path is outside the app base path entirely — leave it alone so
  // the gate's allowlist comparisons (which all live under the app
  // base path) cleanly miss.
  return path
}
