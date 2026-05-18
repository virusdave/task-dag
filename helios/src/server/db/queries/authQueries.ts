import type { QueryResultRow } from 'pg'

import type { Role, SessionUser } from '../../../shared/contracts/domain/auth.js'
import type { UserRecord } from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'

interface UserRow extends QueryResultRow {
  active: boolean
  email: string
  google_sub: string | null
  id: number
  last_login_at: Date | null
  name: string
  role: Role
}

interface UserRecordRow extends UserRow {
  created_at: Date
  updated_at: Date
}

export async function getUserById(db: Queryable, userId: number): Promise<SessionUser | null> {
  const result = await db.query<UserRow>(
    `
      select id, email, name, role, active, google_sub, last_login_at
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
      select id, email, name, role, active, google_sub, last_login_at
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
      returning id, email, name, role, active, google_sub, last_login_at
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
      returning id, email, name, role, active, google_sub, last_login_at
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
      returning id, email, name, role, active, google_sub, last_login_at
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

export async function listAllUsers(db: Queryable): Promise<UserRecord[]> {
  const result = await db.query<UserRecordRow>(
    `
      select id, email, name, role, active, google_sub, last_login_at, created_at, updated_at
      from users
      order by active desc, lower(name), id
    `,
  )
  return result.rows.map(mapUserRecord)
}

export async function getUserRecordById(db: Queryable, userId: number): Promise<UserRecord | null> {
  const result = await db.query<UserRecordRow>(
    `
      select id, email, name, role, active, google_sub, last_login_at, created_at, updated_at
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
  patch: { active?: boolean; name?: string; role?: Role },
): Promise<UserRecord | null> {
  const result = await db.query<UserRecordRow>(
    `
      update users
      set
        role = coalesce($2, role),
        active = coalesce($3, active),
        name = coalesce($4, name),
        updated_at = now()
      where id = $1
      returning id, email, name, role, active, google_sub, last_login_at, created_at, updated_at
    `,
    [userId, patch.role ?? null, patch.active ?? null, patch.name ?? null],
  )
  return result.rows[0] ? mapUserRecord(result.rows[0]) : null
}

function mapSessionUser(row: UserRow): SessionUser {
  return {
    active: row.active,
    email: row.email,
    id: row.id,
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
    name: row.name,
    role: row.role,
    updatedAt: row.updated_at.toISOString(),
  }
}
