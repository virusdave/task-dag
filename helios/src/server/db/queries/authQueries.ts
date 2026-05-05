import type { QueryResultRow } from 'pg'

import type { Role, SessionUser } from '../../../shared/contracts/domain/auth.js'
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

function mapSessionUser(row: UserRow): SessionUser {
  return {
    active: row.active,
    email: row.email,
    id: row.id,
    name: row.name,
    role: row.role,
  }
}
