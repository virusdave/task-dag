import type { Queryable } from '../pool.js'
import type { BrandExpiryOverride } from '../../../shared/contracts/index.js'

interface BrandExpiryOverrideRow {
  brand_id: number | null
  brand_name: string
  expiry_days: number
  notes: string | null
  updated_at: Date | string
  updated_by_user_id: number | null
}

function rowToOverride(row: BrandExpiryOverrideRow): BrandExpiryOverride {
  return {
    brandId: row.brand_id === null ? null : Number(row.brand_id),
    brandName: row.brand_name,
    expiryDays: Number(row.expiry_days),
    notes: row.notes,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    updatedByUserId: row.updated_by_user_id === null ? null : Number(row.updated_by_user_id),
  }
}

export async function listBrandExpiryOverrides(db: Queryable): Promise<BrandExpiryOverride[]> {
  const result = await db.query<BrandExpiryOverrideRow>(
    `select brand_id, brand_name, expiry_days, notes, updated_at, updated_by_user_id
       from brand_expiry_overrides
       order by lower(brand_name) asc`,
  )
  return result.rows.map(rowToOverride)
}

export async function getBrandExpiryOverride(
  db: Queryable,
  brandName: string,
): Promise<BrandExpiryOverride | null> {
  const result = await db.query<BrandExpiryOverrideRow>(
    `select brand_id, brand_name, expiry_days, notes, updated_at, updated_by_user_id
       from brand_expiry_overrides
      where lower(brand_name) = lower($1)
      limit 1`,
    [brandName],
  )
  const row = result.rows[0]
  return row ? rowToOverride(row) : null
}

export interface UpsertBrandExpiryOverrideInput {
  brandName: string
  expiryDays: number
  brandId: number | null
  notes: string | null
  updatedByUserId: number | null
}

export async function upsertBrandExpiryOverride(
  db: Queryable,
  input: UpsertBrandExpiryOverrideInput,
): Promise<BrandExpiryOverride> {
  // The unique index is on lower(brand_name), not the bare brand_name
  // column. Postgres requires the conflict target to match an actual
  // unique constraint or index column expression — using ON CONFLICT
  // (lower(brand_name)) hits the expression index.
  const result = await db.query<BrandExpiryOverrideRow>(
    `insert into brand_expiry_overrides
       (brand_id, brand_name, expiry_days, notes, updated_at, updated_by_user_id)
     values ($1, $2, $3, $4, now(), $5)
     on conflict (lower(brand_name))
       do update set
         brand_id = excluded.brand_id,
         brand_name = excluded.brand_name,
         expiry_days = excluded.expiry_days,
         notes = excluded.notes,
         updated_at = excluded.updated_at,
         updated_by_user_id = excluded.updated_by_user_id
     returning brand_id, brand_name, expiry_days, notes, updated_at, updated_by_user_id`,
    [input.brandId, input.brandName, input.expiryDays, input.notes, input.updatedByUserId],
  )
  return rowToOverride(result.rows[0]!)
}

export async function deleteBrandExpiryOverride(
  db: Queryable,
  brandName: string,
): Promise<boolean> {
  const result = await db.query<{ brand_name: string }>(
    `delete from brand_expiry_overrides
      where lower(brand_name) = lower($1)
      returning brand_name`,
    [brandName],
  )
  return result.rowCount !== null && result.rowCount > 0
}
