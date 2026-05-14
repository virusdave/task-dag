/**
 * Pending Purchase Database Queries
 * Implements CRUD operations for pending purchase packets, rows, and apply requests
 */

import type {
  PendingPurchasePacketSummary,
  PendingPurchaseApplyRequestSummary,
} from '../../../shared/contracts/domain/pendingPurchases.js'

export interface PendingPurchasePacket {
  packetId: number
  packetTitle: string
  source: 'generated' | 'import'
  sourcePath: string | null
  importFileName: string | null
  status: 'ready' | 'superseded'
  stateContext: unknown
  summary: unknown
  siteKeys: string[]
  siteLabels: string[]
  generatedAt: Date
  createdAt: Date
  updatedAt: Date
  createdByUser: string | null
  supersededByPacketId: number | null
}

export interface PendingPurchaseRow {
  rowId: number
  packetId: number
  rowIndex: number
  siteKey: string
  siteDealerId: number
  orderId: string | null
  positionId: string | null
  distributorProductName: string
  parsedBrand: string | null
  parsedCategory: string | null
  parsedSubcategory: string | null
  parsedVariantName: string | null
  parsedStrainName: string | null
  parsedPackSize: string | null
  parsedPackCount: number | null
  costPerUnit: number | null
  proposedRetailPrice: number | null
  gmPercent: number | null
  marketAvgPrice: number | null
  competitorListings: unknown | null
  evidenceTier: 'exact' | 'categorical' | 'none' | null
  matchedProductId: number | null
  matchedGroupId: number | null
  createProduct: boolean
  createGroup: boolean
  primaryImageUrl: string | null
  primaryImageHref: string | null
  metrcTag: string | null
  distributorSku: string | null
  reviewFlags: string[] | null
  mappingStatus: 'mapped_variant_ready_for_link' | 'needs_catalog_create' | 'needs_review' | null
  approvalStatus: 'pending' | 'approved' | 'rejected'
  approvedByUser: string | null
  approvedAt: Date | null
  reviewerNotes: string | null
  applyStatus: 'not_requested' | 'queued' | 'running' | 'applied' | 'failed' | 'blocked'
  applyRequestId: number | null
  appliedAt: Date | null
  applyError: string | null
  createdGroupId: number | null
  createdProductId: number | null
  createdDistributorLinkId: number | null
  createdAt: Date
  updatedAt: Date
}

export interface PendingPurchaseApplyRequest {
  requestId: number
  packetId: number
  jobId: number | null
  status: 'queued' | 'running' | 'succeeded' | 'partially_succeeded' | 'failed' | 'blocked'
  requestedAt: Date
  requestedByUser: string | null
  startedAt: Date | null
  finishedAt: Date | null
  totalRowCount: number
  appliedRowCount: number
  failedRowCount: number
  blockedRowCount: number
  resultSummary: unknown | null
  errorMessage: string | null
  createdAt: Date
  updatedAt: Date
}

export async function createPendingPurchasePacket(
  pool: Pool,
  packet: Omit<PendingPurchasePacket, 'packetId' | 'createdAt' | 'updatedAt'>
): Promise<number> {
  const result = await pool.query<{ packet_id: number }>(
    `INSERT INTO pending_purchase_packets (
      packet_title, source, source_path, import_file_name, status,
      state_context, summary, site_keys, site_labels, generated_at, created_by_user
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING packet_id`,
    [
      packet.packetTitle,
      packet.source,
      packet.sourcePath,
      packet.importFileName,
      packet.status,
      packet.stateContext,
      packet.summary,
      packet.siteKeys,
      packet.siteLabels,
      packet.generatedAt,
      packet.createdByUser,
    ]
  )
  return result.rows[0].packet_id
}

export async function getPendingPurchasePacket(pool: Pool, packetId: number): Promise<PendingPurchasePacket | null> {
  const result = await pool.query<PendingPurchasePacket>(
    `SELECT * FROM pending_purchase_packets WHERE packet_id = $1`,
    [packetId]
  )
  return result.rows[0] || null
}

export async function listPendingPurchasePackets(
  pool: Pool,
  options: { status?: string; limit?: number; offset?: number } = {}
): Promise<PendingPurchasePacket[]> {
  const { status, limit = 50, offset = 0 } = options
  
  let query = 'SELECT * FROM pending_purchase_packets'
  const params: unknown[] = []
  
  if (status) {
    query += ' WHERE status = $1'
    params.push(status)
  }
  
  query += ' ORDER BY generated_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2)
  params.push(limit, offset)
  
  const result = await pool.query<PendingPurchasePacket>(query, params)
  return result.rows
}

export async function createPendingPurchaseRow(
  pool: Pool,
  row: Omit<PendingPurchaseRow, 'rowId' | 'createdAt' | 'updatedAt'>
): Promise<number> {
  const result = await pool.query<{ row_id: number }>(
    `INSERT INTO pending_purchase_rows (
      packet_id, row_index, site_key, site_dealer_id, order_id, position_id,
      distributor_product_name, approval_status, apply_status, create_product, create_group
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING row_id`,
    [
      row.packetId,
      row.rowIndex,
      row.siteKey,
      row.siteDealerId,
      row.orderId,
      row.positionId,
      row.distributorProductName,
      row.approvalStatus || 'pending',
      row.applyStatus || 'not_requested',
      row.createProduct || false,
      row.createGroup || false,
    ]
  )
  return result.rows[0].row_id
}

export async function getPendingPurchaseRow(pool: Pool, rowId: number): Promise<PendingPurchaseRow | null> {
  const result = await pool.query<PendingPurchaseRow>(
    `SELECT * FROM pending_purchase_rows WHERE row_id = $1`,
    [rowId]
  )
  return result.rows[0] || null
}

export async function listPendingPurchaseRows(
  pool: Pool,
  packetId: number
): Promise<PendingPurchaseRow[]> {
  const result = await pool.query<PendingPurchaseRow>(
    `SELECT * FROM pending_purchase_rows WHERE packet_id = $1 ORDER BY row_index`,
    [packetId]
  )
  return result.rows
}

export async function updatePendingPurchaseRow(
  pool: Pool,
  rowId: number,
  updates: Partial<PendingPurchaseRow>
): Promise<void> {
  const fields: string[] = []
  const values: unknown[] = []
  let paramIndex = 1
  
  // Build dynamic UPDATE query based on provided fields
  Object.entries(updates).forEach(([key, value]) => {
    if (key !== 'rowId' && key !== 'createdAt' && key !== 'updatedAt') {
      fields.push(`${key} = $${paramIndex}`)
      values.push(value)
      paramIndex++
    }
  })
  
  if (fields.length === 0) return
  
  values.push(rowId)
  await pool.query(
    `UPDATE pending_purchase_rows SET ${fields.join(', ')} WHERE row_id = $${paramIndex}`,
    values
  )
}

export async function createPendingPurchaseApplyRequest(
  pool: Pool,
  request: Omit<PendingPurchaseApplyRequest, 'requestId' | 'createdAt' | 'updatedAt'>
): Promise<number> {
  const result = await pool.query<{ request_id: number }>(
    `INSERT INTO pending_purchase_apply_requests (
      packet_id, job_id, status, requested_by_user, total_row_count
    ) VALUES ($1, $2, $3, $4, $5)
    RETURNING request_id`,
    [request.packetId, request.jobId, request.status, request.requestedByUser, request.totalRowCount]
  )
  return result.rows[0].request_id
}

export async function updatePendingPurchaseApplyRequest(
  pool: Pool,
  requestId: number,
  updates: Partial<PendingPurchaseApplyRequest>
): Promise<void> {
  const fields: string[] = []
  const values: unknown[] = []
  let paramIndex = 1
  
  Object.entries(updates).forEach(([key, value]) => {
    if (key !== 'requestId' && key !== 'createdAt' && key !== 'updatedAt') {
      fields.push(`${key} = $${paramIndex}`)
      values.push(value)
      paramIndex++
    }
  })
  
  if (fields.length === 0) return
  
  values.push(requestId)
  await pool.query(
    `UPDATE pending_purchase_apply_requests SET ${fields.join(', ')} WHERE request_id = $${paramIndex}`,
    values
  )
}

export async function getPendingPurchaseApplyRequest(
  pool: Pool,
  requestId: number
): Promise<PendingPurchaseApplyRequest | null> {
  const result = await pool.query<PendingPurchaseApplyRequest>(
    `SELECT * FROM pending_purchase_apply_requests WHERE request_id = $1`,
    [requestId]
  )
  return result.rows[0] || null
}
