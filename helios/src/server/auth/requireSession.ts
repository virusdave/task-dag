import type { FastifyReply, FastifyRequest } from 'fastify'

import type { SessionEnvelope, SessionUser } from '../../shared/contracts/index.js'
import { getPermissionsForRole } from '../../shared/domain/permissions.js'
import { buildRuntimeDependencyStatuses } from '../runtime/dependencyStatus.js'
import { getPool } from '../db/pool.js'
import { getUserById } from '../db/queries/authQueries.js'
import { hasAtLeastRole } from './permissions.js'
import { readSessionUserId } from './sessionCookie.js'

export async function buildSessionEnvelope(request: FastifyRequest): Promise<SessionEnvelope> {
  const runtimeDependencies = buildRuntimeDependencyStatuses()
  const userId = readSessionUserId(request)
  if (userId === null) {
    return {
      authMode: 'anonymous',
      permissions: getPermissionsForRole(null),
      runtimeDependencies,
      user: null,
    }
  }

  const user = await getUserById(getPool(), userId)
  if (!user || !user.active) {
    return {
      authMode: 'anonymous',
      permissions: getPermissionsForRole(null),
      runtimeDependencies,
      user: null,
    }
  }

  return {
    authMode: 'session',
    permissions: getPermissionsForRole(user.role),
    runtimeDependencies,
    user,
  }
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
