import type { FastifyReply, FastifyRequest } from 'fastify'

import type { SessionEnvelope, SessionUser } from '../../shared/contracts/index.js'
import { getPermissionsForRole } from '../../shared/domain/permissions.js'
import { getServerEnv, isGoogleOAuthReady } from '../config/env.js'
import { buildRuntimeDependencyStatuses } from '../runtime/dependencyStatus.js'
import { getPool } from '../db/pool.js'
import { getPendingMigrations } from '../db/pendingMigrations.js'
import { getUserById } from '../db/queries/authQueries.js'
import { hasAtLeastRole } from './permissions.js'
import { readSessionUserId } from './sessionCookie.js'

export async function buildSessionEnvelope(request: FastifyRequest): Promise<SessionEnvelope> {
  const runtimeDependencies = buildRuntimeDependencyStatuses()
  const localDevSignInAvailable = isLocalDevSignInAvailable()
  // Pending-migration detection runs against the live DB but is
  // cached for ~30s inside getPendingMigrations, so the per-request
  // cost is amortized. We intentionally surface this on every
  // session response (including anonymous / login-screen calls) so
  // the all-pages banner can render before a user successfully
  // signs in and trips into the underlying SQL error.
  const pendingMigrations = await safelyGetPendingMigrations()
  const userId = readSessionUserId(request)
  if (userId === null) {
    return {
      authMode: 'anonymous',
      localDevSignInAvailable,
      pendingMigrations,
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
      pendingMigrations,
      permissions: getPermissionsForRole(null),
      runtimeDependencies,
      user: null,
    }
  }

  return {
    authMode: 'session',
    localDevSignInAvailable,
    pendingMigrations,
    permissions: getPermissionsForRole(user.role),
    runtimeDependencies,
    user,
  }
}

async function safelyGetPendingMigrations() {
  try {
    return await getPendingMigrations(getPool())
  } catch (error) {
    // Pool is broken / DB unreachable. Don't take down the session
    // response (which already gracefully handles the same kind of
    // failure for the user lookup path). Returning an empty array
    // means the banner stays hidden — the deeper outage will show
    // up via the runtime-dependency badges or the actual route
    // loaders failing.
    console.warn('[buildSessionEnvelope] could not check pending migrations:', error)
    return []
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
