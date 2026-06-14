import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { withTransaction } from '../db/tx.js'
import { claimGoogleIdentityAndTouchLogin, touchLocalDevLoginByEmail } from '../db/queries/authQueries.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { buildGoogleAuthorizationUrl, exchangeGoogleAuthorizationCode } from '../auth/googleOAuth.js'
import {
  clearOauthTransactionCookie,
  readOauthTransactionCookie,
  setOauthTransactionCookie,
  setSessionCookie,
} from '../auth/sessionCookie.js'
import { getGoogleOAuthConfigurationIssue, getServerEnv, isGoogleOAuthReady } from '../config/env.js'
import { joinBasePath } from '../../shared/config/appBasePath.js'
import { normalizeReturnToOrRoot } from '../../shared/config/returnTo.js'

const DevLoginRequestSchema = z.object({
  email: z.string().trim().email(),
})

export async function registerAuthRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/auth/google/start', async (request, reply) => {
    // OAuth redirects must never be cached by a browser/CDN — a cached
    // 302 (or its Set-Cookie) would pin a stale state cookie and break
    // the next sign-in.
    reply.header('Cache-Control', 'no-store')

    const googleOAuthIssue = getGoogleOAuthConfigurationIssue()
    if (googleOAuthIssue) {
      return reply.status(503).send({
        error: googleOAuthIssue,
      })
    }

    const rawQuery = request.query as { returnTo?: string; retry?: string }
    const returnTo = normalizeReturnToOrRoot(rawQuery.returnTo)

    // The state carries a one-shot retry marker (`r0.` / `r1.`) so the
    // callback can recognise a second attempt EVEN when the state
    // cookie itself is the thing failing (e.g. cookies disabled). The
    // marker is never trusted for authentication — exact signed-cookie
    // state matching still gates session creation.
    const isRetry = rawQuery.retry === '1'
    const state = `${isRetry ? 'r1' : 'r0'}.${randomUUID()}`
    setOauthTransactionCookie(reply, { returnTo, state })
    return reply.redirect(buildGoogleAuthorizationUrl(state))
  })

  server.get('/api/auth/google/callback', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')

    const googleOAuthIssue = getGoogleOAuthConfigurationIssue()
    if (googleOAuthIssue) {
      return reply.status(503).send({
        error: googleOAuthIssue,
      })
    }

    const rawQuery = request.query as { code?: string; state?: string; error?: string }
    const transaction = readOauthTransactionCookie(request)
    const returnTo = transaction ? normalizeReturnToOrRoot(transaction.returnTo) : '/'

    // Case 1: Google itself reported a problem (user cancelled, denied
    // consent, etc.). Auto-retrying would just bounce them back to the
    // same prompt, so we show a friendly "try again" page instead of
    // looping or dumping raw JSON.
    if (typeof rawQuery.error === 'string' && rawQuery.error.length > 0) {
      clearOauthTransactionCookie(reply)
      return renderSignInFailure(reply, {
        appBasePath: getServerEnv().appBasePath,
        detail: 'Sign-in was cancelled or denied at Google.',
        returnTo,
      })
    }

    // Case 2/3: the anti-CSRF state cookie is missing or doesn't match
    // the value Google echoed back. This is the failure that used to
    // dump a raw "Google OAuth state validation failed" JSON blob on
    // the user. It is overwhelmingly transient (a stale/duplicate tab
    // clobbered the single-slot cookie, or the cookie expired mid-flow),
    // so we transparently restart the dance ONCE, preserving returnTo.
    // The retry is bounded by the `r1.` marker embedded in the state
    // (NOT by a cookie, which can itself be the failing component) so a
    // genuinely cookie-less browser falls through to a friendly page
    // exactly once rather than looping forever.
    const stateMatches = Boolean(
      rawQuery.code && rawQuery.state && transaction && rawQuery.state === transaction.state,
    )
    if (!stateMatches) {
      clearOauthTransactionCookie(reply)
      const retryAlreadyAttempted = typeof rawQuery.state === 'string' && rawQuery.state.startsWith('r1.')
      if (acceptsHtml(request) && !retryAlreadyAttempted) {
        return reply.redirect(buildStartUrl(getServerEnv().appBasePath, returnTo, true))
      }
      return renderSignInFailure(reply, {
        appBasePath: getServerEnv().appBasePath,
        detail: 'Your sign-in session expired or was already used. Please sign in again.',
        returnTo,
      })
    }

    try {
      const profile = await exchangeGoogleAuthorizationCode(rawQuery.code!)
      const requestId = randomUUID()
      const user = await withTransaction(async (db) => {
        const claimedUser = await claimGoogleIdentityAndTouchLogin(db, {
          email: profile.email,
          googleSub: profile.googleSub,
        })

        if (!claimedUser) {
          throw new Error('This account is not provisioned or is claimed by another Google identity.')
        }

        await appendAuditEvent(db, {
          actorType: 'user',
          actorUserId: claimedUser.id,
          entityId: String(claimedUser.id),
          entityType: 'user',
          eventType: 'auth.user.signed_in',
          module: 'catalog',
          payload: {
            email: claimedUser.email,
            googleSub: profile.googleSub,
            sessionId: requestId,
            userId: claimedUser.id,
          },
          requestId,
          undoPayload: null,
        })

        return claimedUser
      })

      setSessionCookie(reply, user.id)
      clearOauthTransactionCookie(reply)
      return reply.redirect(buildAppRedirectUrl(returnTo))
    } catch (error) {
      // Code-exchange / provisioning / unauthorized-account failures.
      // Do NOT auto-retry (it would loop on a permanently-rejected
      // account); show the reason on a friendly page with a retry link.
      clearOauthTransactionCookie(reply)
      const message = error instanceof Error ? error.message : 'Google sign-in failed.'
      return renderSignInFailure(reply, {
        appBasePath: getServerEnv().appBasePath,
        detail: message,
        returnTo,
      })
    }
  })

  server.post('/api/auth/dev-login', async (request, reply) => {
    if (!isLocalDevLoginAllowed(request)) {
      return reply.status(404).send({ error: 'Local dev sign-in is unavailable.' })
    }

    const body = DevLoginRequestSchema.parse(request.body ?? {})

    try {
      const requestId = randomUUID()
      const user = await withTransaction(async (db) => {
        const claimedUser = await touchLocalDevLoginByEmail(db, body.email)

        if (!claimedUser) {
          throw new Error('This account is not provisioned or is inactive.')
        }

        await appendAuditEvent(db, {
          actorType: 'user',
          actorUserId: claimedUser.id,
          entityId: String(claimedUser.id),
          entityType: 'user',
          eventType: 'auth.user.signed_in',
          module: 'catalog',
          payload: {
            authMethod: 'local-dev',
            email: claimedUser.email,
            sessionId: requestId,
            userId: claimedUser.id,
          },
          requestId,
          undoPayload: null,
        })

        return claimedUser
      })

      setSessionCookie(reply, user.id)
      return reply.status(204).send()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Local dev sign-in failed.'
      return reply.status(403).send({ error: message })
    }
  })
}

function isLocalDevLoginAllowed(request: FastifyRequest): boolean {
  const env = getServerEnv()
  if (env.nodeEnv === 'production' || isGoogleOAuthReady(env)) {
    return false
  }

  return isLoopbackRequest(request)
}

function isLoopbackRequest(request: { hostname: string; ip: string }): boolean {
  return isLoopbackValue(request.hostname) || isLoopbackValue(request.ip)
}

function isLoopbackValue(value: string): boolean {
  const normalizedValue = value.trim().toLowerCase()
  return normalizedValue === 'localhost'
    || normalizedValue === '127.0.0.1'
    || normalizedValue === '::1'
    || normalizedValue === '::ffff:127.0.0.1'
}

// Build the absolute post-login redirect target from the CANONICAL
// configured app base URL plus the validated, app-relative returnTo.
//
// This deliberately ignores request headers (`Origin`, `Referer`,
// `Host`, `X-Forwarded-Host`). The previous implementation trusted the
// request `Origin` header, which on a top-level OAuth callback
// navigation can be absent, `null`, or the *Google* origin depending on
// the browser — sending the just-signed-in user to the wrong host
// ("...had to re-type the base URL"). The redirect must always land on
// our own configured origin.
function buildAppRedirectUrl(returnTo: string): string {
  const env = getServerEnv()
  return new URL(joinBasePath(env.appBasePath, returnTo), env.appBaseUrl).toString()
}

// Build the app-relative `/api/auth/google/start` URL (under the
// deployment base path), forwarding the returnTo and the retry marker.
function buildStartUrl(appBasePath: string, returnTo: string, retry: boolean): string {
  const startPath = joinBasePath(appBasePath, '/api/auth/google/start')
  const params = new URLSearchParams()
  if (returnTo && returnTo !== '/') {
    params.set('returnTo', returnTo)
  }
  if (retry) {
    params.set('retry', '1')
  }
  const query = params.toString()
  return query ? `${startPath}?${query}` : startPath
}

function acceptsHtml(request: FastifyRequest): boolean {
  return String(request.headers.accept ?? '')
    .toLowerCase()
    .includes('text/html')
}

interface SignInFailureOptions {
  appBasePath: string
  detail: string
  returnTo: string
}

// A minimal, self-contained sign-in failure page. Deliberately bare —
// no Helios branding, navbar, or app surface (mirrors the anonymous
// auth-gate notice) — but unlike the old raw JSON error it gives the
// user a one-tap path forward instead of a dead end.
function renderSignInFailure(reply: FastifyReply, options: SignInFailureOptions): FastifyReply {
  const retryHref = escapeHtml(buildStartUrl(options.appBasePath, options.returnTo, false))
  const detail = escapeHtml(options.detail)
  const body = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<title>Sign-in failed</title>',
    '<meta name="robots" content="noindex,nofollow">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '</head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">',
    '<h1 style="font-size:1.25rem">Sign-in didn\u2019t complete</h1>',
    `<p>${detail}</p>`,
    `<p><a href="${retryHref}" style="display:inline-block;margin-top:0.5rem;padding:0.5rem 1rem;background:#1a1a2e;color:#fff;border-radius:6px;text-decoration:none">Try signing in again</a></p>`,
    '</body></html>',
    '',
  ].join('\n')
  return reply
    .status(401)
    .header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
    .type('text/html; charset=utf-8')
    .send(body)
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
