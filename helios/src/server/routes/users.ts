import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'

import {
  UsersCreateBodySchema,
  UsersListResponseSchema,
  UsersMutationResponseSchema,
  UsersRouteParamsSchema,
  UsersUpdateBodySchema,
  type UserRecord,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool, type Queryable } from '../db/pool.js'
import {
  getUserRecordById,
  listAllUsers,
  provisionUser,
  updateUserFields,
} from '../db/queries/authQueries.js'
import { withTransaction } from '../db/tx.js'

// Admin user-management routes. All three endpoints require role >= admin
// (enforced by `requireSessionUser(..., 'admin')`). The audit log is the
// source of truth for "who changed whose access, when, from what to what".
export async function registerUsersRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/users', async (request, reply) => {
    const actor = await requireSessionUser(request, reply, 'admin')
    if (!actor) {
      return
    }
    const users = await listAllUsers(getPool())
    return reply.send(UsersListResponseSchema.parse({ users }))
  })

  server.post('/api/users', async (request, reply) => {
    const actor = await requireSessionUser(request, reply, 'admin')
    if (!actor) {
      return
    }
    const body = UsersCreateBodySchema.parse(request.body ?? {})
    const requestId = randomUUID()

    const user = await withTransaction(async (db) => {
      // `provisionUser` is the same idempotent upsert the
      // helios-provision-users boot oneshot uses. It preserves any
      // already-claimed google_sub, so re-provisioning an existing row
      // is safe (it just refreshes name/role/active).
      const sessionUser = await provisionUser(db, {
        email: body.email,
        name: body.name,
        role: body.role,
        active: body.active ?? true,
      })

      const created = await getUserRecordById(db, sessionUser.id)
      if (!created) {
        // Shouldn't happen — the row was just upserted in the same tx.
        throw new Error('Failed to load user record after provisioning.')
      }

      await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: actor.id,
        entityId: String(created.id),
        entityType: 'user',
        eventType: 'auth.user.provisioned',
        module: 'config',
        payload: {
          actorEmail: actor.email,
          actorUserId: actor.id,
          email: created.email,
          name: created.name,
          role: created.role,
          active: created.active,
          userId: created.id,
        },
        requestId,
        undoPayload: null,
      })

      return created
    })

    return reply.send(UsersMutationResponseSchema.parse({ user }))
  })

  server.patch('/api/users/:userId', async (request, reply) => {
    const actor = await requireSessionUser(request, reply, 'admin')
    if (!actor) {
      return
    }
    const params = UsersRouteParamsSchema.parse(request.params)
    const body = UsersUpdateBodySchema.parse(request.body ?? {})

    // Lockout safety. An admin must not be able to lock themselves
    // out of the system by demoting or deactivating their own account.
    // (Two admins is the minimum to recover; this rule keeps us from
    // accidentally collapsing to zero.) The user can still rename
    // themselves.
    if (params.userId === actor.id) {
      if (body.role !== undefined && body.role !== 'admin') {
        return reply.status(400).send({
          error: 'You cannot change your own role away from admin. Ask another admin to do it.',
        })
      }
      if (body.active === false) {
        return reply.status(400).send({
          error: 'You cannot deactivate your own account.',
        })
      }
    }

    const requestId = randomUUID()
    const result = await withTransaction(async (db) => {
      const before = await getUserRecordById(db, params.userId)
      if (!before) {
        return { ok: false as const, error: 'User not found.' }
      }

      const updated = await updateUserFields(db, params.userId, {
        role: body.role,
        active: body.active,
        name: body.name,
        metricGrants: body.metricGrants,
      })
      if (!updated) {
        return { ok: false as const, error: 'User not found.' }
      }

      // Append one audit event per field that actually changed.
      // The undoPayload carries the prior value so a future "undo
      // access change" surface can reconstruct it without scraping
      // the row history.
      await maybeAppendFieldChange(db, {
        actor,
        before,
        after: updated,
        field: 'role',
        eventType: 'auth.user.role_changed',
        requestId,
      })
      await maybeAppendFieldChange(db, {
        actor,
        before,
        after: updated,
        field: 'active',
        eventType: 'auth.user.active_changed',
        requestId,
      })
      await maybeAppendFieldChange(db, {
        actor,
        before,
        after: updated,
        field: 'name',
        eventType: 'auth.user.name_changed',
        requestId,
      })
      // Metric grants are an array, not a primitive — handle separately
      // so the audit payload carries the BEFORE / AFTER sets verbatim.
      await maybeAppendMetricGrantsChange(db, {
        actor,
        before,
        after: updated,
        requestId,
      })

      return { ok: true as const, user: updated }
    })

    if (!result.ok) {
      return reply.status(404).send({ error: result.error })
    }
    return reply.send(UsersMutationResponseSchema.parse({ user: result.user }))
  })
}

async function maybeAppendMetricGrantsChange(
  db: Queryable,
  input: {
    actor: { email: string; id: number }
    after: UserRecord
    before: UserRecord
    requestId: string
  },
): Promise<void> {
  const before = [...input.before.metricGrants].sort().join(',')
  const after = [...input.after.metricGrants].sort().join(',')
  if (before === after) return
  await appendAuditEvent(db, {
    actorType: 'user',
    actorUserId: input.actor.id,
    entityId: String(input.after.id),
    entityType: 'user',
    eventType: 'auth.user.metric_grants_changed',
    module: 'config',
    payload: {
      actorEmail: input.actor.email,
      actorUserId: input.actor.id,
      email: input.after.email,
      previousMetricGrants: input.before.metricGrants,
      nextMetricGrants: input.after.metricGrants,
      userId: input.after.id,
    },
    requestId: input.requestId,
    undoPayload: {
      field: 'metricGrants',
      previousValue: input.before.metricGrants,
      userId: input.after.id,
    },
  })
}

async function maybeAppendFieldChange(
  db: Queryable,
  input: {
    actor: { email: string; id: number }
    after: UserRecord
    before: UserRecord
    eventType: 'auth.user.role_changed' | 'auth.user.active_changed' | 'auth.user.name_changed'
    field: 'role' | 'active' | 'name'
    requestId: string
  },
): Promise<void> {
  const previous = input.before[input.field]
  const next = input.after[input.field]
  if (previous === next) {
    return
  }
  await appendAuditEvent(db, {
    actorType: 'user',
    actorUserId: input.actor.id,
    entityId: String(input.after.id),
    entityType: 'user',
    eventType: input.eventType,
    module: 'config',
    payload: {
      actorEmail: input.actor.email,
      actorUserId: input.actor.id,
      email: input.after.email,
      field: input.field,
      previousValue: previous,
      nextValue: next,
      userId: input.after.id,
    },
    requestId: input.requestId,
    undoPayload: {
      field: input.field,
      previousValue: previous,
      userId: input.after.id,
    },
  })
}
