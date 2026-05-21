import type { PoolClient } from 'pg'

import {
  WhitelabelSnapshotEnvelopeSchema,
  WhitelabelSnapshotPayloadSchema,
  type WhitelabelSnapshotEnvelope,
  type WhitelabelSnapshotPayload,
} from '../../../shared/contracts/index.js'
import { getPool, type Queryable } from '../pool.js'
import { withTransaction } from '../tx.js'

interface SnapshotRow {
  id: number
  created_at: string | Date
  created_by: string
  cost_basis_generated_at: string | Date
  payload_version: number
  payload: unknown
}

function rowToEnvelope(row: SnapshotRow): WhitelabelSnapshotEnvelope {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  const costBasisGeneratedAt =
    row.cost_basis_generated_at instanceof Date
      ? row.cost_basis_generated_at.toISOString()
      : row.cost_basis_generated_at
  return WhitelabelSnapshotEnvelopeSchema.parse({
    id: row.id,
    createdAt,
    createdBy: row.created_by,
    costBasisGeneratedAt,
    payload: WhitelabelSnapshotPayloadSchema.parse(row.payload),
  })
}

export async function getCurrentWhitelabelSnapshot(
  db: Queryable = getPool(),
): Promise<WhitelabelSnapshotEnvelope | null> {
  const result = await db.query<SnapshotRow>(
    `select id, created_at, created_by, cost_basis_generated_at, payload_version, payload
       from whitelabel_pricing_snapshots
      where is_current = true
      order by created_at desc
      limit 1`,
  )
  if (result.rows.length === 0) return null
  return rowToEnvelope(result.rows[0])
}

export async function insertWhitelabelSnapshot(args: {
  createdBy: string
  costBasisGeneratedAt: string
  payload: WhitelabelSnapshotPayload
}): Promise<WhitelabelSnapshotEnvelope> {
  return withTransaction(async (client: PoolClient) => {
    await client.query(
      `update whitelabel_pricing_snapshots set is_current = false where is_current = true`,
    )
    const inserted = await client.query<SnapshotRow>(
      `insert into whitelabel_pricing_snapshots
         (created_by, cost_basis_generated_at, payload_version, payload, is_current)
       values ($1, $2, $3, $4::jsonb, true)
       returning id, created_at, created_by, cost_basis_generated_at, payload_version, payload`,
      [args.createdBy, args.costBasisGeneratedAt, args.payload.schemaVersion, JSON.stringify(args.payload)],
    )
    return rowToEnvelope(inserted.rows[0])
  })
}
