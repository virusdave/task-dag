import type { FastifyReply, FastifyRequest } from 'fastify'

import { getServerEnv } from '../config/env.js'

const oauthTransactionCookieName = 'helios-google-oauth-txn'

// How long an in-flight OAuth dance may take before the transaction
// cookie expires. Bumped from the original 10 minutes to 1 hour: the
// previous window was tight enough that a user who dwelt on Google's
// account chooser / 2FA prompt could come back to a missing state
// cookie and get dumped on the raw "state validation failed" JSON
// page. The value is still random + signed + httpOnly + consumed on a
// successful callback, so a longer window does not weaken CSRF.
const OAUTH_TRANSACTION_TTL_SECONDS = 60 * 60

// The signed, short-lived record of an in-flight Google OAuth dance.
// `state` is the random anti-CSRF token echoed to Google; `returnTo`
// is the validated, app-relative path the user was trying to reach
// before we bounced them into the login flow (see shared/returnTo.ts).
export interface OauthTransaction {
  state: string
  returnTo: string
}

export function setSessionCookie(reply: FastifyReply, userId: number): void {
  const env = getServerEnv()
  reply.setCookie(env.sessionCookieName, String(userId), baseCookieOptions())
}

export function clearSessionCookie(reply: FastifyReply): void {
  const env = getServerEnv()
  reply.clearCookie(env.sessionCookieName, baseCookieOptions())
}

export function readSessionUserId(request: FastifyRequest): number | null {
  const env = getServerEnv()
  const rawCookieValue = request.cookies[env.sessionCookieName]
  if (!rawCookieValue) {
    return null
  }

  const unsignedCookie = request.unsignCookie(rawCookieValue)
  if (!unsignedCookie.valid || !unsignedCookie.value) {
    return null
  }

  const parsed = Number.parseInt(unsignedCookie.value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

export function setOauthTransactionCookie(reply: FastifyReply, transaction: OauthTransaction): void {
  reply.setCookie(oauthTransactionCookieName, JSON.stringify(transaction), {
    ...baseCookieOptions(),
    maxAge: OAUTH_TRANSACTION_TTL_SECONDS,
  })
}

export function readOauthTransactionCookie(request: FastifyRequest): OauthTransaction | null {
  const rawCookieValue = request.cookies[oauthTransactionCookieName]
  if (!rawCookieValue) {
    return null
  }

  const unsignedCookie = request.unsignCookie(rawCookieValue)
  if (!unsignedCookie.valid || !unsignedCookie.value) {
    return null
  }

  try {
    const parsed = JSON.parse(unsignedCookie.value) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as OauthTransaction).state === 'string' &&
      typeof (parsed as OauthTransaction).returnTo === 'string'
    ) {
      return { state: (parsed as OauthTransaction).state, returnTo: (parsed as OauthTransaction).returnTo }
    }
  } catch {
    // Malformed cookie — treat as absent.
  }
  return null
}

export function clearOauthTransactionCookie(reply: FastifyReply): void {
  reply.clearCookie(oauthTransactionCookieName, baseCookieOptions())
}

function baseCookieOptions() {
  const env = getServerEnv()
  return {
    httpOnly: true,
    path: env.appBasePath,
    sameSite: 'lax' as const,
    secure: env.nodeEnv === 'production',
    signed: true,
  }
}
