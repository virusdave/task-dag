import type { QueryResultRow } from 'pg'

import {
  MetricGrantKeySchema,
  type MetricGrantKey,
  type Role,
  type SessionUser,
} from '../../../shared/contracts/domain/auth.js'
import type { UserRecord } from '../../../shared/contracts/index.js'
import { normalizeMetricGrants } from '../../../shared/domain/metricGrants.js'
import type { Queryable } from '../pool.js'

interface UserRow extends QueryResultRow {
  active: boolean
  email: string
  google_sub: string | null
  id: number
  last_login_at: Date | null
  // Per-user metric subpage grants (text[]). Always non-null in
  // shipped DBs — migration 045 sets a `default '{}'` and a
  // `not null` constraint. We still coerce defensively in
  // `mapSessionUser` / `mapUserRecord` so a hand-crafted test row
  // can't blow up the mapper.
  metric_grants: string[] | null
  name: string
  role: Role
}

interface UserRecordRow extends UserRow {
  created_at: Date
  updated_at: Date
}

// Parse + dedupe a raw text[] column into the typed grant array.
// Unknown strings (e.g. a key that's been removed from the enum)
// are silently dropped so a stale DB row never crashes the auth
// path. Repeated keys are collapsed.
function parseMetricGrants(raw: string[] | null | undefined): MetricGrantKey[] {
  if (!raw || raw.length === 0) return []
  const out: MetricGrantKey[] = []
  for (const value of raw) {
    const parsed = MetricGrantKeySchema.safeParse(value)
    if (parsed.success) out.push(parsed.data)
  }
  return normalizeMetricGrants(out)
}

// SessionUser column projection — every select must include the same
// fields and in the same order so the row mapper stays consistent.
// metric_grants is added by migration 045; we coerce nulls / unknowns
// in `mapSessionUser` rather than at the SQL layer.
const SESSION_USER_COLUMNS =
  'id, email, name, role, active, google_sub, last_login_at, metric_grants'

export async function getUserById(db: Queryable, userId: number): Promise<SessionUser | null> {
  const result = await db.query<UserRow>(
    `
      select ${SESSION_USER_COLUMNS}
      from users
      where id = $1
    `,
    [userId],
  )

  return result.rows[0] ? mapSessionUser(result.rows[0]) : null
}

export async function getUserForLogin(db: Queryable, email: string): Promise<UserRow | null> {
  const result = await db.query<UserRow>(
    `
      select ${SESSION_USER_COLUMNS}
      from users
      where lower(email) = lower($1)
    `,
    [email],
  )

  return result.rows[0] ?? null
}

export async function claimGoogleIdentityAndTouchLogin(
  db: Queryable,
  input: { email: string; googleSub: string },
): Promise<SessionUser | null> {
  const result = await db.query<UserRow>(
    `
      update users
      set
        google_sub = case
          when google_sub is null then $2
          else google_sub
        end,
        last_login_at = now()
      where lower(email) = lower($1)
        and active = true
        and (google_sub is null or google_sub = $2)
      returning ${SESSION_USER_COLUMNS}
    `,
    [input.email, input.googleSub],
  )

  return result.rows[0] ? mapSessionUser(result.rows[0]) : null
}

export async function touchLocalDevLoginByEmail(db: Queryable, email: string): Promise<SessionUser | null> {
  const result = await db.query<UserRow>(
    `
      update users
      set last_login_at = now()
      where lower(email) = lower($1)
        and active = true
      returning ${SESSION_USER_COLUMNS}
    `,
    [email],
  )

  return result.rows[0] ? mapSessionUser(result.rows[0]) : null
}

export async function provisionUser(
  db: Queryable,
  input: { active?: boolean; email: string; name: string; role: Role },
): Promise<SessionUser> {
  const result = await db.query<UserRow>(
    `
      insert into users (email, name, role, active)
      values ($1, $2, $3, coalesce($4, true))
      on conflict ((lower(email))) do update
      set name = excluded.name,
          role = excluded.role,
          active = excluded.active,
          updated_at = now()
      returning ${SESSION_USER_COLUMNS}
    `,
    [input.email, input.name, input.role, input.active ?? true],
  )

  return mapSessionUser(result.rows[0])
}

// ─── Admin user-management surface ────────────────────────────────
//
// The three helpers below back the /api/users routes (admin-only).
// They deliberately keep their SQL narrow and return the full
// `UserRecord` shape (vs the slimmer `SessionUser`) so the admin
// page can show provenance columns (last login, created/updated
// timestamps, whether a Google identity is already claimed).

// UserRecord projection — same as SESSION_USER_COLUMNS plus the
// audit timestamps. Keeping a shared constant means a new column
// added to the mapper requires touching one literal, not eight.
const USER_RECORD_COLUMNS = `${SESSION_USER_COLUMNS}, created_at, updated_at`

export async function listAllUsers(db: Queryable): Promise<UserRecord[]> {
  const result = await db.query<UserRecordRow>(
    `
      select ${USER_RECORD_COLUMNS}
      from users
      order by active desc, lower(name), id
    `,
  )
  return result.rows.map(mapUserRecord)
}

export async function getUserRecordById(db: Queryable, userId: number): Promise<UserRecord | null> {
  const result = await db.query<UserRecordRow>(
    `
      select ${USER_RECORD_COLUMNS}
      from users
      where id = $1
    `,
    [userId],
  )
  return result.rows[0] ? mapUserRecord(result.rows[0]) : null
}

export async function updateUserFields(
  db: Queryable,
  userId: number,
  patch: {
    active?: boolean
    /** Replaces the stored set. Undefined means "leave unchanged". */
    metricGrants?: ReadonlyArray<MetricGrantKey>
    name?: string
    role?: Role
  },
): Promise<UserRecord | null> {
  // metric_grants needs special handling: `coalesce($N, metric_grants)`
  // can't disambiguate "passed []" from "passed null", and we need
  // an empty array to genuinely revoke every grant. Pass the literal
  // array when set, NULL otherwise; the SQL CASE picks the right
  // branch.
  const grantsArg: string[] | null = patch.metricGrants
    ? normalizeMetricGrants([...patch.metricGrants])
    : null
  const grantsDirty = patch.metricGrants !== undefined
  const result = await db.query<UserRecordRow>(
    `
      update users
      set
        role = coalesce($2, role),
        active = coalesce($3, active),
        name = coalesce($4, name),
        metric_grants = case when $6::boolean then $5::text[] else metric_grants end,
        updated_at = now()
      where id = $1
      returning ${USER_RECORD_COLUMNS}
    `,
    [
      userId,
      patch.role ?? null,
      patch.active ?? null,
      patch.name ?? null,
      grantsArg,
      grantsDirty,
    ],
  )
  return result.rows[0] ? mapUserRecord(result.rows[0]) : null
}

function mapSessionUser(row: UserRow): SessionUser {
  return {
    active: row.active,
    email: row.email,
    id: row.id,
    metricGrants: parseMetricGrants(row.metric_grants),
    name: row.name,
    role: row.role,
  }
}

function mapUserRecord(row: UserRecordRow): UserRecord {
  return {
    active: row.active,
    createdAt: row.created_at.toISOString(),
    email: row.email,
    googleSubClaimed: row.google_sub !== null,
    id: row.id,
    lastLoginAt: row.last_login_at ? row.last_login_at.toISOString() : null,
    // The admin UI shows the LITERAL stored set — admins still see
    // an empty array if no grants are stored. The "admins implicitly
    // hold every grant" rule is enforced at the gate (userHasMetricGrant)
    // and mirrored in the UsersPage UI copy.
    metricGrants: parseMetricGrants(row.metric_grants),
    name: row.name,
    role: row.role,
    updatedAt: row.updated_at.toISOString(),
  }
}
