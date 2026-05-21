import type { PoolClient } from 'pg'

import {
  WhitegloveSnapshotEnvelopeSchema,
  WhitegloveSnapshotPayloadSchema,
  type WhitegloveSnapshotEnvelope,
  type WhitegloveSnapshotPayload,
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

function rowToEnvelope(row: SnapshotRow): WhitegloveSnapshotEnvelope {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  const costBasisGeneratedAt =
    row.cost_basis_generated_at instanceof Date
      ? row.cost_basis_generated_at.toISOString()
      : row.cost_basis_generated_at
  return WhitegloveSnapshotEnvelopeSchema.parse({
    id: row.id,
    createdAt,
    createdBy: row.created_by,
    costBasisGeneratedAt,
    payload: WhitegloveSnapshotPayloadSchema.parse(row.payload),
  })
}

export async function getCurrentWhitegloveSnapshot(
  db: Queryable = getPool(),
): Promise<WhitegloveSnapshotEnvelope | null> {
  const result = await db.query<SnapshotRow>(
    `select id, created_at, created_by, cost_basis_generated_at, payload_version, payload
       from whiteglove_pricing_snapshots
      where is_current = true
      order by created_at desc
      limit 1`,
  )
  if (result.rows.length === 0) return null
  return rowToEnvelope(result.rows[0])
}

export async function insertWhitegloveSnapshot(args: {
  createdBy: string
  costBasisGeneratedAt: string
  payload: WhitegloveSnapshotPayload
}): Promise<WhitegloveSnapshotEnvelope> {
  return withTransaction(async (client: PoolClient) => {
    await client.query(
      `update whiteglove_pricing_snapshots set is_current = false where is_current = true`,
    )
    const inserted = await client.query<SnapshotRow>(
      `insert into whiteglove_pricing_snapshots
         (created_by, cost_basis_generated_at, payload_version, payload, is_current)
       values ($1, $2, $3, $4::jsonb, true)
       returning id, created_at, created_by, cost_basis_generated_at, payload_version, payload`,
      [args.createdBy, args.costBasisGeneratedAt, args.payload.schemaVersion, JSON.stringify(args.payload)],
    )
    return rowToEnvelope(inserted.rows[0])
  })
}
