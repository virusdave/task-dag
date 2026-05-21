import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { joinBasePath } from '../../shared/config/appBasePath.js'
import { getServerEnv, isGoogleOAuthReady, type ServerEnv } from '../config/env.js'
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
  // provenance — see registerWhitelabelPricingRoutes for the
  // projection. Consumed by the mostly-static-sites
  // freshlybaked.nyc/white-label/bulk-flower page.
  { method: 'GET', appRelativePath: '/api/whitelabel/public/bulk-flower' },
  // Public "Meet The Team" projection: approved staff only, with
  // only firstName + photoUrl exposed. Consumed by the
  // mostly-static-sites freshlybaked.nyc/about-us page. The
  // editorial layer (approve/reject) lives behind the Utilities →
  // Staff page in Helios.
  { method: 'GET', appRelativePath: '/api/staff/public/team' },
]

export function registerAuthGate(server: FastifyInstance): void {
  server.addHook('onRequest', async (request, reply) => {
    const env = getServerEnv()

    // /healthzz is registered at the absolute root (not under the
    // appBasePath) for infrastructure probes and must never require
    // authentication.
    if (stripQuery(request.url) === '/healthzz') {
      return
    }

    const appPath = stripAppBasePath(stripQuery(request.url), env.appBasePath)

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
}

function isLoginFlowRequest(method: string, appPath: string): boolean {
  return LOGIN_FLOW_ENDPOINTS.some(
    (endpoint) => endpoint.method === method && endpoint.appRelativePath === appPath,
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
    return reply.redirect(joinBasePath(env.appBasePath, '/api/auth/google/start'))
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
