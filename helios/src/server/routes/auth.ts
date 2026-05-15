import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { withTransaction } from '../db/tx.js'
import { claimGoogleIdentityAndTouchLogin, touchLocalDevLoginByEmail } from '../db/queries/authQueries.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { buildGoogleAuthorizationUrl, exchangeGoogleAuthorizationCode } from '../auth/googleOAuth.js'
import { clearOauthStateCookie, readOauthStateCookie, setOauthStateCookie, setSessionCookie } from '../auth/sessionCookie.js'
import { getGoogleOAuthConfigurationIssue, getServerEnv, isGoogleOAuthReady } from '../config/env.js'
import { joinBasePath } from '../../shared/config/appBasePath.js'

const DevLoginRequestSchema = z.object({
  email: z.string().trim().email(),
})

export async function registerAuthRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/auth/google/start', async (_request, reply) => {
    const googleOAuthIssue = getGoogleOAuthConfigurationIssue()
    if (googleOAuthIssue) {
      return reply.status(503).send({
        error: googleOAuthIssue,
      })
    }

    const state = randomUUID()
    setOauthStateCookie(reply, state)
    return reply.redirect(buildGoogleAuthorizationUrl(state))
  })

  server.get('/api/auth/google/callback', async (request, reply) => {
    const googleOAuthIssue = getGoogleOAuthConfigurationIssue()
    if (googleOAuthIssue) {
      return reply.status(503).send({
        error: googleOAuthIssue,
      })
    }

    const rawQuery = request.query as { code?: string; state?: string }
    const expectedState = readOauthStateCookie(request)
    clearOauthStateCookie(reply)

    if (!rawQuery.code || !rawQuery.state || !expectedState || rawQuery.state !== expectedState) {
      return reply.status(400).send({ error: 'Google OAuth state validation failed.' })
    }

    try {
      const profile = await exchangeGoogleAuthorizationCode(rawQuery.code)
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
      return reply.redirect(resolveAppRootUrl(request))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Google sign-in failed.'
      return reply.status(403).send({ error: message })
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

function resolveAppRootUrl(request: { headers: { origin?: string | string[] } }): string {
  const env = getServerEnv()
  const originHeader = request.headers.origin
  const rawOrigin = Array.isArray(originHeader) ? originHeader[0] : originHeader

  if (rawOrigin) {
    try {
      return new URL(joinBasePath(env.appBasePath, '/'), rawOrigin).toString()
    } catch {
      // Fall through to the configured app base URL.
    }
  }

  return new URL(joinBasePath(env.appBasePath, '/'), env.appBaseUrl).toString()
}
