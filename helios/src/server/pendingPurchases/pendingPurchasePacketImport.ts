import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import type { PoolClient } from 'pg'
import { z } from 'zod'

import type {
  JsonValue,
  PendingPurchaseMappingStatus,
  PendingPurchasePacketSource,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import type { Queryable } from '../db/pool.js'
import { isPendingPurchaseRefinementSchemaAvailable } from '../db/queries/pendingPurchaseRefinementQueries.js'

const PendingPurchaseRowImportSchema = z.object({
  actionType: z.string().trim().min(1),
  catalogAction: z.string().trim().min(1),
  currentDescription: z.string().nullable().optional(),
  currentPrice: z.number().nullable().optional(),
  distributorProductId: z.union([z.number().int(), z.string().trim().min(1)]),
  distributorProductName: z.string().trim().min(1),
  expectedCategory: z.string().nullable().optional(),
  expectedSubcategory: z.string().nullable().optional(),
  marketAdviceSummary: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  orderIds: z.array(z.number().int()).default([]),
  positionIds: z.array(z.number().int()).default([]),
  pricingReason: z.string().nullable().optional(),
  primaryImageNote: z.string().nullable().optional(),
  primaryImageSource: z.string().nullable().optional(),
  primaryImageUrl: z.string().nullable().optional(),
  proposedDescription: z.string().nullable().optional(),
  proposedPrice: z.number().nullable().optional(),
  reviewFlags: z.array(z.string()).default([]),
  rowCacheKey: z.string().trim().min(1).optional(),
  rowInputSignature: z.string().trim().min(1).nullable().optional(),
  siteDealerId: z.number().int().positive().nullable().optional(),
  siteDealerName: z.string().nullable().optional(),
  siteKey: z.string().trim().min(1),
  siteLabel: z.string().trim().min(1),
  targetBrand: z.string().nullable().optional(),
  targetGroupName: z.string().nullable().optional(),
  targetVariantName: z.string().nullable().optional(),
}).passthrough()

export const PendingPurchasePacketSchema = z.object({
  generatedAt: z.string().trim().min(1),
  orders: z.array(z.unknown()).default([]),
  packetTitle: z.string().trim().min(1),
  rows: z.array(PendingPurchaseRowImportSchema),
  siteKeys: z.array(z.string()).default([]),
  siteLabels: z.array(z.string()).default([]),
  stateContext: z.record(z.string(), z.unknown()).default({}),
  summary: z.record(z.string(), z.unknown()).default({}),
})

export type PendingPurchasePacket = z.infer<typeof PendingPurchasePacketSchema>
type PendingPurchaseImportRow = z.infer<typeof PendingPurchaseRowImportSchema>

const IMPORT_BATCH_SIZE = 250

interface PreparedPendingPurchaseRow {
  actionType: string
  catalogAction: string
  currentDescription: string | null
  currentPrice: number | null
  distributorProductId: string
  distributorProductName: string
  expectedCategory: string | null
  expectedSubcategory: string | null
  mappingStatus: PendingPurchaseMappingStatus
  marketAdviceSummary: string | null
  notes: string | null
  orderIdsJson: string
  positionIdsJson: string
  pricingReason: string | null
  primaryImageNote: string | null
  primaryImageSource: string | null
  primaryImageUrl: string | null
  proposedDescription: string | null
  proposedPrice: number | null
  rawRowJson: string
  reviewFlagsJson: string
  row: PendingPurchaseImportRow
  rowInputSignature: string | null
  rowKey: string
  siteDealerId: number | null
  siteDealerName: string | null
  siteKey: string
  siteLabel: string
  targetBrand: string | null
  targetGroupName: string | null
  targetVariantName: string | null
}

interface ExistingJobPacketRow {
  audit_event_id: number | null
  audit_row_count: number | null
  id: number
  row_count: number
}

export interface ImportPendingPurchasePacketInput {
  createdByUserId: number | null
  importFileName: string | null
  jobId: number | null
  packet: PendingPurchasePacket
  requestId: string
  source: PendingPurchasePacketSource
  sourcePath: string | null
}

export interface ImportPendingPurchasePacketResult {
  auditEventId: number
  importedRowCount: number
  packetId: number
}

export async function readPendingPurchasePacketFromFile(filePath: string): Promise<PendingPurchasePacket> {
  const normalizedFilePath = resolve(filePath)
  const packetText = await readFile(normalizedFilePath, 'utf8')
  return PendingPurchasePacketSchema.parse(JSON.parse(packetText))
}

export async function importPendingPurchasePacket(
  db: PoolClient,
  input: ImportPendingPurchasePacketInput,
): Promise<ImportPendingPurchasePacketResult> {
  return persistPendingPurchasePacket(db, input)
}

export async function persistPendingPurchasePacket(
  db: PoolClient,
  input: ImportPendingPurchasePacketInput,
): Promise<ImportPendingPurchasePacketResult> {
  const preparedRows = preparePendingPurchaseRows(input.packet.rows)
  const auditEventType = input.source === 'generated'
    ? 'pending_purchase.packet.generated'
    : 'pending_purchase.packet.imported'
  const actionLabel = input.source === 'generated' ? 'Generated' : 'Imported'

  // Take this unconditionally before the schema probe: migration 102 also
  // locks this table, so it cannot commit between a false probe and a legacy
  // packet insert. ACCESS EXCLUSIVE also waits for packet readers, preventing
  // a refinement request from retaining stale root state across supersession.
  await db.query('lock table pending_purchase_packets in access exclusive mode')
  const hasRefinementLineage = await isPendingPurchaseRefinementSchemaAvailable(db)

  if (input.jobId !== null) {
    const existingResult = await db.query<ExistingJobPacketRow>(
      `
        select
          p.id,
          count(rows.id)::integer as row_count,
          audit.id as audit_event_id,
          audit.imported_row_count as audit_row_count
        from pending_purchase_packets p
        left join lateral (
          select
            audit_event.id,
            (audit_event.payload_json ->> 'importedRowCount')::integer as imported_row_count
          from audit_events audit_event
          where audit_event.entity_type = 'pending_purchase_packet'
            and audit_event.entity_id = p.id::text
            and audit_event.event_type = $2
          order by audit_event.id desc
          limit 1
        ) audit on true
        left join pending_purchase_rows rows on rows.packet_id = p.id
        where p.job_id = $1
          and p.source = $3
        group by p.id, audit.id, audit.imported_row_count
        order by p.id asc
      `,
      [input.jobId, auditEventType, input.source],
    )
    if (existingResult.rows.length > 1) {
      throw new Error(`Pending-purchase job ${input.jobId} already has multiple persisted packets.`)
    }
    const existing = existingResult.rows[0]
    if (existing !== undefined) {
      if (existing.audit_event_id === null || existing.audit_row_count !== existing.row_count) {
        throw new Error(`Pending-purchase job ${input.jobId} has incomplete persisted packet ${existing.id}.`)
      }
      return {
        auditEventId: existing.audit_event_id,
        importedRowCount: existing.row_count,
        packetId: existing.id,
      }
    }
  }

  if (hasRefinementLineage) {
    await db.query(
      `
        update pending_purchase_packets
        set revision_status = 'superseded',
            is_applyable = false,
            updated_at = now()
        where packet_root_id in (
          select id
          from pending_purchase_packet_roots
          where root_status = 'active'
        )
          and id in (
            select current_packet_id
            from pending_purchase_packet_roots
            where root_status = 'active'
          )
          and (revision_status <> 'superseded' or is_applyable)
      `,
    )
    await db.query(
      `
        update pending_purchase_packet_roots
        set current_packet_id = null,
            current_revision_number = null,
            root_status = 'superseded',
            version = version + 1,
            updated_at = now()
        where root_status = 'active'
      `,
    )
  }

  await db.query(
    `
      update pending_purchase_packets
      set status = 'superseded',
          ${hasRefinementLineage ? "revision_status = 'superseded', is_applyable = false," : ''}
          updated_at = now()
      where status = 'ready'
    `,
  )

  const packetInsert = await db.query<{ id: number }>(
    `
      insert into pending_purchase_packets (
        source,
        status,
        packet_title,
        import_file_name,
        source_path,
        generated_at,
        site_keys_json,
        site_labels_json,
        orders_json,
        summary_json,
        state_context_json,
        job_id,
        created_by_user_id
      )
      values ($1, 'ready', $2, $3, $4, $5::timestamptz, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12)
      returning id
    `,
    [
      input.source,
      input.packet.packetTitle,
      input.importFileName,
      input.sourcePath,
      input.packet.generatedAt,
      JSON.stringify(input.packet.siteKeys),
      JSON.stringify(input.packet.siteLabels),
      JSON.stringify(input.packet.orders),
      JSON.stringify(input.packet.summary),
      JSON.stringify(input.packet.stateContext),
      input.jobId,
      input.createdByUserId,
    ],
  )

  const packetId = packetInsert.rows[0].id

  for (const batchRows of chunkItems(preparedRows, IMPORT_BATCH_SIZE)) {
    await insertPendingPurchaseRows(db, packetId, batchRows)
  }

  if (hasRefinementLineage) {
    await db.query(
      `
        update pending_purchase_rows
        set row_lineage_id = 'pprline_' || id::text,
            lineage_revision_number = 1
        where packet_id = $1
          and row_lineage_id is null
      `,
      [packetId],
    )
    const rootInsertValues: [rootKey: string, packetId: number, createdByUserId: number | null] = [
      `pprroot_${packetId}`,
      packetId,
      input.createdByUserId,
    ]
    const rootInsert = await db.query<{ id: number }>(
      `
        insert into pending_purchase_packet_roots (
          root_key,
          source_packet_id,
          current_packet_id,
          current_revision_number,
          root_status,
          created_by_user_id,
          current_updated_by_user_id,
          current_updated_at
        )
        values ($1, $2, $2, 1, 'active', $3, $3, now())
        returning id
      `,
      rootInsertValues,
    )
    await db.query(
      `
        update pending_purchase_packets
        set packet_root_id = $2,
            revision_number = 1,
            revision_status = 'current',
            is_applyable = true,
            revision_created_reason = 'Initial persisted packet.',
            accepted_at = coalesce(generated_at, created_at, now()),
            accepted_by_user_id = $3,
            updated_at = now()
        where id = $1
      `,
      [packetId, rootInsert.rows[0].id, input.createdByUserId],
    )
  }

  const auditEventId = await appendAuditEvent(db, {
    actorType: 'system',
    actorUserId: null,
    entityId: String(packetId),
    entityType: 'pending_purchase_packet',
    eventType: auditEventType,
    module: 'catalog',
    payload: {
      importedRowCount: preparedRows.length,
      packetId,
      packetTitle: input.packet.packetTitle,
      source: input.source,
      sourcePath: input.sourcePath,
      summary: `${actionLabel} pending-purchase packet #${packetId} with ${preparedRows.length} rows.`,
    },
    requestId: input.requestId,
    scope: { entityId: String(packetId), entityType: 'pending_purchase_packet' },
    undoPayload: null,
  })

  return { auditEventId, importedRowCount: preparedRows.length, packetId }
}

export function getPendingPurchaseImportFileName(filePath: string): string {
  return basename(resolve(filePath))
}

function preparePendingPurchaseRows(rows: PendingPurchaseImportRow[]): PreparedPendingPurchaseRow[] {
  return rows.map((row) => ({
    actionType: row.actionType,
    catalogAction: row.catalogAction,
    currentDescription: normalizeNullableString(row.currentDescription),
    currentPrice: normalizeNullableNumber(row.currentPrice),
    distributorProductId: String(row.distributorProductId),
    distributorProductName: row.distributorProductName,
    expectedCategory: normalizeNullableString(row.expectedCategory),
    expectedSubcategory: normalizeNullableString(row.expectedSubcategory),
    mappingStatus: deriveMappingStatus(row),
    marketAdviceSummary: normalizeNullableString(row.marketAdviceSummary),
    notes: normalizeNullableString(row.notes),
    orderIdsJson: JSON.stringify(row.orderIds),
    positionIdsJson: JSON.stringify(row.positionIds),
    pricingReason: normalizeNullableString(row.pricingReason),
    primaryImageNote: normalizeNullableString(row.primaryImageNote),
    primaryImageSource: normalizeNullableString(row.primaryImageSource),
    primaryImageUrl: normalizeNullableString(row.primaryImageUrl),
    proposedDescription: normalizeNullableString(row.proposedDescription),
    proposedPrice: normalizeNullableNumber(row.proposedPrice),
    rawRowJson: JSON.stringify(row),
    reviewFlagsJson: JSON.stringify(row.reviewFlags),
    row,
    rowInputSignature: normalizeNullableString(row.rowInputSignature),
    rowKey: row.rowCacheKey ?? `${row.siteKey}:${String(row.distributorProductId)}`,
    siteDealerId: typeof row.siteDealerId === 'number' ? row.siteDealerId : null,
    siteDealerName: normalizeNullableString(row.siteDealerName),
    siteKey: row.siteKey,
    siteLabel: row.siteLabel,
    targetBrand: normalizeNullableString(row.targetBrand),
    targetGroupName: normalizeNullableString(row.targetGroupName),
    targetVariantName: normalizeNullableString(row.targetVariantName),
  }))
}

async function insertPendingPurchaseRows(
  db: Queryable,
  packetId: number,
  rows: PreparedPendingPurchaseRow[],
): Promise<void> {
  const values: unknown[] = []
  const tuples = rows.map((preparedRow, index) => {
    const offset = index * 31
    values.push(
      packetId,
      preparedRow.rowKey,
      preparedRow.rowInputSignature,
      preparedRow.siteKey,
      preparedRow.siteLabel,
      preparedRow.siteDealerId,
      preparedRow.siteDealerName,
      preparedRow.distributorProductId,
      preparedRow.distributorProductName,
      preparedRow.actionType,
      preparedRow.mappingStatus,
      preparedRow.targetBrand,
      preparedRow.targetGroupName,
      preparedRow.targetVariantName,
      preparedRow.expectedCategory,
      preparedRow.expectedSubcategory,
      preparedRow.currentPrice,
      preparedRow.proposedPrice,
      preparedRow.currentDescription,
      preparedRow.proposedDescription,
      preparedRow.primaryImageUrl,
      preparedRow.primaryImageSource,
      preparedRow.primaryImageNote,
      preparedRow.catalogAction,
      preparedRow.pricingReason,
      preparedRow.marketAdviceSummary,
      preparedRow.notes,
      preparedRow.reviewFlagsJson,
      preparedRow.orderIdsJson,
      preparedRow.positionIdsJson,
      preparedRow.rawRowJson,
    )

    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}, $${offset + 16}, $${offset + 17}, $${offset + 18}, $${offset + 19}, $${offset + 20}, $${offset + 21}, $${offset + 22}, $${offset + 23}, $${offset + 24}, $${offset + 25}, $${offset + 26}, $${offset + 27}, $${offset + 28}::jsonb, $${offset + 29}::jsonb, $${offset + 30}::jsonb, $${offset + 31}::jsonb)`
  })

  await db.query(
    `
      insert into pending_purchase_rows (
        packet_id,
        row_key,
        row_input_signature,
        site_key,
        site_label,
        site_dealer_id,
        site_dealer_name,
        distributor_product_id,
        distributor_product_name,
        action_type,
        mapping_status,
        target_brand,
        target_group_name,
        target_variant_name,
        expected_category,
        expected_subcategory,
        current_price,
        proposed_price,
        current_description,
        proposed_description,
        primary_image_url,
        primary_image_source,
        primary_image_note,
        catalog_action,
        pricing_reason,
        market_advice_summary,
        notes,
        review_flags_json,
        order_ids_json,
        position_ids_json,
        raw_row_json
      )
      values ${tuples.join(', ')}
    `,
    values,
  )
}

function deriveMappingStatus(row: PendingPurchaseImportRow): PendingPurchaseMappingStatus {
  if (row.actionType === 'mapping-only') {
    return 'mapped_variant_ready_for_link'
  }
  if (row.actionType === 'catalog-create') {
    return 'needs_catalog_create'
  }
  return 'needs_review'
}

function normalizeNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function chunkItems<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

export function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
