import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { z } from 'zod'

import { ValidationIssueSchema, type ValidationIssue } from '../../shared/contracts/domain/proposals.js'
import { sha256, stableJsonStringify } from '../../shared/util/hash.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import type { Queryable } from '../db/pool.js'

const ImportedValidationIssueSchema = z
  .union([z.string(), ValidationIssueSchema])
  .transform<ValidationIssue>((issue) => {
    if (typeof issue === 'string') {
      return {
        code: 'imported-issue',
        detail: issue,
        severity: 'warning',
      }
    }

    return issue
  })

const IMPORT_BATCH_SIZE = 250

export const ReviewProductSchema = z.object({
  gmPercent: z.number().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  name: z.string(),
  price: z.number().nullable().optional(),
  productId: z.number().int(),
  shortName: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
  tab: z.string(),
  wholesaleCost: z.number().nullable().optional(),
})

export const ReviewRowSchema = z.object({
  attemptCount: z.number().int().optional(),
  brand: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  confidence: z.string().nullable().optional(),
  currentDescription: z.string().nullable().optional(),
  effects: z.array(z.string()).default([]),
  flavorings: z.array(z.string()).default([]),
  generatedAt: z.string(),
  groupFullName: z.string().nullable().optional(),
  groupId: z.number().int(),
  groupName: z.string(),
  imageUrl: z.string().nullable().optional(),
  litalertsCandidateListings: z.array(z.unknown()).default([]),
  litalertsMatchedListings: z.array(z.unknown()).default([]),
  litalertsSearchTerms: z.array(z.string()).default([]),
  litalertsSelectedListingIndexes: z.array(z.number().int()).default([]),
  litalertsSourceNote: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  omittedRequiredPhrases: z.array(z.string()).default([]),
  originalDescription: z.string().nullable().optional(),
  productTabs: z.array(z.string()).default([]),
  products: z.array(ReviewProductSchema).default([]),
  promptVersion: z.string().nullable().optional(),
  proposedDescription: z.string(),
  requiredPhrasePresence: z.record(z.string(), z.boolean()).default({}),
  scents: z.array(z.string()).default([]),
  seoKeywords: z.array(z.string()).default([]),
  strain: z.string().nullable().optional(),
  subcategory: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  validationIssues: z.array(ImportedValidationIssueSchema).default([]),
})

export const ReviewPacketSchema = z.object({
  dealerId: z.number().int(),
  dealerName: z.string(),
  generatedAt: z.string(),
  rows: z.array(ReviewRowSchema),
  summary: z.record(z.string(), z.unknown()),
})

export type ReviewRow = z.infer<typeof ReviewRowSchema>
export type ReviewPacket = z.infer<typeof ReviewPacketSchema>

interface PreparedImportRow {
  currentDescriptionJson: string
  evidenceJson: string
  generatedAt: string
  groupFullName: string
  lineItemValidationIssuesJson: string
  liveStateHash: string
  liveStateJson: string
  merchandisingContextJson: string
  productTabsJson: string
  proposedDescriptionJson: string
  row: ReviewRow
}

export interface ImportReviewPacketInput {
  createdByUserId: number | null
  importFileName: string
  jobId: number | null
  packet: ReviewPacket
  requestId: string
  sourcePath: string | null
}

export interface ImportReviewPacketResult {
  auditEventId: number
  importedGroupCount: number
  importedLineItemCount: number
  proposalBatchId: number
}

export async function readReviewPacketFromFile(filePath: string): Promise<ReviewPacket> {
  const normalizedFilePath = resolve(filePath)
  const packetText = await readFile(normalizedFilePath, 'utf8')
  return ReviewPacketSchema.parse(JSON.parse(packetText))
}

export async function importReviewPacket(
  db: Queryable,
  input: ImportReviewPacketInput,
): Promise<ImportReviewPacketResult> {
  const preparedRows = prepareImportRows(input.packet.rows)
  const duplicateGroupIds = findDuplicateGroupIds(preparedRows)
  if (duplicateGroupIds.length > 0) {
    throw new Error(
      `Review packet contains duplicate groupIds: ${duplicateGroupIds.slice(0, 10).join(', ')}${duplicateGroupIds.length > 10 ? ', ...' : ''}`,
    )
  }

  const batchInsert = await db.query<{ id: number }>(
    `
      insert into proposal_batches (
        type,
        source,
        trigger_mode,
        status,
        prompt_version,
        model,
        summary_json,
        config_json,
        job_id,
        created_by_user_id
      )
      values ('description', 'import', 'import', 'ready', $1, $2, $3::jsonb, $4::jsonb, $5, $6)
      returning id
    `,
    [
      input.packet.rows[0]?.promptVersion ?? null,
      input.packet.rows[0]?.model ?? null,
      JSON.stringify(input.packet.summary),
      JSON.stringify({
        dealerId: input.packet.dealerId,
        dealerName: input.packet.dealerName,
        generatedAt: input.packet.generatedAt,
        importFileName: input.importFileName,
        sourcePath: input.sourcePath,
      }),
      input.jobId,
      input.createdByUserId,
    ],
  )

  const proposalBatchId = batchInsert.rows[0].id
  const catalogGroupIdBySweedGroupId = new Map<number, number>()
  for (const batchRows of chunkItems(preparedRows, IMPORT_BATCH_SIZE)) {
    const insertedGroups = await insertCatalogGroups(db, batchRows)
    for (const insertedGroup of insertedGroups) {
      catalogGroupIdBySweedGroupId.set(insertedGroup.sweed_group_id, insertedGroup.id)
    }
  }

  const snapshotIdByCatalogGroupId = new Map<number, number>()
  for (const batchRows of chunkItems(preparedRows, IMPORT_BATCH_SIZE)) {
    const insertedSnapshots = await insertCatalogGroupSnapshots(db, batchRows, catalogGroupIdBySweedGroupId)
    for (const insertedSnapshot of insertedSnapshots) {
      snapshotIdByCatalogGroupId.set(insertedSnapshot.catalog_group_id, insertedSnapshot.id)
    }
  }

  const proposalRowIdBySweedGroupId = new Map<number, number>()
  for (const batchRows of chunkItems(preparedRows, IMPORT_BATCH_SIZE)) {
    const insertedProposalRows = await insertProposalRows(
      db,
      proposalBatchId,
      batchRows,
      catalogGroupIdBySweedGroupId,
      snapshotIdByCatalogGroupId,
    )
    for (const insertedProposalRow of insertedProposalRows) {
      proposalRowIdBySweedGroupId.set(insertedProposalRow.target_entity_id, insertedProposalRow.id)
    }
  }

  for (const batchRows of chunkItems(preparedRows, IMPORT_BATCH_SIZE)) {
    await insertProposalLineItems(db, batchRows, catalogGroupIdBySweedGroupId, proposalRowIdBySweedGroupId)
  }

  const importedGroupCount = preparedRows.length
  const importedLineItemCount = preparedRows.length

  const auditEventId = await appendAuditEvent(db, {
    actorType: 'system',
    actorUserId: null,
    entityId: String(proposalBatchId),
    entityType: 'proposal_batch',
    eventType: 'proposal.batch.imported',
    module: 'catalog',
    payload: {
      generatedAt: input.packet.generatedAt,
      importFileName: input.importFileName,
      importedGroupCount,
      importedLineItemCount,
      proposalBatchId,
      sourcePath: input.sourcePath,
    },
    requestId: input.requestId,
    undoPayload: null,
  })

  return { auditEventId, importedGroupCount, importedLineItemCount, proposalBatchId }
}

function buildImportedLiveState(row: ReviewRow) {
  return {
    brand: row.brand ?? null,
    category: row.category ?? null,
    confidence: row.confidence ?? null,
    currentDescription: row.currentDescription ?? '',
    effects: row.effects,
    flavorings: row.flavorings,
    groupFullName: row.groupFullName ?? row.groupName,
    groupId: row.groupId,
    groupName: row.groupName,
    imageUrl: row.imageUrl ?? null,
    productTabs: row.productTabs,
    products: row.products,
    scents: row.scents,
    strain: row.strain ?? null,
    subcategory: row.subcategory ?? null,
    tags: row.tags,
  }
}

function prepareImportRows(rows: ReviewRow[]): PreparedImportRow[] {
  return rows.map((row) => {
    const liveState = buildImportedLiveState(row)

    return {
      currentDescriptionJson: JSON.stringify(row.currentDescription ?? ''),
      evidenceJson: JSON.stringify({
        attemptCount: row.attemptCount ?? null,
        litalertsCandidateListings: row.litalertsCandidateListings,
        litalertsMatchedListings: row.litalertsMatchedListings,
        litalertsSearchTerms: row.litalertsSearchTerms,
        litalertsSelectedListingIndexes: row.litalertsSelectedListingIndexes,
        litalertsSourceNote: row.litalertsSourceNote ?? null,
        omittedRequiredPhrases: row.omittedRequiredPhrases,
        originalDescription: row.originalDescription ?? null,
        requiredPhrasePresence: row.requiredPhrasePresence,
      }),
      generatedAt: row.generatedAt,
      groupFullName: row.groupFullName ?? row.groupName,
      lineItemValidationIssuesJson: JSON.stringify(row.validationIssues),
      liveStateHash: sha256(stableJsonStringify(liveState)),
      liveStateJson: JSON.stringify(liveState),
      merchandisingContextJson: JSON.stringify({
        confidence: row.confidence ?? null,
        currentDescription: row.currentDescription ?? null,
        seoKeywords: row.seoKeywords,
        tags: row.tags,
      }),
      productTabsJson: JSON.stringify(row.productTabs),
      proposedDescriptionJson: JSON.stringify(row.proposedDescription),
      row,
    }
  })
}

function findDuplicateGroupIds(rows: PreparedImportRow[]): number[] {
  const seenGroupIds = new Set<number>()
  const duplicateGroupIds = new Set<number>()

  for (const preparedRow of rows) {
    if (seenGroupIds.has(preparedRow.row.groupId)) {
      duplicateGroupIds.add(preparedRow.row.groupId)
      continue
    }

    seenGroupIds.add(preparedRow.row.groupId)
  }

  return [...duplicateGroupIds].sort((left, right) => left - right)
}

async function insertCatalogGroups(
  db: Queryable,
  rows: PreparedImportRow[],
): Promise<Array<{ id: number; sweed_group_id: number }>> {
  const values: unknown[] = []
  const tuples = rows.map((preparedRow, index) => {
    const offset = index * 11
    values.push(
      preparedRow.row.groupId,
      preparedRow.row.groupName,
      preparedRow.groupFullName,
      preparedRow.row.brand ?? null,
      preparedRow.row.category ?? null,
      preparedRow.row.subcategory ?? null,
      preparedRow.row.strain ?? null,
      preparedRow.productTabsJson,
      preparedRow.liveStateJson,
      preparedRow.liveStateHash,
      preparedRow.generatedAt,
    )

    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}::jsonb, $${offset + 9}::jsonb, $${offset + 10}, 'unknown', $${offset + 11}::timestamptz, $${offset + 11}::timestamptz)`
  })

  const result = await db.query<{ id: number; sweed_group_id: number }>(
    `
      insert into catalog_groups (
        sweed_group_id,
        group_name,
        group_full_name,
        brand_name,
        category_name,
        subcategory_name,
        strain_name,
        product_tabs_json,
        live_state_json,
        live_state_hash,
        reconcile_status,
        last_synced_at,
        last_seen_at
      )
      values ${tuples.join(', ')}
      on conflict (sweed_group_id) do update
      set group_name = excluded.group_name,
          group_full_name = excluded.group_full_name,
          brand_name = excluded.brand_name,
          category_name = excluded.category_name,
          subcategory_name = excluded.subcategory_name,
          strain_name = excluded.strain_name,
          product_tabs_json = excluded.product_tabs_json,
          live_state_json = excluded.live_state_json,
          live_state_hash = excluded.live_state_hash,
          last_synced_at = excluded.last_synced_at,
          last_seen_at = excluded.last_seen_at,
          updated_at = now()
      returning id, sweed_group_id
    `,
    values,
  )

  return result.rows
}

async function insertCatalogGroupSnapshots(
  db: Queryable,
  rows: PreparedImportRow[],
  catalogGroupIdBySweedGroupId: Map<number, number>,
): Promise<Array<{ catalog_group_id: number; id: number }>> {
  const values: unknown[] = []
  const tuples = rows.map((preparedRow, index) => {
    const offset = index * 3
    values.push(
      getRequiredMapValue(catalogGroupIdBySweedGroupId, preparedRow.row.groupId, 'catalog group id'),
      preparedRow.liveStateJson,
      preparedRow.liveStateHash,
    )

    return `($${offset + 1}, 'sync', $${offset + 2}::jsonb, $${offset + 3})`
  })

  const result = await db.query<{ catalog_group_id: number; id: number }>(
    `
      insert into catalog_group_snapshots (catalog_group_id, source, state_json, state_hash)
      values ${tuples.join(', ')}
      returning id, catalog_group_id
    `,
    values,
  )

  return result.rows
}

async function insertProposalRows(
  db: Queryable,
  proposalBatchId: number,
  rows: PreparedImportRow[],
  catalogGroupIdBySweedGroupId: Map<number, number>,
  snapshotIdByCatalogGroupId: Map<number, number>,
): Promise<Array<{ id: number; target_entity_id: number }>> {
  const values: unknown[] = []
  const tuples = rows.map((preparedRow, index) => {
    const offset = index * 7
    const catalogGroupId = getRequiredMapValue(catalogGroupIdBySweedGroupId, preparedRow.row.groupId, 'catalog group id')
    values.push(
      proposalBatchId,
      catalogGroupId,
      preparedRow.row.groupId,
      getRequiredMapValue(snapshotIdByCatalogGroupId, catalogGroupId, 'snapshot id'),
      preparedRow.groupFullName,
      preparedRow.merchandisingContextJson,
      preparedRow.evidenceJson,
    )

    return `($${offset + 1}, $${offset + 2}, 'catalog_group', $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}::jsonb, $${offset + 7}::jsonb)`
  })

  const result = await db.query<{ id: number; target_entity_id: number }>(
    `
      insert into proposal_rows (
        proposal_batch_id,
        catalog_group_id,
        target_entity_type,
        target_entity_id,
        baseline_snapshot_id,
        row_title,
        merchandising_context_json,
        evidence_json
      )
      values ${tuples.join(', ')}
      returning id, target_entity_id
    `,
    values,
  )

  return result.rows
}

async function insertProposalLineItems(
  db: Queryable,
  rows: PreparedImportRow[],
  catalogGroupIdBySweedGroupId: Map<number, number>,
  proposalRowIdBySweedGroupId: Map<number, number>,
): Promise<void> {
  const values: unknown[] = []
  const tuples = rows.map((preparedRow, index) => {
    const offset = index * 6
    values.push(
      getRequiredMapValue(proposalRowIdBySweedGroupId, preparedRow.row.groupId, 'proposal row id'),
      getRequiredMapValue(catalogGroupIdBySweedGroupId, preparedRow.row.groupId, 'catalog group id'),
      preparedRow.row.groupId,
      preparedRow.currentDescriptionJson,
      preparedRow.proposedDescriptionJson,
      preparedRow.lineItemValidationIssuesJson,
    )

    return `($${offset + 1}, $${offset + 2}, 'catalog_group', $${offset + 3}, 'description', $${offset + 4}::jsonb, $${offset + 5}::jsonb, null, $${offset + 5}::jsonb, 'pending', 1, null, $${offset + 6}::jsonb)`
  })

  await db.query(
    `
      insert into proposal_line_items (
        proposal_row_id,
        catalog_group_id,
        target_entity_type,
        target_entity_id,
        field_path,
        baseline_value_json,
        suggested_value_json,
        edited_value_json,
        effective_value_json,
        approval_status,
        version,
        notes,
        validation_issues_json
      )
      values ${tuples.join(', ')}
    `,
    values,
  )
}

function chunkItems<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }

  return chunks
}

function getRequiredMapValue<K, V>(values: Map<K, V>, key: K, label: string): V {
  const value = values.get(key)
  if (value === undefined) {
    throw new Error(`Missing ${label} for ${String(key)} during review import.`)
  }

  return value
}
