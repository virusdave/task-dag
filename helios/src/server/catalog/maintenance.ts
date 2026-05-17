/**
 * Catalog Image Maintenance — DB-backed survey + Sweed write helpers.
 *
 * The page under /catalog/maintenance surfaces two categories of catalog
 * gaps for in-stock SKUs:
 *
 *   1. groups that have at least one in-stock variant but zero
 *      product-catalog-level images
 *   2. groups with two or more in-stock variants but without an exhaustive
 *      per-variant image set (some variants only inherit the group image,
 *      or every variant shares the same single variant image)
 *
 * Read path:
 *   We do NOT crawl Sweed at page-render time. Both lists are derived
 *   entirely from Helios DB tables that other workers already keep
 *   fresh:
 *     - `catalog_groups.live_state_json`  (per-group + per-variant
 *       image refs, barcode, size, pack-of-size, brand/category/etc.)
 *     - `stock_variant_state`             (which in-stock products at
 *       which site, plus the most recent METRC tags observed there)
 *   A small in-memory cache keyed by query parameters keeps the
 *   per-render cost negligible. `?refresh=1` and successful writes
 *   both invalidate the cache.
 *
 * Write path:
 *   Uploads / barcode edits still need Sweed. We open one locked
 *   write batch per operation, pin the Sweed dealer context exactly
 *   once at the top (then skip redundant `store.auth.dealer.set`
 *   calls), push the new image blob, attach it, and on success:
 *     - invalidate the in-memory survey cache
 *     - flag the affected catalog_group as `needs_reanalysis` and
 *       enqueue a forced `catalog.sync.group_detail` job so the
 *       worker pulls fresh live state into `live_state_json` ASAP
 *   The route returns the freshly-uploaded blob URL so the client can
 *   optimistically render it without waiting for the worker.
 */

import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import {
  buildCatalogGroupModuleScope,
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type CatalogMaintenanceGroup,
  type CatalogMaintenanceListResponse,
  type CatalogMaintenanceSurveyMeta,
  type CatalogMaintenanceVariant,
  type HeliosPendingPurchaseSiteDealer,
} from '../../shared/contracts/index.js'
import {
  NormalizedCatalogGroupLiveStateSchema,
  type NormalizedCatalogGroupLiveState,
  type NormalizedCatalogImageRef,
  type NormalizedCatalogProductLiveState,
} from '../../worker/catalog/liveState.js'
import { getServerEnv } from '../config/env.js'
import { getPool, type Queryable } from '../db/pool.js'
import { enqueueJob } from '../jobs/enqueueJob.js'
import {
  SWEED_SESSION_CONCURRENCY_KEY,
  getOptionalSweedSessionConcurrencyKey,
} from '../jobs/concurrency.js'

const SURVEY_TTL_MS = 60 * 1000
const SWEED_REQUEST_TIMEOUT_MS = 30_000
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])

const RpcEnvelopeSchema = z.object({
  error: z.object({ message: z.string().nullable().optional() }).optional(),
  result: z.unknown().optional(),
})

const DealerSetResultSchema = z.object({
  user: z.object({
    currentDealerId: z.coerce.number().int(),
    currentDealerName: z.string().nullable().optional(),
  }),
})

const SweedImageRefSchema = z
  .object({
    id: z.union([z.coerce.number().int(), z.string().trim().min(1)]).nullable().optional(),
    url: z.string().nullable().optional(),
  })
  .passthrough()

const SweedProductImagesSchema = z
  .object({
    id: z.coerce.number().int(),
    externalBarcode: z.string().nullable().optional(),
    images: z.array(SweedImageRefSchema).default([]),
  })
  .passthrough()

const SweedProductDetailWrappedImagesSchema = z
  .object({ product: SweedProductImagesSchema })
  .passthrough()
  .transform((value) => value.product)

const SweedProductImagesDetailSchema = z.union([
  SweedProductDetailWrappedImagesSchema,
  SweedProductImagesSchema,
])

const SweedGroupImagesSchema = z
  .object({
    id: z.coerce.number().int(),
    images: z.array(SweedImageRefSchema).default([]),
  })
  .passthrough()

interface SurveyResult {
  missingGroupImage: CatalogMaintenanceGroup[]
  missingVariantImages: CatalogMaintenanceGroup[]
  meta: CatalogMaintenanceSurveyMeta
}

interface CachedSurvey {
  expiresAt: number
  value: SurveyResult
}

let cachedSurvey: CachedSurvey | null = null
let inFlightSurvey: Promise<SurveyResult> | null = null
let sweedWriteQueue: Promise<void> = Promise.resolve()
let sweedWriteDealerId: number | null = null

export interface MaintenanceSurveyOptions {
  forceRefresh?: boolean
}

export type MaintenanceSurveyList = 'missing-group-images' | 'missing-variant-images'

export async function loadCatalogMaintenanceList(
  kind: MaintenanceSurveyList,
  options: MaintenanceSurveyOptions = {},
): Promise<CatalogMaintenanceListResponse> {
  const survey = await loadCatalogMaintenanceSurvey(options)
  const groups = kind === 'missing-group-images' ? survey.missingGroupImage : survey.missingVariantImages
  return { meta: survey.meta, groups }
}

export async function invalidateCatalogMaintenanceSurvey(): Promise<void> {
  cachedSurvey = null
}

export async function loadCatalogMaintenanceSurvey(
  options: MaintenanceSurveyOptions = {},
): Promise<SurveyResult> {
  const now = Date.now()
  if (!options.forceRefresh && cachedSurvey && cachedSurvey.expiresAt > now) {
    return cachedSurvey.value
  }
  if (inFlightSurvey) {
    return inFlightSurvey
  }

  inFlightSurvey = (async () => {
    try {
      const result = await buildSurveyFromDb()
      cachedSurvey = {
        expiresAt: Date.now() + SURVEY_TTL_MS,
        value: result,
      }
      return result
    } finally {
      inFlightSurvey = null
    }
  })()

  return inFlightSurvey
}

/* -------------------------------------------------------------------------- */
/*  Survey: read entirely from cached DB tables.                              */
/* -------------------------------------------------------------------------- */

interface CatalogGroupRow {
  id: number
  sweed_group_id: number
  group_name: string | null
  brand_name: string | null
  category_name: string | null
  subcategory_name: string | null
  live_state_json: unknown
  last_synced_at: Date | null
  needs_reanalysis_at: Date | null
}

interface StockRow {
  site_dealer_id: number
  product_id: number
  metrc_tags_json: unknown
}

async function buildSurveyFromDb(): Promise<SurveyResult> {
  const db = getPool()
  const warnings: string[] = []
  const scannedDealerIds: number[] = HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) => site.dealerId)

  const [groupsResult, stockResult] = await Promise.all([
    db.query<CatalogGroupRow>(
      `
        select
          id,
          sweed_group_id,
          group_name,
          brand_name,
          category_name,
          subcategory_name,
          live_state_json,
          last_synced_at,
          needs_reanalysis_at
        from catalog_groups
        where deleted_at is null
      `,
    ),
    db.query<StockRow>(
      `
        select site_dealer_id, product_id, metrc_tags_json
        from stock_variant_state
        where is_on_stock = true
          and site_dealer_id = any($1::bigint[])
      `,
      [scannedDealerIds],
    ),
  ])

  const inStockByProductId = new Map<number, { siteKeys: Set<string>; metrcTags: Set<string> }>()
  const siteKeyByDealerId = new Map<number, string>()
  for (const site of HELIOS_PENDING_PURCHASE_SITE_DEALERS) {
    siteKeyByDealerId.set(site.dealerId, site.siteKey)
  }

  for (const stockRow of stockResult.rows) {
    const siteKey = siteKeyByDealerId.get(stockRow.site_dealer_id)
    if (!siteKey) {
      continue
    }
    let bucket = inStockByProductId.get(stockRow.product_id)
    if (!bucket) {
      bucket = { siteKeys: new Set(), metrcTags: new Set() }
      inStockByProductId.set(stockRow.product_id, bucket)
    }
    bucket.siteKeys.add(siteKey)
    for (const tag of parseMetrcTagsJson(stockRow.metrc_tags_json)) {
      bucket.metrcTags.add(tag)
    }
  }

  let oldestSyncedAt: Date | null = null
  let totalInStockVariants = 0
  let totalUniqueGroups = 0
  const matchedProductIds = new Set<number>()
  const reanalyzingGroupNames: string[] = []

  const missingGroupImage: CatalogMaintenanceGroup[] = []
  const missingVariantImages: CatalogMaintenanceGroup[] = []

  for (const row of groupsResult.rows) {
    const parsed = safeParseLiveState(row.live_state_json)
    if (!parsed) {
      warnings.push(`Skipping group ${row.id} (${row.group_name ?? 'unnamed'}): live_state_json failed to parse.`)
      continue
    }

    if (row.last_synced_at !== null) {
      if (oldestSyncedAt === null || row.last_synced_at.getTime() < oldestSyncedAt.getTime()) {
        oldestSyncedAt = row.last_synced_at
      }
    }

    const liveState = parsed
    const inStockVariantEntries: Array<{
      product: NormalizedCatalogProductLiveState
      siteKeys: string[]
      metrcTags: string[]
    }> = []

    for (const product of liveState.products) {
      const stock = inStockByProductId.get(product.productId)
      if (!stock) {
        continue
      }
      matchedProductIds.add(product.productId)
      inStockVariantEntries.push({
        product,
        siteKeys: [...stock.siteKeys].sort(),
        metrcTags: [...stock.metrcTags].sort(),
      })
    }

    if (inStockVariantEntries.length === 0) {
      continue
    }

    totalInStockVariants += inStockVariantEntries.length
    totalUniqueGroups += 1

    const summary = buildGroupSummary({
      catalogGroupId: row.id,
      sweedGroupId: row.sweed_group_id,
      groupName: row.group_name ?? liveState.groupName,
      brandName: row.brand_name,
      categoryName: row.category_name,
      subcategoryName: row.subcategory_name,
      liveState,
      inStockEntries: inStockVariantEntries,
      needsReanalysis: row.needs_reanalysis_at !== null,
    })

    if (row.needs_reanalysis_at !== null) {
      reanalyzingGroupNames.push(summary.groupName ?? `Group #${summary.groupId}`)
    }

    if (summary.groupImageCount === 0) {
      missingGroupImage.push(summary)
      continue
    }

    if (summary.inStockVariantCount >= 2) {
      const variantsWithOwnImage = summary.variants.filter((variant) => variant.variantSpecificImageCount > 0)
      const distinctVariantImageSignatures = new Set(
        summary.variants.map((variant) => variant.previewImageUrl ?? `id:${variant.productId}`),
      )
      if (
        variantsWithOwnImage.length < summary.inStockVariantCount ||
        distinctVariantImageSignatures.size < summary.inStockVariantCount
      ) {
        missingVariantImages.push(summary)
      }
    }
  }

  const unmatchedProductIds: number[] = []
  for (const productId of inStockByProductId.keys()) {
    if (!matchedProductIds.has(productId)) {
      unmatchedProductIds.push(productId)
    }
  }
  if (unmatchedProductIds.length > 0) {
    const sample = unmatchedProductIds.slice(0, 5).join(', ')
    warnings.push(
      `${unmatchedProductIds.length} in-stock variants were skipped because no cached catalog_groups row contains them (sample productIds: ${sample}).`,
    )
  }
  if (reanalyzingGroupNames.length > 0) {
    const sample = reanalyzingGroupNames.slice(0, 5).join(', ')
    warnings.push(
      `${reanalyzingGroupNames.length} group${reanalyzingGroupNames.length === 1 ? ' is' : 's are'} pending worker reanalysis after a recent edit (sample: ${sample}).`,
    )
  }

  missingGroupImage.sort(compareGroupForUi)
  missingVariantImages.sort(compareGroupForUi)

  const generatedAtMs = oldestSyncedAt?.getTime() ?? Date.now()
  const meta: CatalogMaintenanceSurveyMeta = {
    generatedAt: new Date(generatedAtMs).toISOString(),
    expiresAt: new Date(Date.now() + SURVEY_TTL_MS).toISOString(),
    scannedDealerIds,
    totalInStockVariants,
    totalUniqueGroups,
    warnings,
  }

  return { missingGroupImage, missingVariantImages, meta }
}

function safeParseLiveState(value: unknown): NormalizedCatalogGroupLiveState | null {
  const result = NormalizedCatalogGroupLiveStateSchema.safeParse(value)
  return result.success ? result.data : null
}

function parseMetrcTagsJson(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const tags: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      const trimmed = entry.trim()
      if (trimmed.length > 0) {
        tags.push(trimmed)
      }
    }
  }
  return tags
}

interface GroupSummaryInput {
  catalogGroupId: number
  sweedGroupId: number
  groupName: string | null
  brandName: string | null
  categoryName: string | null
  subcategoryName: string | null
  liveState: NormalizedCatalogGroupLiveState
  inStockEntries: Array<{
    product: NormalizedCatalogProductLiveState
    siteKeys: string[]
    metrcTags: string[]
  }>
  needsReanalysis: boolean
}

function buildGroupSummary(input: GroupSummaryInput): CatalogMaintenanceGroup {
  const groupImages = input.liveState.images
  const groupImageIds = new Set(
    groupImages.map((image) => image.id).filter((id): id is string => id !== null),
  )
  const groupImageUrls = new Set(
    groupImages.map((image) => image.url).filter((url): url is string => url !== null),
  )

  const variants: CatalogMaintenanceVariant[] = []
  const allSiteKeys = new Set<string>()
  for (const entry of input.inStockEntries) {
    for (const siteKey of entry.siteKeys) {
      allSiteKeys.add(siteKey)
    }
    const ownImages = entry.product.images
    const variantSpecificImageCount = ownImages.filter((image) => {
      if (image.id !== null && groupImageIds.has(image.id)) {
        return false
      }
      if (image.id === null && image.url !== null && groupImageUrls.has(image.url)) {
        return false
      }
      return true
    }).length

    variants.push({
      productId: entry.product.productId,
      name: entry.product.name,
      shortName: entry.product.shortName,
      tab: entry.product.tab,
      packOfSize: entry.product.packOfSize,
      sizeName: entry.product.sizeName,
      inStockSites: entry.siteKeys,
      imageCount: ownImages.length > 0 ? ownImages.length : groupImages.length,
      variantSpecificImageCount,
      previewImageUrl: pickPreviewUrl(ownImages) ?? pickPreviewUrl(groupImages) ?? entry.product.imageUrl,
      metrcTags: entry.metrcTags,
      externalBarcode: entry.product.externalBarcode,
    })
  }

  variants.sort((left, right) => {
    const leftKey = `${left.tab ?? ''}|${left.packOfSize ?? 0}|${left.sizeName ?? ''}|${left.name ?? ''}`
    const rightKey = `${right.tab ?? ''}|${right.packOfSize ?? 0}|${right.sizeName ?? ''}|${right.name ?? ''}`
    return leftKey.localeCompare(rightKey)
  })

  return {
    groupId: input.sweedGroupId,
    groupName: input.groupName ?? input.liveState.groupName,
    brandName: input.brandName ?? input.liveState.brand,
    categoryName: input.categoryName ?? input.liveState.category,
    subcategoryName: input.subcategoryName ?? input.liveState.subcategory,
    groupImageCount: groupImages.length,
    groupPreviewImageUrl: pickPreviewUrl(groupImages) ?? input.liveState.imageUrl,
    inStockSites: [...allSiteKeys].sort(),
    inStockVariantCount: input.inStockEntries.length,
    totalVariantCount: input.liveState.products.length,
    variants,
  }
}

function compareGroupForUi(left: CatalogMaintenanceGroup, right: CatalogMaintenanceGroup): number {
  const leftKey = `${left.brandName ?? ''}|${left.groupName ?? ''}|${left.groupId}`
  const rightKey = `${right.brandName ?? ''}|${right.groupName ?? ''}|${right.groupId}`
  return leftKey.localeCompare(rightKey)
}

function pickPreviewUrl(images: NormalizedCatalogImageRef[]): string | null {
  for (const image of images) {
    if (typeof image.url === 'string' && image.url.length > 0) {
      return image.url
    }
  }
  return null
}

/* -------------------------------------------------------------------------- */
/*  Image upload — accept multipart bytes, push to Sweed blob, then attach.   */
/* -------------------------------------------------------------------------- */

export interface UploadInput {
  fileBytes: Uint8Array
  contentType: string
  targetType: 'group' | 'variants'
  groupId: number
  productIds: number[]
  requestedByUserId: number | null
}

export interface UploadResult {
  uploadedBlobId: string
  blobUrl: string | null
  affectedProductIds: number[]
  reanalysisJobId: number | null
}

export async function uploadCatalogMaintenanceImage(input: UploadInput): Promise<UploadResult> {
  if (input.fileBytes.byteLength === 0) {
    throw new HttpError(400, 'Upload payload is empty.')
  }
  if (input.fileBytes.byteLength > MAX_IMAGE_BYTES) {
    throw new HttpError(413, `Image exceeds ${MAX_IMAGE_BYTES} bytes.`)
  }
  if (!ALLOWED_IMAGE_MIME_TYPES.has(input.contentType.toLowerCase())) {
    throw new HttpError(415, `Unsupported content type ${input.contentType}.`)
  }
  if (input.targetType === 'variants' && input.productIds.length === 0) {
    throw new HttpError(400, 'At least one variant must be selected for variant uploads.')
  }

  const result = await runInSweedWriteBatch(async () => {
    const stateDealerId = getServerEnv().sweedStateDealerId
    await ensureDealerContext(stateDealerId)

    const blobId = await createBlob(stateDealerId)
    await putBlobBytes(blobId, input.fileBytes, input.contentType)

    if (input.targetType === 'group') {
      const group = await fetchGroupImagesWithinLock(input.groupId)
      const existingImageIds = collectExistingImageIds(group.images)
      const nextImageIds = appendUnique(existingImageIds, blobId)
      await callSweedRpcForDealer(stateDealerId, 'store.product.group.edit', {
        id: input.groupId,
        imagesIds: nextImageIds,
      })
      const refreshed = await fetchGroupImagesWithinLock(input.groupId)
      const blobUrl = pickRawPreviewUrl(refreshed.images.filter((image) => normalizeImageId(image) === blobId))
      return { uploadedBlobId: blobId, blobUrl, affectedProductIds: [] }
    }

    const affectedProductIds: number[] = []
    let blobUrl: string | null = null
    for (const productId of input.productIds) {
      const product = await fetchProductImagesWithinLock(productId)
      const existingImageIds = collectExistingImageIds(product.images)
      const nextImageIds = appendUnique(existingImageIds, blobId)
      await callSweedRpcForDealer(stateDealerId, 'store.product.edit', {
        id: productId,
        imagesIds: nextImageIds,
      })
      affectedProductIds.push(productId)
      if (blobUrl === null) {
        const refreshed = await fetchProductImagesWithinLock(productId)
        blobUrl = pickRawPreviewUrl(refreshed.images.filter((image) => normalizeImageId(image) === blobId))
      }
    }
    return { uploadedBlobId: blobId, blobUrl, affectedProductIds }
  })

  const reanalysisJobId = await flagSweedGroupForReanalysis({
    sweedGroupId: input.groupId,
    reason:
      input.targetType === 'group'
        ? 'catalog_maintenance_group_image_upload'
        : 'catalog_maintenance_variant_image_upload',
    requestedByUserId: input.requestedByUserId,
  })

  await invalidateCatalogMaintenanceSurvey()

  return { ...result, reanalysisJobId }
}

export interface UpdateBarcodeInput {
  productId: number
  externalBarcode: string
  sweedGroupId: number
  requestedByUserId: number | null
}

export interface UpdateBarcodeResult {
  productId: number
  externalBarcode: string
  reanalysisJobId: number | null
}

export async function updateVariantBarcode(input: UpdateBarcodeInput): Promise<UpdateBarcodeResult> {
  const normalized = input.externalBarcode.trim()
  if (normalized.length === 0) {
    throw new HttpError(400, 'externalBarcode must be non-empty.')
  }
  const result = await runInSweedWriteBatch(async () => {
    const stateDealerId = getServerEnv().sweedStateDealerId
    await ensureDealerContext(stateDealerId)
    await callSweedRpcForDealer(stateDealerId, 'store.product.edit', {
      id: input.productId,
      externalBarcode: normalized,
    })
    const refreshed = await fetchProductImagesWithinLock(input.productId)
    return {
      productId: input.productId,
      externalBarcode: nonEmptyString(refreshed.externalBarcode) ?? normalized,
    }
  })

  const reanalysisJobId = await flagSweedGroupForReanalysis({
    sweedGroupId: input.sweedGroupId,
    reason: 'catalog_maintenance_barcode_edit',
    requestedByUserId: input.requestedByUserId,
  })

  await invalidateCatalogMaintenanceSurvey()
  return { ...result, reanalysisJobId }
}

async function fetchGroupImagesWithinLock(groupId: number): Promise<z.infer<typeof SweedGroupImagesSchema>> {
  const stateDealerId = getServerEnv().sweedStateDealerId
  const raw = await callSweedRpcForDealer(stateDealerId, 'store.product.group.get', { id: groupId })
  return SweedGroupImagesSchema.parse(raw)
}

async function fetchProductImagesWithinLock(productId: number): Promise<z.infer<typeof SweedProductImagesSchema>> {
  const stateDealerId = getServerEnv().sweedStateDealerId
  const raw = await callSweedRpcForDealer(stateDealerId, 'store.product.get', { id: String(productId) })
  return SweedProductImagesDetailSchema.parse(raw)
}

function collectExistingImageIds(images: Array<z.infer<typeof SweedImageRefSchema>>): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const image of images) {
    const id = normalizeImageId(image)
    if (id === null || seen.has(id)) {
      continue
    }
    seen.add(id)
    ids.push(id)
  }
  return ids
}

function appendUnique(existing: string[], blobId: string): string[] {
  const filtered = existing.filter((id) => id !== blobId)
  filtered.push(blobId)
  return filtered
}

async function createBlob(stateDealerId: number): Promise<string> {
  const raw = await callSweedRpcForDealer(stateDealerId, 'store.blob.add', { type: 'banner' })
  return z
    .union([
      z.string().trim().min(1),
      z
        .object({ id: z.string().trim().min(1) })
        .passthrough()
        .transform((value) => value.id),
    ])
    .parse(raw)
}

async function putBlobBytes(blobId: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const response = await fetch(`https://prime.sweedpos.com/api/blobs/upload/${blobId}`, {
    body: bytes,
    headers: {
      'content-type': contentType,
      'user-agent': 'helios-server/1.0',
    },
    method: 'PUT',
    signal: AbortSignal.timeout(SWEED_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`Blob upload failed for ${blobId}: HTTP ${response.status}.`)
  }
}

function pickRawPreviewUrl(images: Array<z.infer<typeof SweedImageRefSchema>>): string | null {
  for (const image of images) {
    if (typeof image.url === 'string' && image.url.length > 0) {
      return image.url
    }
  }
  return null
}

function normalizeImageId(image: z.infer<typeof SweedImageRefSchema>): string | null {
  if (image.id === undefined || image.id === null) {
    return null
  }
  return String(image.id)
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/* -------------------------------------------------------------------------- */
/*  Post-write reanalysis: flag DB row + enqueue forced sync job.             */
/* -------------------------------------------------------------------------- */

interface FlagForReanalysisInput {
  sweedGroupId: number
  reason: string
  requestedByUserId: number | null
}

async function flagSweedGroupForReanalysis(input: FlagForReanalysisInput): Promise<number | null> {
  const db: Queryable = getPool()
  const lookup = await db.query<{ id: number }>(
    `select id from catalog_groups where sweed_group_id = $1 and deleted_at is null limit 1`,
    [input.sweedGroupId],
  )
  const catalogGroupId = lookup.rows[0]?.id ?? null
  if (catalogGroupId === null) {
    // No cached catalog_groups row for this Sweed group yet (e.g. brand-new
    // group that hasn't been picked up by the review packet importer).
    // Nothing to flag; the next stock-refresh cycle will surface it.
    return null
  }

  await db.query(
    `
      update catalog_groups
      set needs_reanalysis_at = now(),
          needs_reanalysis_reason = $2,
          updated_at = now()
      where id = $1
    `,
    [catalogGroupId, input.reason],
  )

  const scope = buildCatalogGroupModuleScope(catalogGroupId)
  return enqueueJob(db, {
    concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
    dedupeKey: `catalog.sync.group_detail:${catalogGroupId}`,
    jobType: 'catalog.sync.group_detail',
    module: 'catalog',
    payload: {
      catalogGroupId,
      forceLiveRefresh: true,
      requestedByUserId: input.requestedByUserId,
      trigger: 'catalog_maintenance_edit',
    },
    requestedByUserId: input.requestedByUserId,
    scope,
  })
}

/* -------------------------------------------------------------------------- */
/*  Sweed RPC plumbing — module-local write queue with sticky dealer cache.    */
/* -------------------------------------------------------------------------- */

async function callSweedRpcForDealer<TResult>(
  dealerId: number,
  name: string,
  params: Record<string, unknown>,
): Promise<TResult> {
  await ensureDealerContext(dealerId)
  return callSweedRpcRaw(name, params)
}

async function ensureDealerContext(dealerId: number): Promise<void> {
  // The write queue (`runInSweedWriteBatch`) guarantees we're the only
  // caller using this shared Sweed auth token right now, so a previously
  // pinned dealerId is still in effect on Sweed's side. Skip the redundant
  // `store.auth.dealer.set` round-trip on the hot path.
  if (sweedWriteDealerId === dealerId) {
    return
  }
  const result = DealerSetResultSchema.parse(await callSweedRpcRaw('store.auth.dealer.set', { dealerId }))
  if (result.user.currentDealerId !== dealerId) {
    sweedWriteDealerId = null
    throw new Error(
      `Sweed dealer context mismatch. Expected ${dealerId}, got ${result.user.currentDealerId} ${result.user.currentDealerName ?? ''}`.trim(),
    )
  }
  sweedWriteDealerId = dealerId
}

async function callSweedRpcRaw<TResult>(name: string, params?: Record<string, unknown>): Promise<TResult> {
  const env = getServerEnv()
  if (!env.sweedAuthToken) {
    throw new Error('SWEED_AUTH_TOKEN is required for catalog maintenance.')
  }

  const response = await fetch(env.sweedApiUrl, {
    body: JSON.stringify({
      auth: env.sweedAuthToken,
      id: randomUUID(),
      name,
      ...(params === undefined ? {} : { params }),
    }),
    headers: {
      'content-type': 'application/json',
      'user-agent': 'helios-server/1.0',
    },
    method: 'POST',
    signal: AbortSignal.timeout(SWEED_REQUEST_TIMEOUT_MS),
  })

  const responseText = await response.text()
  if (!response.ok) {
    throw new Error(`${name} returned HTTP ${response.status}: ${truncate(responseText)}`)
  }

  const envelope = RpcEnvelopeSchema.parse(JSON.parse(responseText))
  if (envelope.error) {
    throw new Error(`${name} failed: ${envelope.error.message ?? 'Unknown Sweed RPC error.'}`)
  }
  if (envelope.result === undefined) {
    throw new Error(`${name} returned no result payload.`)
  }
  return envelope.result as TResult
}

/**
 * Serialize Sweed write operations behind a shared queue so the
 * sticky `sweedWriteDealerId` short-circuit in `ensureDealerContext`
 * remains coherent: while one batch is running, no other batch is
 * allowed to switch the shared SWEED_AUTH_TOKEN's dealer context out
 * from under it. On any thrown error we forget the cached dealer id
 * so the next batch defensively re-pins it.
 */
function runInSweedWriteBatch<T>(operation: () => Promise<T>): Promise<T> {
  const run = sweedWriteQueue.then(operation, operation)
  sweedWriteQueue = run.then(
    () => undefined,
    () => {
      sweedWriteDealerId = null
      return undefined
    },
  )
  return run
}

function truncate(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 240) {
    return normalized
  }
  return `${normalized.slice(0, 239)}…`
}

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// Re-export for legacy callers that imported the concurrency key from
// this module before the maintenance flow grew its own write queue.
export const _SWEED_WRITE_CONCURRENCY_KEY = SWEED_SESSION_CONCURRENCY_KEY
