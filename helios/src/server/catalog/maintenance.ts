/**
 * Catalog Image Maintenance — server-side survey + upload helpers.
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
 * The operator fixes them by uploading or capturing a photo on the spot,
 * which is attached either to the Sweed group or to a specific set of its
 * variants via `store.product.group.edit` / `store.product.edit` (with the
 * `imagesIds` field).
 *
 * We hit Sweed live and cache the survey in process for 10 minutes; uploads
 * invalidate the cache immediately so the fixed candidate disappears on the
 * next refresh.
 */

import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type CatalogMaintenanceGroup,
  type CatalogMaintenanceListResponse,
  type CatalogMaintenanceSurveyMeta,
  type CatalogMaintenanceVariant,
  type HeliosPendingPurchaseSiteDealer,
} from '../../shared/contracts/index.js'
import { getServerEnv } from '../config/env.js'

const SURVEY_TTL_MS = 10 * 60 * 1000
const GROUPED_INVENTORY_PAGE_SIZE = 200
const SWEED_REQUEST_TIMEOUT_MS = 30_000
const GROUP_FETCH_CONCURRENCY = 6
const PRODUCT_FETCH_CONCURRENCY = 8
const VARIANT_FETCH_CONCURRENCY = 6
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

const SweedImageSchema = z
  .object({
    id: z.union([z.coerce.number().int(), z.string().trim().min(1)]).nullable().optional(),
    url: z.string().nullable().optional(),
  })
  .passthrough()

const SweedNamedRefSchema = z
  .object({
    id: z.coerce.number().int().nullable().optional(),
    name: z.string().nullable().optional(),
  })
  .passthrough()

const SweedProductSchema = z
  .object({
    id: z.coerce.number().int(),
    name: z.string().nullable().optional(),
    shortName: z.string().nullable().optional(),
    tab: z.string().nullable().optional(),
    packOfSize: z.coerce.number().int().nullable().optional(),
    size: SweedNamedRefSchema.nullable().optional(),
    productGroupId: z.union([z.coerce.number().int(), z.string().trim().min(1)]).nullable().optional(),
    images: z.array(SweedImageSchema).default([]),
    groupImages: z.array(SweedImageSchema).default([]),
  })
  .passthrough()

const SweedProductDetailWrappedSchema = z
  .object({ product: SweedProductSchema })
  .passthrough()
  .transform((value) => value.product)

const SweedProductDetailSchema = z.union([SweedProductDetailWrappedSchema, SweedProductSchema])

const SweedGroupSchema = z
  .object({
    id: z.coerce.number().int(),
    name: z.string().nullable().optional(),
    brand: SweedNamedRefSchema.nullable().optional(),
    category: SweedNamedRefSchema.nullable().optional(),
    subcategory: SweedNamedRefSchema.nullable().optional(),
    images: z.array(SweedImageSchema).default([]),
    products: z.array(SweedProductSchema).default([]),
  })
  .passthrough()

const GroupedInventoryResponseSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            product: z
              .object({
                id: z.coerce.number().int().positive().optional(),
                name: z.string().nullable().optional(),
                shortName: z.string().nullable().optional(),
                productGroupId: z
                  .union([z.coerce.number().int(), z.string().trim().min(1)])
                  .nullable()
                  .optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .default([]),
    totalCount: z.coerce.number().int().min(0).optional(),
  })
  .passthrough()

type SweedImage = z.infer<typeof SweedImageSchema>
type SweedProduct = z.infer<typeof SweedProductSchema>
type SweedGroup = z.infer<typeof SweedGroupSchema>

interface InStockVariantSeed {
  productId: number
  productGroupId: number | null
  name: string | null
  shortName: string | null
  siteKeys: Set<string>
}

interface ResolvedVariant {
  productId: number
  groupId: number
  name: string | null
  shortName: string | null
  siteKeys: Set<string>
}

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
let sweedSessionQueue: Promise<void> = Promise.resolve()

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
      const result = await buildSurvey()
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

async function buildSurvey(): Promise<SurveyResult> {
  return withSweedSessionLockReturning(async () => buildSurveyWithinLock())
}

async function buildSurveyWithinLock(): Promise<SurveyResult> {
  const warnings: string[] = []
  const scannedDealerIds: number[] = []
  const variantSeeds = new Map<number, InStockVariantSeed>()

  {
    for (const site of HELIOS_PENDING_PURCHASE_SITE_DEALERS) {
      scannedDealerIds.push(site.dealerId)
      await collectInStockVariantsForSite(site, variantSeeds)
    }

    // Variants whose grouped-inventory row did not surface productGroupId
    // require a one-off store.product.get to discover it.
    const variantsNeedingGroupId = [...variantSeeds.values()].filter(
      (seed) => seed.productGroupId === null,
    )
    if (variantsNeedingGroupId.length > 0) {
      await runWithConcurrency(variantsNeedingGroupId, PRODUCT_FETCH_CONCURRENCY, async (seed) => {
        try {
          const product = await fetchProductDetail(seed.productId)
          const numericGroupId = coerceOptionalInt(product.productGroupId)
          if (numericGroupId !== null) {
            seed.productGroupId = numericGroupId
          }
        } catch (error) {
          warnings.push(
            `Failed to resolve productGroupId for product ${seed.productId}: ${describeError(error)}`,
          )
        }
      })
    }

    const resolvedByGroup = new Map<number, ResolvedVariant[]>()
    for (const seed of variantSeeds.values()) {
      if (seed.productGroupId === null) {
        continue
      }
      const groupId = seed.productGroupId
      const bucket = resolvedByGroup.get(groupId) ?? []
      bucket.push({
        productId: seed.productId,
        groupId,
        name: seed.name,
        shortName: seed.shortName,
        siteKeys: seed.siteKeys,
      })
      resolvedByGroup.set(groupId, bucket)
    }

    const groupIds = [...resolvedByGroup.keys()].sort((left, right) => left - right)
    const fetchedGroups = new Map<number, SweedGroup>()

    await runWithConcurrency(groupIds, GROUP_FETCH_CONCURRENCY, async (groupId) => {
      try {
        const group = await fetchGroupDetail(groupId)
        fetchedGroups.set(groupId, group)
      } catch (error) {
        warnings.push(`Failed to fetch group ${groupId}: ${describeError(error)}`)
      }
    })

    // For variant-level analysis we need to know which images live on the
    // variant itself vs. inherited from the group. The grouped products
    // embedded in store.product.group.get may or may not include the
    // images array; when missing or empty we fall back to per-variant
    // fetches but only for groups that look like candidates for the
    // "missing exhaustive variant images" list.
    const variantDetailsNeeded: number[] = []
    for (const [groupId, variants] of resolvedByGroup) {
      if (variants.length < 2) {
        continue
      }
      const group = fetchedGroups.get(groupId)
      if (!group) {
        continue
      }
      for (const variant of variants) {
        const embedded = group.products.find((entry) => entry.id === variant.productId)
        const hasImagesField =
          embedded !== undefined && (embedded.images.length > 0 || embedded.groupImages.length > 0)
        if (!embedded || !hasImagesField) {
          variantDetailsNeeded.push(variant.productId)
        }
      }
    }

    const variantDetailMap = new Map<number, SweedProduct>()
    if (variantDetailsNeeded.length > 0) {
      await runWithConcurrency(variantDetailsNeeded, VARIANT_FETCH_CONCURRENCY, async (productId) => {
        try {
          const product = await fetchProductDetail(productId)
          variantDetailMap.set(productId, product)
        } catch (error) {
          warnings.push(`Failed to fetch variant ${productId}: ${describeError(error)}`)
        }
      })
    }

    const missingGroupImage: CatalogMaintenanceGroup[] = []
    const missingVariantImages: CatalogMaintenanceGroup[] = []

    for (const groupId of groupIds) {
      const group = fetchedGroups.get(groupId)
      if (!group) {
        continue
      }
      const inStockVariants = resolvedByGroup.get(groupId) ?? []
      const summary = buildGroupSummary(group, inStockVariants, variantDetailMap)

      if (summary.groupImageCount === 0) {
        missingGroupImage.push(summary)
        continue
      }

      if (inStockVariants.length >= 2) {
        const variantsWithOwnImage = summary.variants.filter((variant) => variant.variantSpecificImageCount > 0)
        const distinctVariantImageSignatures = new Set(
          summary.variants.map((variant) => variant.previewImageUrl ?? `id:${variant.productId}`),
        )
        if (
          variantsWithOwnImage.length < inStockVariants.length ||
          distinctVariantImageSignatures.size < inStockVariants.length
        ) {
          missingVariantImages.push(summary)
        }
      }
    }

    const meta: CatalogMaintenanceSurveyMeta = {
      generatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + SURVEY_TTL_MS).toISOString(),
      scannedDealerIds,
      totalInStockVariants: variantSeeds.size,
      totalUniqueGroups: groupIds.length,
      warnings,
    }

    missingGroupImage.sort(compareGroupForUi)
    missingVariantImages.sort(compareGroupForUi)

    return { missingGroupImage, missingVariantImages, meta }
  }
}

function buildGroupSummary(
  group: SweedGroup,
  inStockVariants: ResolvedVariant[],
  variantDetailMap: Map<number, SweedProduct>,
): CatalogMaintenanceGroup {
  const groupImageCount = group.images.length
  const groupPreviewImageUrl = pickPreviewUrl(group.images)
  const groupImageIds = new Set(
    group.images.map((image) => normalizeImageId(image)).filter((value): value is string => value !== null),
  )

  const allSiteKeys = new Set<string>()
  for (const variant of inStockVariants) {
    for (const siteKey of variant.siteKeys) {
      allSiteKeys.add(siteKey)
    }
  }

  const variants: CatalogMaintenanceVariant[] = []
  for (const variant of inStockVariants) {
    const embedded = group.products.find((entry) => entry.id === variant.productId)
    const detail = variantDetailMap.get(variant.productId) ?? null
    const sourceImages = pickBestImageSource(embedded, detail)
    const variantSpecificImageCount = sourceImages.filter((image) => {
      const id = normalizeImageId(image)
      if (id === null) {
        return false
      }
      return !groupImageIds.has(id)
    }).length

    const baseProduct: SweedProduct = detail ?? embedded ?? {
      id: variant.productId,
      name: variant.name,
      shortName: variant.shortName,
      tab: null,
      packOfSize: null,
      size: null,
      productGroupId: group.id,
      images: [],
      groupImages: [],
    }

    variants.push({
      productId: variant.productId,
      name: baseProduct.name ?? variant.name,
      shortName: baseProduct.shortName ?? variant.shortName,
      tab: baseProduct.tab ?? null,
      packOfSize: baseProduct.packOfSize ?? null,
      sizeName: baseProduct.size?.name ?? null,
      inStockSites: [...variant.siteKeys].sort(),
      imageCount: sourceImages.length,
      variantSpecificImageCount,
      previewImageUrl: pickPreviewUrl(sourceImages),
    })
  }

  variants.sort((left, right) => {
    const leftKey = `${left.tab ?? ''}|${left.packOfSize ?? 0}|${left.sizeName ?? ''}|${left.name ?? ''}`
    const rightKey = `${right.tab ?? ''}|${right.packOfSize ?? 0}|${right.sizeName ?? ''}|${right.name ?? ''}`
    return leftKey.localeCompare(rightKey)
  })

  return {
    groupId: group.id,
    groupName: group.name ?? null,
    brandName: group.brand?.name ?? null,
    categoryName: group.category?.name ?? null,
    subcategoryName: group.subcategory?.name ?? null,
    groupImageCount,
    groupPreviewImageUrl,
    inStockSites: [...allSiteKeys].sort(),
    inStockVariantCount: inStockVariants.length,
    totalVariantCount: group.products.length,
    variants,
  }
}

function compareGroupForUi(left: CatalogMaintenanceGroup, right: CatalogMaintenanceGroup): number {
  const leftKey = `${left.brandName ?? ''}|${left.groupName ?? ''}|${left.groupId}`
  const rightKey = `${right.brandName ?? ''}|${right.groupName ?? ''}|${right.groupId}`
  return leftKey.localeCompare(rightKey)
}

function pickBestImageSource(
  embedded: SweedProduct | undefined,
  detail: SweedProduct | null,
): SweedImage[] {
  if (detail && detail.images.length > 0) {
    return detail.images
  }
  if (embedded && embedded.images.length > 0) {
    return embedded.images
  }
  if (detail && detail.groupImages.length > 0) {
    return detail.groupImages
  }
  if (embedded && embedded.groupImages.length > 0) {
    return embedded.groupImages
  }
  return []
}

function pickPreviewUrl(images: SweedImage[]): string | null {
  for (const image of images) {
    if (typeof image.url === 'string' && image.url.length > 0) {
      return image.url
    }
  }
  return null
}

function normalizeImageId(image: SweedImage): string | null {
  if (image.id === undefined || image.id === null) {
    return null
  }
  return String(image.id)
}

function coerceOptionalInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isInteger(parsed)) {
      return parsed
    }
  }
  return null
}

async function collectInStockVariantsForSite(
  site: HeliosPendingPurchaseSiteDealer,
  variantSeeds: Map<number, InStockVariantSeed>,
): Promise<void> {
  let page = 1
  while (true) {
    const raw = await callSweedRpcForDealer(site.dealerId, 'store.inventory.item.list.grouped', {
      isOnStock: true,
      page,
      pageSize: GROUPED_INVENTORY_PAGE_SIZE,
    })
    const parsed = GroupedInventoryResponseSchema.parse(raw)

    for (const row of parsed.data) {
      const product = row.product
      if (!product || typeof product.id !== 'number') {
        continue
      }
      const existing = variantSeeds.get(product.id)
      if (existing) {
        existing.siteKeys.add(site.siteKey)
        if (existing.productGroupId === null) {
          existing.productGroupId = coerceOptionalInt(product.productGroupId)
        }
        if (!existing.name && product.name) {
          existing.name = product.name
        }
        if (!existing.shortName && product.shortName) {
          existing.shortName = product.shortName
        }
        continue
      }
      variantSeeds.set(product.id, {
        productId: product.id,
        productGroupId: coerceOptionalInt(product.productGroupId),
        name: product.name ?? null,
        shortName: product.shortName ?? null,
        siteKeys: new Set([site.siteKey]),
      })
    }

    if (parsed.data.length < GROUPED_INVENTORY_PAGE_SIZE) {
      break
    }
    page += 1
  }
}

async function fetchGroupDetail(groupId: number): Promise<SweedGroup> {
  const stateDealerId = getServerEnv().sweedStateDealerId
  const raw = await callSweedRpcForDealer(stateDealerId, 'store.product.group.get', { id: groupId })
  return SweedGroupSchema.parse(raw)
}

async function fetchProductDetail(productId: number): Promise<SweedProduct> {
  const stateDealerId = getServerEnv().sweedStateDealerId
  const raw = await callSweedRpcForDealer(stateDealerId, 'store.product.get', { id: String(productId) })
  return SweedProductDetailSchema.parse(raw)
}

async function runWithConcurrency<TItem>(
  items: TItem[],
  concurrency: number,
  worker: (item: TItem) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const runnerCount = Math.min(concurrency, items.length)
  if (runnerCount <= 0) {
    return
  }
  await Promise.all(
    Array.from({ length: runnerCount }, async () => {
      while (true) {
        const index = cursor
        cursor += 1
        if (index >= items.length) {
          return
        }
        await worker(items[index]!)
      }
    }),
  )
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
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
}

export interface UploadResult {
  uploadedBlobId: string
  blobUrl: string | null
  affectedProductIds: number[]
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

  return withSweedSessionLockReturning(async () => {
    const stateDealerId = getServerEnv().sweedStateDealerId

    const blobId = await createBlob(stateDealerId)
    await putBlobBytes(blobId, input.fileBytes, input.contentType)

    if (input.targetType === 'group') {
      const group = await fetchGroupDetailWithinLock(input.groupId)
      const existingImageIds = collectExistingImageIds(group.images)
      if (existingImageIds.includes(blobId)) {
        existingImageIds.splice(existingImageIds.indexOf(blobId), 1)
      }
      const nextImageIds = [...existingImageIds, blobId]
      await callSweedRpcForDealer(stateDealerId, 'store.product.group.edit', {
        id: input.groupId,
        imagesIds: nextImageIds,
      })
      const refreshed = await fetchGroupDetailWithinLock(input.groupId)
      const blobUrl = pickPreviewUrl(refreshed.images.filter((image) => normalizeImageId(image) === blobId))
      return { uploadedBlobId: blobId, blobUrl, affectedProductIds: [] }
    }

    // variants: attach the same blob to each selected variant. Sweed
    // expects imagesIds to fully describe the variant image set, so we
    // read each variant first and append rather than replace.
    const affectedProductIds: number[] = []
    let blobUrl: string | null = null
    for (const productId of input.productIds) {
      const product = await fetchProductDetailWithinLock(productId)
      const existingImageIds = collectExistingImageIds(product.images)
      if (existingImageIds.includes(blobId)) {
        existingImageIds.splice(existingImageIds.indexOf(blobId), 1)
      }
      const nextImageIds = [...existingImageIds, blobId]
      await callSweedRpcForDealer(stateDealerId, 'store.product.edit', {
        id: productId,
        imagesIds: nextImageIds,
      })
      affectedProductIds.push(productId)
      if (blobUrl === null) {
        const refreshed = await fetchProductDetailWithinLock(productId)
        blobUrl = pickPreviewUrl(refreshed.images.filter((image) => normalizeImageId(image) === blobId))
      }
    }
    return { uploadedBlobId: blobId, blobUrl, affectedProductIds }
  })
}

async function fetchGroupDetailWithinLock(groupId: number): Promise<SweedGroup> {
  const stateDealerId = getServerEnv().sweedStateDealerId
  const raw = await callSweedRpcForDealer(stateDealerId, 'store.product.group.get', { id: groupId })
  return SweedGroupSchema.parse(raw)
}

async function fetchProductDetailWithinLock(productId: number): Promise<SweedProduct> {
  const stateDealerId = getServerEnv().sweedStateDealerId
  const raw = await callSweedRpcForDealer(stateDealerId, 'store.product.get', { id: String(productId) })
  return SweedProductDetailSchema.parse(raw)
}

function collectExistingImageIds(images: SweedImage[]): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const image of images) {
    const id = normalizeImageId(image)
    if (id === null) {
      continue
    }
    if (seen.has(id)) {
      continue
    }
    seen.add(id)
    ids.push(id)
  }
  return ids
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

/* -------------------------------------------------------------------------- */
/*  Sweed RPC plumbing — own session lock for this module.                    */
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
  const result = DealerSetResultSchema.parse(await callSweedRpcRaw('store.auth.dealer.set', { dealerId }))
  if (result.user.currentDealerId !== dealerId) {
    throw new Error(
      `Sweed dealer context mismatch. Expected ${dealerId}, got ${result.user.currentDealerId} ${result.user.currentDealerName ?? ''}`.trim(),
    )
  }
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

function withSweedSessionLock<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
  const run = sweedSessionQueue.then(operation, operation)
  sweedSessionQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function withSweedSessionLockReturning<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
  return withSweedSessionLock(operation)
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
