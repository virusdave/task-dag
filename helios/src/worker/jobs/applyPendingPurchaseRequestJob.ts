import { randomUUID } from 'node:crypto'

import type { QueryResultRow } from 'pg'
import { z } from 'zod'

import type { CatalogPendingPurchasesApplyJobPayload, JsonValue } from '../../shared/contracts/index.js'
import { PENDING_PURCHASE_TEMPORARY_UNSELLABLE_PRICE } from '../../shared/domain/pendingPurchasePricing.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { getPool, type Queryable } from '../../server/db/pool.js'
import {
  insertPendingPurchaseParseObservation,
  normalizePendingPurchaseParserText,
  updatePendingPurchaseParseRuleFeedback,
} from '../../server/db/queries/pendingPurchaseParserQueries.js'
import {
  assertPendingPurchasePacketApplyable,
  lockPendingPurchasePacketRootForApply,
} from '../../server/db/queries/pendingPurchaseRefinementQueries.js'
import { withTransaction } from '../../server/db/tx.js'
import { enqueueJob } from '../../server/jobs/enqueueJob.js'
import { findDescriptionMedicalClaimIssues, normalizeDescriptionText } from '../catalog/liveState.js'
import { getWorkerEnv } from '../config/env.js'
import { downloadValidatedImageAsset, UnsupportedImageFormatError } from '../pendingPurchases/imageSafety.js'
import {
  compareLiveReuse,
  precheckReuseDrift,
  type LiveReuseProductFacts,
  type ParsedReuseSnapshot,
} from '../pendingPurchases/reuseDriftGuard.js'
import { enqueueMarketRefreshForProducts } from '../litalerts/enqueueMarketRefresh.js'
import { isRetiredRecordName, looksLikeSweedDeadScreenError } from './screensCarouselHelpers.js'
import { DependencyUnavailableWorkerError, RetryableWorkerError } from '../runtime/errors.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'
import { callSweedRpcForDealer, readSweedDealerContext } from '../sweed/client.js'

const ALLOWED_SALE_TYPE_ID = 1

export { PENDING_PURCHASE_TEMPORARY_UNSELLABLE_PRICE }
const SUBCATEGORY_ALIASES = new Map<string, string>([
  ['vapes:disposable', 'All In One / Disposable'],
])

/**
 * Subcategory names we want explicitly dropped (treated as if the
 * row had no subcategory) regardless of whether Sweed exposes them.
 * Edibles gummies are deliberately stored with no subcategory in our
 * Sweed taxonomy — there is no enabled "Gummies" or "Chews/Gummies"
 * subcategory under Edibles. Any legacy pending row that still has
 * `expected_subcategory='Gummies'` should apply as no-subcategory
 * instead of failing with "Missing subcategory" or being rewritten to
 * a name that doesn't exist either.
 */
const SUBCATEGORY_DROPS = new Set<string>([
  'edibles:gummies',
  'edibles:gummy',
  'edibles:chews/gummies',
])

const PENDING_PURCHASE_SOURCE_SYSTEM = 'metrc'

// Sweed UOM id 16 = "Milligram". Used for THC/CBD content fields on
// edibles, tinctures, etc. — categories whose limitType requires
// thc/cbd ("Forbidden to create product without thc&cbd" if omitted).
const MILLIGRAM_UOM_ID = 16

// Job-detail page reads payload_json.progressLog; cap at 5000 entries
// per job to keep the row from ballooning under retry storms. Matches
// MAX_JOB_PROGRESS_LOG_ENTRIES in generatePendingPurchasePacketJob.ts.
const MAX_JOB_PROGRESS_LOG_ENTRIES = 5000

// Categories whose Sweed `limitType.isThcAndCbdRequired === true`.
// (We cannot read limitType from the catalog dictionary loader, so
// keeping a small allow-list is the simplest correct option until
// the dictionary is enriched.) Edibles fail without these fields,
// Vapes / Flower / Pre-Rolls do not.
const CATEGORIES_REQUIRING_CANNABINOID_FIELDS = new Set<string>([
  'edibles',
  'tinctures',
  'topicals',
  'oral & nasal',
])

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
  // Sweed liveness flag. The C7 drift guard refuses to link a generated reuse
  // onto a disabled product even if its identity is otherwise unchanged (the C5
  // validator only ever confirmed reuse onto a live product).
  enabled: z.boolean().nullable().optional(),
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
  // Sweed liveness flag (see ProductSummarySchema.enabled). The drift guard
  // treats a disabled group as a non-live reuse target.
  enabled: z.boolean().nullable().optional(),
  id: z.coerce.number().int(),
  images: z.array(z.object({ id: z.union([z.coerce.number().int(), z.string().trim().min(1)]).nullable().optional(), url: z.string().nullable().optional() }).passthrough()).default([]),
  name: z.string().nullable().optional(),
  products: z.array(ProductSummarySchema).default([]),
  strain: NamedIdSchema.nullable().optional(),
  subcategory: NameOnlySchema.nullable().optional(),
}).passthrough()

export function readInactiveReuseTargetReason(
  product: Pick<z.infer<typeof ProductSummarySchema>, 'enabled' | 'id' | 'name'>,
  group: Pick<z.infer<typeof ProductGroupDetailSchema>, 'brand' | 'enabled' | 'name'>,
): string | null {
  if (
    product.enabled !== false
    && group.enabled !== false
    && !isRetiredRecordName(product.name)
    && !isRetiredRecordName(group.name)
    && !isRetiredRecordName(group.brand?.name)
  ) {
    return null
  }
  return `targets disabled or retired Sweed product ${product.id}; choose an active product or force catalog creation.`
}

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

// The frozen live-product identity the C5 validator confirmed a generated reuse
// link against, persisted on the row as `raw_row_json.validatedReuseSnapshot`.
// Shape mirrors `ReconciledReuseSnapshot` from reconcilePendingPurchaseDrafts.ts
// (the producer). Unknown extra keys are stripped (forward-compatible with a C8+
// snapshot extension); a MISSING required key fails the parse, which the loader
// surfaces as a 'malformed' snapshot so the drift guard blocks the row rather
// than trusting unreadable safety metadata.
const ValidatedReuseSnapshotSchema = z.object({
  productId: z.number().int().positive(),
  // Non-null to mirror the producer (`ReconciledReuseSnapshot.productName`): the
  // validator only snapshots a confirmed live product, which always has a name.
  productName: z.string(),
  groupId: z.number().int().positive().nullable(),
  brand: z.string().nullable(),
  category: z.string().nullable(),
  subcategory: z.string().nullable(),
  groupName: z.string().nullable(),
  variantTab: z.string().nullable(),
  strain: z.string().nullable(),
  size: z.string().nullable(),
  packCount: z.number().int().positive().nullable(),
})

function readValidatedReuseSnapshot(rawRow: Record<string, JsonValue>): ParsedReuseSnapshot {
  const raw = rawRow.validatedReuseSnapshot
  if (raw === undefined || raw === null) {
    return { kind: 'absent' }
  }
  const parsed = ValidatedReuseSnapshotSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      kind: 'malformed',
      error: parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; '),
    }
  }
  return { kind: 'valid', snapshot: parsed.data }
}

// Structured marker persisted into last_apply_summary_json when a product was
// created/updated successfully but its image could not be attached (e.g. the
// source is AVIF, which Sweed does not accept). The row still counts as
// `applied` — the operator explicitly prefers getting inventory live over
// blocking on images — and this record lets a later backfill find exactly
// which live products still need an image, and why.
interface AppliedImageSkip {
  status: 'skipped'
  sourceUrl: string
  reasonCode: 'unsupported_format' | 'image_upload_failed'
  message: string
}

const CREATED_SKU_CHECKPOINT_KEY = 'pendingPurchaseCreatedSku'
const CreatedSkuCheckpointSchema = z.object({
  appliedPrice: z.literal(PENDING_PURCHASE_TEMPORARY_UNSELLABLE_PRICE),
  createdAt: z.string().datetime(),
  groupId: z.number().int().positive().optional(),
  phase: z.enum(['group_create_pending', 'group_created', 'product_create_pending', 'product_created']),
  productId: z.number().int().positive().optional(),
  repriceRequired: z.literal(true),
  requestId: z.number().int().positive(),
  rowId: z.number().int().positive(),
})
type CreatedSkuCheckpoint = z.infer<typeof CreatedSkuCheckpointSchema>

export function mayIssueCreatedSkuAdd(
  kind: 'group' | 'product',
  checkpoint: Pick<CreatedSkuCheckpoint, 'phase'> | null,
): boolean {
  if (kind === 'group') return checkpoint === null
  return checkpoint === null || checkpoint.phase === 'group_created'
}

// Cap the stored/displayed image-skip message so a pathological error object
// cannot bloat the summary JSON row.
const MAX_IMAGE_SKIP_MESSAGE_LENGTH = 400

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
  createdSkuCheckpoint: CreatedSkuCheckpoint | null
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
  /**
   * Effective product-id this row should link to in Sweed.
   *  - `null` + `reuseProductIdOverridePresent=false`: catalog-create
   *    path (no reuse).
   *  - `positive int` + `reuseProductIdOverridePresent=false`: legacy
   *    parser-derived reuse via `raw_row_json.reuseProductId`. Apply
   *    may still rewrite the product's identity fields from parser
   *    text (variant name, group name, size, etc.).
   *  - `positive int` + `reuseProductIdOverridePresent=true`: reviewer
   *    explicitly chose this Sweed product via the link-override
   *    picker. Apply MUST link to this product and MUST NOT rewrite
   *    any of its Sweed identity fields. The reviewer asserted that
   *    the chosen variant is already correct as-is.
   *  - `null` + `reuseProductIdOverridePresent=true`: reviewer
   *    explicitly cleared the parser-proposed reuse; apply falls
   *    through to the catalog-create branch.
   */
  reuseProductId: number | null
  reuseProductIdOverridePresent: boolean
  /**
   * Parsed `raw_row_json.validatedReuseSnapshot` — the frozen live-product
   * identity the C5 validator confirmed a GENERATED reuse against. Consumed by
   * the C7 apply-time drift guard (only for generator reuse, never reviewer
   * overrides). See {@link ParsedReuseSnapshot} for the three-state semantics.
   */
  validatedReuseSnapshot: ParsedReuseSnapshot
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

// Append one entry to the worker job's progressLog so the
// /jobs/<id> page renders a per-mutation audit trail. Mirrors the
// SQL pattern used by generatePendingPurchasePacketJob.updateJobProgress
// (trims to MAX_JOB_PROGRESS_LOG_ENTRIES newest entries on each write).
async function appendApplyJobProgressLog(
  jobId: number,
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const entry = {
    createdAt: new Date().toISOString(),
    message,
    ...(data && Object.keys(data).length > 0 ? { data } : {}),
  }
  try {
    await getPool().query(
      `
        update job_queue
        set payload_json = jsonb_set(
              coalesce(payload_json, '{}'::jsonb),
              '{progressLog}',
              (
                select coalesce(jsonb_agg(entry order by ordinality asc), '[]'::jsonb)
                from (
                  select entry, ordinality
                  from jsonb_array_elements(
                    coalesce(payload_json->'progressLog', '[]'::jsonb) || $2::jsonb
                  ) with ordinality as log_entries(entry, ordinality)
                  order by ordinality desc
                  limit ${MAX_JOB_PROGRESS_LOG_ENTRIES}
                ) trimmed
              ),
              true
            ),
            updated_at = now()
        where id = $1
      `,
      [jobId, JSON.stringify([entry])],
    )
  } catch (error) {
    // Never let a logging failure abort the apply itself.
    console.warn(`[applyPendingPurchaseRequestJob] progressLog write failed: ${error instanceof Error ? error.message : error}`)
  }
}

// Compute the THC/CBD payload for a `store.product.add` call when the
// row's category requires it (e.g. Edibles). We derive the per-unit
// THC from the targetSize when it is expressed in milligrams (e.g.
// "10mg"); total per-product is per-unit × packCount. CBD defaults to
// 0 because we do not currently capture per-row CBD content. If the
// size is not mg-shaped we still emit zeros + the Milligram UOM —
// Sweed only rejects when the fields are completely absent.
function buildCannabinoidPayload(row: LoadedPendingPurchaseRow): Record<string, unknown> {
  const categoryName = (row.expectedCategory ?? '').trim().toLowerCase()
  if (!CATEGORIES_REQUIRING_CANNABINOID_FIELDS.has(categoryName)) {
    return {}
  }
  const sizeName = (row.targetSize ?? '').trim()
  const mgMatch = /^(\d+(?:\.\d+)?)\s*mg$/i.exec(sizeName)
  const thcPerUnitMg = mgMatch ? Number(mgMatch[1]) : 0
  const packCount = row.targetPackCount ?? 1
  return {
    cbdContentPerProduct: 0,
    cbdContentPerUnit: 0,
    cbdContentUomId: MILLIGRAM_UOM_ID,
    thcContentPerProduct: thcPerUnitMg * packCount,
    thcContentPerUnit: thcPerUnitMg,
    thcContentUomId: MILLIGRAM_UOM_ID,
  }
}

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
    const packetId = await readPendingPurchaseApplyRequestPacketId(db, payload.pendingPurchaseApplyRequestId)
    await lockPendingPurchasePacketRootForApply(db, packetId)
    const current = await lockPendingPurchaseApplyRequest(db, payload.pendingPurchaseApplyRequestId)
    if (isFinalRequestStatus(current.status)) {
      return current
    }
    await assertPendingPurchasePacketApplyable(db, current.packet_id)

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

  // Collect every product this request created, including rows durably marked
  // applied by an earlier attempt, so retries cannot strand follow-up work.
  const createdProductIds: number[] = rows.flatMap((row) => readCreatedProductId(row.last_apply_summary_json))
  const createdProducts = rows.flatMap((row) => readCreatedProductId(row.last_apply_summary_json)
    .map((productId) => ({ productId, rowId: row.id })))

  for (const rowRecord of rows) {
    if (rowRecord.last_apply_status === 'applied') {
      continue
    }

    const row = loadPendingPurchaseRow(rowRecord)
    await appendApplyJobProgressLog(context.id, `Row ${row.rowId} apply starting`, {
      rowId: row.rowId,
      brand: row.targetBrand,
      groupName: row.targetGroupName,
      variantName: row.targetVariantName,
      category: row.expectedCategory,
      subcategory: row.expectedSubcategory,
    })
    try {
      const rowSummary = await applyPendingPurchaseRow(
        row,
        payload.pendingPurchaseApplyRequestId,
        env.sweedStateDealerId,
        dictionaries,
        context.id,
      )
      await markPendingPurchaseRowApplied(row, payload.pendingPurchaseApplyRequestId, rowSummary)
      const createdProductId = (rowSummary as { createdProductId?: number | null }).createdProductId ?? null
      if (typeof createdProductId === 'number' && Number.isInteger(createdProductId) && createdProductId > 0) {
        createdProductIds.push(createdProductId)
        createdProducts.push({ productId: createdProductId, rowId: row.rowId })
      }
      await appendApplyJobProgressLog(context.id, `Row ${row.rowId} applied`, {
        rowId: row.rowId,
        createdGroupId: (rowSummary as { createdGroupId?: number | null }).createdGroupId ?? null,
        createdProductId,
      })
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
      await appendApplyJobProgressLog(context.id, `Row ${row.rowId} ${failureStatus}`, {
        rowId: row.rowId,
        error: failureSummary.summaryText,
      })
    }
  }

  if (createdProductIds.length > 0) {
    const uniqueCreatedProductIds = [...new Set(createdProductIds)]
    try {
      await enqueueMarketRefreshForProducts(uniqueCreatedProductIds, {
        trigger: { kind: 'pending-purchase', pendingPurchaseRowId: applyRequest.packet_id },
        priority: 10,
        requestedByUserId: payload.requestedByUserId ?? null,
      })
      await withTransaction(async (db) => {
        const repriceJobId = await enqueueJob(db, {
          dedupeKey: `catalog.pending_purchases.queue_reprice:${payload.pendingPurchaseApplyRequestId}`,
          jobType: 'catalog.pending_purchases.queue_reprice',
          module: 'catalog',
          payload: {
            createdProducts: [...new Map(createdProducts.map((item) => [item.rowId, item])).values()],
            pendingPurchaseApplyRequestId: payload.pendingPurchaseApplyRequestId,
            requestedByUserId: payload.requestedByUserId ?? null,
          },
          requestedByUserId: payload.requestedByUserId ?? null,
        })
        await db.query(
          `update pending_purchase_rows
           set last_apply_summary_json = jsonb_set(
                 last_apply_summary_json,
                 '{pendingPurchaseCreatedSku,repriceQueueJobId}',
                 to_jsonb($2::bigint),
                 true
               ),
               updated_at = now()
           where id = any($1::bigint[])`,
          [[...new Set(createdProducts.map((item) => item.rowId))], repriceJobId],
        )
      })
    } catch (error) {
      throw new RetryableWorkerError(
        `Created products are durable but mandatory repricing follow-up could not be queued: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const requestSummary = await finalizePendingPurchaseApplyRequest(context, applyRequest, stateDealerContext)

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

  // Job-level success requires every approved/selected row to have been
  // applied. If any row failed or was blocked, surface that as a job failure
  // so the worker run shows up as `failed` (with `last_error` describing
  // the partial outcome) rather than silently `succeeded`. The apply
  // request row itself already records the partial status; the wrapping
  // catch-block's after-crash finalize is a no-op for finalized requests.
  if (requestSummary.status !== 'succeeded') {
    throw new Error(
      `Pending-purchase apply finished as ${requestSummary.status}: ${requestSummary.summaryText}`,
    )
  }
}

async function applyPendingPurchaseRow(
  row: LoadedPendingPurchaseRow,
  applyRequestId: number,
  stateDealerId: number,
  dictionaries: StateDictionaries,
  jobId: number,
): Promise<Record<string, unknown>> {
  if (row.siteDealerId === null) {
    throw new Error(`Pending-purchase row ${row.rowId} is missing a site dealer id.`)
  }
  if (!row.targetVariantName?.trim()) {
    throw new Error(`Pending-purchase row ${row.rowId} is missing a target variant name.`)
  }

  const logMutation = (op: string, data?: Record<string, unknown>): Promise<void> =>
    appendApplyJobProgressLog(jobId, `row ${row.rowId}: ${op}`, data)

  // Non-fatal degradations during this row's apply (subcategory dropped
  // because Sweed didn't recognise it, edit skipped because Sweed
  // refused it, etc.). Surfaced in the final summary so the operator
  // can act on them without having to dig through the progress log.
  const applyDegradations: string[] = []

  const normalizedDescription = row.effectiveProposedDescription
    ? normalizeDescriptionText(row.effectiveProposedDescription)
    : null
  if (normalizedDescription) {
    const medicalClaimIssues = findDescriptionMedicalClaimIssues(normalizedDescription)
    if (medicalClaimIssues.length > 0) {
      throw new PendingPurchaseBlockedError(`Pending-purchase apply blocked description: ${medicalClaimIssues.join(', ')}`)
    }
  }

  // C7 generated-reuse drift guard — RPC-independent precheck. Runs BEFORE ANY
  // Sweed read (including the distributor resolution and the variant lookups
  // below) so a deterministic, row-level block (malformed snapshot, or a
  // snapshot whose productId disagrees with the row) can never be masked by a
  // transient/permanent RPC failure that would mis-classify a `blocked` row as
  // `failed`. The live comparison happens after the product/group fetch below,
  // also before `resolveRowDistributor`, so a deleted/disabled reuse target
  // blocks before any purchase-order RPC can fail.
  const driftPrecheck = precheckReuseDrift({
    rowId: row.rowId,
    reuseProductId: row.reuseProductId,
    reuseProductIdOverridePresent: row.reuseProductIdOverridePresent,
    snapshot: row.validatedReuseSnapshot,
  })
  if (driftPrecheck.kind === 'block') {
    await logMutation('reuse drift guard blocked', { productId: row.reuseProductId, reason: driftPrecheck.reason })
    throw new PendingPurchaseBlockedError(driftPrecheck.reason)
  }

  // Variant resolution waterfall:
  //  1. If the reviewer set the link-override (`targetReuseProductId`
  //     present in edited_structured_fields), trust it absolutely:
  //     - positive int → link to that exact Sweed product, do NOT
  //       fall back to findExactVariant by name (the override exists
  //       precisely because the parser's name didn't match).
  //     - explicit null → reviewer cleared the parser-proposed reuse;
  //       skip findExactVariant too (the operator has decided this
  //       row must take the catalog-create branch).
  //  2. Otherwise prefer `row.reuseProductId` from the generator.
  //  3. Otherwise look up by exact target variant name (legacy).
  const exactVariant = row.reuseProductIdOverridePresent
    ? (row.reuseProductId !== null
      ? { id: row.reuseProductId, name: row.targetVariantName }
      : null)
    : (row.reuseProductId
      ? { id: row.reuseProductId, name: row.targetVariantName }
      : await findExactVariant(stateDealerId, row.targetVariantName))
  // When the reviewer forced a specific Sweed product id, the chosen
  // variant is identity-authoritative: we must not rewrite its name,
  // tab, size, pack-of-size, group name, or strain from parser text
  // (which is exactly what was wrong in the first place — see job
  // 133150 / packet 36 rows 389-390). Apply still updates operational
  // fields (price, ecommerce visibility, distributor link).
  const preserveLinkedVariantIdentity = row.reuseProductIdOverridePresent && row.reuseProductId !== null

  let createdBlobId: string | null = null
  const checkpointCreatedAt = row.createdSkuCheckpoint?.createdAt ?? new Date().toISOString()
  const reconcileCheckpointedProduct = row.createdSkuCheckpoint?.phase === 'product_create_pending'
  let imageSkip: AppliedImageSkip | null = null
  let createdGroupId: number | null = row.createdSkuCheckpoint?.groupId ?? null
  let createdProductId: number | null = row.createdSkuCheckpoint?.productId ?? null
  let product: z.infer<typeof ProductSummarySchema> | null = null
  let group: z.infer<typeof ProductGroupDetailSchema> | null = null
  try {
    product = exactVariant
      ? ProductDetailSchema.parse(await callSweedRpcForDealer(stateDealerId, 'store.product.get', { id: String(exactVariant.id) })).product
      : null
    group = product?.productGroupId
      ? ProductGroupDetailSchema.parse(
        await callSweedRpcForDealer(stateDealerId, 'store.product.group.get', { id: Number(product.productGroupId) }),
      )
      : null
  } catch (fetchError) {
    // For a guarded generated reuse, Sweed's misleading "does not exist / no
    // permission" (subcode 14002) means the validated target was deleted or
    // disabled since validation — a drift BLOCK (reviewer must re-confirm), not
    // a generic failure. We convert ONLY that known signal to a null target so
    // the comparison below blocks it; every other error (transient, schema,
    // unexpected) propagates unchanged, and the legacy/override paths never
    // swallow load errors (which could otherwise fall into a duplicate create).
    if (driftPrecheck.kind === 'compare-live' && looksLikeSweedDeadScreenError(fetchError)) {
      product = null
      group = null
    } else {
      throw fetchError
    }
  }
  if (row.createdSkuCheckpoint && row.createdSkuCheckpoint.groupId === undefined) {
    throw new DependencyUnavailableWorkerError(
      `The outcome of Sweed group creation for pending-purchase row ${row.rowId} is unknown; refusing to create a duplicate group.`,
      { delayMs: 5 * 60 * 1000 },
    )
  }
  if (row.createdSkuCheckpoint?.groupId) {
    group = ProductGroupDetailSchema.parse(
      await callSweedRpcForDealer(stateDealerId, 'store.product.group.get', { id: row.createdSkuCheckpoint.groupId }),
    )
    if (row.createdSkuCheckpoint.productId) {
      const resumed = await waitForProductInGroup(stateDealerId, group.id, row.createdSkuCheckpoint.productId)
      group = resumed.group
      product = resumed.product
    } else {
      product = null
    }
  }
  const groupBefore = group ? summarizeGroup(group) : null
  const productBefore = product ? summarizeProduct(product) : null

  // Reviewer-forced links are identity-authoritative, but they are not exempt
  // from Sweed liveness. A product can be disabled or soft-retired after the
  // operator selects it (and API callers can bypass the picker entirely), so
  // block every loaded reuse target before any mutation rather than trusting
  // client-side filtering.
  const inactiveReuseReason = product !== null && group !== null
    ? readInactiveReuseTargetReason(product, group)
    : null
  if (product !== null && inactiveReuseReason !== null) {
    const reason = `Pending-purchase row ${row.rowId} ${inactiveReuseReason}`
    await logMutation('inactive reuse target blocked', { productId: product.id, reason })
    throw new PendingPurchaseBlockedError(reason)
  }

  if (driftPrecheck.kind === 'compare-live') {
    // A disabled product/group is not a live reuse target even if its identity
    // is otherwise unchanged (the C5 validator only confirms reuse onto live
    // products), so treat it as a null target → block.
    const liveFacts: LiveReuseProductFacts | null =
      product !== null && group !== null && product.enabled !== false && group.enabled !== false
        ? buildLiveReuseFacts(product, group)
        : null
    const comparison = compareLiveReuse(
      row.rowId,
      driftPrecheck.snapshot.productId,
      driftPrecheck.snapshot,
      liveFacts,
    )
    if (comparison.kind === 'block') {
      await logMutation('reuse drift guard blocked', { productId: row.reuseProductId, reason: comparison.reason })
      throw new PendingPurchaseBlockedError(comparison.reason)
    }
    await logMutation('reuse drift guard passed', { productId: row.reuseProductId })
  }

  // Resolve the distributor only AFTER the drift guard has run. This RPC
  // (store.purchase.order.get) can fail transiently; running it first would
  // surface a deterministic `blocked` row (malformed/mismatched snapshot,
  // deleted/disabled reuse target) as a generic `failed` instead.
  const distributor = await resolveRowDistributor(row)

  if (!product || !group) {
    const categoryContext = resolveCategoryContext(row, dictionaries)
    if (categoryContext.subcategoryNote) {
      applyDegradations.push(categoryContext.subcategoryNote)
      await logMutation('subcategory dropped', {
        requested: row.expectedSubcategory,
        category: row.expectedCategory,
        note: categoryContext.subcategoryNote,
      })
    }
    const brand = await ensureBrand(stateDealerId, dictionaries, requireNonEmptyString(row.targetBrand, 'target brand'))
    const productPrice = PENDING_PURCHASE_TEMPORARY_UNSELLABLE_PRICE
    if (row.effectivePrimaryImageUrl) {
      // Image attachment is NON-FATAL by operator directive: it is better to
      // create the product without an image (so the inventory can go on sale
      // now) and backfill the image later than to block the whole apply. Any
      // failure here — an unsupported format like AVIF, a source 4xx/network
      // error, or a Sweed blob-upload failure — is downgraded to an
      // `imageSkip` degradation; the product is still created below. We do NOT
      // rethrow transient (Retryable) errors: if Sweed itself is broadly
      // unavailable, the REQUIRED store.product.group.add / store.product.add
      // calls immediately below will throw RetryableWorkerError and the whole
      // job retries anyway, giving the image another attempt.
      try {
        createdBlobId = await uploadImage(row.effectivePrimaryImageUrl)
      } catch (imageError) {
        imageSkip = buildImageSkip(row.effectivePrimaryImageUrl, imageError)
        applyDegradations.push(
          `Image skipped; product created without an image (${imageSkip.message}). ` +
            `Source: ${imageSkip.sourceUrl}. Backfill the image later.`,
        )
        await logMutation('image upload skipped', {
          url: imageSkip.sourceUrl,
          reasonCode: imageSkip.reasonCode,
          error: imageSkip.message,
        })
      }
      if (createdBlobId) {
        await logMutation('uploaded image', { blobId: createdBlobId, url: row.effectivePrimaryImageUrl })
      }
    }

    const groupName = requireNonEmptyString(row.targetGroupName ?? row.targetVariantName, 'target group name')
    const groupAddPayload = {
      brandId: brand.id,
      categoryId: categoryContext.category.id,
      description: normalizedDescription ?? undefined,
      imagesIds: createdBlobId ? [createdBlobId] : undefined,
      isFinishedProduct: true,
      name: groupName,
      subcategoryId: categoryContext.subcategory?.id,
    }
    if (createdGroupId === null) {
      if (!mayIssueCreatedSkuAdd('group', row.createdSkuCheckpoint)) {
        throw new DependencyUnavailableWorkerError(`Refusing to repeat Sweed group creation for pending-purchase row ${row.rowId}.`)
      }
      await persistCreatedSkuCheckpoint(row.rowId, applyRequestId, {
        createdAt: checkpointCreatedAt,
        phase: 'group_create_pending',
      })
      const groupResult = z.object({ id: z.coerce.number().int() }).passthrough().parse(
        await callSweedRpcForDealer(stateDealerId, 'store.product.group.add', groupAddPayload),
      )
      createdGroupId = groupResult.id
      await persistCreatedSkuCheckpoint(row.rowId, applyRequestId, {
        createdAt: checkpointCreatedAt,
        groupId: createdGroupId,
        phase: 'group_created',
      })
      await logMutation('store.product.group.add', {
        groupId: createdGroupId,
        name: groupName,
        brandId: brand.id,
        categoryId: categoryContext.category.id,
        subcategoryId: categoryContext.subcategory?.id ?? null,
      })
    }
    group = ProductGroupDetailSchema.parse(
      await callSweedRpcForDealer(stateDealerId, 'store.product.group.get', { id: createdGroupId }),
    )

    const cannabinoidPayload = buildCannabinoidPayload(row)
    const productAddPayload = {
      allowedSaleTypeId: ALLOWED_SALE_TYPE_ID,
      displayInEcommerce: true,
      isPacked: true,
      packOfSize: row.targetPackCount ?? 1,
      price: productPrice,
      productGroupId: createdGroupId,
      sizeId: resolveSizeId(row, dictionaries),
      tab: row.targetVariantTab ?? '',
      ...cannabinoidPayload,
    }
    const reconciledProduct = reconcileCheckpointedProduct
      ? await reconcileCheckpointedGroupProduct(stateDealerId, createdGroupId, productAddPayload)
      : null
    if (reconciledProduct) {
      createdProductId = reconciledProduct.id
    } else {
      if (!mayIssueCreatedSkuAdd('product', row.createdSkuCheckpoint)) {
        throw new DependencyUnavailableWorkerError(
          `The outcome of Sweed product creation for pending-purchase row ${row.rowId} is still unknown; refusing to create a duplicate product.`,
          { delayMs: 5 * 60 * 1000 },
        )
      }
      await persistCreatedSkuCheckpoint(row.rowId, applyRequestId, {
        createdAt: checkpointCreatedAt,
        groupId: createdGroupId,
        phase: 'product_create_pending',
      })
      const productResult = z.object({ id: z.coerce.number().int() }).passthrough().parse(
        await callSweedRpcForDealer(stateDealerId, 'store.product.add', productAddPayload),
      )
      createdProductId = productResult.id
    }
    await persistCreatedSkuCheckpoint(row.rowId, applyRequestId, {
      createdAt: checkpointCreatedAt,
      groupId: createdGroupId,
      phase: 'product_created',
      productId: createdProductId,
    })
    await logMutation('store.product.add', {
      productId: createdProductId,
      groupId: createdGroupId,
      sizeId: productAddPayload.sizeId,
      packOfSize: productAddPayload.packOfSize,
      tab: productAddPayload.tab,
      price: productPrice,
      cannabinoidFieldsIncluded: Object.keys(cannabinoidPayload).length > 0,
    })

    const waitResult = await waitForProductInGroup(stateDealerId, createdGroupId, createdProductId)
    group = waitResult.group
    product = waitResult.product
  }

  // When the reviewer forced a specific Sweed product id, skip the
  // identity-mutating steps (strain resolution, group rename/strain
  // re-link, product rename/size/pack/tab edit). The reviewer's
  // assertion is "this Sweed variant is already correct; just link
  // to it" — we only need the operational edits below (price,
  // ecommerce visibility, distributor link), which buildProductEditPayload
  // still produces because they're orthogonal to identity.
  const strainRow = preserveLinkedVariantIdentity
    ? null
    : await ensureTargetStrain(stateDealerId, dictionaries, row.targetStrain, row.targetPrevalence)
  if (!preserveLinkedVariantIdentity) {
    const groupEditPayload = buildGroupEditPayload(group, row, normalizedDescription, strainRow?.id ?? null)
    if (Object.keys(groupEditPayload).length > 1) {
      await callSweedRpcForDealer(stateDealerId, 'store.product.group.edit', groupEditPayload)
      await logMutation('store.product.group.edit', {
        groupId: group.id,
        fieldsUpdated: Object.keys(groupEditPayload).filter((k) => k !== 'id'),
      })
      group = ProductGroupDetailSchema.parse(
        await callSweedRpcForDealer(stateDealerId, 'store.product.group.get', { id: group.id }),
      )
    }
  } else {
    applyDegradations.push(
      `Reviewer-forced link to existing product ${product.id} ("${product.name ?? ''}") — preserved Sweed identity; parser-derived name/group/strain/size/tab/pack values were ignored.`,
    )
    await logMutation('preserved linked variant identity', {
      productId: product.id,
      groupId: group.id,
      productName: product.name,
      groupName: group.name,
    })
  }

  const productEditPayload = buildProductEditPayload(product, row, dictionaries, {
    preserveIdentity: preserveLinkedVariantIdentity,
    preservePrice: createdProductId !== null,
  })
  if (Object.keys(productEditPayload).length > 1) {
    await callSweedRpcForDealer(stateDealerId, 'store.product.edit', productEditPayload)
    await logMutation('store.product.edit', {
      productId: product.id,
      fieldsUpdated: Object.keys(productEditPayload).filter((k) => k !== 'id'),
    })
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
  await logMutation('distributor link', distributorLink)
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
  const summaryText = buildAppliedRowSummary(row, createdProductId ?? product.id, verification, applyDegradations)

  return {
    appliedAt: new Date().toISOString(),
    createdBlobId,
    createdGroupId,
    createdProductId,
    ...(createdProductId !== null ? {
      appliedPrice: PENDING_PURCHASE_TEMPORARY_UNSELLABLE_PRICE,
      repriceRequired: true,
      repriceState: 'pending_queue',
    } : {}),
    distributorLink,
    distributorName: distributor.distributorName,
    distributorProductId: row.distributorProductId,
    groupAfter,
    groupBefore,
    // Present only when the product was applied WITHOUT its image. The UI reads
    // this to show an always-visible "applied without image — backfill needed"
    // notice, and a future backfill can query for rows whose apply summary has
    // imageUpload.status === 'skipped'.
    ...(imageSkip ? { imageUpload: imageSkip } : {}),
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
  options: { preserveIdentity: boolean; preservePrice?: boolean } = { preserveIdentity: false },
): Record<string, unknown> {
  const payload: Record<string, unknown> = { id: product.id }

  // Identity fields (name / shortName / tab / packOfSize / sizeId)
  // come from parser text and the reviewer's structured overrides.
  // When the reviewer forced a specific Sweed product id via the
  // link-override picker, the chosen variant is identity-authoritative
  // — we leave all of these as Sweed already has them. Apply still
  // updates the operational fields below (price, ecommerce visibility,
  // packed state) because those are orthogonal to identity and
  // continue to be the apply's responsibility.
  if (!options.preserveIdentity) {
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
    if ((product.packOfSize ?? 0) !== (row.targetPackCount ?? 1)) {
      payload.packOfSize = row.targetPackCount ?? 1
    }
    if ((product.size?.id ?? null) !== targetSizeId) {
      payload.sizeId = targetSizeId
    }
  }

  if (!options.preservePrice && typeof row.effectiveProposedPrice === 'number' && Math.abs((product.price ?? 0) - row.effectiveProposedPrice) >= 0.01) {
    payload.price = row.effectiveProposedPrice
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

  // Sweed's store.product.edit refuses to save cannabinoid-weight-based
  // categories (edibles, tinctures, topicals, oral & nasal) unless the
  // edit payload carries populated lab data for THC Total + CBD Total
  // (error: "Cannabinoid weight based product must contain populated
  // (value > 0) lab data for 'THC Total' and 'CBD Total' cannabinoids").
  // store.product.add already includes the same fields via
  // buildCannabinoidPayload; product.edit was historically constructed
  // without them and crashed when an existing edibles SKU was apply-
  // edited (job 133150 rows 379/380/381). Fold the same payload in so
  // edits succeed by default. We always include the keys (rather than
  // conditionally diffing) because Sweed treats absent and zero
  // differently here — absent triggers the validation error, zero is a
  // valid placeholder that satisfies the rule.
  const cannabinoidPayload = buildCannabinoidPayload(row)
  for (const [key, value] of Object.entries(cannabinoidPayload)) {
    payload[key] = value
  }

  return payload
}

function resolveCategoryContext(
  row: LoadedPendingPurchaseRow,
  dictionaries: StateDictionaries,
): {
  category: z.infer<typeof CategoryRowSchema>
  subcategory: z.infer<typeof NamedIdSchema> | null
  /**
   * Operator-visible note when the requested subcategory could not be
   * matched against Sweed's live taxonomy. The apply continues with
   * `subcategory: null` (a perfectly valid Sweed state) rather than
   * failing the whole row, but the note is surfaced in the apply
   * summary so the operator can either add the subcategory to Sweed
   * later or update the parser/teacher to stop proposing it.
   */
  subcategoryNote: string | null
} {
  const categoryName = requireNonEmptyString(row.expectedCategory, 'expected category')
  const category = dictionaries.categoriesByName.get(categoryName.toLowerCase())
  if (!category) {
    throw new Error(`Missing category \`${categoryName}\` in Sweed.`)
  }

  const requestedSubcategory = normalizeNullableString(row.expectedSubcategory)
  if (!requestedSubcategory) {
    return { category, subcategory: null, subcategoryNote: null }
  }

  const aliasKey = `${categoryName.toLowerCase()}:${requestedSubcategory.toLowerCase()}`
  // Explicit drop list: subcategories the operator has declared should
  // never be sent to Sweed even if a stale pending row still requests
  // them. Apply with subcategory: null silently — no degradation note,
  // because this is the *intended* shape, not a fallback.
  if (SUBCATEGORY_DROPS.has(aliasKey)) {
    return { category, subcategory: null, subcategoryNote: null }
  }
  const resolvedSubcategoryName = SUBCATEGORY_ALIASES.get(aliasKey) ?? requestedSubcategory
  const subcategory = category.subcategories.find((candidate) => candidate.name.toLowerCase() === resolvedSubcategoryName.toLowerCase()) ?? null
  if (!subcategory) {
    // Old behavior threw — that crashed the whole apply for the row
    // even when the rest of the row was perfectly valid. A bogus
    // subcategory (e.g. LLM teacher proposed "Gummies" for Edibles
    // when Sweed's Edibles category doesn't have a "Gummies"
    // subcategory) is not a structural failure; it is a refinement
    // that we should silently drop rather than fail over. The row's
    // apply summary calls out the dropped subcategory so an operator
    // can decide whether to add it to Sweed.
    const availableNames = category.subcategories.map((sc) => sc.name).filter((n) => n.length > 0)
    const availableHint = availableNames.length > 0
      ? `Available: ${availableNames.slice(0, 8).join(', ')}${availableNames.length > 8 ? ', …' : ''}.`
      : 'Sweed reports no subcategories under this category.'
    return {
      category,
      subcategory: null,
      subcategoryNote: `Requested subcategory "${requestedSubcategory}" does not exist under "${categoryName}" in Sweed; applied with no subcategory. ${availableHint}`,
    }
  }

  return { category, subcategory, subcategoryNote: null }
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

  let addResponse: unknown = null
  try {
    addResponse = await callSweedRpcForDealer(stateDealerId, 'store.product.strain.add', {
      name: normalizedName,
      prevalenceId: prevalence.id,
    })
  } catch {
    // strain.add failed — fall back to a list lookup. Useful for the
    // case where strain.add raced with a concurrent worker and a peer
    // already created the same strain (Sweed returns a duplicate-name
    // error in that case).
    const fallback = await findExactNamedRowWithRetry(
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

  // Primary path: strain.add returns the new row directly. We used to
  // discard the response and re-list, which lost rows whenever Sweed's
  // strain-list cache hadn't propagated yet (this was the recurring
  // "Unable to resolve strain `<name>` after create" failure on apply
  // jobs — e.g. job 133150 rows 371/372/374). Parse the response when
  // we can; fall back to a retrying list lookup if it isn't shaped
  // like a strain row.
  const parsedFromResponse = StrainRowSchema.safeParse(addResponse)
  if (parsedFromResponse.success) {
    dictionaries.strainsByName.set(parsedFromResponse.data.name.toLowerCase(), parsedFromResponse.data)
    return parsedFromResponse.data
  }
  const created = await findExactNamedRowWithRetry(
    stateDealerId,
    'store.product.strain.list',
    normalizedName,
    ListResponseSchema(StrainRowSchema),
  )
  if (!created) {
    throw new Error(`Unable to resolve strain \`${normalizedName}\` after create (response shape: ${typeof addResponse}; list lookup retries exhausted).`)
  }
  dictionaries.strainsByName.set(created.name.toLowerCase(), created)
  return created
}

// Retry an exact-name list lookup with short exponential backoff to
// paper over Sweed's read-after-write delay on dictionary endpoints
// (strain list, brand list, etc.). The strain.list endpoint in
// particular has been observed to lag a freshly-added strain by a
// few seconds, especially under load. Total wait ≈ 0.5 + 1 + 2 = 3.5s
// across 3 retries, well under any reasonable apply-row deadline.
async function findExactNamedRowWithRetry<T extends { id: number; name: string }>(
  stateDealerId: number,
  rpcMethod: string,
  name: string,
  schema: z.ZodType<T[]>,
): Promise<T | null> {
  const delaysMs = [0, 500, 1000, 2000]
  let lastResult: T | null = null
  for (const delayMs of delaysMs) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    lastResult = await findExactNamedRow(stateDealerId, rpcMethod, name, schema)
    if (lastResult) {
      return lastResult
    }
  }
  return lastResult
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

async function reconcileCheckpointedGroupProduct(
  stateDealerId: number,
  groupId: number,
  expected: { packOfSize: number; price: number; sizeId: number; tab: string },
): Promise<z.infer<typeof ProductSummarySchema> | null> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const group = ProductGroupDetailSchema.parse(
      await callSweedRpcForDealer(stateDealerId, 'store.product.group.get', { id: groupId }),
    )
    const matches = group.products.filter((candidate) =>
      candidate.packOfSize === expected.packOfSize
      && candidate.price === expected.price
      && candidate.size?.id === expected.sizeId
      && (candidate.tab ?? '') === expected.tab,
    )
    if (matches.length > 1) {
      throw new Error(`Checkpointed group ${groupId} contains multiple products matching the pending-purchase SKU.`)
    }
    if (matches.length === 1) return matches[0]!
    if (attempt < 9) await delay(400)
  }
  return null
}

async function persistCreatedSkuCheckpoint(
  rowId: number,
  requestId: number,
  ids: { createdAt: string; groupId?: number; phase: CreatedSkuCheckpoint['phase']; productId?: number },
): Promise<void> {
  const checkpoint = CreatedSkuCheckpointSchema.parse({
    appliedPrice: PENDING_PURCHASE_TEMPORARY_UNSELLABLE_PRICE,
    ...ids,
    repriceRequired: true,
    requestId,
    rowId,
  })
  const result = await getPool().query(
    `update pending_purchase_rows
     set last_apply_summary_json = jsonb_set(last_apply_summary_json, $3::text[], $4::jsonb, true),
         updated_at = now()
     where id = $1 and last_apply_request_id = $2`,
    [rowId, requestId, [CREATED_SKU_CHECKPOINT_KEY], JSON.stringify(checkpoint)],
  )
  if (result.rowCount !== 1) {
    throw new Error(`Pending-purchase row ${rowId} no longer matches apply request ${requestId}.`)
  }
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
  //
  // For the link-override (`targetReuseProductId`) we deliberately
  // use key-presence semantics (NOT `??`): an explicit `null` in the
  // JSONB clears the parser-proposed reuse, an absent key falls
  // through to the parser, a positive integer forces apply onto that
  // exact Sweed product. See LoadedPendingPurchaseRow.reuseProductId
  // / reuseProductIdOverridePresent for the contract apply consumes.
  const reuseOverridePresent = Object.prototype.hasOwnProperty.call(overrides, 'targetReuseProductId')
  const reuseOverrideValue = reuseOverridePresent ? overrides.targetReuseProductId ?? null : null
  const effectiveReuseProductId = reuseOverridePresent
    ? reuseOverrideValue
    : readOptionalInt(rawRow.reuseProductId)
  return {
    actionType: row.action_type,
    catalogAction: row.catalog_action,
    createdSkuCheckpoint: readCreatedSkuCheckpoint(row.last_apply_summary_json, row.id, row.last_apply_request_id),
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
    reuseProductId: effectiveReuseProductId,
    reuseProductIdOverridePresent: reuseOverridePresent,
    validatedReuseSnapshot: readValidatedReuseSnapshot(rawRow),
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
  // Reviewer-forced link to an existing Sweed product id. See the
  // LoadedPendingPurchaseRow.reuseProductId comment for the three-state
  // semantics (absent / positive int / explicit null).
  targetReuseProductId: number | null
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

async function readPendingPurchaseApplyRequestPacketId(
  db: Queryable,
  applyRequestId: number,
): Promise<number> {
  const result = await db.query<{ packet_id: number }>(
    'select packet_id from pending_purchase_apply_requests where id = $1',
    [applyRequestId],
  )
  const packetId = result.rows[0]?.packet_id
  if (!packetId) throw new Error(`Pending-purchase apply request ${applyRequestId} was not found.`)
  return packetId
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
            last_apply_summary_json = last_apply_summary_json || $3::jsonb,
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
            last_apply_summary_json = last_apply_summary_json || $5::jsonb,
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
  // How many rows went live but WITHOUT their image (non-fatal skip). Surfaced
  // in the request summary so a systemic image/blob outage that silently skips
  // every image cannot masquerade as a fully-clean apply.
  const imageSkippedRowCount = rowsResult.rows.filter((row) => summaryRowHasImageSkip(row.last_apply_summary_json)).length
  const status = mismatchedRowCount > 0
    ? 'failed'
    : deriveApplyRequestStatus({ appliedRowCount, blockedRowCount, failedRowCount, selectedRowCount })
  const baseSummaryText = mismatchedRowCount > 0
    ? `Pending-purchase apply failed integrity checks: expected ${selectedRowCount} selected rows but only found ${rowsResult.rows.length}.`
    : buildApplyRequestSummaryText({ appliedRowCount, blockedRowCount, failedRowCount, selectedRowCount, status })
  const summaryText = imageSkippedRowCount > 0
    ? `${baseSummaryText} ${imageSkippedRowCount} applied without an image; backfill needed.`
    : baseSummaryText

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
          imageSkippedRowCount,
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
            last_apply_summary_json = last_apply_summary_json
              || jsonb_build_object('status', 'failed', 'summaryText', $2),
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

// Classify a non-fatal image-attachment failure into the structured marker the
// UI and future backfill consume. `UnsupportedImageFormatError` (e.g. AVIF) is
// deterministic and unfixable by retry; everything else (source 4xx/network,
// Sweed blob upload failure) is bucketed as a generic upload failure.
function buildImageSkip(sourceUrl: string, error: unknown): AppliedImageSkip {
  const rawMessage = error instanceof Error && error.message ? error.message : 'Unknown image error.'
  const message = rawMessage.length > MAX_IMAGE_SKIP_MESSAGE_LENGTH
    ? `${rawMessage.slice(0, MAX_IMAGE_SKIP_MESSAGE_LENGTH - 1)}…`
    : rawMessage
  return {
    status: 'skipped',
    sourceUrl,
    reasonCode: error instanceof UnsupportedImageFormatError ? 'unsupported_format' : 'image_upload_failed',
    message,
  }
}

// True when a persisted row summary carries the structured "image skipped"
// marker (product applied without its image). Defensive JsonValue narrowing —
// no casts — because the summary is stored/loaded as raw JSON.
function summaryRowHasImageSkip(summary: JsonValue): boolean {
  if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) {
    return false
  }
  const imageUpload = summary.imageUpload
  if (imageUpload === undefined || imageUpload === null || typeof imageUpload !== 'object' || Array.isArray(imageUpload)) {
    return false
  }
  return imageUpload.status === 'skipped'
}

function readCreatedProductId(summary: JsonValue): number[] {
  if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) return []
  const checkpoint = CreatedSkuCheckpointSchema.safeParse(summary[CREATED_SKU_CHECKPOINT_KEY])
  if (checkpoint.success && checkpoint.data.productId) return [checkpoint.data.productId]
  const value = summary.createdProductId
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? [value] : []
}

function readCreatedSkuCheckpoint(summary: JsonValue, rowId: number, _requestId: number | null): CreatedSkuCheckpoint | null {
  if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) return null
  const parsed = CreatedSkuCheckpointSchema.safeParse(summary[CREATED_SKU_CHECKPOINT_KEY])
  if (!parsed.success) return null
  if (parsed.data.rowId !== rowId) return null
  return parsed.data
}

function buildAppliedRowSummary(
  row: LoadedPendingPurchaseRow,
  productId: number,
  verification: PendingPurchaseSuggestionVerification,
  degradations: readonly string[] = [],
): string {
  const head = `Applied pending-purchase row ${row.rowId} for ${row.targetVariantName} onto product ${productId}. ${verification.summaryText}`
  if (degradations.length === 0) {
    return head
  }
  // Surface non-fatal degradations (subcategory dropped, etc.) at the
  // end of the row summary so they're visible in the apply-result UI
  // without an operator having to dig through the per-row progress log.
  return `${head} Degradations: ${degradations.join('; ')}`
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

/**
 * Project the live Sweed product + group (read at apply time) into the
 * identity vocabulary the C7 drift guard compares against the validator's frozen
 * snapshot. Identity lanes only — operational fields the apply is allowed to
 * mutate (price, ecommerce visibility, sale type, packed state) are excluded.
 * `packCount` mirrors the generator's live-summary rule (a positive int, else
 * null → treated as single-pack by the guard) so a single-pack product never
 * falsely drifts.
 */
function buildLiveReuseFacts(
  product: z.infer<typeof ProductSummarySchema>,
  group: z.infer<typeof ProductGroupDetailSchema>,
): LiveReuseProductFacts {
  const packOfSize = product.packOfSize
  return {
    productId: product.id,
    productName: normalizeNullableString(product.name),
    groupId: product.productGroupId ? Number(product.productGroupId) : null,
    brand: normalizeNullableString(group.brand?.name),
    category: normalizeNullableString(group.category?.name),
    subcategory: normalizeNullableString(group.subcategory?.name),
    groupName: normalizeNullableString(group.name),
    variantTab: normalizeNullableString(product.tab),
    strain: normalizeNullableString(group.strain?.name),
    size: normalizeNullableString(product.size?.name),
    packCount: typeof packOfSize === 'number' && Number.isInteger(packOfSize) && packOfSize > 0 ? packOfSize : null,
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
