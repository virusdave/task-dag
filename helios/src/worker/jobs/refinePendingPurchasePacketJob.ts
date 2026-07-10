import { z } from 'zod'

import type { CatalogPendingPurchasesRefineJobPayload } from '../../shared/contracts/index.js'
import { getPool } from '../../server/db/pool.js'
import {
  createPendingPurchaseCandidateRevision,
  markPendingPurchaseRefinementTurnFailed,
  preparePendingPurchaseRefinement,
  type PreparedPendingPurchaseRefinement,
} from '../../server/db/queries/pendingPurchaseRefinementQueries.js'
import { withTransaction } from '../../server/db/tx.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'
import {
  refinePendingPurchasePacketWithLlm,
  type PendingPurchaseRefinementContextItem,
  type PendingPurchaseRefinementRowInput,
} from '../pendingPurchases/refinePendingPurchasePacket.js'

const CandidateSchema = z.object({
  productId: z.number().int().positive(),
  productName: z.string().nullable().optional(),
  score: z.number().nullable().optional(),
}).passthrough()

const EditedStructuredFieldsSchema = z.object({
  expectedCategory: z.string().nullable().optional(),
  expectedSubcategory: z.string().nullable().optional(),
  targetBrand: z.string().nullable().optional(),
  targetGroupName: z.string().nullable().optional(),
  targetPackCount: z.number().int().positive().nullable().optional(),
  targetReuseProductId: z.number().int().positive().nullable().optional(),
  targetSize: z.string().nullable().optional(),
  targetStrainName: z.string().nullable().optional(),
  targetVariantName: z.string().nullable().optional(),
  targetVariantTab: z.string().nullable().optional(),
}).strict()

const ValidatedReuseSnapshotSchema = z.object({
  productId: z.number().int().positive(),
  productName: z.string(),
}).passthrough()

const RefinementSnapshotRowSchema = z.object({
  distributorProductId: z.string().trim().min(1),
  distributorProductName: z.string().trim().min(1),
  editedStructuredFields: EditedStructuredFieldsSchema.nullable(),
  expectedCategory: z.string().nullable(),
  expectedSubcategory: z.string().nullable(),
  rawProvenance: z.object({
    reuseProductId: z.number().int().positive().nullable().optional(),
    suggestionCandidates: z.array(CandidateSchema).optional(),
    validatedReuseSnapshot: ValidatedReuseSnapshotSchema.nullable().optional(),
  }).passthrough(),
  rowId: z.number().int().positive(),
  rowLineageId: z.string().trim().min(1),
}).passthrough()

const RefinementSnapshotSchema = z.object({
  rows: z.array(RefinementSnapshotRowSchema).min(1),
})

export async function runCatalogPendingPurchasesRefineJob(
  _context: JobHandlerContext,
  payload: CatalogPendingPurchasesRefineJobPayload,
): Promise<void> {
  try {
    const prepared = await withTransaction((db) => preparePendingPurchaseRefinement(db, payload.refinementTurnId))
    if (prepared === null) {
      return
    }

    const db = getPool()
    const taxonomy = await loadRefinementTaxonomy(db)
    let { contextItems, rows } = buildRefinementModelRows(prepared)
    const currentProductIds = await loadCurrentCatalogProductIds(db, rows.flatMap((row) => row.productIdCandidates))
    rows = rows.map((row) => ({
      ...row,
      productIdCandidates: row.productIdCandidates.filter((productId) => currentProductIds.has(productId)),
    }))
    const currentContextIds = new Set(rows.flatMap((row) =>
      row.productIdCandidates.map((productId) => `catalog:${row.rowLineageId}:${productId}`),
    ))
    contextItems = contextItems.filter((item) => currentContextIds.has(item.contextId))
    const refinement = await refinePendingPurchasePacketWithLlm({
      allowedTaxonomy: taxonomy,
      contextItems,
      db,
      feedbackText: prepared.feedbackText,
      packetDescription: prepared.packetTitle,
      rows,
      rowSnapshotSha256: prepared.rowSnapshotSha256,
    })

    await withTransaction(async (transaction) => {
      await createPendingPurchaseCandidateRevision(transaction, payload.refinementTurnId, refinement)
    })
  } catch (error) {
    await withTransaction(async (db) => {
      await markPendingPurchaseRefinementTurnFailed(
        db,
        payload.refinementTurnId,
        error instanceof Error ? error.message : 'Pending-purchase refinement failed.',
      )
    })
    throw error
  }
}

function buildRefinementModelRows(prepared: PreparedPendingPurchaseRefinement): {
  contextItems: PendingPurchaseRefinementContextItem[]
  rows: PendingPurchaseRefinementRowInput[]
} {
  const snapshot = RefinementSnapshotSchema.parse(prepared.rowSnapshot)
  const refsByRowId = new Map(prepared.rowRefs.map((row) => [row.rowId, row]))
  const contextItems: PendingPurchaseRefinementContextItem[] = []
  const rows = snapshot.rows.map((current): PendingPurchaseRefinementRowInput => {
    const rowId = current.rowId
    const rowLineageId = current.rowLineageId
    const rowRef = refsByRowId.get(rowId)
    if (!rowRef || rowRef.rowLineageId !== rowLineageId) {
      throw new Error(`Pending-purchase refinement row ${rowId} has invalid lineage snapshot metadata.`)
    }

    const effectiveCurrent = buildEffectiveCurrent(current)
    const candidates = readCandidateProducts(current)
    for (const candidate of candidates) {
      contextItems.push({
        contextId: `catalog:${rowLineageId}:${candidate.productId}`,
        data: candidate.data,
        source: 'catalog',
      })
    }
    return {
      current: effectiveCurrent,
      distributorProductId: current.distributorProductId,
      distributorProductName: current.distributorProductName,
      lineageRevisionNumber: rowRef.lineageRevisionNumber,
      productIdCandidates: candidates.map((candidate) => candidate.productId),
      rowLineageId,
    }
  })
  return { contextItems, rows }
}

function readCandidateProducts(current: z.infer<typeof RefinementSnapshotRowSchema>): Array<{
  data: { productId: number; productName?: string | null; score?: number | null }
  productId: number
}> {
  const { editedStructuredFields: overrides, rawProvenance: raw } = current
  const reuseOverridePresent = overrides !== null && Object.prototype.hasOwnProperty.call(overrides, 'targetReuseProductId')
  const effectiveReuseProductId = reuseOverridePresent ? overrides.targetReuseProductId ?? null : raw.reuseProductId ?? null
  if (effectiveReuseProductId === null) {
    return []
  }
  const suggestion = raw.suggestionCandidates?.find((candidate) => candidate.productId === effectiveReuseProductId)
  const validatedName = raw.validatedReuseSnapshot?.productId === effectiveReuseProductId
    ? raw.validatedReuseSnapshot.productName
    : null
  return [{
    data: {
      productId: effectiveReuseProductId,
      productName: suggestion?.productName ?? validatedName,
      ...(suggestion?.score !== undefined ? { score: suggestion.score } : {}),
    },
    productId: effectiveReuseProductId,
  }]
}

function buildEffectiveCurrent(current: z.infer<typeof RefinementSnapshotRowSchema>): Record<string, unknown> {
  const overrides = current.editedStructuredFields
  const raw = current.rawProvenance
  return {
    ...current,
    expectedCategory: pickEffective(overrides, 'expectedCategory', current.expectedCategory),
    expectedSubcategory: pickEffective(overrides, 'expectedSubcategory', current.expectedSubcategory),
    targetBrand: pickEffective(overrides, 'targetBrand', readNullableString(current.targetBrand)),
    targetGroupName: pickEffective(overrides, 'targetGroupName', readNullableString(current.targetGroupName)),
    targetPackCount: pickEffective(overrides, 'targetPackCount', readNullablePositiveInt(raw.targetPackCount)),
    targetReuseProductId: pickEffective(overrides, 'targetReuseProductId', raw.reuseProductId ?? null),
    targetSize: pickEffective(overrides, 'targetSize', readNullableString(raw.targetSize)),
    targetStrainName: pickEffective(overrides, 'targetStrainName', readNullableString(raw.targetStrain)),
    targetVariantName: pickEffective(overrides, 'targetVariantName', readNullableString(current.targetVariantName)),
    targetVariantTab: pickEffective(overrides, 'targetVariantTab', readNullableString(raw.targetVariantTab)),
  }
}

function pickEffective<K extends keyof z.infer<typeof EditedStructuredFieldsSchema>>(
  overrides: z.infer<typeof EditedStructuredFieldsSchema> | null,
  key: K,
  fallback: z.infer<typeof EditedStructuredFieldsSchema>[K] | null,
): z.infer<typeof EditedStructuredFieldsSchema>[K] | null {
  return overrides !== null && Object.prototype.hasOwnProperty.call(overrides, key)
    ? overrides[key] ?? null
    : fallback
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readNullablePositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

async function loadCurrentCatalogProductIds(
  db: ReturnType<typeof getPool>,
  productIds: readonly number[],
): Promise<Set<number>> {
  const uniqueProductIds = [...new Set(productIds)]
  if (uniqueProductIds.length === 0) {
    return new Set()
  }
  const result = await db.query<{ product_id: number }>(
    `
      select distinct product.product_id
      from catalog_group_products product
      join catalog_groups catalog_group on catalog_group.id = product.catalog_group_id
      cross join lateral jsonb_array_elements(catalog_group.live_state_json -> 'products') live_product
      where product.product_id = any($1::bigint[])
        and (live_product ->> 'productId')::bigint = product.product_id
        and lower(live_product ->> 'enabled') = 'true'
        and lower(catalog_group.live_state_json ->> 'enabled') = 'true'
        and upper(trim(coalesce(product.name, ''))) !~ '^(DEAD[[:space:]]*-?|DELETED|RETIRED)'
        and upper(trim(coalesce(catalog_group.group_name, ''))) !~ '^(DEAD[[:space:]]*-?|DELETED|RETIRED)'
        and upper(trim(coalesce(catalog_group.brand_name, ''))) !~ '^(DEAD[[:space:]]*-?|DELETED|RETIRED)'
    `,
    [uniqueProductIds],
  )
  return new Set(result.rows.map((row) => row.product_id))
}

async function loadRefinementTaxonomy(db: ReturnType<typeof getPool>): Promise<{
  categories: string[]
  subcategories: string[]
}> {
  const [categories, subcategories] = await Promise.all([
    db.query<{ value: string }>(
      `
        select distinct category_name as value
        from catalog_groups
        where category_name is not null and category_name <> ''
          and lower(live_state_json ->> 'enabled') = 'true'
          and upper(trim(coalesce(group_name, ''))) !~ '^(DEAD[[:space:]]*-?|DELETED|RETIRED)'
          and upper(trim(coalesce(brand_name, ''))) !~ '^(DEAD[[:space:]]*-?|DELETED|RETIRED)'
        order by category_name asc
      `,
    ),
    db.query<{ value: string }>(
      `
        select distinct subcategory_name as value
        from catalog_groups
        where subcategory_name is not null and subcategory_name <> ''
          and lower(live_state_json ->> 'enabled') = 'true'
          and upper(trim(coalesce(group_name, ''))) !~ '^(DEAD[[:space:]]*-?|DELETED|RETIRED)'
          and upper(trim(coalesce(brand_name, ''))) !~ '^(DEAD[[:space:]]*-?|DELETED|RETIRED)'
        order by subcategory_name asc
      `,
    ),
  ])
  return {
    categories: categories.rows.map((row) => row.value),
    subcategories: subcategories.rows.map((row) => row.value),
  }
}
