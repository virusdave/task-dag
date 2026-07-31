import type { QueryResultRow } from 'pg'

import {
  DEFAULT_WORKER_CAPACITY_CONFIG,
  WORKER_CAPACITY_SETTINGS_KEY,
  WorkerCapacityConfigSchema,
  type WorkerCapacityConfig,
} from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'

interface CapacityRow extends QueryResultRow {
  value: unknown
  updated_at: Date
  updated_by: string
}

export interface LockedWorkerCapacity {
  config: WorkerCapacityConfig
  updatedAt: string
  updatedBy: string
}

export async function lockWorkerCapacityConfig(db: Queryable): Promise<LockedWorkerCapacity> {
  let result = await db.query<CapacityRow>(
    `select value, updated_by, updated_at from app_settings where key = $1 for update`,
    [WORKER_CAPACITY_SETTINGS_KEY],
  )
  if (!result.rows[0]) {
    await db.query(
      `insert into app_settings (key, value, updated_by)
       values ($1, $2::jsonb, 'system-default') on conflict (key) do nothing`,
      [WORKER_CAPACITY_SETTINGS_KEY, JSON.stringify(DEFAULT_WORKER_CAPACITY_CONFIG)],
    )
    result = await db.query<CapacityRow>(
      `select value, updated_by, updated_at from app_settings where key = $1 for update`,
      [WORKER_CAPACITY_SETTINGS_KEY],
    )
  }
  const row = result.rows[0]
  if (!row) throw new Error('Worker capacity authority row could not be created.')
  return {
    config: WorkerCapacityConfigSchema.parse(row.value),
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
  }
}
