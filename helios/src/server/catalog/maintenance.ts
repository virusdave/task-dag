/**
 * Catalog Images & Barcodes — DB-backed survey + Sweed write helpers.
 *
 * The page under /catalog/maintenance (label: "Images & Barcodes")
 * surfaces three categories of cached-catalog gaps for in-stock SKUs,
 * organized first by site (bronx, midtown):
 *
 *   1. Missing catalog image:  group has no group-level image
 *   2. Missing variant image:  in-stock variant has no own image (its
 *                              group has one but the variant is using
 *                              the inherited group image)
 *   3. Missing or invalid package barcode:  in-stock variant has no
 *                              externalBarcode, or the barcode fails
 *                              basic validation (empty, non-digit
 *                              characters, fewer than 8 digits, or
 *                              starts with a known placeholder).
 *
 * Read path:
 *   Derived from cached Helios DB tables only — `catalog_groups`
 *   (live_state_json, needs_reanalysis_at, etc.) and
 *   `stock_variant_state` (which in-stock products at which site,
 *   quantity, METRC tags). No Sweed calls on page render.
 *
 * Stale cache: if any required field predates the recent schema
 * upgrade (raw live_state_json missing the new `images`,
 * `externalBarcode`, `sizeName`, `packOfSize` fields; stock rows with
 * empty `metrc_tags_json`; in-stock product ids not present in any
 * `catalog_groups.live_state_json.products` array) the response
 * carries a `fatal` banner with codes and counts. The client
 * surfaces it with a "Fix cache" button that hits
 * /api/catalog/maintenance/cache-repair to enqueue high-priority
 * worker jobs.
 *
 * Write path:
 *   Same as before — locked write batch with a sticky dealer cache,
 *   blob upload, attach via store.product.group.edit /
 *   store.product.edit, then invalidate survey cache + flag the
 *   group for immediate reanalysis.
 */

import { z } from 'zod'

import {
  buildCatalogGroupModuleScope,
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type CatalogMaintenanceCacheRepairResponse,
  type CatalogMaintenanceFatalBanner,
  type CatalogMaintenanceFatalReason,
  type CatalogMaintenanceFatalReasonCode,
  type CatalogMaintenanceMovePackageOutcome,
  type CatalogMaintenanceMovePackageResponse,
  type CatalogMaintenanceMovedLot,
  type CatalogMaintenancePackageLot,
  type CatalogMaintenanceQuickFilterBrand,
  type CatalogMaintenanceSiteGroup,
  type CatalogMaintenanceSiteVariant,
  type CatalogMaintenanceSurveyMeta,
  type CatalogMaintenanceSurveyResponse,
  type CatalogMaintenanceSurveySection,
  type CatalogMaintenanceSurveySite,
  type HeliosPendingPurchaseSiteDealer,
} from '../../shared/contracts/index.js'
import { callSweedRpc } from '../../worker/sweed/rpc.js'
import { withSweedSession } from '../../worker/sweed/session.js'
import { getServerEnv } from '../config/env.js'
import { getPool, type Queryable } from '../db/pool.js'
import { enqueueJob } from '../jobs/enqueueJob.js'
import { getPendingImageUploadStore } from './pendingImageUploadStore.js'
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

interface CachedSurvey {
  expiresAt: number
  value: CatalogMaintenanceSurveyResponse
}

let cachedSurvey: CachedSurvey | null = null
let inFlightSurvey: Promise<CatalogMaintenanceSurveyResponse> | null = null

export interface MaintenanceSurveyOptions {
  forceRefresh?: boolean
}

export async function invalidateCatalogMaintenanceSurvey(): Promise<void> {
  cachedSurvey = null
}

export async function loadCatalogMaintenanceSurvey(
  options: MaintenanceSurveyOptions = {},
): Promise<CatalogMaintenanceSurveyResponse> {
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
      // Cached DB tables lag Sweed by up to a sync cycle, so the
      // candidate set frequently includes groups/variants that have
      // already been fixed in Sweed but whose `catalog_groups` row
      // hasn't been re-ingested yet. Hit Sweed live for just the
      // candidate set and drop anything that's already resolved.
      // Failures here are non-fatal — we keep the original entry so
      // the operator can still act on it.
      const verified = await liveVerifyCandidateSet(result)
      cachedSurvey = {
        expiresAt: Date.now() + SURVEY_TTL_MS,
        value: verified,
      }
      return verified
    } finally {
      inFlightSurvey = null
    }
  })()

  return inFlightSurvey
}

/* -------------------------------------------------------------------------- */
/*  Live verification — drop candidates that Sweed says are already fixed.    */
/* -------------------------------------------------------------------------- */

/**
 * Page size for the per-site grouped-inventory pull. The survey only
 * ever cares about in-stock variants, so a single ≥500-row page covers
 * every in-stock SKU at each site in one shot today (or two if a site
 * grows past 500 distinct in-stock variants).
 */
const LIVE_VERIFY_PAGE_SIZE = 500

/**
 * Loose schema for `store.inventory.item.list.grouped` rows that picks
 * out only the fields we need to settle "is the image / barcode now
 * present?". Sweed's response also carries quantity / pricing / METRC
 * data but we deliberately don't touch any of that here. Any field we
 * can't read just leaves the candidate in the response (fail-open).
 */
const LiveVerifyImageRefSchema = z
  .object({
    id: z.union([z.coerce.number().int(), z.string().trim().min(1)]).nullable().optional(),
    url: z.string().nullable().optional(),
  })
  .passthrough()

const LiveVerifyProductGroupSchema = z
  .object({
    id: z.coerce.number().int().positive().optional(),
    images: z.array(LiveVerifyImageRefSchema).optional(),
  })
  .passthrough()

const LiveVerifyProductSchema = z
  .object({
    id: z.coerce.number().int().positive().optional(),
    externalBarcode: z.string().nullable().optional(),
    images: z.array(LiveVerifyImageRefSchema).optional(),
    productGroup: LiveVerifyProductGroupSchema.nullable().optional(),
  })
  .passthrough()

/**
 * The per-lot rows under each grouped-inventory row. These carry the
 * data needed for the runtime "FOR SALE * + not a trade sample"
 * filter and for populating `CatalogMaintenancePackageLot`s on the
 * survey response.
 */
const LiveVerifyItemSchema = z
  .object({
    id: z.union([z.coerce.number().int(), z.string().trim().min(1)]).nullable().optional(),
    availableQty: z.coerce.number().nullable().optional(),
    currentQty: z.coerce.number().nullable().optional(),
    isTradeSample: z.boolean().nullable().optional(),
    isNotForSale: z.boolean().nullable().optional(),
    isAvailableOnline: z.boolean().nullable().optional(),
    externalTrackCode: z.string().nullable().optional(),
    stockLocation: z
      .object({
        id: z.coerce.number().int().optional(),
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    stockType: z
      .object({
        id: z.coerce.number().int().optional(),
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()

const LiveVerifyRowSchema = z
  .object({
    product: LiveVerifyProductSchema.nullable().optional(),
    items: z.array(LiveVerifyItemSchema).default([]),
  })
  .passthrough()

const LiveVerifyResponseSchema = z
  .object({
    data: z.array(LiveVerifyRowSchema).default([]),
  })
  .passthrough()

/**
 * Mirror of `isForSaleStockLocationName` in
 * `configWorkersStockRefreshJob.ts` — kept local rather than imported
 * to avoid pulling worker-side code into the server bundle. A lot
 * counts as "for sale" only when its `stockLocation.name` starts with
 * the literal prefix `for sale` (case-insensitive). Lots in
 * `NOT FOR SALE - …` buckets (Reception, Quarantine, etc.) are
 * filtered out of the maintenance survey at runtime.
 */
function isForSaleStockLocationName(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false
  return name.trim().toLowerCase().startsWith('for sale')
}

async function liveVerifyCandidateSet(
  survey: CatalogMaintenanceSurveyResponse,
): Promise<CatalogMaintenanceSurveyResponse> {
  // Collect the unique work items.
  const groupIdsNeedingImageCheck = new Set<number>()
  const productIdsNeedingBarcodeCheck = new Set<number>()
  for (const site of survey.sites) {
    for (const section of site.sections) {
      if (section.kind === 'missing-catalog-image') {
        for (const group of section.groups) groupIdsNeedingImageCheck.add(group.groupId)
      } else if (section.kind === 'missing-or-invalid-barcode') {
        for (const group of section.groups) {
          for (const variant of group.variants) productIdsNeedingBarcodeCheck.add(variant.productId)
        }
      }
    }
  }
  if (groupIdsNeedingImageCheck.size === 0 && productIdsNeedingBarcodeCheck.size === 0) {
    return survey
  }

  // Single grouped-inventory pull per site covers the whole candidate
  // set in 1–2 RPC calls; way cheaper than fanning out one
  // `store.product.group.get` + one `store.product.get` per item.
  // The grouped rows include `product.externalBarcode`,
  // `product.images`, `product.productGroup.{id, images}`, and the
  // per-lot `items[]` array we use to (a) filter variants whose only
  // live qty is in NOT-FOR-SALE locations or marked as trade samples,
  // and (b) emit per-package detail onto the variant payload so the
  // UI can render the "Move to Inspection" button without a second
  // round-trip.
  const groupHasImage = new Map<number, boolean>()
  const productHasBarcode = new Map<number, boolean>()
  // siteKey → productId → has at least one FOR-SALE-locationed,
  // non-trade-sample lot with qty > 0
  const productHasForSaleLotBySite = new Map<string, Map<number, boolean>>()
  // siteKey → productId → ordered lot payloads (drives both filtering
  // and UI badges)
  const lotsByProductBySite = new Map<string, Map<number, CatalogMaintenancePackageLot[]>>()
  for (const site of HELIOS_PENDING_PURCHASE_SITE_DEALERS) {
    productHasForSaleLotBySite.set(site.siteKey, new Map())
    lotsByProductBySite.set(site.siteKey, new Map())
  }
  try {
    await withSweedSession(async () => {
      for (const site of HELIOS_PENDING_PURCHASE_SITE_DEALERS) {
        const siteHasForSaleLot = productHasForSaleLotBySite.get(site.siteKey)!
        const siteLots = lotsByProductBySite.get(site.siteKey)!
        let page = 1
        while (true) {
          const raw = await callSweedRpc(site.dealerId, 'store.inventory.item.list.grouped', {
            isOnStock: true,
            page,
            pageSize: LIVE_VERIFY_PAGE_SIZE,
          })
          const parsed = LiveVerifyResponseSchema.parse(raw)
          for (const row of parsed.data) {
            const product = row.product
            if (!product) continue
            const productId = product.id
            if (productId !== undefined) {
              const barcode = nonEmptyString(product.externalBarcode ?? null)
              productHasBarcode.set(productId, barcode !== null)
            }
            const group = product.productGroup
            if (group && group.id !== undefined && Array.isArray(group.images)) {
              groupHasImage.set(group.id, group.images.length > 0)
            }
            if (productId !== undefined) {
              const builtLots: CatalogMaintenancePackageLot[] = []
              let sawForSaleLot = false
              for (const item of row.items) {
                const itemIdRaw = item.id
                if (itemIdRaw === null || itemIdRaw === undefined) continue
                const stockLocationName = item.stockLocation?.name ?? null
                const isTradeSample = item.isTradeSample === true
                const availableQty =
                  typeof item.availableQty === 'number'
                    ? item.availableQty
                    : typeof item.currentQty === 'number'
                      ? item.currentQty
                      : null
                const isForSale =
                  !isTradeSample &&
                  item.isNotForSale !== true &&
                  isForSaleStockLocationName(stockLocationName)
                if (isForSale && typeof availableQty === 'number' && availableQty > 0) {
                  sawForSaleLot = true
                }
                builtLots.push({
                  itemId: String(itemIdRaw),
                  externalTrackCode: nonEmptyString(item.externalTrackCode ?? null),
                  stockLocationId: item.stockLocation?.id ?? null,
                  stockLocationName,
                  stockTypeId: item.stockType?.id ?? null,
                  stockTypeName: item.stockType?.name ?? null,
                  availableQty,
                  isForSale,
                  isTradeSample,
                })
              }
              // Merge with anything seen on a prior grouped-feed row for
              // the same product (the feed *should* be one row per
              // productId but defensively concatenate).
              const previousLots = siteLots.get(productId)
              siteLots.set(
                productId,
                previousLots ? [...previousLots, ...builtLots] : builtLots,
              )
              const prevHasForSale = siteHasForSaleLot.get(productId) === true
              siteHasForSaleLot.set(productId, prevHasForSale || sawForSaleLot)
            }
          }
          if (parsed.data.length < LIVE_VERIFY_PAGE_SIZE) break
          page += 1
        }
      }
    })
  } catch (error) {
    // No pool token available, transport blew up, etc. Fail open: return
    // the unverified survey rather than blocking the page.
    console.warn('[catalog-maintenance] live verify pass failed; returning unverified survey.', error)
    return survey
  }

  const brandIssueCounts = new Map<string, number>()
  const newSites = survey.sites.map((site) => {
    const siteHasForSaleLot = productHasForSaleLotBySite.get(site.siteKey) ?? new Map<number, boolean>()
    const siteLots = lotsByProductBySite.get(site.siteKey) ?? new Map<number, CatalogMaintenancePackageLot[]>()
    /**
     * "FOR SALE * + non-trade-sample" filter applied at runtime.
     * `stock_variant_state.is_on_stock` flips true if ANY lot (incl.
     * trade samples and lots in Reception / Quarantine) has qty > 0,
     * so on its own it over-counts the maintenance population. The
     * live verify pass already pulls per-lot detail to render the
     * "Move to Inspection" button; we re-use that data here to drop
     * variants whose only remaining stock is in NOT-FOR-SALE buckets
     * or is marked as a trade sample.
     *
     * If the live verify pass produced no lot data for a productId
     * at this site (cache lag, brand-new variant Sweed has not
     * returned yet, …) we treat the variant as "for sale" so we
     * don't accidentally hide a real problem just because Sweed
     * paginated past it.
     */
    const variantPasses = (productId: number): boolean => {
      if (!siteLots.has(productId)) return true
      return siteHasForSaleLot.get(productId) === true
    }
    const annotateVariant = (variant: CatalogMaintenanceSiteVariant): CatalogMaintenanceSiteVariant => ({
      ...variant,
      lots: siteLots.get(variant.productId) ?? [],
    })
    const newSections = site.sections.map((section) => {
      if (section.kind === 'missing-catalog-image') {
        const keptGroups: CatalogMaintenanceSiteGroup[] = []
        for (const group of section.groups) {
          if (groupHasImage.get(group.groupId) === true) continue
          const keptVariants = group.variants.filter((v) => variantPasses(v.productId))
          if (keptVariants.length === 0) continue
          keptGroups.push({ ...group, variants: keptVariants.map(annotateVariant) })
          countBrandIssue(brandIssueCounts, group.brandName, keptVariants.length)
        }
        return { ...section, groups: keptGroups, issueCount: keptGroups.length }
      }
      if (section.kind === 'missing-or-invalid-barcode') {
        const keptGroups: CatalogMaintenanceSiteGroup[] = []
        for (const group of section.groups) {
          const keptVariants = group.variants.filter(
            (variant) =>
              productHasBarcode.get(variant.productId) !== true && variantPasses(variant.productId),
          )
          if (keptVariants.length === 0) continue
          keptGroups.push({ ...group, variants: keptVariants.map(annotateVariant) })
          countBrandIssue(brandIssueCounts, group.brandName, keptVariants.length)
        }
        return { ...section, groups: keptGroups, issueCount: keptGroups.length }
      }
      return section
    })
    return {
      ...site,
      sections: newSections,
      totalIssueCount: newSections.reduce((acc, s) => acc + s.issueCount, 0),
    }
  })

  const brands = [...brandIssueCounts.entries()]
    .filter(([, count]) => count > 0)
    .map(([brandName, issueCount]) => ({ brandName, issueCount }))
    .sort((a, b) => a.brandName.localeCompare(b.brandName))

  return {
    ...survey,
    sites: newSites,
    quickFilters: { brands },
  }
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
  quantity: number | string | null
  metrc_tags_json: unknown
}

interface LiveStateFreshness {
  isStale: boolean
  reasons: Set<CatalogMaintenanceFatalReasonCode>
}

interface ParsedGroup {
  catalogGroupId: number
  sweedGroupId: number
  groupName: string | null
  brandName: string | null
  categoryName: string | null
  subcategoryName: string | null
  liveState: ParsedLiveState
  needsReanalysis: boolean
  freshness: LiveStateFreshness
}

interface ParsedLiveState {
  groupImageIds: Set<string>
  groupImageUrls: Set<string>
  groupImageCount: number
  groupPreviewImageUrl: string | null
  totalVariantCount: number
  products: ParsedProduct[]
  /**
   * Sweed numeric identifiers extracted from the normalized live state's
   * `brand.id` / `category.id` / `subcategory.id` (when present). Null
   * for older catalog_groups rows synced before the liveState
   * normalizer learned to capture them.
   */
  brandId: number | null
  categoryId: number | null
  subcategoryId: number | null
}

interface ParsedProduct {
  productId: number
  name: string | null
  shortName: string | null
  tab: string | null
  packOfSize: number | null
  sizeName: string | null
  externalBarcode: string | null
  imageIds: Set<string>
  ownImagePreviewUrl: string | null
  ownImageCount: number
  variantSpecificImageCount: number
}

interface PerSiteStock {
  metrcTags: string[]
  quantity: number | null
}

async function buildSurveyFromDb(): Promise<CatalogMaintenanceSurveyResponse> {
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
        select site_dealer_id, product_id, quantity, metrc_tags_json
        from stock_variant_state
        where is_on_stock = true
          and site_dealer_id = any($1::bigint[])
      `,
      [scannedDealerIds],
    ),
  ])

  // stockByProductId[productId][siteKey] = { metricTags, quantity }
  const stockByProductId = new Map<number, Map<string, PerSiteStock>>()
  const siteKeyByDealerId = new Map<number, string>()
  const siteLabelByKey = new Map<string, string>()
  for (const site of HELIOS_PENDING_PURCHASE_SITE_DEALERS) {
    siteKeyByDealerId.set(site.dealerId, site.siteKey)
    siteLabelByKey.set(site.siteKey, site.siteLabel)
  }

  // Candidate set; we filter to cannabis categories below once we have the
  // catalog group → category mapping. METRC tags are only an error condition
  // for cannabis categories (not Accessories / Other) — for non-cannabis
  // categories a missing METRC tag is not even a warning.
  const productIdsMissingMetrcCandidates: number[] = []
  for (const stockRow of stockResult.rows) {
    const siteKey = siteKeyByDealerId.get(stockRow.site_dealer_id)
    if (!siteKey) {
      continue
    }
    const metrcTags = parseMetrcTagsJson(stockRow.metrc_tags_json)
    if (metrcTags.length === 0) {
      productIdsMissingMetrcCandidates.push(stockRow.product_id)
    }
    const quantity =
      typeof stockRow.quantity === 'number'
        ? stockRow.quantity
        : typeof stockRow.quantity === 'string'
          ? Number(stockRow.quantity)
          : null

    let perProduct = stockByProductId.get(stockRow.product_id)
    if (!perProduct) {
      perProduct = new Map()
      stockByProductId.set(stockRow.product_id, perProduct)
    }
    perProduct.set(siteKey, {
      metrcTags,
      quantity: typeof quantity === 'number' && Number.isFinite(quantity) ? quantity : null,
    })
  }

  // Parse catalog group rows.
  const parsedGroups: ParsedGroup[] = []
  let parseFailedCount = 0
  let staleSchemaCount = 0
  const parseFailedSampleIds: number[] = []
  const staleSchemaSampleIds: number[] = []
  let oldestSyncedAt: Date | null = null

  for (const row of groupsResult.rows) {
    const freshness = inspectLiveStateFreshness(row.live_state_json)
    if (freshness.reasons.has('live-state-parse-failed')) {
      parseFailedCount += 1
      if (parseFailedSampleIds.length < 5) {
        parseFailedSampleIds.push(row.id)
      }
      continue
    }
    if (freshness.isStale) {
      staleSchemaCount += 1
      if (staleSchemaSampleIds.length < 5) {
        staleSchemaSampleIds.push(row.id)
      }
    }
    const liveState = parseLiveStateForSurvey(row.live_state_json)
    if (liveState === null) {
      parseFailedCount += 1
      if (parseFailedSampleIds.length < 5) {
        parseFailedSampleIds.push(row.id)
      }
      continue
    }
    if (row.last_synced_at !== null) {
      if (oldestSyncedAt === null || row.last_synced_at.getTime() < oldestSyncedAt.getTime()) {
        oldestSyncedAt = row.last_synced_at
      }
    }
    parsedGroups.push({
      catalogGroupId: row.id,
      sweedGroupId: row.sweed_group_id,
      groupName: row.group_name,
      brandName: row.brand_name,
      categoryName: row.category_name,
      subcategoryName: row.subcategory_name,
      liveState,
      needsReanalysis: row.needs_reanalysis_at !== null,
      freshness,
    })
  }

  // For each site, build the three sections.
  const productIndex = new Map<number, { group: ParsedGroup; product: ParsedProduct }>()
  for (const group of parsedGroups) {
    for (const product of group.liveState.products) {
      productIndex.set(product.productId, { group, product })
    }
  }

  const matchedProductIds = new Set<number>()
  const sites: CatalogMaintenanceSurveySite[] = []
  const brandIssueCounts = new Map<string, number>()
  let totalInStockVariants = 0
  let totalUniqueGroups = 0
  const renderedGroupIds = new Set<number>()

  for (const site of HELIOS_PENDING_PURCHASE_SITE_DEALERS) {
    const missingCatalogImage: CatalogMaintenanceSiteGroup[] = []
    const missingBarcode: CatalogMaintenanceSiteGroup[] = []

    // Bucket in-stock products at this site by their group.
    const productsByGroup = new Map<number, Array<{ product: ParsedProduct; siteStock: PerSiteStock }>>()
    for (const [productId, sitesMap] of stockByProductId) {
      const siteStock = sitesMap.get(site.siteKey)
      if (!siteStock) {
        continue
      }
      totalInStockVariants += 1
      const indexed = productIndex.get(productId)
      if (!indexed) {
        continue
      }
      matchedProductIds.add(productId)
      const bucket = productsByGroup.get(indexed.group.catalogGroupId) ?? []
      bucket.push({ product: indexed.product, siteStock })
      productsByGroup.set(indexed.group.catalogGroupId, bucket)
    }

    for (const [catalogGroupId, entries] of productsByGroup) {
      const indexed = parsedGroups.find((g) => g.catalogGroupId === catalogGroupId)
      if (!indexed) continue
      renderedGroupIds.add(catalogGroupId)

      const inStockProductIds = new Set(entries.map((e) => e.product.productId))

      const variantsForGroupCard: CatalogMaintenanceSiteVariant[] = entries.map((entry) =>
        buildVariantPayload(entry.product, entry.siteStock, indexed.liveState),
      )

      const groupNeedsCatalogImage = indexed.liveState.groupImageCount === 0
      // Variants whose barcode is missing. Like the missing-METRC check,
      // this is only an error condition for cannabis categories —
      // Accessories / Other groups are skipped entirely (no warning
      // either). "Invalid" barcode detection has been deliberately removed
      // until the human defines the validation rules they actually care
      // about; today we only surface MISSING barcodes.
      const barcodeIssueVariants = isCannabisCategory(indexed.categoryName)
        ? entries.filter((entry) => classifyBarcode(entry.product.externalBarcode).status === 'missing')
        : []

      if (groupNeedsCatalogImage) {
        const card = buildSiteGroupCard({
          parsedGroup: indexed,
          site,
          entries,
          variantsForGroupCard,
        })
        missingCatalogImage.push(card)
        countBrandIssue(brandIssueCounts, indexed.brandName, entries.length)
      }

      // Per-variant image gaps are intentionally NOT surfaced as their own
      // section today. The upload-image-to-variant path is not yet known
      // to work against Sweed (variant-specific images don't take via
      // `store.product.edit { imagesIds }`), so flagging variants whose
      // own image is missing would just queue up actions an operator
      // can't complete. The corresponding section kind in the contract
      // is left in place but always populated with zero candidates.

      if (barcodeIssueVariants.length > 0) {
        const onlyAffected = variantsForGroupCard.filter((v) => barcodeIssueVariants.some((e) => e.product.productId === v.productId))
        missingBarcode.push(
          buildSiteGroupCard({
            parsedGroup: indexed,
            site,
            entries: barcodeIssueVariants,
            variantsForGroupCard: onlyAffected,
          }),
        )
        countBrandIssue(brandIssueCounts, indexed.brandName, barcodeIssueVariants.length)
      }

      void inStockProductIds
    }

    sortSiteGroups(missingCatalogImage)
    sortSiteGroups(missingBarcode)

    // NOTE: the `missing-variant-image` section kind is intentionally NOT
    // emitted today. Variant-level image upload isn't a working flow yet
    // (Sweed's `store.product.edit { imagesIds }` doesn't appear to
    // persist), so surfacing variants without their own image would only
    // queue up un-fixable work for the operator. The enum value is left
    // in the shared contract for forward-compat.
    const sections: CatalogMaintenanceSurveySection[] = [
      {
        kind: 'missing-catalog-image',
        label: 'Missing catalog image',
        targetId: sectionAnchorId(site.siteKey, 'missing-catalog-image'),
        issueCount: missingCatalogImage.length,
        groups: missingCatalogImage,
      },
      {
        kind: 'missing-or-invalid-barcode',
        label: 'Missing package barcode',
        targetId: sectionAnchorId(site.siteKey, 'missing-or-invalid-barcode'),
        issueCount: missingBarcode.length,
        groups: missingBarcode,
      },
    ]

    sites.push({
      siteKey: site.siteKey,
      siteLabel: site.siteLabel,
      targetId: siteAnchorId(site.siteKey),
      totalIssueCount: sections.reduce((acc, s) => acc + s.issueCount, 0),
      sections,
    })
  }

  totalUniqueGroups = renderedGroupIds.size

  // Build quick filter brand list (only brands with any non-zero issue count).
  const brands: CatalogMaintenanceQuickFilterBrand[] = [...brandIssueCounts.entries()]
    .filter(([, count]) => count > 0)
    .map(([brandName, issueCount]) => ({ brandName, issueCount }))
    .sort((a, b) => a.brandName.localeCompare(b.brandName))

  // Build fatal banner if needed.
  const orphanProductIds: number[] = []
  for (const productId of stockByProductId.keys()) {
    if (!matchedProductIds.has(productId)) {
      orphanProductIds.push(productId)
    }
  }

  // Restrict missing-METRC complaints to cannabis-category groups. For
  // Accessories / Other groups a missing METRC tag is expected and is not
  // an error or warning. Products with no resolvable catalog group fall
  // into `orphanProductIds` and are reported separately, so we drop them
  // from the METRC list here to avoid double-counting.
  const productIdsMissingMetrc = productIdsMissingMetrcCandidates.filter((productId) => {
    const indexed = productIndex.get(productId)
    if (!indexed) return false
    return isCannabisCategory(indexed.group.categoryName)
  })

  const fatal = buildFatalBanner({
    orphanProductIds,
    productIdsMissingMetrc,
    staleSchemaCount,
    staleSchemaSampleIds,
    parseFailedCount,
    parseFailedSampleIds,
  })

  if (fatal === null && orphanProductIds.length === 0 && productIdsMissingMetrc.length === 0) {
    // Nothing to warn about. Leave warnings empty.
  } else if (fatal !== null) {
    warnings.push(`Cache is incomplete: ${fatal.reasons.length} issue(s) detected. Use the "Fix cache" button.`)
  }

  const generatedAtMs = oldestSyncedAt?.getTime() ?? Date.now()
  const meta: CatalogMaintenanceSurveyMeta = {
    generatedAt: new Date(generatedAtMs).toISOString(),
    expiresAt: new Date(Date.now() + SURVEY_TTL_MS).toISOString(),
    scannedDealerIds,
    totalInStockVariants,
    totalUniqueGroups,
    warnings,
  }

  return {
    meta,
    fatal,
    sites,
    quickFilters: { brands },
  }
}

function buildSiteGroupCard(input: {
  parsedGroup: ParsedGroup
  site: HeliosPendingPurchaseSiteDealer
  entries: Array<{ product: ParsedProduct; siteStock: PerSiteStock }>
  variantsForGroupCard: CatalogMaintenanceSiteVariant[]
}): CatalogMaintenanceSiteGroup {
  const { parsedGroup, site, entries, variantsForGroupCard } = input
  // Sort variants inside a card: category → subcategory → variant/size → brand
  // is mostly a group-level sort; within a single card we sort by tab,
  // pack-of-size, size, name as a stable inner ordering.
  const sortedVariants = [...variantsForGroupCard].sort((left, right) => compareVariantsForCard(left, right))

  return {
    groupId: parsedGroup.sweedGroupId,
    groupName: parsedGroup.groupName,
    brandName: parsedGroup.brandName,
    brandId: parsedGroup.liveState.brandId,
    categoryName: parsedGroup.categoryName,
    categoryId: parsedGroup.liveState.categoryId,
    subcategoryName: parsedGroup.subcategoryName,
    subcategoryId: parsedGroup.liveState.subcategoryId,
    groupImageCount: parsedGroup.liveState.groupImageCount,
    groupPreviewImageUrl: parsedGroup.liveState.groupPreviewImageUrl,
    siteKey: site.siteKey,
    siteLabel: site.siteLabel,
    totalVariantCount: parsedGroup.liveState.totalVariantCount,
    variants: sortedVariants,
    needsReanalysis: parsedGroup.needsReanalysis,
  }
  void entries
}

function buildVariantPayload(
  product: ParsedProduct,
  siteStock: PerSiteStock,
  liveState: ParsedLiveState,
): CatalogMaintenanceSiteVariant {
  const barcode = classifyBarcode(product.externalBarcode)
  return {
    productId: product.productId,
    name: product.name,
    shortName: product.shortName,
    tab: product.tab,
    packOfSize: product.packOfSize,
    sizeName: product.sizeName,
    quantity: siteStock.quantity,
    metrcTags: siteStock.metrcTags,
    // Lots are filled in by `liveVerifyCandidateSet` after the per-site
    // grouped-inventory pull. Until then the variant ships with an
    // empty array; the UI renders the METRC chips read-only when no
    // lot detail is present (e.g. live verify failed).
    lots: [],
    previewImageUrl: product.ownImagePreviewUrl ?? liveState.groupPreviewImageUrl,
    imageCount: product.ownImageCount > 0 ? product.ownImageCount : liveState.groupImageCount,
    variantSpecificImageCount: product.variantSpecificImageCount,
    externalBarcode: product.externalBarcode,
    barcodeStatus: barcode.status,
    barcodeIssueReason: barcode.reason,
  }
}

function sortSiteGroups(groups: CatalogMaintenanceSiteGroup[]): void {
  groups.sort((left, right) => {
    const leftKey = `${left.categoryName ?? ''}|${left.subcategoryName ?? ''}|${primaryVariantSortKey(left)}|${left.brandName ?? ''}|${left.groupName ?? ''}|${left.groupId}`
    const rightKey = `${right.categoryName ?? ''}|${right.subcategoryName ?? ''}|${primaryVariantSortKey(right)}|${right.brandName ?? ''}|${right.groupName ?? ''}|${right.groupId}`
    return leftKey.localeCompare(rightKey)
  })
}

function primaryVariantSortKey(group: CatalogMaintenanceSiteGroup): string {
  const first = group.variants[0]
  if (!first) return ''
  return `${first.tab ?? ''}|${String(first.packOfSize ?? 0).padStart(4, '0')}|${first.sizeName ?? ''}|${first.name ?? ''}`
}

function compareVariantsForCard(left: CatalogMaintenanceSiteVariant, right: CatalogMaintenanceSiteVariant): number {
  const leftKey = `${left.tab ?? ''}|${String(left.packOfSize ?? 0).padStart(4, '0')}|${left.sizeName ?? ''}|${left.name ?? ''}`
  const rightKey = `${right.tab ?? ''}|${String(right.packOfSize ?? 0).padStart(4, '0')}|${right.sizeName ?? ''}|${right.name ?? ''}`
  return leftKey.localeCompare(rightKey)
}

function countBrandIssue(counts: Map<string, number>, brand: string | null, n: number): void {
  if (!brand) return
  counts.set(brand, (counts.get(brand) ?? 0) + n)
}

/**
 * Category names for which METRC tags and barcode quality are NOT tracked
 * as errors or warnings on the Images & Barcodes page. Everything else is
 * treated as a cannabis category, so we err on the side of flagging issues
 * for groups whose category we don't recognize.
 */
const NON_CANNABIS_CATEGORY_NAMES = new Set<string>(['Accessories', 'Other'])

function isCannabisCategory(categoryName: string | null): boolean {
  if (categoryName === null) return true
  return !NON_CANNABIS_CATEGORY_NAMES.has(categoryName.trim())
}

function classifyBarcode(value: string | null): { status: 'ok' | 'missing' | 'invalid'; reason: string | null } {
  // Today we ONLY classify a barcode as missing vs ok. "Invalid" is
  // deliberately not detected — the human has not yet defined what
  // patterns we consider invalid (and explicitly does NOT want us to
  // apply any ISO-spec / heuristic checks in the meantime). The 'invalid'
  // status value is left in the shared contract for forward-compat.
  if (value === null) {
    return { status: 'missing', reason: 'No barcode on file.' }
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return { status: 'missing', reason: 'Barcode is empty.' }
  }
  return { status: 'ok', reason: null }
}

function siteAnchorId(siteKey: string): string {
  return `site-${siteKey}`
}

function sectionAnchorId(siteKey: string, kind: string): string {
  return `site-${siteKey}-${kind}`
}

/* -------------------------------------------------------------------------- */
/*  Raw-JSON parsing — preserves staleness signal that Zod defaults would hide. */
/* -------------------------------------------------------------------------- */

function inspectLiveStateFreshness(value: unknown): LiveStateFreshness {
  const reasons = new Set<CatalogMaintenanceFatalReasonCode>()
  if (value === null || typeof value !== 'object') {
    reasons.add('live-state-parse-failed')
    return { isStale: true, reasons }
  }
  const obj = value as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(obj, 'images')) {
    reasons.add('live-state-schema-stale')
  }
  if (Array.isArray(obj.products)) {
    for (const rawProduct of obj.products as unknown[]) {
      if (rawProduct === null || typeof rawProduct !== 'object') {
        reasons.add('live-state-schema-stale')
        continue
      }
      const productObj = rawProduct as Record<string, unknown>
      if (!Object.prototype.hasOwnProperty.call(productObj, 'images')) {
        reasons.add('live-state-schema-stale')
      }
      if (!Object.prototype.hasOwnProperty.call(productObj, 'externalBarcode')) {
        reasons.add('live-state-schema-stale')
      }
      if (!Object.prototype.hasOwnProperty.call(productObj, 'sizeName')) {
        reasons.add('live-state-schema-stale')
      }
      if (!Object.prototype.hasOwnProperty.call(productObj, 'packOfSize')) {
        reasons.add('live-state-schema-stale')
      }
    }
  }
  return { isStale: reasons.size > 0, reasons }
}

function parseLiveStateForSurvey(value: unknown): ParsedLiveState | null {
  if (value === null || typeof value !== 'object') {
    return null
  }
  const obj = value as Record<string, unknown>
  const rawGroupImages = Array.isArray(obj.images) ? (obj.images as unknown[]) : []
  const groupImages = rawGroupImages
    .map((image) => coerceImageRef(image))
    .filter((image): image is { id: string | null; url: string | null } => image !== null)
  const groupImageIds = new Set(groupImages.map((i) => i.id).filter((id): id is string => id !== null))
  const groupImageUrls = new Set(groupImages.map((i) => i.url).filter((url): url is string => url !== null))
  const groupPreviewImageUrl = groupImages.find((image) => image.url !== null)?.url ?? null

  const rawProducts = Array.isArray(obj.products) ? (obj.products as unknown[]) : []
  const products: ParsedProduct[] = []
  for (const rawProduct of rawProducts) {
    if (rawProduct === null || typeof rawProduct !== 'object') continue
    const productObj = rawProduct as Record<string, unknown>
    const productId = coerceInt(productObj.productId)
    if (productId === null) continue
    const rawImages = Array.isArray(productObj.images) ? (productObj.images as unknown[]) : []
    const images = rawImages
      .map((image) => coerceImageRef(image))
      .filter((image): image is { id: string | null; url: string | null } => image !== null)
    const imageIds = new Set(images.map((i) => i.id).filter((id): id is string => id !== null))
    const variantSpecificImageCount = images.filter((image) => {
      if (image.id !== null && groupImageIds.has(image.id)) return false
      if (image.id === null && image.url !== null && groupImageUrls.has(image.url)) return false
      return true
    }).length
    const ownImagePreviewUrl = images.find((image) => image.url !== null)?.url ?? null
    products.push({
      productId,
      name: coerceString(productObj.name),
      shortName: coerceString(productObj.shortName),
      tab: coerceString(productObj.tab),
      packOfSize: coerceInt(productObj.packOfSize),
      sizeName: coerceString(productObj.sizeName),
      externalBarcode: coerceString(productObj.externalBarcode),
      imageIds,
      ownImagePreviewUrl,
      ownImageCount: images.length,
      variantSpecificImageCount,
    })
  }

  return {
    groupImageIds,
    groupImageUrls,
    groupImageCount: groupImages.length,
    groupPreviewImageUrl,
    totalVariantCount: products.length,
    products,
    brandId: coerceInt(obj.brandId),
    categoryId: coerceInt(obj.categoryId),
    subcategoryId: coerceInt(obj.subcategoryId),
  }
}

function coerceImageRef(value: unknown): { id: string | null; url: string | null } | null {
  if (value === null || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  const id =
    typeof obj.id === 'string' && obj.id.trim().length > 0
      ? obj.id.trim()
      : typeof obj.id === 'number' && Number.isFinite(obj.id)
        ? String(obj.id)
        : null
  const url = typeof obj.url === 'string' && obj.url.trim().length > 0 ? obj.url : null
  return { id, url }
}

function coerceInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length === 0) return null
    const parsed = Number(trimmed)
    if (Number.isInteger(parsed)) return parsed
  }
  return null
}

function coerceString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function parseMetrcTagsJson(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const tags: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      const trimmed = entry.trim()
      if (trimmed.length > 0) tags.push(trimmed)
    }
  }
  return tags
}

function buildFatalBanner(input: {
  orphanProductIds: number[]
  productIdsMissingMetrc: number[]
  staleSchemaCount: number
  staleSchemaSampleIds: number[]
  parseFailedCount: number
  parseFailedSampleIds: number[]
}): CatalogMaintenanceFatalBanner | null {
  const reasons: CatalogMaintenanceFatalReason[] = []
  if (input.orphanProductIds.length > 0) {
    reasons.push({
      code: 'orphan-in-stock-variants',
      message:
        `${input.orphanProductIds.length} in-stock variant${input.orphanProductIds.length === 1 ? ' is' : 's are'} ` +
        `not present in any cached catalog group. Run "Fix cache" to discover their groups and sync them.`,
      count: input.orphanProductIds.length,
      sampleIds: input.orphanProductIds.slice(0, 5),
    })
  }
  if (input.productIdsMissingMetrc.length > 0) {
    reasons.push({
      code: 'stock-metrc-tags-missing',
      message:
        `${input.productIdsMissingMetrc.length} in-stock row${input.productIdsMissingMetrc.length === 1 ? '' : 's'} ` +
        `lack cached METRC tags. The next stock refresh repopulates them.`,
      count: input.productIdsMissingMetrc.length,
      sampleIds: input.productIdsMissingMetrc.slice(0, 5),
    })
  }
  if (input.staleSchemaCount > 0) {
    reasons.push({
      code: 'live-state-schema-stale',
      message:
        `${input.staleSchemaCount} catalog group${input.staleSchemaCount === 1 ? '' : 's'} ` +
        `cached before the recent live-state schema upgrade. Run "Fix cache" to re-sync.`,
      count: input.staleSchemaCount,
      sampleIds: input.staleSchemaSampleIds,
    })
  }
  if (input.parseFailedCount > 0) {
    reasons.push({
      code: 'live-state-parse-failed',
      message:
        `${input.parseFailedCount} catalog group${input.parseFailedCount === 1 ? '' : 's'} ` +
        `have unparseable live_state_json and were skipped.`,
      count: input.parseFailedCount,
      sampleIds: input.parseFailedSampleIds,
    })
  }
  if (reasons.length === 0) return null
  return {
    title: 'Cache is incomplete',
    message:
      'This page is hiding or misclassifying some rows because required cached data is missing or predates ' +
      'the recent schema upgrade. Fixing the cache enqueues high-priority worker jobs to backfill it.',
    reasons,
    canRepair: true,
  }
}

/* -------------------------------------------------------------------------- */
/*  Cache repair: enqueue full-summary, stock refresh, orphan discovery.       */
/* -------------------------------------------------------------------------- */

export async function enqueueCacheRepairJobs(requestedByUserId: number | null): Promise<CatalogMaintenanceCacheRepairResponse> {
  const db = getPool()
  const earlyRunAt = new Date(Date.now() - 60_000)
  const fullSummaryJobId = await enqueueJob(db, {
    concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
    dedupeKey: 'catalog.sync.full_summary:catalog-maintenance-repair',
    jobType: 'catalog.sync.full_summary',
    module: 'catalog',
    payload: {
      requestedByUserId,
      trigger: 'catalog_maintenance_fix_cache',
    },
    requestedByUserId,
    runAt: earlyRunAt,
    scope: null,
  })

  const stockRefreshJobId = await enqueueJob(db, {
    concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
    dedupeKey: 'config.workers.stock_refresh:catalog-maintenance-repair',
    jobType: 'config.workers.stock_refresh',
    module: 'config',
    payload: {
      requestedByUserId,
      siteDealerIds: [],
      trigger: 'catalog_maintenance_fix_cache',
    },
    requestedByUserId,
    runAt: earlyRunAt,
    scope: null,
  })

  const discoverOrphanGroupsJobId = await enqueueJob(db, {
    concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
    dedupeKey: 'catalog.sync.discover_orphan_groups:catalog-maintenance-repair',
    jobType: 'catalog.sync.discover_orphan_groups',
    module: 'catalog',
    payload: {
      requestedByUserId,
      siteDealerIds: [],
      trigger: 'catalog_maintenance_fix_cache',
    },
    requestedByUserId,
    runAt: earlyRunAt,
    scope: null,
  })

  await invalidateCatalogMaintenanceSurvey()
  return {
    fullSummaryJobId,
    stockRefreshJobId,
    discoverOrphanGroupsJobId,
  }
}

/* -------------------------------------------------------------------------- */
/*  Image upload — durable staging + queued worker job.                       */
/*                                                                            */
/*  The route handler stashes incoming bytes via PendingImageUploadStore and  */
/*  enqueues a `catalog.maintenance.upload_group_image` worker job. The       */
/*  worker (see src/worker/jobs/catalogMaintenanceUploadGroupImageJob.ts)     */
/*  leases a token from sweed_session_tokens, performs blob.add → PUT bytes   */
/*  → group.edit → verify, flags the group for reanalysis, and deletes the    */
/*  staged bytes only on success. A transient failure leaves the bytes on     */
/*  disk so the worker's standard retry/backoff re-runs against the same      */
/*  stagedRef — operators do NOT need to re-upload.                            */
/*                                                                            */
/*  Variant-image uploads are not supported by this flow because              */
/*  store.product.edit { imagesIds } silently no-ops for variants in Sweed;    */
/*  the route returns HTTP 410 for `targetType: 'variants'`.                   */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the helios `catalog_groups.id` for a given Sweed group id.
 *
 * The upload-group-image worker payload schema requires `catalogGroupId`
 * (used to address the row for reanalysis flagging). Callers in this
 * module pass `sweedGroupId` (the external Sweed id) because that's what
 * the route + staged metadata carry, so we look up the internal id here.
 */
async function resolveCatalogGroupIdForSweedGroup(sweedGroupId: number): Promise<number> {
  const db: Queryable = getPool()
  const lookup = await db.query<{ id: number }>(
    `select id from catalog_groups where sweed_group_id = $1 and deleted_at is null limit 1`,
    [sweedGroupId],
  )
  const catalogGroupId = lookup.rows[0]?.id ?? null
  if (catalogGroupId === null) {
    throw new HttpError(
      404,
      `No catalog_groups row found for sweed_group_id=${sweedGroupId}; ` +
        `cannot enqueue image upload until the group has been synced into helios.`,
    )
  }
  return catalogGroupId
}

export interface EnqueueGroupImageUploadInput {
  fileBytes: Uint8Array
  contentType: string
  originalFilename: string | null
  requestedByUserId: number | null
  sweedGroupId: number
}

export interface EnqueueGroupImageUploadResult {
  jobId: number
  stagedRef: string
}

export async function enqueueGroupImageUploadJob(
  input: EnqueueGroupImageUploadInput,
): Promise<EnqueueGroupImageUploadResult> {
  if (input.fileBytes.byteLength === 0) {
    throw new HttpError(400, 'Upload payload is empty.')
  }
  if (input.fileBytes.byteLength > MAX_IMAGE_BYTES) {
    throw new HttpError(413, `Image exceeds ${MAX_IMAGE_BYTES} bytes.`)
  }
  if (!ALLOWED_IMAGE_MIME_TYPES.has(input.contentType.toLowerCase())) {
    throw new HttpError(415, `Unsupported content type ${input.contentType}.`)
  }

  const catalogGroupId = await resolveCatalogGroupIdForSweedGroup(input.sweedGroupId)

  const store = getPendingImageUploadStore()
  const { stagedRef } = await store.put({
    bytes: input.fileBytes,
    meta: {
      contentType: input.contentType,
      groupId: input.sweedGroupId, // legacy alias kept for the meta sidecar
      originalFilename: input.originalFilename,
      requestedByUserId: input.requestedByUserId,
      sweedGroupId: input.sweedGroupId,
      targetType: 'group',
    },
  })

  const jobId = await enqueueJob(getPool(), {
    concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
    dedupeKey: `catalog.maintenance.upload_group_image:${stagedRef}`,
    jobType: 'catalog.maintenance.upload_group_image',
    module: 'catalog',
    payload: {
      stagedRef,
      catalogGroupId,
      sweedGroupId: input.sweedGroupId,
      requestedByUserId: input.requestedByUserId,
    },
    requestedByUserId: input.requestedByUserId,
    scope: null,
  })

  // Don't invalidate the survey cache yet — the upload is only
  // queued. The client polls /api/jobs/:id and force-refreshes the
  // survey when the job transitions to `succeeded`.
  return { jobId, stagedRef }
}

export interface RetryGroupImageUploadInput {
  stagedRef: string
  requestedByUserId: number | null
}

export interface RetryGroupImageUploadResult {
  jobId: number
  stagedRef: string
  sweedGroupId: number
}

export async function retryGroupImageUploadJob(
  input: RetryGroupImageUploadInput,
): Promise<RetryGroupImageUploadResult> {
  const store = getPendingImageUploadStore()
  let staged: Awaited<ReturnType<typeof store.read>>
  try {
    staged = await store.read(input.stagedRef)
  } catch (error) {
    throw new HttpError(
      404,
      `Staged image ${input.stagedRef} no longer exists; the upload likely ` +
        `succeeded already or was garbage-collected. Re-select the file and upload again. ` +
        `(${(error as Error).message})`,
    )
  }

  const catalogGroupId = await resolveCatalogGroupIdForSweedGroup(staged.meta.sweedGroupId)

  const jobId = await enqueueJob(getPool(), {
    concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
    dedupeKey: `catalog.maintenance.upload_group_image:${input.stagedRef}`,
    jobType: 'catalog.maintenance.upload_group_image',
    module: 'catalog',
    payload: {
      stagedRef: input.stagedRef,
      catalogGroupId,
      sweedGroupId: staged.meta.sweedGroupId,
      requestedByUserId: input.requestedByUserId,
    },
    requestedByUserId: input.requestedByUserId,
    scope: null,
  })

  return { jobId, stagedRef: input.stagedRef, sweedGroupId: staged.meta.sweedGroupId }
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
  const result = await withSweedSession(async () => {
    const stateDealerId = getServerEnv().sweedStateDealerId
    await callSweedRpc(stateDealerId, 'store.product.edit', {
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

/* -------------------------------------------------------------------------- */
/*  Move-package-to-inspection — write path.                                   */
/*                                                                            */
/*  See docs/sweed/stock-item-transfer.md for the RPC shapes. This            */
/*  function chains store.stock.location.list →                                */
/*  store.inventory.product.item.list → store.inventory.item.transfer         */
/*  inside one withSweedSession block so the dealer context is pinned         */
/*  for the whole operation. If the operator-clicked package can no longer    */
/*  be located by its METRC tag (Sweed has already moved or consumed it),     */
/*  we fall back to draining every remaining lot of the variant into the     */
/*  inspection bin per the stated intent ("stop trying to sell it").          */
/* -------------------------------------------------------------------------- */

/**
 * The canonical "Hold for Dave inspection" location name (Sweed
 * presents it as "NOT FOR SALE - Hold for Dave inspection" on the
 * demo dealer). We match case-insensitively on this substring so
 * minor naming drift between sites still works. If a dealer simply
 * does not have such a location configured the move endpoint
 * returns a 409 — we will not silently invent a target.
 */
const INSPECTION_LOCATION_NAME_NEEDLE = 'hold for dave inspection'

const StockLocationListEntrySchema = z
  .object({
    id: z.coerce.number().int(),
    name: z.string().nullable().optional(),
    enabled: z.boolean().nullable().optional(),
    stockType: z
      .object({
        id: z.coerce.number().int(),
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()

const StockLocationListResponseSchema = z.union([
  z.array(StockLocationListEntrySchema),
  z.object({ data: z.array(StockLocationListEntrySchema).default([]) }).passthrough().transform((v) => v.data),
])

const InventoryProductItemSchema = z
  .object({
    id: z.union([z.coerce.number().int(), z.string().trim().min(1)]),
    externalTrackCode: z.string().nullable().optional(),
    availableQty: z.coerce.number().nullable().optional(),
    currentQty: z.coerce.number().nullable().optional(),
    isTradeSample: z.boolean().nullable().optional(),
    stockLocation: z
      .object({
        id: z.coerce.number().int(),
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    stockType: z
      .object({
        id: z.coerce.number().int(),
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()

const InventoryProductItemListResponseSchema = z
  .object({
    result: z
      .object({
        data: z.array(InventoryProductItemSchema).default([]),
        totalCount: z.coerce.number().int().min(0).optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    data: z.array(InventoryProductItemSchema).optional(),
  })
  .passthrough()
  .transform((value) => value.result?.data ?? value.data ?? [])

export interface MovePackageToInspectionInput {
  siteDealerId: number
  productId: number
  externalTrackCode: string
  expectedItemId: string | null
  expectedLocationName: string | null
  requestedByUserId: number | null
}

export interface MovePackageToInspectionResult extends CatalogMaintenanceMovePackageResponse {}

export async function movePackageToInspection(
  input: MovePackageToInspectionInput,
): Promise<MovePackageToInspectionResult> {
  // Ensure the requested site is one we know about. (Random dealer
  // ids would otherwise sail straight through to Sweed and either
  // 403 or — worse — succeed against the wrong store.)
  const site = HELIOS_PENDING_PURCHASE_SITE_DEALERS.find((s) => s.dealerId === input.siteDealerId)
  if (!site) {
    throw new HttpError(400, `Unknown siteDealerId=${input.siteDealerId}.`)
  }

  const normalizedTag = input.externalTrackCode.trim()
  if (normalizedTag.length === 0) {
    throw new HttpError(400, 'externalTrackCode must be non-empty.')
  }

  const result = await withSweedSession(async () => {
    // 1. List stock locations for this dealer and locate the
    //    inspection bin by name.
    const locationsRaw = await callSweedRpc<unknown>(input.siteDealerId, 'store.stock.location.list', {})
    const locations = StockLocationListResponseSchema.parse(extractRpcResult(locationsRaw))
    const target = locations.find(
      (loc) =>
        typeof loc.name === 'string' &&
        loc.name.trim().toLowerCase().includes(INSPECTION_LOCATION_NAME_NEEDLE),
    )
    if (!target || typeof target.name !== 'string' || target.stockType?.id === undefined) {
      throw new HttpError(
        409,
        `Dealer ${input.siteDealerId} has no stock location matching "${INSPECTION_LOCATION_NAME_NEEDLE}". ` +
          `Found ${locations.length} location(s): ${locations.map((l) => l.name ?? '?').join(', ')}.`,
      )
    }
    const targetLocationId = target.id
    const targetLocationName = target.name
    const targetStockTypeId = target.stockType.id

    // 2. Live-list lots for this product so we can resolve the exact
    //    inventory item id for the operator's METRC tag.
    const itemsRaw = await callSweedRpc<unknown>(input.siteDealerId, 'store.inventory.product.item.list', {
      productId: String(input.productId),
      page: 1,
      pageSize: 50,
      isOnStock: true,
    })
    const items = InventoryProductItemListResponseSchema.parse(itemsRaw)

    if (items.length === 0) {
      // Nothing live in Sweed for this product — operator probably
      // already moved/sold it. Treat as success-no-op; the cache
      // refresh from invalidateCatalogMaintenanceSurvey() below will
      // get the variant off the page.
      return {
        outcome: 'nothing-to-move' as CatalogMaintenanceMovePackageOutcome,
        targetLocationId,
        targetLocationName,
        movedLots: [] as CatalogMaintenanceMovedLot[],
      }
    }

    const matchByTag = items.filter(
      (item) =>
        typeof item.externalTrackCode === 'string' &&
        item.externalTrackCode.trim() === normalizedTag,
    )

    // 3a. Happy path: the specific METRC-tagged lot still exists.
    if (matchByTag.length > 0) {
      const movedLots: CatalogMaintenanceMovedLot[] = []
      for (const item of matchByTag) {
        const moved = await transferOneLotToInspection({
          siteDealerId: input.siteDealerId,
          item,
          targetLocationId,
          targetStockTypeId,
        })
        if (moved) movedLots.push(moved)
      }
      return {
        outcome: 'moved-target-lot' as CatalogMaintenanceMovePackageOutcome,
        targetLocationId,
        targetLocationName,
        movedLots,
      }
    }

    // 3b. Fallback: METRC tag no longer present (Sweed has moved or
    //     consumed it). Drain every remaining lot of this product into
    //     the inspection bin so the operator's intent — get the variant
    //     off the floor — is honored even with a stale cache.
    const movedLots: CatalogMaintenanceMovedLot[] = []
    for (const item of items) {
      const moved = await transferOneLotToInspection({
        siteDealerId: input.siteDealerId,
        item,
        targetLocationId,
        targetStockTypeId,
      })
      if (moved) movedLots.push(moved)
    }
    return {
      outcome: 'moved-fallback-all-lots' as CatalogMaintenanceMovePackageOutcome,
      targetLocationId,
      targetLocationName,
      movedLots,
    }
  })

  // Refresh the page on next survey load — the cached response now
  // includes the moved lots in "FOR SALE …", which is stale.
  await invalidateCatalogMaintenanceSurvey()
  void input.requestedByUserId
  return result
}

interface TransferOneLotInput {
  siteDealerId: number
  item: z.infer<typeof InventoryProductItemSchema>
  targetLocationId: number
  targetStockTypeId: number
}

async function transferOneLotToInspection(input: TransferOneLotInput): Promise<CatalogMaintenanceMovedLot | null> {
  const { item, siteDealerId, targetLocationId, targetStockTypeId } = input
  const fromLocationId = item.stockLocation?.id
  const fromLocationName = item.stockLocation?.name ?? null
  const fromStockTypeId = item.stockType?.id
  const qty =
    typeof item.availableQty === 'number'
      ? item.availableQty
      : typeof item.currentQty === 'number'
        ? item.currentQty
        : 0
  if (qty <= 0 || fromLocationId === undefined || fromStockTypeId === undefined) {
    // Nothing actually movable (qty 0 or missing source bucket).
    return null
  }
  if (fromLocationId === targetLocationId && fromStockTypeId === targetStockTypeId) {
    // Already in inspection — silently no-op so the operator can
    // re-click the button without errors.
    return null
  }
  await callSweedRpc(siteDealerId, 'store.inventory.item.transfer', {
    stockTypeFrom: fromStockTypeId,
    stockLocationFrom: fromLocationId,
    stockTypeTo: targetStockTypeId,
    stockLocationTo: targetLocationId,
    transferReservedItems: false,
    items: [
      {
        id: String(item.id),
        qty,
        externalTrackCode: item.externalTrackCode ?? null,
      },
    ],
  })
  return {
    itemId: String(item.id),
    externalTrackCode: nonEmptyString(item.externalTrackCode ?? null),
    qty,
    fromStockLocationId: fromLocationId,
    fromStockLocationName: fromLocationName ?? `#${fromLocationId}`,
    fromStockTypeId,
  }
}

/**
 * Sweed RPC responses are sometimes returned as
 * `{ result: <payload>, id, version }` and sometimes as the bare
 * `<payload>`. Our transport in `postSweedRpc` returns whatever the
 * server sent, so callers that need the inner payload (location.list
 * for example) tolerate both shapes via this helper.
 */
function extractRpcResult(raw: unknown): unknown {
  if (raw !== null && typeof raw === 'object' && 'result' in (raw as Record<string, unknown>)) {
    return (raw as { result: unknown }).result
  }
  return raw
}

async function fetchGroupImagesWithinLock(groupId: number): Promise<z.infer<typeof SweedGroupImagesSchema>> {
  const stateDealerId = getServerEnv().sweedStateDealerId
  const raw = await callSweedRpc(stateDealerId, 'store.product.group.get', { id: groupId })
  return SweedGroupImagesSchema.parse(raw)
}

async function fetchProductImagesWithinLock(productId: number): Promise<z.infer<typeof SweedProductImagesSchema>> {
  const stateDealerId = getServerEnv().sweedStateDealerId
  const raw = await callSweedRpc(stateDealerId, 'store.product.get', { id: String(productId) })
  return SweedProductImagesDetailSchema.parse(raw)
}

function collectExistingImageIds(images: Array<z.infer<typeof SweedImageRefSchema>>): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const image of images) {
    const id = normalizeImageId(image)
    if (id === null || seen.has(id)) continue
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
  const raw = await callSweedRpc(stateDealerId, 'store.blob.add', { type: 'banner' })
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
    if (typeof image.url === 'string' && image.url.length > 0) return image.url
  }
  return null
}

function normalizeImageId(image: z.infer<typeof SweedImageRefSchema>): string | null {
  if (image.id === undefined || image.id === null) return null
  return String(image.id)
}

function describeImageIds(images: Array<z.infer<typeof SweedImageRefSchema>>): string {
  if (images.length === 0) return '[]'
  const ids = images.map((image) => normalizeImageId(image) ?? '<no-id>')
  return `[${ids.join(', ')}]`
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
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

export async function flagSweedGroupForReanalysis(input: FlagForReanalysisInput): Promise<number | null> {
  const db: Queryable = getPool()
  const lookup = await db.query<{ id: number }>(
    `select id from catalog_groups where sweed_group_id = $1 and deleted_at is null limit 1`,
    [input.sweedGroupId],
  )
  const catalogGroupId = lookup.rows[0]?.id ?? null
  if (catalogGroupId === null) return null

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
/*  Sweed RPC plumbing — pooled session via withSweedSession().                */
/*  All Sweed RPCs from this module run inside withSweedSession() blocks so   */
/*  they lease a token from sweed_session_tokens (claimed for the duration    */
/*  of the call), pin the dealer once per session, and release the token in   */
/*  `finally`. Empty-pool deferral and dead-token retirement are handled by   */
/*  src/worker/sweed/session.ts and src/worker/sweed/transport.ts; this       */
/*  module no longer touches SWEED_AUTH_TOKEN directly.                       */
/* -------------------------------------------------------------------------- */

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export const _SWEED_WRITE_CONCURRENCY_KEY = SWEED_SESSION_CONCURRENCY_KEY
