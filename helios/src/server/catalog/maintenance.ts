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

import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import {
  buildCatalogGroupModuleScope,
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type CatalogMaintenanceCacheRepairResponse,
  type CatalogMaintenanceFatalBanner,
  type CatalogMaintenanceFatalReason,
  type CatalogMaintenanceFatalReasonCode,
  type CatalogMaintenanceQuickFilterBrand,
  type CatalogMaintenanceSiteGroup,
  type CatalogMaintenanceSiteVariant,
  type CatalogMaintenanceSurveyMeta,
  type CatalogMaintenanceSurveyResponse,
  type CatalogMaintenanceSurveySection,
  type CatalogMaintenanceSurveySite,
  type HeliosPendingPurchaseSiteDealer,
} from '../../shared/contracts/index.js'
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

const BARCODE_MIN_DIGITS = 8
const BARCODE_PLACEHOLDER_PREFIX = '000000'

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

interface CachedSurvey {
  expiresAt: number
  value: CatalogMaintenanceSurveyResponse
}

let cachedSurvey: CachedSurvey | null = null
let inFlightSurvey: Promise<CatalogMaintenanceSurveyResponse> | null = null
let sweedWriteQueue: Promise<void> = Promise.resolve()
let sweedWriteDealerId: number | null = null

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
    const missingVariantImage: CatalogMaintenanceSiteGroup[] = []
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
      // Variants missing their own image (for the variant section we only
      // include the variants that are actually in stock at this site AND
      // lack a variant-specific image AND there's more than one in-stock
      // variant for the group at this site).
      const variantsNeedingOwnImage =
        entries.length >= 2
          ? entries.filter((entry) => entry.product.variantSpecificImageCount === 0)
          : []
      // Variants whose barcode is missing or invalid (for any in-stock
      // variant). Like the missing-METRC check, this is only an error
      // condition for cannabis categories — Accessories / Other groups are
      // skipped entirely (no warning either).
      const barcodeIssueVariants = isCannabisCategory(indexed.categoryName)
        ? entries.filter((entry) => classifyBarcode(entry.product.externalBarcode).status !== 'ok')
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

      if (variantsNeedingOwnImage.length > 0 && !groupNeedsCatalogImage) {
        const onlyAffected = variantsForGroupCard.filter((v) => variantsNeedingOwnImage.some((e) => e.product.productId === v.productId))
        missingVariantImage.push(
          buildSiteGroupCard({
            parsedGroup: indexed,
            site,
            entries: variantsNeedingOwnImage,
            variantsForGroupCard: onlyAffected,
          }),
        )
        countBrandIssue(brandIssueCounts, indexed.brandName, variantsNeedingOwnImage.length)
      }

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
    sortSiteGroups(missingVariantImage)
    sortSiteGroups(missingBarcode)

    const sections: CatalogMaintenanceSurveySection[] = [
      {
        kind: 'missing-catalog-image',
        label: 'Missing catalog image',
        targetId: sectionAnchorId(site.siteKey, 'missing-catalog-image'),
        issueCount: missingCatalogImage.length,
        groups: missingCatalogImage,
      },
      {
        kind: 'missing-variant-image',
        label: 'Missing variant image',
        targetId: sectionAnchorId(site.siteKey, 'missing-variant-image'),
        issueCount: missingVariantImage.length,
        groups: missingVariantImage,
      },
      {
        kind: 'missing-or-invalid-barcode',
        label: 'Missing or invalid package barcode',
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
    categoryName: parsedGroup.categoryName,
    subcategoryName: parsedGroup.subcategoryName,
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
  if (value === null) {
    return { status: 'missing', reason: 'No barcode on file.' }
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return { status: 'missing', reason: 'Barcode is empty.' }
  }
  if (!/^\d+$/.test(trimmed)) {
    return { status: 'invalid', reason: 'Barcode contains non-digit characters.' }
  }
  if (trimmed.length < BARCODE_MIN_DIGITS) {
    return { status: 'invalid', reason: `Barcode is shorter than ${BARCODE_MIN_DIGITS} digits.` }
  }
  if (trimmed.startsWith(BARCODE_PLACEHOLDER_PREFIX)) {
    return { status: 'invalid', reason: 'Barcode looks like a placeholder (000000…).' }
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
      const matching = refreshed.images.filter((image) => normalizeImageId(image) === blobId)
      if (matching.length === 0) {
        throw new HttpError(
          502,
          `Sweed accepted store.product.group.edit for group ${input.groupId} but the new image blob ${blobId} is not present in the refreshed image list (got ${describeImageIds(refreshed.images)}). The upload did NOT take effect.`,
        )
      }
      const blobUrl = pickRawPreviewUrl(matching)
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
      // Re-fetch *every* variant after the edit and verify the new blob
      // is actually attached. Sweed's `store.product.edit` does not return
      // a body that reflects the post-edit image list, and historically
      // some product fields are silently ignored. Without this read-back
      // a successful HTTP 200 would mask a no-op write and the operator
      // would see nothing change in Sweed.
      const refreshed = await fetchProductImagesWithinLock(productId)
      const matching = refreshed.images.filter((image) => normalizeImageId(image) === blobId)
      if (matching.length === 0) {
        throw new HttpError(
          502,
          `Sweed accepted store.product.edit for variant ${productId} but the new image blob ${blobId} is not present in the refreshed image list (got ${describeImageIds(refreshed.images)}). The upload did NOT take effect — likely Sweed does not accept \`imagesIds\` for variants and we need a different RPC / field name.`,
        )
      }
      affectedProductIds.push(productId)
      if (blobUrl === null) {
        blobUrl = pickRawPreviewUrl(matching)
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

async function flagSweedGroupForReanalysis(input: FlagForReanalysisInput): Promise<number | null> {
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
  if (sweedWriteDealerId === dealerId) return
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
  if (normalized.length <= 240) return normalized
  return `${normalized.slice(0, 239)}…`
}

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export const _SWEED_WRITE_CONCURRENCY_KEY = SWEED_SESSION_CONCURRENCY_KEY
