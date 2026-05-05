import type { FastifyReply, FastifyRequest } from 'fastify'

import { getServerEnv } from '../config/env.js'

const oauthStateCookieName = 'helios-google-oauth-state'

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

export function setOauthStateCookie(reply: FastifyReply, state: string): void {
  reply.setCookie(oauthStateCookieName, state, {
    ...baseCookieOptions(),
    maxAge: 10 * 60,
  })
}

export function readOauthStateCookie(request: FastifyRequest): string | null {
  const rawCookieValue = request.cookies[oauthStateCookieName]
  if (!rawCookieValue) {
    return null
  }

  const unsignedCookie = request.unsignCookie(rawCookieValue)
  if (!unsignedCookie.valid || !unsignedCookie.value) {
    return null
  }

  return unsignedCookie.value
}

export function clearOauthStateCookie(reply: FastifyReply): void {
  reply.clearCookie(oauthStateCookieName, baseCookieOptions())
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
