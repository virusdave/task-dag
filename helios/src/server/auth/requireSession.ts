import type { FastifyReply, FastifyRequest } from 'fastify'

import type { SessionEnvelope, SessionUser } from '../../shared/contracts/index.js'
import { getPermissionsForRole } from '../../shared/domain/permissions.js'
import { getServerEnv, isGoogleOAuthReady } from '../config/env.js'
import { buildRuntimeDependencyStatuses } from '../runtime/dependencyStatus.js'
import { getPool } from '../db/pool.js'
import { getUserById } from '../db/queries/authQueries.js'
import { hasAtLeastRole } from './permissions.js'
import { readSessionUserId } from './sessionCookie.js'

export async function buildSessionEnvelope(request: FastifyRequest): Promise<SessionEnvelope> {
  const runtimeDependencies = buildRuntimeDependencyStatuses()
  const localDevSignInAvailable = isLocalDevSignInAvailable()
  const userId = readSessionUserId(request)
  if (userId === null) {
    return {
      authMode: 'anonymous',
      localDevSignInAvailable,
      permissions: getPermissionsForRole(null),
      runtimeDependencies,
      user: null,
    }
  }

  const user = await getUserById(getPool(), userId)
  if (!user || !user.active) {
    return {
      authMode: 'anonymous',
      localDevSignInAvailable,
      permissions: getPermissionsForRole(null),
      runtimeDependencies,
      user: null,
    }
  }

  return {
    authMode: 'session',
    localDevSignInAvailable,
    permissions: getPermissionsForRole(user.role),
    runtimeDependencies,
    user,
  }
}

// Mirrors the structural half of `isLocalDevLoginAllowed` in routes/auth.ts:
// the POST /api/auth/dev-login endpoint additionally requires the request to
// arrive on a loopback interface, but the client login page only needs to
// know whether the option exists in this deployment at all. In production
// (NODE_ENV=production) we never offer it, regardless of the OAuth state, so
// a misconfigured prod OAuth setup doesn't silently fall back to dev login.
function isLocalDevSignInAvailable(): boolean {
  const env = getServerEnv()
  if (env.nodeEnv === 'production') {
    return false
  }
  return !isGoogleOAuthReady(env)
}

export async function requireSessionUser(
  request: FastifyRequest,
  reply: FastifyReply,
  minimumRole: SessionUser['role'] = 'viewer',
): Promise<SessionUser | null> {
  const session = await buildSessionEnvelope(request)
  if (!session.user) {
    reply.status(401).send({ error: 'Authentication required.' })
    return null
  }
  if (!hasAtLeastRole(session.user.role, minimumRole)) {
    reply.status(403).send({ error: 'You do not have permission to perform this action.' })
    return null
  }
  return session.user
}
