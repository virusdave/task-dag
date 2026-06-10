import type { QueryResultRow } from 'pg'

import type { Queryable } from '../pool.js'

// Tiny key/value accessor over `app_settings` (see
// `db/schema/appSettings.sql`). The stored `value` is an opaque JSONB
// blob; the caller is responsible for validating its shape against the
// feature-specific contract.

export interface AppSettingRecord {
  readonly key: string
  readonly value: unknown
  readonly updatedBy: string
  readonly updatedAt: string
}

interface AppSettingRow extends QueryResultRow {
  key: string
  value: unknown
  updated_by: string
  updated_at: Date
}

function mapRow(row: AppSettingRow): AppSettingRecord {
  return {
    key: row.key,
    value: row.value,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
  }
}

export async function getAppSetting(
  db: Queryable,
  key: string,
): Promise<AppSettingRecord | null> {
  const result = await db.query<AppSettingRow>(
    `select key, value, updated_by, updated_at
       from app_settings
      where key = $1`,
    [key],
  )
  const row = result.rows[0]
  return row ? mapRow(row) : null
}

export async function upsertAppSetting(
  db: Queryable,
  key: string,
  value: unknown,
  updatedBy: string,
): Promise<AppSettingRecord> {
  const result = await db.query<AppSettingRow>(
    `insert into app_settings (key, value, updated_by, updated_at)
          values ($1, $2::jsonb, $3, now())
     on conflict (key) do update
            set value = excluded.value,
                updated_by = excluded.updated_by,
                updated_at = now()
      returning key, value, updated_by, updated_at`,
    [key, JSON.stringify(value), updatedBy],
  )
  return mapRow(result.rows[0]!)
}

export async function deleteAppSetting(db: Queryable, key: string): Promise<boolean> {
  const result = await db.query(`delete from app_settings where key = $1`, [key])
  return (result.rowCount ?? 0) > 0
}
