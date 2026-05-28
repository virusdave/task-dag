import { randomUUID } from 'node:crypto'

import type { QueryResultRow } from 'pg'
import { z } from 'zod'

import type { CatalogPendingPurchasesApplyJobPayload, JsonValue } from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { getPool, type Queryable } from '../../server/db/pool.js'
import {
  insertPendingPurchaseParseObservation,
  normalizePendingPurchaseParserText,
  updatePendingPurchaseParseRuleFeedback,
} from '../../server/db/queries/pendingPurchaseParserQueries.js'
import { withTransaction } from '../../server/db/tx.js'
import { findDescriptionMedicalClaimIssues, normalizeDescriptionText } from '../catalog/liveState.js'
import { getWorkerEnv } from '../config/env.js'
import { downloadValidatedImageAsset } from '../pendingPurchases/imageSafety.js'
import { RetryableWorkerError } from '../runtime/errors.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'
import { callSweedRpcForDealer, readSweedDealerContext } from '../sweed/client.js'

const ALLOWED_SALE_TYPE_ID = 1
const SUBCATEGORY_ALIASES = new Map<string, string>([
  ['vapes:disposable', 'All In One / Disposable'],
])

const PENDING_PURCHASE_SOURCE_SYSTEM = 'metrc'

const NamedIdSchema = z.object({
  id: z.coerce.number().int(),
  name: z.string().trim().min(1),
}).passthrough()

const NameOnlySchema = z.object({
  name: z.string().nullable().optional(),
}).passthrough()

const ProductSummarySchema = z.object({
  allowedSaleType: z.object({ id: z.coerce.number().int().nullable().optional(), name: z.string().nullable().optional() })
    .passthrough()
    .nullable()
    .optional(),
  displayInEcommerce: z.boolean().nullable().optional(),
  id: z.coerce.number().int(),
  isPacked: z.boolean().nullable().optional(),
  name: z.string().nullable().optional(),
  packOfSize: z.coerce.number().int().nullable().optional(),
  price: z.coerce.number().nullable().optional(),
  productGroupId: z.union([z.coerce.number().int(), z.string().trim().min(1)]).nullable().optional(),
  shortName: z.string().nullable().optional(),
  size: z.object({ id: z.coerce.number().int().nullable().optional(), name: z.string().nullable().optional() }).passthrough().nullable().optional(),
  tab: z.string().nullable().optional(),
}).passthrough()

const ProductDetailSchema = z.object({
  product: ProductSummarySchema,
}).passthrough()

const ProductGroupDetailSchema = z.object({
  brand: NamedIdSchema.nullable().optional(),
  category: NameOnlySchema.nullable().optional(),
  description: z.string().nullable().optional(),
  id: z.coerce.number().int(),
  images: z.array(z.object({ id: z.union([z.coerce.number().int(), z.string().trim().min(1)]).nullable().optional(), url: z.string().nullable().optional() }).passthrough()).default([]),
  name: z.string().nullable().optional(),
  products: z.array(ProductSummarySchema).default([]),
  strain: NamedIdSchema.nullable().optional(),
  subcategory: NameOnlySchema.nullable().optional(),
}).passthrough()

const ProductListShortResponseSchema = z.object({
  data: z.array(z.object({ id: z.coerce.number().int(), name: z.string().nullable().optional() }).passthrough()).default([]),
}).passthrough()

const PurchaseOrderDetailSchema = z.object({
  distributor: z.object({ id: z.coerce.number().int().nullable().optional(), name: z.string().nullable().optional() })
    .passthrough()
    .nullable()
    .optional(),
  id: z.coerce.number().int(),
  positions: z.array(z.object({ id: z.coerce.number().int() }).passthrough()).default([]),
}).passthrough()

const PurchaseSuggestionSchema = z.object({
  orderPositions: z.array(z.object({
    orderPositionId: z.coerce.number().int(),
    products: z.array(z.object({
      product: z.object({ id: z.coerce.number().int(), name: z.string().nullable().optional() }).passthrough().nullable().optional(),
      score: z.coerce.number().nullable().optional(),
    }).passthrough()).default([]),
  }).passthrough()).default([]),
}).passthrough()

const DistributorProductListSchema = z.object({
  data: z.array(z.object({
    distributor: z.object({ id: z.coerce.number().int().nullable().optional(), name: z.string().nullable().optional() }).passthrough().nullable().optional(),
    id: z.coerce.number().int(),
    name: z.string().nullable().optional(),
    product: z.object({ id: z.coerce.number().int().nullable().optional(), name: z.string().nullable().optional() }).passthrough().nullable().optional(),
  }).passthrough()).default([]),
}).passthrough()

const CategoryRowSchema = NamedIdSchema.extend({
  subcategories: z.array(NamedIdSchema).default([]),
}).passthrough()

const StrainRowSchema = NamedIdSchema.extend({
  prevalence: NameOnlySchema.nullable().optional(),
}).passthrough()

interface PendingPurchaseApplyRequestRow extends QueryResultRow {
  id: number
  packet_id: number
  selected_row_count: number
  selected_row_ids_json: number[]
  status: 'blocked' | 'failed' | 'partially_succeeded' | 'queued' | 'running' | 'succeeded'
}

interface PendingPurchaseApplyWorkRow extends QueryResultRow {
  action_type: string
  approval_status: 'approved' | 'pending' | 'rejected'
  catalog_action: string
  distributor_product_id: string
  distributor_product_name: string
  edited_primary_image_url: string | null
  edited_proposed_description: string | null
  edited_proposed_price: number | null
  edited_structured_fields: JsonValue
  expected_category: string | null
  expected_subcategory: string | null
  id: number
  last_apply_request_id: number | null
  last_apply_status: 'applied' | 'blocked' | 'failed' | 'not_requested' | 'queued' | 'running'
  last_apply_summary_json: JsonValue
  order_ids_json: number[]
  packet_id: number
  position_ids_json: number[]
  primary_image_url: string | null
  proposed_description: string | null
  proposed_price: number | null
  raw_row_json: JsonValue
  site_dealer_id: number | null
  site_dealer_name: string | null
  target_brand: string | null
  target_group_name: string | null
  target_variant_name: string | null
  version: number
}

interface PendingPurchaseApplySummaryRow extends QueryResultRow {
  last_apply_error: string | null
  last_apply_status: 'applied' | 'blocked' | 'failed' | 'not_requested' | 'queued' | 'running'
  last_apply_summary_json: JsonValue
  row_id: number
}

interface StateDictionaries {
  brandsByName: Map<string, z.infer<typeof NamedIdSchema>>
  categoriesByName: Map<string, z.infer<typeof CategoryRowSchema>>
  prevalencesByName: Map<string, z.infer<typeof NamedIdSchema>>
  sizesByName: Map<string, z.infer<typeof NamedIdSchema>>
  strainsByName: Map<string, z.infer<typeof StrainRowSchema>>
}

interface LoadedPendingPurchaseRow {
  actionType: string
  catalogAction: string
  distributorProductId: string
  distributorProductName: string
  effectivePrimaryImageUrl: string | null
  effectiveProposedDescription: string | null
  effectiveProposedPrice: number | null
  effectiveUnitCost: number | null
  expectedCategory: string | null
  expectedSubcategory: string | null
  orderIds: number[]
  packetId: number
  positionIds: number[]
  rawRow: Record<string, JsonValue>
  reuseProductId: number | null
  rowId: number
  siteDealerId: number | null
  siteDealerName: string | null
  targetBrand: string | null
  targetGroupName: string | null
  targetPackCount: number | null
  targetPrevalence: string | null
  targetSize: string | null
  targetStrain: string | null
  targetVariantName: string | null
  targetVariantTab: string | null
}

interface SuggestionVerificationPositionCheck {
  manualFollowUpRequired: boolean
  positionId: number
  status: 'suggestion_row_missing' | 'suggestions_available_but_target_missing' | 'still_unresolved' | 'target_suggested'
  suggestedProducts: Array<{ productId: number | null; productName: string | null; score: number | null }>
}

interface SuggestionVerificationOrderInput {
  orderId: number
  positionChecks: SuggestionVerificationPositionCheck[]
}

interface PendingPurchaseSuggestionVerification {
  manualFollowUpOrderCount: number
  manualFollowUpPositionCount: number
  matchedTargetPositionCount: number
  orders: Array<{
    manualFollowUpPositionIds: number[]
    matchedTargetPositionCount: number
    orderId: number
    positionChecks: SuggestionVerificationPositionCheck[]
    relevantPositionCount: number
    status: 'manual_follow_up_required' | 'verified'
  }>
  /**
   * `verification_deferred` is set when the catalog write (group +
   * product + distributor link) ALL succeeded but the post-write
   * Sweed `store.distributor.product.suggestion` RPC failed (typically
   * an intermittent 500 from Sweed). In that case the new product is
   * already live in the catalog — we just couldn't confirm whether
   * Sweed's suggestion engine has caught up and is now proposing the
   * new product on the open purchase positions. Marking the row
   * applied (rather than failed) avoids re-creating duplicate Sweed
   * products on retry; the reviewer can re-verify suggestions later
   * from Sweed directly.
   */
  overallStatus: 'manual_follow_up_required' | 'verified' | 'verification_deferred'
  relevantPositionCount: number
  summaryText: string
  targetProductName: string
  verificationError?: string
}

class PendingPurchaseBlockedError extends Error {}

export async function runCatalogPendingPurchasesApplyJob(
  context: JobHandlerContext,
  payload: CatalogPendingPurchasesApplyJobPayload,
): Promise<void> {
  try {
    await runPendingPurchaseApplyJob(context, payload)
  } catch (error) {
    if (error instanceof RetryableWorkerError) {
      await resetPendingPurchaseApplyRequestForRetry(payload.pendingPurchaseApplyRequestId, error.message)
    } else {
      await finalizePendingPurchaseApplyRequestAfterCrash(
        context,
        payload.pendingPurchaseApplyRequestId,
        error instanceof Error ? error.message : 'Pending-purchase apply crashed unexpectedly.',
      )
    }
    throw error
  }
}

async function runPendingPurchaseApplyJob(
  context: JobHandlerContext,
  payload: CatalogPendingPurchasesApplyJobPayload,
): Promise<void> {
  const env = getWorkerEnv()
  if (!env.sweedAuthToken) {
    throw new Error('SWEED_AUTH_TOKEN is required for pending-purchase apply jobs.')
  }

  const applyRequest = await withTransaction(async (db) => {
    const current = await lockPendingPurchaseApplyRequest(db, payload.pendingPurchaseApplyRequestId)
    if (isFinalRequestStatus(current.status)) {
      return current
    }

    await db.query(
      `
        update pending_purchase_apply_requests
        set status = 'running',
            started_at = coalesce(started_at, now()),
            updated_at = now()
        where id = $1
      `,
      [payload.pendingPurchaseApplyRequestId],
    )
    await db.query(
      `
        update pending_purchase_rows
        set last_apply_status = 'running',
            updated_at = now()
        where last_apply_request_id = $1
          and last_apply_status = 'queued'
      `,
      [payload.pendingPurchaseApplyRequestId],
    )

    return current
  })

  if (isFinalRequestStatus(applyRequest.status)) {
    return
  }

  const stateDealerContext = await readSweedDealerContext(env.sweedStateDealerId)
  const dictionaries = await loadStateDictionaries(env.sweedStateDealerId)
  const rows = await listPendingPurchaseApplyRows(applyRequest)

  for (const rowRecord of rows) {
    if (rowRecord.last_apply_status === 'applied') {
      continue
    }

    const row = loadPendingPurchaseRow(rowRecord)
    try {
      const rowSummary = await applyPendingPurchaseRow(row, env.sweedStateDealerId, dictionaries)
      await markPendingPurchaseRowApplied(row, payload.pendingPurchaseApplyRequestId, rowSummary)
    } catch (error) {
      if (error instanceof RetryableWorkerError) {
        throw error
      }

      const failureStatus = error instanceof PendingPurchaseBlockedError ? 'blocked' : 'failed'
      const failureSummary = {
        rowId: row.rowId,
        status: failureStatus,
        summaryText: error instanceof Error ? error.message : 'Pending-purchase apply failed.',
      }
      await markPendingPurchaseRowFailed(row, payload.pendingPurchaseApplyRequestId, failureStatus, failureSummary)
    }
  }

  const requestSummary = await finalizePendingPurchaseApplyRequest(
    context,
    applyRequest,
    stateDealerContext,
  )

  await withTransaction(async (db) => {
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(payload.pendingPurchaseApplyRequestId),
      entityType: 'pending_purchase_apply_request',
      eventType: 'pending_purchase.apply.completed',
      module: 'catalog',
      payload: {
        jobId: context.id,
        packetId: applyRequest.packet_id,
        pendingPurchaseApplyRequestId: payload.pendingPurchaseApplyRequestId,
        status: requestSummary.status,
        summary: requestSummary.summaryText,
        summaryCounts: {
          appliedRowCount: requestSummary.appliedRowCount,
          blockedRowCount: requestSummary.blockedRowCount,
          failedRowCount: requestSummary.failedRowCount,
          selectedRowCount: requestSummary.selectedRowCount,
        },
      },
      requestId: randomUUID(),
      scope: buildPendingPurchasePacketScope(applyRequest.packet_id),
      undoPayload: null,
    })
  })
}

async function applyPendingPurchaseRow(
  row: LoadedPendingPurchaseRow,
  stateDealerId: number,
  dictionaries: StateDictionaries,
): Promise<Record<string, unknown>> {
  if (row.siteDealerId === null) {
    throw new Error(`Pending-purchase row ${row.rowId} is missing a site dealer id.`)
  }
  if (!row.targetVariantName?.trim()) {
    throw new Error(`Pending-purchase row ${row.rowId} is missing a target variant name.`)
  }

  const normalizedDescription = row.effectiveProposedDescription
    ? normalizeDescriptionText(row.effectiveProposedDescription)
    : null
  if (normalizedDescription) {
    const medicalClaimIssues = findDescriptionMedicalClaimIssues(normalizedDescription)
    if (medicalClaimIssues.length > 0) {
      throw new PendingPurchaseBlockedError(`Pending-purchase apply blocked description: ${medicalClaimIssues.join(', ')}`)
    }
  }

  const distributor = await resolveRowDistributor(row)
  const exactVariant = row.reuseProductId
    ? { id: row.reuseProductId, name: row.targetVariantName }
    : await findExactVariant(stateDealerId, row.targetVariantName)

  let createdBlobId: string | null = null
  let createdGroupId: number | null = null
  let createdProductId: number | null = null
  let product = exactVariant
    ? ProductDetailSchema.parse(await callSweedRpcForDealer(stateDealerId, 'store.product.get', { id: String(exactVariant.id) })).product
    : null
  let group = product?.productGroupId
    ? ProductGroupDetailSchema.parse(
      await callSweedRpcForDealer(stateDealerId, 'store.product.group.get', { id: Number(product.productGroupId) }),
    )
    : null
  const groupBefore = group ? summarizeGroup(group) : null
  const productBefore = product ? summarizeProduct(product) : null

  if (!product || !group) {
    const categoryContext = resolveCategoryContext(row, dictionaries)
    const brand = await ensureBrand(stateDealerId, dictionaries, requireNonEmptyString(row.targetBrand, 'target brand'))
    const productPrice = requirePendingPurchasePrice(row)
    createdBlobId = row.effectivePrimaryImageUrl ? await uploadImage(row.effectivePrimaryImageUrl) : null

    const groupResult = z.object({ id: z.coerce.number().int() }).passthrough().parse(
      await callSweedRpcForDealer(stateDealerId, 'store.product.group.add', {
        brandId: brand.id,
        categoryId: categoryContext.category.id,
        description: normalizedDescription ?? undefined,
        imagesIds: createdBlobId ? [createdBlobId] : undefined,
        isFinishedProduct: true,
        name: requireNonEmptyString(row.targetGroupName ?? row.targetVariantName, 'target group name'),
        subcategoryId: categoryContext.subcategory?.id,
      }),
    )
    createdGroupId = groupResult.id
    group = ProductGroupDetailSchema.parse(
      await callSweedRpcForDealer(stateDealerId, 'store.product.group.get', { id: createdGroupId }),
    )

    const productResult = z.object({ id: z.coerce.number().int() }).passthrough().parse(
      await callSweedRpcForDealer(stateDealerId, 'store.product.add', {
        allowedSaleTypeId: ALLOWED_SALE_TYPE_ID,
        displayInEcommerce: true,
        isPacked: true,
        packOfSize: row.targetPackCount ?? 1,
        price: productPrice,
        productGroupId: createdGroupId,
        sizeId: resolveSizeId(row, dictionaries),
        tab: row.targetVariantTab ?? '',
      }),
    )
    createdProductId = productResult.id

    const waitResult = await waitForProductInGroup(stateDealerId, createdGroupId, createdProductId)
    group = waitResult.group
    product = waitResult.product
  }

  const strainRow = await ensureTargetStrain(stateDealerId, dictionaries, row.targetStrain, row.targetPrevalence)
  const groupEditPayload = buildGroupEditPayload(group, row, normalizedDescription, strainRow?.id ?? null)
  if (Object.keys(groupEditPayload).length > 1) {
    await callSweedRpcForDealer(stateDealerId, 'store.product.group.edit', groupEditPayload)
    group = ProductGroupDetailSchema.parse(
      await callSweedRpcForDealer(stateDealerId, 'store.product.group.get', { id: group.id }),
    )
  }

  const productEditPayload = buildProductEditPayload(product, row, dictionaries)
  if (Object.keys(productEditPayload).length > 1) {
    await callSweedRpcForDealer(stateDealerId, 'store.product.edit', productEditPayload)
    const refreshed = await waitForProductInGroup(stateDealerId, group.id, product.id)
    group = refreshed.group
    product = refreshed.product
  }

  const distributorLink = await ensureDistributorLink(
    stateDealerId,
    distributor.distributorId,
    distributor.distributorName,
    row,
    product.id,
  )
  // Verification is intentionally non-fatal. Every Sweed write above
  // (group add, product add, group/product edit, distributor link)
  // has already succeeded by this point; if Sweed's suggestion RPC
  // throws (typically a transient 500 on
  // store.distributor.product.suggestion), failing the WHOLE row
  // would lie to the operator (the catalog WAS written, the product
  // IS live) and would cause duplicate-product creation on the next
  // apply retry. Capture the error in the verification record
  // instead so it shows up in the apply summary for follow-up.
  let verification: PendingPurchaseSuggestionVerification
  try {
    verification = await verifyPendingPurchaseSuggestions(row, product.id, row.targetVariantName)
  } catch (verificationError) {
    const errorMessage = verificationError instanceof Error
      ? verificationError.message
      : 'Unknown verification error'
    verification = {
      manualFollowUpOrderCount: row.orderIds.length,
      manualFollowUpPositionCount: row.positionIds.length,
      matchedTargetPositionCount: 0,
      orders: [],
      overallStatus: 'verification_deferred',
      relevantPositionCount: 0,
      summaryText: `Catalog apply succeeded for ${row.targetVariantName}, but Sweed's post-write suggestion check failed (${errorMessage}). The new product is live; re-check Sweed manually if you need to confirm the distributor-position suggestion mapping.`,
      targetProductName: row.targetVariantName,
      verificationError: errorMessage,
    }
  }
  const groupAfter = summarizeGroup(group)
  const productAfter = summarizeProduct(product)
  const summaryText = buildAppliedRowSummary(row, createdProductId ?? product.id, verification)

  return {
    appliedAt: new Date().toISOString(),
    createdBlobId,
    createdGroupId,
    createdProductId,
    distributorLink,
    distributorName: distributor.distributorName,
    distributorProductId: row.distributorProductId,
    groupAfter,
    groupBefore,
    packetId: row.packetId,
    productAfter,
    productBefore,
    rowId: row.rowId,
    status: 'applied',
    summaryText,
    targetVariantName: row.targetVariantName,
    verification,
  }
}

async function resolveRowDistributor(
  row: LoadedPendingPurchaseRow,
): Promise<{ distributorId: number; distributorName: string }> {
  const resolvedDistributors = new Map<number, string>()

  for (const orderId of row.orderIds) {
    const order = PurchaseOrderDetailSchema.parse(
      await callSweedRpcForDealer(row.siteDealerId as number, 'store.purchase.order.get', { id: orderId }),
    )
    const distributorId = order.distributor?.id ?? null
    const distributorName = normalizeNullableString(order.distributor?.name)
    if (distributorId === null || distributorName === null) {
      throw new Error(`Order ${orderId} does not expose a usable distributor.`)
    }
    resolvedDistributors.set(distributorId, distributorName)
  }

  if (resolvedDistributors.size !== 1) {
    throw new Error(`Pending-purchase row ${row.rowId} spans multiple distributors and cannot be applied safely.`)
  }

  const [distributorId, distributorName] = [...resolvedDistributors.entries()][0]
  return { distributorId, distributorName }
}

async function verifyPendingPurchaseSuggestions(
  row: LoadedPendingPurchaseRow,
  targetProductId: number,
  targetProductName: string,
): Promise<PendingPurchaseSuggestionVerification> {
  const orderSummaries: SuggestionVerificationOrderInput[] = []

  for (const orderId of row.orderIds) {
    const order = PurchaseOrderDetailSchema.parse(
      await callSweedRpcForDealer(row.siteDealerId as number, 'store.purchase.order.get', { id: orderId }),
    )
    const orderPositionIds = row.positionIds.filter((positionId) => order.positions.some((position) => position.id === positionId))
    const suggestion = PurchaseSuggestionSchema.parse(
      await callSweedRpcForDealer(row.siteDealerId as number, 'store.distributor.product.suggestion', { orderId }),
    )
    const byPosition = new Map(suggestion.orderPositions.map((position) => [position.orderPositionId, position]))
    const positionChecks = orderPositionIds.map<SuggestionVerificationPositionCheck>((positionId) => {
      const suggestionRow = byPosition.get(positionId)
      if (!suggestionRow) {
        return {
          manualFollowUpRequired: true,
          positionId,
          status: 'suggestion_row_missing',
          suggestedProducts: [],
        }
      }

      const suggestedProducts = suggestionRow.products.map((candidate) => ({
        productId: candidate.product?.id ?? null,
        productName: normalizeNullableString(candidate.product?.name),
        score: typeof candidate.score === 'number' && Number.isFinite(candidate.score) ? candidate.score : null,
      }))

      if (suggestedProducts.some((candidate) => candidate.productId === targetProductId)) {
        return {
          manualFollowUpRequired: false,
          positionId,
          status: 'target_suggested',
          suggestedProducts,
        }
      }

      return {
        manualFollowUpRequired: true,
        positionId,
        status: suggestedProducts.length === 0 ? 'still_unresolved' : 'suggestions_available_but_target_missing',
        suggestedProducts,
      }
    })

    orderSummaries.push({ orderId, positionChecks })
  }

  return buildPendingPurchaseSuggestionVerification({ orders: orderSummaries, targetProductName })
}

async function ensureDistributorLink(
  stateDealerId: number,
  distributorId: number,
  distributorName: string,
  row: LoadedPendingPurchaseRow,
  productId: number,
): Promise<Record<string, unknown>> {
  const existingRows = DistributorProductListSchema.parse(
    await callSweedRpcForDealer(stateDealerId, 'store.distributor.product.list', {
      page: 1,
      pageSize: 1000000,
      productId,
    }),
  )

  for (const candidate of existingRows.data) {
    if (candidate.distributor?.id !== distributorId) {
      continue
    }
    if (normalizeText(candidate.name) !== normalizeText(row.distributorProductName)) {
      continue
    }
    return {
      created: false,
      distributorId,
      distributorName,
      distributorProductId: candidate.id,
      priceAdded: false,
    }
  }

  const created = z.object({ id: z.coerce.number().int() }).passthrough().parse(
    await callSweedRpcForDealer(stateDealerId, 'store.distributor.product.add', {
      distributorId,
      name: row.distributorProductName,
      productId: String(productId),
      productQty: 1,
    }),
  )

  let priceAdded = false
  if (typeof row.effectiveUnitCost === 'number' && Number.isFinite(row.effectiveUnitCost) && row.effectiveUnitCost > 0) {
    await callSweedRpcForDealer(stateDealerId, 'store.distributor.product.price.add', {
      distributorProductId: String(created.id),
      distributorProductPrice: row.effectiveUnitCost,
      fromDate: new Date().toISOString().slice(0, 10),
    })
    priceAdded = true
  }

  return {
    created: true,
    distributorId,
    distributorName,
    distributorProductId: created.id,
    priceAdded,
  }
}

function buildGroupEditPayload(
  group: z.infer<typeof ProductGroupDetailSchema>,
  row: LoadedPendingPurchaseRow,
  normalizedDescription: string | null,
  strainId: number | null,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { id: group.id }

  if (row.targetGroupName && group.name !== row.targetGroupName) {
    payload.name = row.targetGroupName
  }
  if (normalizedDescription && normalizeDescriptionText(group.description ?? '') !== normalizedDescription) {
    payload.description = normalizedDescription
  }
  if (strainId !== null && (group.strain?.id ?? null) !== strainId) {
    payload.strainId = strainId
  }

  return payload
}

function buildProductEditPayload(
  product: z.infer<typeof ProductSummarySchema>,
  row: LoadedPendingPurchaseRow,
  dictionaries: StateDictionaries,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { id: product.id }
  const targetSizeId = resolveSizeId(row, dictionaries)

  if (row.targetVariantName && product.name !== row.targetVariantName) {
    payload.name = row.targetVariantName
  }
  if (row.targetVariantName && product.shortName !== row.targetVariantName) {
    payload.shortName = row.targetVariantName
  }
  if ((product.tab ?? '') !== (row.targetVariantTab ?? '')) {
    payload.tab = row.targetVariantTab ?? ''
  }
  if (typeof row.effectiveProposedPrice === 'number' && Math.abs((product.price ?? 0) - row.effectiveProposedPrice) >= 0.01) {
    payload.price = row.effectiveProposedPrice
  }
  if ((product.packOfSize ?? 0) !== (row.targetPackCount ?? 1)) {
    payload.packOfSize = row.targetPackCount ?? 1
  }
  if ((product.size?.id ?? null) !== targetSizeId) {
    payload.sizeId = targetSizeId
  }
  if ((product.allowedSaleType?.id ?? null) !== ALLOWED_SALE_TYPE_ID) {
    payload.allowedSaleTypeId = ALLOWED_SALE_TYPE_ID
  }
  if (product.displayInEcommerce !== true) {
    payload.displayInEcommerce = true
  }
  if (product.isPacked !== true) {
    payload.isPacked = true
  }

  return payload
}

function resolveCategoryContext(
  row: LoadedPendingPurchaseRow,
  dictionaries: StateDictionaries,
): { category: z.infer<typeof CategoryRowSchema>; subcategory: z.infer<typeof NamedIdSchema> | null } {
  const categoryName = requireNonEmptyString(row.expectedCategory, 'expected category')
  const category = dictionaries.categoriesByName.get(categoryName.toLowerCase())
  if (!category) {
    throw new Error(`Missing category \`${categoryName}\` in Sweed.`)
  }

  const requestedSubcategory = normalizeNullableString(row.expectedSubcategory)
  if (!requestedSubcategory) {
    return { category, subcategory: null }
  }

  const aliasKey = `${categoryName.toLowerCase()}:${requestedSubcategory.toLowerCase()}`
  const resolvedSubcategoryName = SUBCATEGORY_ALIASES.get(aliasKey) ?? requestedSubcategory
  const subcategory = category.subcategories.find((candidate) => candidate.name.toLowerCase() === resolvedSubcategoryName.toLowerCase()) ?? null
  if (!subcategory) {
    throw new Error(`Missing subcategory \`${requestedSubcategory}\` under category \`${categoryName}\`.`)
  }

  return { category, subcategory }
}

function resolveSizeId(row: LoadedPendingPurchaseRow, dictionaries: StateDictionaries): number {
  const sizeName = requireNonEmptyString(row.targetSize, 'target size')
  const size = dictionaries.sizesByName.get(sizeName.toLowerCase())
  if (!size) {
    throw new Error(`Missing size \`${sizeName}\` in Sweed.`)
  }
  return size.id
}

async function ensureBrand(
  stateDealerId: number,
  dictionaries: StateDictionaries,
  brandName: string,
): Promise<z.infer<typeof NamedIdSchema>> {
  const existing = dictionaries.brandsByName.get(brandName.toLowerCase())
  if (existing) {
    return existing
  }

  try {
    const created = NamedIdSchema.parse(
      await callSweedRpcForDealer(stateDealerId, 'store.product.brand.add', { name: brandName }),
    )
    dictionaries.brandsByName.set(created.name.toLowerCase(), created)
    return created
  } catch {
    const resolved = await findExactNamedRow(
      stateDealerId,
      'store.product.brand.list',
      brandName,
      ListResponseSchema(NamedIdSchema),
    )
    if (!resolved) {
      throw new Error(`Unable to resolve brand \`${brandName}\` after create.`)
    }
    dictionaries.brandsByName.set(resolved.name.toLowerCase(), resolved)
    return resolved
  }
}

async function ensureTargetStrain(
  stateDealerId: number,
  dictionaries: StateDictionaries,
  strainName: string | null,
  prevalenceName: string | null,
): Promise<z.infer<typeof StrainRowSchema> | null> {
  const normalizedName = normalizeNullableString(strainName)
  if (!normalizedName) {
    return null
  }

  const cached = dictionaries.strainsByName.get(normalizedName.toLowerCase())
  if (cached) {
    return cached
  }

  const existing = await findExactNamedRow(
    stateDealerId,
    'store.product.strain.list',
    normalizedName,
    ListResponseSchema(StrainRowSchema),
  )
  if (existing) {
    dictionaries.strainsByName.set(existing.name.toLowerCase(), existing)
    return existing
  }

  const resolvedPrevalenceName = normalizeNullableString(prevalenceName)
  if (!resolvedPrevalenceName) {
    return null
  }
  const prevalence = dictionaries.prevalencesByName.get(resolvedPrevalenceName.toLowerCase())
  if (!prevalence) {
    throw new Error(`Missing prevalence \`${resolvedPrevalenceName}\` for strain \`${normalizedName}\`.`)
  }

  try {
    await callSweedRpcForDealer(stateDealerId, 'store.product.strain.add', {
      name: normalizedName,
      prevalenceId: prevalence.id,
    })
  } catch {
    const fallback = await findExactNamedRow(
      stateDealerId,
      'store.product.strain.list',
      normalizedName,
      ListResponseSchema(StrainRowSchema),
    )
    if (!fallback) {
      throw new Error(`Unable to resolve strain \`${normalizedName}\` after create.`)
    }
    dictionaries.strainsByName.set(fallback.name.toLowerCase(), fallback)
    return fallback
  }

  const created = await findExactNamedRow(
    stateDealerId,
    'store.product.strain.list',
    normalizedName,
    ListResponseSchema(StrainRowSchema),
  )
  if (!created) {
    throw new Error(`Unable to resolve strain \`${normalizedName}\` after create.`)
  }
  dictionaries.strainsByName.set(created.name.toLowerCase(), created)
  return created
}

async function findExactVariant(
  stateDealerId: number,
  targetVariantName: string,
): Promise<{ id: number; name: string | null } | null> {
  const response = ProductListShortResponseSchema.parse(
    await callSweedRpcForDealer(stateDealerId, 'store.product.list.short', {
      page: 1,
      pageSize: 100,
      query: targetVariantName,
      reload: true,
    }),
  )

  const normalizedTarget = normalizeText(targetVariantName)
  const match = response.data.find((row) => normalizeText(row.name) === normalizedTarget)
  return match ? { id: match.id, name: normalizeNullableString(match.name) } : null
}

async function waitForProductInGroup(
  stateDealerId: number,
  groupId: number,
  productId: number,
): Promise<{ group: z.infer<typeof ProductGroupDetailSchema>; product: z.infer<typeof ProductSummarySchema> }> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const group = ProductGroupDetailSchema.parse(
      await callSweedRpcForDealer(stateDealerId, 'store.product.group.get', { id: groupId }),
    )
    const product = group.products.find((candidate) => candidate.id === productId) ?? null
    if (product) {
      return { group, product }
    }
    await delay(400)
  }

  throw new RetryableWorkerError(`Product ${productId} never appeared under group ${groupId} after apply.`)
}

async function uploadImage(url: string): Promise<string> {
  const imageAsset = await downloadValidatedImageAsset({
    timeoutMs: getWorkerEnv().sweedRequestTimeoutMs,
    url,
  })

  const blobIdResult = await callSweedRpcForDealer<unknown>(getWorkerEnv().sweedStateDealerId, 'store.blob.add', { type: 'banner' })
  const blobId = z.union([
    z.string().trim().min(1),
    z.object({ id: z.string().trim().min(1) }).passthrough().transform((value) => value.id),
  ]).parse(blobIdResult)

  const uploadResponse = await fetch(`https://prime.sweedpos.com/api/blobs/upload/${blobId}`, {
    body: imageAsset.bytes,
    headers: {
      'content-type': 'application/octet-stream',
      'user-agent': 'helios-worker/1.0',
    },
    method: 'PUT',
    signal: AbortSignal.timeout(getWorkerEnv().sweedRequestTimeoutMs),
  })
  if (!uploadResponse.ok) {
    throw new Error(`Image upload failed for blob ${blobId}: HTTP ${uploadResponse.status}.`)
  }

  return blobId
}

async function loadStateDictionaries(stateDealerId: number): Promise<StateDictionaries> {
  const brands = ListResponseSchema(NamedIdSchema).parse(
    await callSweedRpcForDealer(stateDealerId, 'store.product.brand.list', { page: 1, pageSize: 1000000 }),
  )
  const categories = ListResponseSchema(CategoryRowSchema).parse(
    await callSweedRpcForDealer(stateDealerId, 'store.product.category.list', {}),
  )
  const sizes = ListResponseSchema(NamedIdSchema).parse(
    await callSweedRpcForDealer(stateDealerId, 'store.product.size.list', { page: 1, pageSize: 1000000 }),
  )
  const strains = ListResponseSchema(StrainRowSchema).parse(
    await callSweedRpcForDealer(stateDealerId, 'store.product.strain.list', { page: 1, pageSize: 1000000 }),
  )
  const prevalences = ListResponseSchema(NamedIdSchema).parse(
    await callSweedRpcForDealer(stateDealerId, 'store.product.strain.prevalence.list', {}),
  )

  return {
    brandsByName: lowerNameMap(brands),
    categoriesByName: lowerNameMap(categories),
    prevalencesByName: lowerNameMap(prevalences),
    sizesByName: lowerNameMap(sizes),
    strainsByName: lowerNameMap(strains),
  }
}

async function findExactNamedRow<T extends { name: string }>(
  stateDealerId: number,
  rpcName: string,
  query: string,
  schema: z.ZodType<T[]>,
): Promise<T | null> {
  const rows = schema.parse(
    await callSweedRpcForDealer(stateDealerId, rpcName, { page: 1, pageSize: 100, query }),
  )
  const normalizedQuery = normalizeText(query)
  return rows.find((row) => normalizeText(row.name) === normalizedQuery) ?? null
}

async function listPendingPurchaseApplyRows(applyRequest: PendingPurchaseApplyRequestRow): Promise<PendingPurchaseApplyWorkRow[]> {
  if (applyRequest.selected_row_ids_json.length !== applyRequest.selected_row_count) {
    throw new Error(`Pending-purchase apply request ${applyRequest.id} has an invalid selected-row snapshot.`)
  }

  const result = await getPool().query<PendingPurchaseApplyWorkRow>(
    `
      select
        id,
        packet_id,
        action_type,
        distributor_product_id,
        distributor_product_name,
        site_dealer_id,
        site_dealer_name,
        order_ids_json,
        position_ids_json,
        approval_status,
        last_apply_request_id,
        last_apply_status,
        last_apply_summary_json,
        target_brand,
        target_group_name,
        target_variant_name,
        expected_category,
        expected_subcategory,
        proposed_price::double precision as proposed_price,
        edited_proposed_price::double precision as edited_proposed_price,
        proposed_description,
        edited_proposed_description,
        primary_image_url,
        edited_primary_image_url,
        edited_structured_fields,
        catalog_action,
        raw_row_json,
        version
      from pending_purchase_rows
      where id = any($1::bigint[])
      order by id asc
    `,
    [applyRequest.selected_row_ids_json],
  )

  if (result.rows.length !== applyRequest.selected_row_count) {
    throw new Error(`Pending-purchase apply request ${applyRequest.id} is missing one or more selected rows.`)
  }

  const selectedRowIds = new Set(applyRequest.selected_row_ids_json)
  for (const row of result.rows) {
    if (!selectedRowIds.has(row.id)) {
      throw new Error(`Pending-purchase apply request ${applyRequest.id} loaded an unexpected row ${row.id}.`)
    }
    if (row.packet_id !== applyRequest.packet_id) {
      throw new Error(`Pending-purchase apply request ${applyRequest.id} row ${row.id} no longer belongs to packet ${applyRequest.packet_id}.`)
    }
    if (row.last_apply_request_id !== applyRequest.id) {
      throw new Error(`Pending-purchase apply request ${applyRequest.id} row ${row.id} drifted away from the request.`)
    }
    if (row.approval_status !== 'approved') {
      throw new Error(`Pending-purchase apply request ${applyRequest.id} row ${row.id} is no longer approved.`)
    }
  }

  return result.rows
}

function loadPendingPurchaseRow(row: PendingPurchaseApplyWorkRow): LoadedPendingPurchaseRow {
  const rawRow = readRecord(row.raw_row_json)
  const overrides = readEditedStructuredFields(row.edited_structured_fields)
  // `effectiveStructuredFields` mirrors how
  // `effective_proposed_price` / `effective_proposed_description` /
  // `effective_primary_image_url` work above: take the override when
  // present (even an explicit null clears the field), otherwise fall
  // back to the parser/LLM value carried on the row. Issue #35.
  return {
    actionType: row.action_type,
    catalogAction: row.catalog_action,
    distributorProductId: row.distributor_product_id,
    distributorProductName: row.distributor_product_name,
    effectivePrimaryImageUrl: row.edited_primary_image_url ?? row.primary_image_url,
    effectiveProposedDescription: row.edited_proposed_description ?? row.proposed_description,
    effectiveProposedPrice: row.edited_proposed_price ?? row.proposed_price,
    effectiveUnitCost: readOptionalNumber(rawRow.effectiveUnitCost),
    expectedCategory: pickEffectiveString(overrides, 'expectedCategory', row.expected_category),
    expectedSubcategory: pickEffectiveString(overrides, 'expectedSubcategory', row.expected_subcategory),
    orderIds: row.order_ids_json,
    packetId: row.packet_id,
    positionIds: row.position_ids_json,
    rawRow,
    reuseProductId: readOptionalInt(rawRow.reuseProductId),
    rowId: row.id,
    siteDealerId: row.site_dealer_id,
    siteDealerName: row.site_dealer_name,
    targetBrand: pickEffectiveString(overrides, 'targetBrand', row.target_brand),
    targetGroupName: pickEffectiveString(overrides, 'targetGroupName', row.target_group_name),
    targetPackCount: pickEffectiveInt(overrides, 'targetPackCount', readOptionalInt(rawRow.targetPackCount)),
    targetPrevalence: readOptionalString(rawRow.targetPrevalence),
    targetSize: pickEffectiveString(overrides, 'targetSize', readOptionalString(rawRow.targetSize)),
    // The DB / JSONB override key is `targetStrainName` (matches the
    // canonical UI label); the in-memory field stays `targetStrain` to
    // avoid churning every consumer site of `LoadedPendingPurchaseRow`.
    targetStrain: pickEffectiveString(overrides, 'targetStrainName', readOptionalString(rawRow.targetStrain)),
    targetVariantName: pickEffectiveString(overrides, 'targetVariantName', row.target_variant_name),
    targetVariantTab: pickEffectiveString(overrides, 'targetVariantTab', readOptionalString(rawRow.targetVariantTab)),
  }
}

/**
 * Reviewer-supplied overrides for the structured taxonomy fields,
 * persisted as the JSONB `pending_purchase_rows.edited_structured_fields`
 * column. Shape mirrors `EditedStructuredFields` in
 * `shared/contracts/api/pendingPurchases.ts`; we decode loosely here
 * rather than re-importing the zod schema so the worker keeps the
 * "trust DB shape" pattern used for the rest of this row loader.
 */
type EditedStructuredFieldOverrides = Partial<{
  expectedCategory: string | null
  expectedSubcategory: string | null
  targetBrand: string | null
  targetGroupName: string | null
  targetPackCount: number | null
  targetSize: string | null
  targetStrainName: string | null
  targetVariantName: string | null
  targetVariantTab: string | null
}>

function readEditedStructuredFields(value: JsonValue): EditedStructuredFieldOverrides {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as EditedStructuredFieldOverrides
}

/**
 * Returns the reviewer's override when it's been explicitly set in
 * the JSONB payload (key present — including `null`, which means
 * "clear the field"); otherwise returns the parsed/LLM fallback.
 */
function pickEffectiveString<K extends keyof EditedStructuredFieldOverrides>(
  overrides: EditedStructuredFieldOverrides,
  key: K,
  fallback: string | null,
): string | null {
  if (!Object.prototype.hasOwnProperty.call(overrides, key)) {
    return fallback
  }
  const raw = overrides[key]
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') return fallback
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

function pickEffectiveInt<K extends keyof EditedStructuredFieldOverrides>(
  overrides: EditedStructuredFieldOverrides,
  key: K,
  fallback: number | null,
): number | null {
  if (!Object.prototype.hasOwnProperty.call(overrides, key)) {
    return fallback
  }
  const raw = overrides[key]
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) return fallback
  return raw
}

async function lockPendingPurchaseApplyRequest(
  db: Queryable,
  applyRequestId: number,
): Promise<PendingPurchaseApplyRequestRow> {
  const result = await db.query<PendingPurchaseApplyRequestRow>(
    `
      select id, packet_id, status
        , selected_row_count
        , selected_row_ids_json
      from pending_purchase_apply_requests
      where id = $1
      for update
    `,
    [applyRequestId],
  )

  const row = result.rows[0]
  if (!row) {
    throw new Error(`Pending-purchase apply request ${applyRequestId} was not found.`)
  }
  return row
}

async function markPendingPurchaseRowApplied(
  row: LoadedPendingPurchaseRow,
  applyRequestId: number,
  summary: Record<string, unknown>,
): Promise<void> {
  await withTransaction(async (db) => {
    const result = await db.query(
      `
        update pending_purchase_rows
        set last_apply_status = 'applied',
            last_apply_error = null,
            last_apply_summary_json = $3::jsonb,
            applied_at = now(),
            version = version + 1,
            updated_at = now()
        where id = $1
          and last_apply_request_id = $2
      `,
      [row.rowId, applyRequestId, JSON.stringify(summary)],
    )

    if (result.rowCount !== 1) {
      throw new Error(`Pending-purchase row ${row.rowId} no longer matches apply request ${applyRequestId}.`)
    }

    await recordPendingPurchaseParserApplyFeedback(db, row, 'applied', summary)
  })
}

async function markPendingPurchaseRowFailed(
  row: LoadedPendingPurchaseRow,
  applyRequestId: number,
  status: 'blocked' | 'failed',
  summary: Record<string, unknown>,
): Promise<void> {
  await withTransaction(async (db) => {
    const result = await db.query(
      `
        update pending_purchase_rows
        set last_apply_status = $3,
            last_apply_error = $4,
            last_apply_summary_json = $5::jsonb,
            version = version + 1,
            updated_at = now()
        where id = $1
          and last_apply_request_id = $2
      `,
      [row.rowId, applyRequestId, status, readOptionalString(summary.summaryText as JsonValue) ?? null, JSON.stringify(summary)],
    )

    if (result.rowCount !== 1) {
      throw new Error(`Pending-purchase row ${row.rowId} no longer matches apply request ${applyRequestId}.`)
    }

    await recordPendingPurchaseParserApplyFeedback(db, row, status, summary)
  })
}

async function recordPendingPurchaseParserApplyFeedback(
  db: Queryable,
  row: LoadedPendingPurchaseRow,
  status: 'applied' | 'blocked' | 'failed',
  summary: Record<string, unknown>,
): Promise<void> {
  const parserRuleId = readOptionalInt(row.rawRow.parserRuleId)
  const parserBrandProfileId = readOptionalInt(row.rawRow.parserBrandProfileId)
  if (parserRuleId === null && parserBrandProfileId === null) {
    return
  }

  const summaryText = readOptionalString(summary.summaryText as JsonValue) ?? null
  await insertPendingPurchaseParseObservation(db, {
    brandProfileId: parserBrandProfileId,
    inference: toJsonValue({
      applySummary: summary,
      parserSource: readOptionalString(row.rawRow.parserSource),
    }),
    normalizedDistributorProductName: normalizePendingPurchaseParserText(row.distributorProductName),
    notes: summaryText,
    observationStatus: status === 'applied' ? 'succeeded' : status,
    observationType: 'apply_outcome',
    packetId: row.packetId,
    parseRuleId: parserRuleId,
    pendingPurchaseRowId: row.rowId,
    rawDistributorProductName: row.distributorProductName,
    rawRow: row.rawRow,
    rowInputSignature: readOptionalString(row.rawRow.rowInputSignature),
    sourceSystem: PENDING_PURCHASE_SOURCE_SYSTEM,
  })

  if (parserRuleId === null) {
    return
  }

  if (status === 'applied') {
    await updatePendingPurchaseParseRuleFeedback(db, {
      feedbackType: 'applied',
      ruleId: parserRuleId,
      state: readOptionalString(row.rawRow.parserRuleState) === 'provisional' ? 'active' : null,
    })
    return
  }

  if (isLikelyParserRelatedApplyFailure(summaryText)) {
    await updatePendingPurchaseParseRuleFeedback(db, {
      feedbackType: status,
      ruleId: parserRuleId,
      state: 'draft',
    })
  }
}

async function finalizePendingPurchaseApplyRequest(
  context: JobHandlerContext,
  applyRequest: PendingPurchaseApplyRequestRow,
  stateDealerContext: { dealerId: number; dealerName: string | null },
): Promise<{ appliedRowCount: number; blockedRowCount: number; failedRowCount: number; selectedRowCount: number; status: string; summaryText: string }> {
  const rowsResult = await getPool().query<PendingPurchaseApplySummaryRow>(
    `
      select
        id as row_id,
        last_apply_status,
        last_apply_error,
        last_apply_summary_json
      from pending_purchase_rows
      where id = any($1::bigint[])
      order by id asc
    `,
    [applyRequest.selected_row_ids_json],
  )

  const selectedRowCount = applyRequest.selected_row_count
  const appliedRowCount = rowsResult.rows.filter((row) => row.last_apply_status === 'applied').length
  const blockedRowCount = rowsResult.rows.filter((row) => row.last_apply_status === 'blocked').length
  const mismatchedRowCount = Math.max(selectedRowCount - rowsResult.rows.length, 0)
  const failedRowCount = rowsResult.rows.filter((row) => row.last_apply_status === 'failed').length + mismatchedRowCount
  const status = mismatchedRowCount > 0
    ? 'failed'
    : deriveApplyRequestStatus({ appliedRowCount, blockedRowCount, failedRowCount, selectedRowCount })
  const summaryText = mismatchedRowCount > 0
    ? `Pending-purchase apply failed integrity checks: expected ${selectedRowCount} selected rows but only found ${rowsResult.rows.length}.`
    : buildApplyRequestSummaryText({ appliedRowCount, blockedRowCount, failedRowCount, selectedRowCount, status })

  await withTransaction(async (db) => {
    await db.query(
      `
        update pending_purchase_apply_requests
        set status = $2,
            applied_row_count = $3,
            blocked_row_count = $4,
            failed_row_count = $5,
            summary_json = $6::jsonb,
            finished_at = now(),
            updated_at = now()
        where id = $1
      `,
      [
        applyRequest.id,
        status,
        appliedRowCount,
        blockedRowCount,
        failedRowCount,
        JSON.stringify({
          completedAt: new Date().toISOString(),
          jobId: context.id,
          rows: rowsResult.rows.map((row) => ({
            rowId: row.row_id,
            status: row.last_apply_status,
            summary: row.last_apply_summary_json,
          })),
          stateContext: stateDealerContext,
          summaryText,
        }),
      ],
    )
  })

  return { appliedRowCount, blockedRowCount, failedRowCount, selectedRowCount, status, summaryText }
}

async function finalizePendingPurchaseApplyRequestAfterCrash(
  context: JobHandlerContext,
  applyRequestId: number,
  errorMessage: string,
): Promise<void> {
  await withTransaction(async (db) => {
    const request = await lockPendingPurchaseApplyRequest(db, applyRequestId)
    if (isFinalRequestStatus(request.status)) {
      return
    }

    await db.query(
      `
        update pending_purchase_rows
        set last_apply_status = 'failed',
            last_apply_error = $2,
            last_apply_summary_json = jsonb_build_object('status', 'failed', 'summaryText', $2),
            version = version + 1,
            updated_at = now()
        where last_apply_request_id = $1
          and last_apply_status in ('queued', 'running')
      `,
      [applyRequestId, errorMessage],
    )

    const summaryRows = await db.query<PendingPurchaseApplySummaryRow>(
      `
        select
          id as row_id,
          last_apply_status,
          last_apply_error,
          last_apply_summary_json
        from pending_purchase_rows
        where id = any($1::bigint[])
        order by id asc
      `,
      [request.selected_row_ids_json],
    )
    const appliedRowCount = summaryRows.rows.filter((row) => row.last_apply_status === 'applied').length
    const blockedRowCount = summaryRows.rows.filter((row) => row.last_apply_status === 'blocked').length
    const failedRowCount = summaryRows.rows.filter((row) => row.last_apply_status === 'failed').length + Math.max(request.selected_row_count - summaryRows.rows.length, 0)

    await db.query(
      `
        update pending_purchase_apply_requests
        set status = 'failed',
            applied_row_count = $2,
            blocked_row_count = $3,
            failed_row_count = $4,
            summary_json = $5::jsonb,
            finished_at = now(),
            updated_at = now()
        where id = $1
      `,
      [
        applyRequestId,
        appliedRowCount,
        blockedRowCount,
        failedRowCount,
        JSON.stringify({
          completedAt: new Date().toISOString(),
          jobId: context.id,
          rows: summaryRows.rows.map((row) => ({
            rowId: row.row_id,
            status: row.last_apply_status,
            summary: row.last_apply_summary_json,
          })),
          summaryText: errorMessage,
        }),
      ],
    )

    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(applyRequestId),
      entityType: 'pending_purchase_apply_request',
      eventType: 'pending_purchase.apply.completed',
      module: 'catalog',
      payload: {
        jobId: context.id,
        packetId: request.packet_id,
        pendingPurchaseApplyRequestId: applyRequestId,
        status: 'failed',
        summary: errorMessage,
      },
      requestId: randomUUID(),
      scope: buildPendingPurchasePacketScope(request.packet_id),
      undoPayload: null,
    })
  })
}

async function resetPendingPurchaseApplyRequestForRetry(
  applyRequestId: number,
  errorMessage: string,
): Promise<void> {
  await withTransaction(async (db) => {
    const request = await lockPendingPurchaseApplyRequest(db, applyRequestId)
    if (isFinalRequestStatus(request.status)) {
      return
    }

    await db.query(
      `
        update pending_purchase_apply_requests
        set status = 'queued',
            summary_json = summary_json || $2::jsonb,
            updated_at = now()
        where id = $1
      `,
      [applyRequestId, JSON.stringify({ lastRetryableError: errorMessage })],
    )
    await db.query(
      `
        update pending_purchase_rows
        set last_apply_status = 'queued',
            updated_at = now()
        where last_apply_request_id = $1
          and last_apply_status = 'running'
      `,
      [applyRequestId],
    )
  })
}

function deriveApplyRequestStatus(input: {
  appliedRowCount: number
  blockedRowCount: number
  failedRowCount: number
  selectedRowCount: number
}): 'blocked' | 'failed' | 'partially_succeeded' | 'succeeded' {
  if (input.appliedRowCount === input.selectedRowCount) {
    return 'succeeded'
  }
  if (input.appliedRowCount > 0) {
    return 'partially_succeeded'
  }
  if (input.blockedRowCount > 0 && input.failedRowCount === 0) {
    return 'blocked'
  }
  return 'failed'
}

function buildApplyRequestSummaryText(input: {
  appliedRowCount: number
  blockedRowCount: number
  failedRowCount: number
  selectedRowCount: number
  status: string
}): string {
  return `Pending-purchase apply ${input.status.replaceAll('_', ' ')}: ${input.appliedRowCount}/${input.selectedRowCount} applied, ${input.blockedRowCount} blocked, ${input.failedRowCount} failed.`
}

export function buildPendingPurchaseSuggestionVerification(input: {
  orders: SuggestionVerificationOrderInput[]
  targetProductName: string
}): PendingPurchaseSuggestionVerification {
  let matchedTargetPositionCount = 0
  let manualFollowUpPositionCount = 0
  let relevantPositionCount = 0

  const orders = input.orders.map((order) => {
    const matchedTargetPositionIds = order.positionChecks
      .filter((position) => position.status === 'target_suggested')
      .map((position) => position.positionId)
    const manualFollowUpPositionIds = order.positionChecks
      .filter((position) => position.manualFollowUpRequired)
      .map((position) => position.positionId)

    matchedTargetPositionCount += matchedTargetPositionIds.length
    manualFollowUpPositionCount += manualFollowUpPositionIds.length
    relevantPositionCount += order.positionChecks.length

    return {
      manualFollowUpPositionIds,
      matchedTargetPositionCount: matchedTargetPositionIds.length,
      orderId: order.orderId,
      positionChecks: order.positionChecks,
      relevantPositionCount: order.positionChecks.length,
      status: manualFollowUpPositionIds.length === 0
        ? 'verified' as const
        : 'manual_follow_up_required' as const,
    }
  })

  const manualFollowUpOrderCount = orders.filter((order) => order.status === 'manual_follow_up_required').length
  const overallStatus = manualFollowUpOrderCount === 0 ? 'verified' : 'manual_follow_up_required'
  const summaryText = relevantPositionCount === 0
    ? `Catalog apply succeeded, but suggestion verification could not find any matching purchase positions for ${input.targetProductName}; manual purchase-side follow-up is still required.`
    : overallStatus === 'verified'
      ? `Catalog apply succeeded and suggestion verification now proposes ${input.targetProductName} for all ${relevantPositionCount} relevant purchase position${relevantPositionCount === 1 ? '' : 's'}.`
      : `Catalog apply succeeded, but manual purchase-side follow-up is still required for ${manualFollowUpPositionCount} of ${relevantPositionCount} relevant purchase position${relevantPositionCount === 1 ? '' : 's'} across ${manualFollowUpOrderCount} order${manualFollowUpOrderCount === 1 ? '' : 's'}.`

  return {
    manualFollowUpOrderCount,
    manualFollowUpPositionCount,
    matchedTargetPositionCount,
    orders,
    overallStatus,
    relevantPositionCount,
    summaryText,
    targetProductName: input.targetProductName,
  }
}

function buildAppliedRowSummary(
  row: LoadedPendingPurchaseRow,
  productId: number,
  verification: PendingPurchaseSuggestionVerification,
): string {
  return `Applied pending-purchase row ${row.rowId} for ${row.targetVariantName} onto product ${productId}. ${verification.summaryText}`
}

function requirePendingPurchasePrice(row: LoadedPendingPurchaseRow): number {
  if (typeof row.effectiveProposedPrice === 'number' && Number.isFinite(row.effectiveProposedPrice) && row.effectiveProposedPrice >= 0) {
    return row.effectiveProposedPrice
  }
  throw new Error(`Pending-purchase row ${row.rowId} is missing an approved price.`)
}

function requireNonEmptyString(value: string | null | undefined, label: string): string {
  const normalized = normalizeNullableString(value)
  if (!normalized) {
    throw new Error(`Pending-purchase row is missing ${label}.`)
  }
  return normalized
}

function lowerNameMap<T extends { name: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.name.toLowerCase(), row]))
}

function ListResponseSchema<T extends z.ZodTypeAny>(itemSchema: T): z.ZodType<z.infer<T>[]> {
  return z.union([
    z.array(itemSchema),
    z.object({ data: z.array(itemSchema).default([]) }).passthrough().transform((value) => value.data),
  ]).transform((value) => Array.isArray(value) ? value : value)
}

function summarizeGroup(group: z.infer<typeof ProductGroupDetailSchema>): Record<string, unknown> {
  return {
    brand: normalizeNullableString(group.brand?.name),
    category: normalizeNullableString(group.category?.name),
    description: normalizeNullableString(group.description),
    groupId: group.id,
    imageUrls: group.images.map((image) => normalizeNullableString(image.url)).filter((url): url is string => url !== null),
    name: normalizeNullableString(group.name),
    strain: normalizeNullableString(group.strain?.name),
    subcategory: normalizeNullableString(group.subcategory?.name),
  }
}

function summarizeProduct(product: z.infer<typeof ProductSummarySchema>): Record<string, unknown> {
  return {
    allowedSaleType: normalizeNullableString(product.allowedSaleType?.name),
    displayInEcommerce: product.displayInEcommerce ?? null,
    isPacked: product.isPacked ?? null,
    name: normalizeNullableString(product.name),
    packOfSize: product.packOfSize ?? null,
    price: product.price ?? null,
    productGroupId: product.productGroupId ? Number(product.productGroupId) : null,
    productId: product.id,
    shortName: normalizeNullableString(product.shortName),
    size: normalizeNullableString(product.size?.name),
    tab: normalizeNullableString(product.tab),
  }
}

function buildPendingPurchasePacketScope(packetId: number): { entityId: string; entityType: 'pending_purchase_packet' } {
  return { entityId: String(packetId), entityType: 'pending_purchase_packet' }
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function normalizeText(value: unknown): string {
  return (typeof value === 'string' ? value : '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function readRecord(value: JsonValue): Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function readOptionalInt(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function readOptionalNumber(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readOptionalString(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function isLikelyParserRelatedApplyFailure(summaryText: string | null): boolean {
  if (!summaryText) {
    return false
  }
  const lowered = summaryText.toLowerCase()
  return (
    lowered.includes('target') ||
    lowered.includes('taxonomy') ||
    lowered.includes('not found') ||
    ['brand', 'category', 'size', 'strain', 'subcategory', 'variant'].some((token) => lowered.includes(token))
  )
}

function isFinalRequestStatus(status: PendingPurchaseApplyRequestRow['status']): boolean {
  return status === 'blocked' || status === 'failed' || status === 'partially_succeeded' || status === 'succeeded'
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}
