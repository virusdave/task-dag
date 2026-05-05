import { execFile } from 'node:child_process'
import { rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { closePool } from '../src/server/db/pool.js'
import { buildEmptyGroupRecentSales, loadRecentSalesForGroups } from '../src/server/catalog/liveRecentSales.js'
import { HELIOS_PENDING_PURCHASE_SITE_DEALERS } from '../src/shared/contracts/domain/pendingPurchases.js'
import type { GroupRecentSales, GroupRecentSalesProductRow, RecentSalesSummary } from '../src/shared/contracts/api/catalog.js'
import {
  normalizeCatalogGroupDetail,
  type NormalizedCatalogGroupLiveState,
} from '../src/worker/catalog/liveState.js'
import { getWorkerEnv } from '../src/worker/config/env.js'
import {
  buildBrandMetadataRef,
  buildPacketRowHierarchy,
  type PacketRowHierarchy,
  type PricingReviewBrandMetadataRef,
} from './bronxMidtownPricingReviewShared.js'
import { renderReviewTreeNav, type ReviewTreeNavNode } from '../../ui/controls/tree-nav/renderReviewTreeNav.js'
import {
  buildPricingPlan,
  type GeneratedPricingLineItem,
  type PricingMarketContext,
  type ProductPricingMarketEvidence,
  type SkippedPricingProduct,
} from '../src/worker/pricing/deterministicPricing.js'
import { buildPricingFamilyContext, type PricingFamilyContext, type ProductPricingFamilyEvidence } from '../src/worker/pricing/familyPricing.js'
import { buildPricingMarketContextWithFailureHandling } from '../src/worker/pricing/litAlertsMarket.js'
import { loadMidtownReceivedProductScope } from '../src/worker/pricing/productScope.js'

const execFileAsync = promisify(execFile)

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ONE_OFF_OUTPUT_ROOT = resolve(SCRIPT_DIR, '../../bulk_additions/2026-04-18')
const DEFAULT_PACKET_DIR = join(ONE_OFF_OUTPUT_ROOT, 'bronx_midtown_full_catalog_pricing_review_packet')
const PACKET_JSON_PATH = join(DEFAULT_PACKET_DIR, 'packet.json')
const PACKET_UI_SOURCE_PATH = join(SCRIPT_DIR, 'reviewPacketUi.js')
const REVIEW_TREE_NAV_SOURCE_PATH = resolve(SCRIPT_DIR, '../../ui/controls/tree-nav/reviewTreeNav.js')
const GROUP_PROCESSING_CONCURRENCY = 6
const POST_TAX_MULTIPLIER = 1.13
const PRICE_EPSILON = 0.009
const QUARTER_INCREMENT = 0.25

interface PacketPricingBandConfig {
  fallbackTargetGmPercent: number
  maxGmPercent: number
  minGmPercent: number
}

const MSO_PACKET_PRICING_BAND: PacketPricingBandConfig = {
  fallbackTargetGmPercent: 67.2,
  maxGmPercent: 67.7,
  minGmPercent: 62.5,
}

interface PacketArtifactPaths {
  detailsDir: string
  indexHtmlPath: string
  packetDir: string
  packetJsonPath: string
  packetUiOutputPath: string
  reviewTreeNavOutputPath: string
  zipPath: string
}

type SiteKey = (typeof HELIOS_PENDING_PURCHASE_SITE_DEALERS)[number]['siteKey']

interface SiteScopeMetrics {
  averageDailySold: number | null
  currentQty: number | null
  daysLeft: number | null
  inStockQty: number | null
  lastReceivedDate: string | null
  last30DaysQtySold: number | null
  orderIds: number[]
  price: number | null
  receivedOrderCount: number
  receivedPositionCount: number
  recentOos: boolean
}

interface ScopedProductSiteSummary {
  siteKey: SiteKey
  siteLabel: string
  metrics: SiteScopeMetrics
}

interface ScopedProductAggregate {
  productId: number
  sites: Partial<Record<SiteKey, ScopedProductSiteSummary>>
}

interface ScopedCatalogGroup {
  brandName: string | null
  categoryName: string | null
  groupFullName: string
  groupId: number
  groupName: string
  lastSyncedAt: string | null
  liveState: NormalizedCatalogGroupLiveState
  scopedProductIds: Set<number>
  subcategoryName: string | null
}

interface PacketGroup {
  brandName: string | null
  categoryName: string | null
  currentGroupCount: number
  currentProductCount: number
  generatedProducts: PacketRow[]
  groupName: string
  lastSyncedAt: string | null
  marketAvailability: PricingMarketContext['availability']
  marketNote: string | null
  scopedProductCount: number
  subcategoryName: string | null
  catalogGroupId: number
}

interface PacketProductRecentSales {
  sites: GroupRecentSalesProductRow[]
  summary: RecentSalesSummary
}

interface PacketRow {
  actionLabel: string
  actionType: 'keep' | 'lower' | 'raise' | 'set' | 'warning'
  averageCompetitorPostTaxPrice: number | null
  averageCompetitorPreTaxPrice: number | null
  brand: string | null
  brandMetadata: PricingReviewBrandMetadataRef
  category: string | null
  currentGmPercent: number | null
  currentPrice: number | null
  detailHref: string
  familyAnchor: ProductPricingFamilyEvidence | null
  groupId: number
  groupName: string
  hierarchy: PacketRowHierarchy
  imageUrl: string | null
  isActionable: boolean
  marketAvailability: PricingMarketContext['availability']
  marketEvidence: ProductPricingMarketEvidence | null
  marketNote: string | null
  productId: number
  productName: string
  proposedGmPercent: number | null
  proposedPrice: number | null
  recentSales: PacketProductRecentSales
  reason: string
  scopeBadges: string[]
  scopeNotes: string[]
  siteScope: ScopedProductSiteSummary[]
  subcategory: string | null
  tab: string
  wholesaleCost: number | null
}

interface PacketReport {
  packetId: string
  generatedAt: string
  recentSalesIssue: string | null
  scopeDefinition: string
  scopeSummary: {
    excludedProductCount: number
    excludedProductIds: number[]
    liveSupplementedProductCount: number
    liveSupplementedProductIds: number[]
    missingMirroredProductCount: number
    missingMirroredProductIds: number[]
    receivedOrderCount: number
    scopedCatalogGroupCount: number
    scopedProductCount: number
    siteBreakdown: Array<{
      latestReceivedDate: string | null
      positionCount: number
      productCount: number
      receivedOrderCount: number
      siteKey: SiteKey
      siteLabel: string
    }>
  }
  summary: {
    groupCount: number
    keepPriceCount: number
    lowerCount: number
    marketEvidenceCount: number
    missingCostCount: number
    productCount: number
    raiseCount: number
    reviewRowCount: number
    setCount: number
  }
  groups: PacketGroup[]
}

interface PacketNavigationNode {
  childCount: number
  children: PacketNavigationNode[]
  key: string
  label: string
  level: 'brand' | 'category' | 'subcategory' | 'variant'
  targetId: string
}

interface RawRpcEnvelope<TResult> {
  error?: { message?: string }
  result?: TResult
}

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2))
  if (cli.renderFromJsonPath) {
    const artifactPaths = buildArtifactPaths(cli.renderFromJsonPath)
    progress(`Re-rendering pricing packet UI from locked snapshot ${artifactPaths.packetJsonPath}`)
    const report = hydratePacketHierarchy(JSON.parse(await readFile(artifactPaths.packetJsonPath, 'utf8')) as PacketReport)
    await writePacket(report, artifactPaths)
    await zipPacket(artifactPaths)
    progress(`Packet UI refreshed from snapshot at ${artifactPaths.indexHtmlPath}`)
    await closePool()
    return
  }

  const artifactPaths = buildArtifactPaths(PACKET_JSON_PATH)
  const startedAt = Date.now()
  progress('Collecting Midtown ever-received purchase-history scope')
  const scopedProducts = await buildScopedProductMap()
  progress(`Resolved ${scopedProducts.size} unique scoped product ids from Midtown received purchase history`)

  progress('Hydrating scoped packet catalog groups directly from live Sweed')
  const { groups, liveSupplementedProductIds, missingMirroredProductIds, missingProductIds } = await loadScopedGroups(scopedProducts)
  progress(
    `Hydrated ${groups.length} live catalog groups for the scoped packet; `
    + `${missingProductIds.length} scoped product ids remain unresolved`,
  )

  progress('Loading shared recent-sales velocity summaries for scoped groups')
  const recentSalesByGroupId = await loadPacketRecentSales(groups)

  progress('Resolving scoped distributor-product costs from live state catalog pricing')
  const distributorProductCosts = await loadDistributorProductCosts(groups)
  progress(`Resolved nonzero distributor-product costs for ${distributorProductCosts.size} scoped products`)

  progress('Building pricing plans and review rows')
  const packetGroups = await mapWithConcurrency(groups, GROUP_PROCESSING_CONCURRENCY, async (group, index) => {
    const packetGroup = await buildPacketGroup(
      group,
      scopedProducts,
      distributorProductCosts,
      recentSalesByGroupId.get(group.groupId) ?? buildEmptyGroupRecentSales(group.liveState),
    )
    if (index === 0 || (index + 1) % 25 === 0 || index + 1 === groups.length) {
      progress(`Processed ${index + 1}/${groups.length} catalog groups`)
    }
    return packetGroup
  })

  const filteredPacketGroups = packetGroups.filter((group): group is PacketGroup => group !== null)
  const report = await buildReport(
    filteredPacketGroups,
    scopedProducts,
    liveSupplementedProductIds,
    missingMirroredProductIds,
    missingProductIds,
    artifactPaths.packetJsonPath,
    null,
  )

  progress('Writing review packet artifacts')
  await writePacket(report, artifactPaths)
  await zipPacket(artifactPaths)

  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  progress(`Packet ready in ${elapsedSeconds}s at ${artifactPaths.indexHtmlPath}`)
  await closePool()
}

function parseCliArgs(argv: string[]): { renderFromJsonPath: string | null } {
  let renderFromJsonPath: string | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if ((argument === '--render-from-json' || argument === '--packet-json') && argv[index + 1]) {
      renderFromJsonPath = resolve(argv[index + 1] as string)
      index += 1
    }
  }

  return { renderFromJsonPath }
}

function buildArtifactPaths(packetJsonPath: string): PacketArtifactPaths {
  const packetDir = dirname(packetJsonPath)
  const outputRoot = dirname(packetDir)
  return {
    detailsDir: join(packetDir, 'details'),
    indexHtmlPath: join(packetDir, 'index.html'),
    packetDir,
    packetJsonPath,
    packetUiOutputPath: join(packetDir, 'review-packet-ui.js'),
    reviewTreeNavOutputPath: join(packetDir, 'review-tree-nav.js'),
    zipPath: join(outputRoot, `${basename(packetDir)}.zip`),
  }
}

async function buildScopedProductMap(): Promise<Map<number, ScopedProductAggregate>> {
  const receivedScope = await loadMidtownReceivedProductScope()
  const scopedProducts = new Map<number, ScopedProductAggregate>()

  for (const summary of receivedScope.productsById.values()) {
    const aggregate = ensureScopedProduct(scopedProducts, summary.productId)
    const siteSummary = ensureSiteSummary(aggregate, 'midtown', 'Midtown')
    siteSummary.metrics.lastReceivedDate = summary.lastReceivedDate
    siteSummary.metrics.orderIds = summary.orderIds
    siteSummary.metrics.receivedOrderCount = summary.orderCount
    siteSummary.metrics.receivedPositionCount = summary.positionCount
  }

  return scopedProducts
}

async function loadScopedGroups(scopedProducts: Map<number, ScopedProductAggregate>): Promise<{
  groups: ScopedCatalogGroup[]
  missingMirroredProductIds: number[]
  missingProductIds: number[]
  liveSupplementedProductIds: number[]
}> {
  const scopedProductIds = [...scopedProducts.keys()].sort((left, right) => left - right)
  const liveHydration = await loadLiveScopedGroups(scopedProductIds, scopedProducts)
  const groups = [...liveHydration.groups].sort(compareScopedCatalogGroups)
  const missingProductIds = scopedProductIds.filter((productId) => !liveHydration.resolvedProductIds.has(productId))
  return {
    groups,
    liveSupplementedProductIds: [],
    missingMirroredProductIds: [],
    missingProductIds,
  }
}

async function loadLiveScopedGroups(
  requestedProductIds: number[],
  scopedProducts: Map<number, ScopedProductAggregate>,
): Promise<{
  groups: ScopedCatalogGroup[]
  resolvedProductIds: Set<number>
}> {
  if (requestedProductIds.length === 0) {
    return {
      groups: [],
      resolvedProductIds: new Set(),
    }
  }

  return withSweedSessionLock(async () => {
    const env = getWorkerEnv()
    await ensureDealerContext(env.sweedStateDealerId)

    const requestedProductIdSet = new Set(requestedProductIds)
    const requestedProductIdsByGroupId = new Map<number, Set<number>>()

    for (const [index, productId] of requestedProductIds.entries()) {
      const detail = await callSweedRpcRaw<unknown>('store.product.get', { id: String(productId) })
      const groupId = resolveProductGroupId(detail)
      if (groupId === null) {
        throw new Error(`Scoped product ${productId} could not be mapped to a live product group.`)
      }
      const groupProductIds = requestedProductIdsByGroupId.get(groupId) ?? new Set<number>()
      groupProductIds.add(productId)
      requestedProductIdsByGroupId.set(groupId, groupProductIds)

      if (index === 0 || (index + 1) % 25 === 0 || index + 1 === requestedProductIds.length) {
        progress(`Resolved live product-group ids for ${index + 1}/${requestedProductIds.length} scoped packet products`)
      }
    }

    const groups: ScopedCatalogGroup[] = []
    const resolvedProductIds = new Set<number>()
    const sortedGroupIds = [...requestedProductIdsByGroupId.keys()].sort((left, right) => left - right)

    for (const [index, groupId] of sortedGroupIds.entries()) {
      const detail = await callSweedRpcRaw<unknown>('store.product.group.get', { id: groupId })
      const liveState = normalizeCatalogGroupDetail(detail)
      const scopedProductIds = new Set(liveState.products.map((product) => product.productId).filter((productId) => scopedProducts.has(productId)))
      if (scopedProductIds.size === 0) {
        const requestedGroupProductIds = [...(requestedProductIdsByGroupId.get(groupId) ?? [])].sort((left, right) => left - right)
        throw new Error(
          `Live product group ${groupId} did not contain any scoped packet products while hydrating requested ids ${requestedGroupProductIds.join(', ')}.`,
        )
      }

      for (const productId of scopedProductIds) {
        if (requestedProductIdSet.has(productId)) {
          resolvedProductIds.add(productId)
        }
      }

      groups.push({
        brandName: liveState.brand,
        categoryName: liveState.category,
        groupFullName: liveState.groupFullName,
        groupId: liveState.groupId,
        groupName: liveState.groupName,
        lastSyncedAt: null,
        liveState,
        scopedProductIds,
        subcategoryName: liveState.subcategory,
      })

      if (index === 0 || (index + 1) % 25 === 0 || index + 1 === sortedGroupIds.length) {
        progress(`Hydrated ${index + 1}/${sortedGroupIds.length} live catalog groups for the scoped packet`)
      }
    }

    return {
      groups,
      resolvedProductIds,
    }
  })
}

function resolveProductGroupId(detail: unknown): number | null {
  const payload = asRecord(detail)
  const product = asRecord(payload?.product ?? detail)
  return asNumber(product?.productGroupId) ?? null
}

function compareScopedCatalogGroups(left: ScopedCatalogGroup, right: ScopedCatalogGroup): number {
  return compareNullableText(left.categoryName, right.categoryName)
    || compareNullableText(left.subcategoryName, right.subcategoryName)
    || compareNullableText(left.brandName, right.brandName)
    || left.groupName.localeCompare(right.groupName)
    || left.groupId - right.groupId
}

function compareNullableText(left: string | null, right: string | null): number {
  if (left === right) {
    return 0
  }
  if (left === null) {
    return 1
  }
  if (right === null) {
    return -1
  }
  return left.localeCompare(right)
}

async function buildPacketGroup(
  group: ScopedCatalogGroup,
  scopedProducts: Map<number, ScopedProductAggregate>,
  distributorProductCosts: Map<number, number>,
  groupRecentSales: GroupRecentSales,
): Promise<PacketGroup | null> {
  const liveState = hydrateLiveStateWithDistributorCosts(group.liveState, distributorProductCosts)
  const familyContext = await buildPricingFamilyContext(liveState)
  const marketContext = await buildPricingMarketContextWithFailureHandling({
    failureContext: 'Bronx + Midtown pricing packet generation failed',
    liveState,
    shouldPageOnFailure: () => true,
  })
  const fullPlan = buildPricingPlan(liveState, marketContext, familyContext)

  const generatedById = new Map<number, GeneratedPricingLineItem>(
    fullPlan.generatedLineItems.map((lineItem) => [lineItem.productId, lineItem]),
  )
  const skippedById = new Map<number, SkippedPricingProduct>(
    fullPlan.skippedProducts.map((product) => [product.productId, product]),
  )

  const rows: PacketRow[] = []
  for (const product of liveState.products) {
    if (!group.scopedProductIds.has(product.productId)) {
      continue
    }
    const generated = generatedById.get(product.productId) ?? null
    const skipped = skippedById.get(product.productId) ?? null
    const scope = scopedProducts.get(product.productId)
    if (!scope) {
      continue
    }
    rows.push(buildPacketRow(
      { ...group, liveState },
      product,
      generated,
      skipped,
      scope,
      marketContext,
      familyContext,
      buildPacketProductRecentSales(groupRecentSales, product.productId),
    ))
  }

  if (rows.length === 0) {
    return null
  }

  return {
    brandName: group.brandName,
    categoryName: group.categoryName,
    currentGroupCount: 1,
    currentProductCount: liveState.products.length,
    generatedProducts: rows.sort(comparePacketRows),
    groupName: group.groupFullName || group.groupName,
    lastSyncedAt: group.lastSyncedAt,
    marketAvailability: marketContext.availability,
    marketNote: marketContext.note,
    scopedProductCount: rows.length,
    subcategoryName: group.subcategoryName,
    catalogGroupId: group.groupId,
  }
}

async function loadDistributorProductCosts(
  groups: ScopedCatalogGroup[],
): Promise<Map<number, number>> {
  const productIds = [...new Set(groups.flatMap((group) => [...group.scopedProductIds]))].sort((left, right) => left - right)
  if (productIds.length === 0) {
    return new Map()
  }

  return withSweedSessionLock(async () => {
    const env = getWorkerEnv()
    await ensureDealerContext(env.sweedStateDealerId)

    const costs = new Map<number, number>()
    for (const [index, productId] of productIds.entries()) {
      const payload = await callSweedRpcRaw<{
        data?: Array<Record<string, unknown>>
        productRecentPrices?: Array<Record<string, unknown>>
      }>('store.distributor.product.list', {
        page: 1,
        pageSize: 1000,
        productId,
      })

      const resolvedCost = resolveDistributorProductCost(payload)
      if (resolvedCost !== null && resolvedCost > 0) {
        costs.set(productId, resolvedCost)
      }

      if ((index + 1) % 100 === 0 || index + 1 === productIds.length) {
        progress(`Resolved distributor-product prices for ${index + 1}/${productIds.length} scoped products`)
      }
    }

    return costs
  })
}

function resolveDistributorProductCost(payload: {
  data?: Array<Record<string, unknown>>
  productRecentPrices?: Array<Record<string, unknown>>
}): number | null {
  const mostRecentPrice = [...(payload.productRecentPrices ?? [])]
    .sort((left, right) => Number(Boolean(right.isMostRecent)) - Number(Boolean(left.isMostRecent)))
    .map((row) => asNumber(row.price))
    .find((price): price is number => price !== null && price > 0)
  if (mostRecentPrice !== undefined) {
    return mostRecentPrice
  }

  const datedCandidates = (payload.data ?? []).flatMap((row) => {
    const price = asNumber(row.price)
    if (price === null || price <= 0) {
      return []
    }
    const priceLists = Array.isArray(row.pricesLists) ? row.pricesLists : []
    const latestFromDate = priceLists
      .map((entry) => asString(asRecord(entry)?.fromDate))
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? null
    return [{ latestFromDate, price }]
  })

  if (datedCandidates.length === 0) {
    return null
  }

  datedCandidates.sort((left, right) => {
    if (left.latestFromDate === right.latestFromDate) {
      return right.price - left.price
    }
    if (left.latestFromDate === null) {
      return 1
    }
    if (right.latestFromDate === null) {
      return -1
    }
    return right.latestFromDate.localeCompare(left.latestFromDate)
  })

  return datedCandidates[0]?.price ?? null
}

function hydrateLiveStateWithDistributorCosts(
  liveState: NormalizedCatalogGroupLiveState,
  distributorProductCosts: Map<number, number>,
): NormalizedCatalogGroupLiveState {
  return {
    ...liveState,
    products: liveState.products.map((product) => {
      const distributorCost = distributorProductCosts.get(product.productId)
      const wholesaleCost = distributorCost ?? normalizeWholesaleCost(product.wholesaleCost)
      return {
        ...product,
        gmPercent: calculateGrossMarginPercent(product.price, wholesaleCost),
        wholesaleCost,
      }
    }),
  }
}

function normalizeWholesaleCost(value: number | null): number | null {
  if (value === null || value <= 0) {
    return null
  }
  return value
}

function calculateGrossMarginPercent(price: number | null, wholesaleCost: number | null): number | null {
  if (price === null || wholesaleCost === null || price <= 0) {
    return null
  }

  return Math.round((1 - (POST_TAX_MULTIPLIER * wholesaleCost) / price) * 10000) / 100
}

function buildPacketRow(
  group: {
    groupId: number
    groupName: string
    groupFullName: string
    liveState: NormalizedCatalogGroupLiveState
  },
  product: NormalizedCatalogGroupLiveState['products'][number],
  generated: GeneratedPricingLineItem | null,
  skipped: SkippedPricingProduct | null,
  scope: ScopedProductAggregate,
  marketContext: PricingMarketContext,
  familyContext: PricingFamilyContext,
  recentSales: PacketProductRecentSales,
): PacketRow {
  const hierarchy = buildPacketRowHierarchy({
    brand: group.liveState.brand,
    category: group.liveState.category,
    subcategory: group.liveState.subcategory,
    variant: product.tab,
  })
  const siteScope = Object.values(scope.sites)
    .filter((entry): entry is ScopedProductSiteSummary => Boolean(entry))
    .sort((left, right) => left.siteLabel.localeCompare(right.siteLabel))
  const scopeBadges: string[] = []
  const scopeNotes: string[] = []
  for (const site of siteScope) {
    if (site.metrics.receivedOrderCount > 0) {
      scopeBadges.push(`${site.siteLabel} received`)
      scopeNotes.push(
        `${site.siteLabel}: seen on ${site.metrics.receivedOrderCount} received order${site.metrics.receivedOrderCount === 1 ? '' : 's'} ` +
        `across ${site.metrics.receivedPositionCount} position${site.metrics.receivedPositionCount === 1 ? '' : 's'}` +
        `${site.metrics.lastReceivedDate ? `, latest ${site.metrics.lastReceivedDate}` : ''}.`,
      )
    }
  }

  if (generated) {
    return {
      actionLabel: generated.action,
      actionType: mapActionType(generated.action),
      averageCompetitorPostTaxPrice: generated.marketEvidence?.averagePostTaxPrice ?? null,
      averageCompetitorPreTaxPrice: generated.marketEvidence?.averagePreTaxPrice ?? null,
      brand: group.liveState.brand,
      brandMetadata: buildBrandMetadataRef(group.liveState.brand),
      category: group.liveState.category,
      currentGmPercent: generated.currentGmPercent,
      currentPrice: generated.baselinePrice,
      detailHref: `details/${product.productId}.html`,
      familyAnchor: generated.familyPricingEvidence,
      groupId: group.groupId,
      groupName: group.groupFullName || group.groupName,
      hierarchy,
      imageUrl: product.imageUrl ?? group.liveState.imageUrl,
      isActionable: true,
      marketAvailability: marketContext.availability,
      marketEvidence: generated.marketEvidence,
      marketNote: marketContext.note,
      productId: product.productId,
      productName: product.name,
      proposedGmPercent: generated.proposedGmPercent,
      proposedPrice: generated.proposedPrice,
      recentSales,
      reason: generated.priceReason,
      scopeBadges,
      scopeNotes,
      siteScope,
      subcategory: group.liveState.subcategory,
      tab: product.tab,
      wholesaleCost: generated.wholesaleCost,
    }
  }

  const keptPrice = skipped?.currentPrice ?? product.price ?? null
  return {
    actionLabel: skipped ? classifySkippedAction(skipped.reason) : 'keep-price',
    actionType: skipped?.wholesaleCost === null ? 'warning' : 'keep',
    averageCompetitorPostTaxPrice: skipped?.marketEvidence?.averagePostTaxPrice ?? null,
    averageCompetitorPreTaxPrice: skipped?.marketEvidence?.averagePreTaxPrice ?? null,
    brand: group.liveState.brand,
    brandMetadata: buildBrandMetadataRef(group.liveState.brand),
    category: group.liveState.category,
    currentGmPercent: product.gmPercent,
    currentPrice: product.price,
    detailHref: `details/${product.productId}.html`,
    familyAnchor: familyContext.productEvidenceById[product.productId] ?? null,
    groupId: group.groupId,
    groupName: group.groupFullName || group.groupName,
    hierarchy,
    imageUrl: product.imageUrl ?? group.liveState.imageUrl,
    isActionable: false,
    marketAvailability: marketContext.availability,
    marketEvidence: skipped?.marketEvidence ?? null,
    marketNote: marketContext.note,
    productId: product.productId,
    productName: product.name,
    proposedGmPercent: product.gmPercent,
    proposedPrice: keptPrice,
    recentSales,
    reason: skipped?.reason ?? 'No pricing proposal was generated for this product.',
    scopeBadges,
    scopeNotes,
    siteScope,
    subcategory: group.liveState.subcategory,
    tab: product.tab,
    wholesaleCost: skipped?.wholesaleCost ?? product.wholesaleCost,
  }
}

async function buildReport(
  groups: PacketGroup[],
  scopedProducts: Map<number, ScopedProductAggregate>,
  liveSupplementedProductIds: number[],
  missingMirroredProductIds: number[],
  missingProductIds: number[],
  existingPacketJsonPath: string,
  recentSalesIssue: string | null,
): Promise<PacketReport> {
  const rows = groups.flatMap((group) => group.generatedProducts)
  const keepPriceCount = rows.filter((row) => row.actionLabel === 'keep-price').length
  const lowerCount = rows.filter((row) => row.actionLabel === 'lower-price').length
  const missingCostCount = rows.filter((row) => row.actionLabel === 'missing-cost').length
  const marketEvidenceCount = rows.filter((row) => row.marketEvidence !== null && row.marketEvidence.averagePostTaxPrice !== null).length
  const raiseCount = rows.filter((row) => row.actionLabel === 'raise-price').length
  const reviewRowCount = rows.filter((row) => row.actionLabel !== 'missing-cost').length
  const setCount = rows.filter((row) => row.actionLabel === 'set-price').length
  const siteBreakdown: PacketReport['scopeSummary']['siteBreakdown'] = []
  for (const site of HELIOS_PENDING_PURCHASE_SITE_DEALERS) {
    const siteScoped = [...scopedProducts.values()].map((row) => row.sites[site.siteKey]).filter((value): value is ScopedProductSiteSummary => Boolean(value))
    if (siteScoped.length === 0) {
      continue
    }
    const latestReceivedDate = siteScoped
      .map((row) => row.metrics.lastReceivedDate)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null
    const receivedOrderCount = new Set(siteScoped.flatMap((row) => row.metrics.orderIds)).size
    const positionCount = siteScoped.reduce((total, row) => total + row.metrics.receivedPositionCount, 0)
    siteBreakdown.push({
      latestReceivedDate,
      positionCount,
      productCount: siteScoped.length,
      receivedOrderCount,
      siteKey: site.siteKey,
      siteLabel: site.siteLabel,
    })
  }
  const receivedOrderCount = new Set(siteBreakdown.flatMap((site) => {
    const matchingProducts = [...scopedProducts.values()].map((row) => row.sites[site.siteKey]).filter((value): value is ScopedProductSiteSummary => Boolean(value))
    return matchingProducts.flatMap((row) => row.metrics.orderIds)
  })).size

  return {
    generatedAt: new Date().toISOString(),
    groups,
    packetId: await readExistingPacketId(existingPacketJsonPath),
    recentSalesIssue,
    scopeDefinition: 'Scope contains every live catalog product referenced by at least one Midtown purchase order whose status name contains “received”. Packet generation rehydrates every in-scope product group directly from live Sweed and fails hard if any required live product, live group, or downstream dependency read fails.',
    scopeSummary: {
      excludedProductCount: missingProductIds.length,
      excludedProductIds: missingProductIds,
      liveSupplementedProductCount: liveSupplementedProductIds.length,
      liveSupplementedProductIds,
      missingMirroredProductCount: missingMirroredProductIds.length,
      missingMirroredProductIds,
      receivedOrderCount,
      scopedCatalogGroupCount: groups.length,
      scopedProductCount: rows.length,
      siteBreakdown,
    },
    summary: {
      groupCount: groups.length,
      keepPriceCount,
      lowerCount,
      marketEvidenceCount,
      missingCostCount,
      productCount: rows.length,
      raiseCount,
      reviewRowCount,
      setCount,
    },
  }
}

async function loadPacketRecentSales(groups: Array<{
  groupId: number
  liveState: NormalizedCatalogGroupLiveState
}>): Promise<Map<number, GroupRecentSales>> {
  if (groups.length === 0) {
    return new Map()
  }

  try {
    return await loadRecentSalesForGroups(
      groups.map((group) => ({ catalogGroupId: group.groupId, liveState: group.liveState })),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown recent-sales loading failure.'
    throw new Error(
      `Recent sales velocity could not be loaded for this pricing packet. Set the required Helios runtime configuration such as APP_BASE_URL and retry packet generation. Root cause: ${message}`,
    )
  }
}

function buildPacketProductRecentSales(groupRecentSales: GroupRecentSales, productId: number): PacketProductRecentSales {
  const sites = groupRecentSales.productRows.filter((row) => row.productId === productId)
  const coveredSites = sites.filter((row) => row.hasCoverage)
  const unitsPerDay = sumNullableNumbers(coveredSites.map((row) => row.unitsPerDay))

  return {
    sites,
    summary: {
      combinationCount: sites.length,
      coverageCount: coveredSites.length,
      daysPerUnit: unitsPerDay !== null && unitsPerDay > 0 ? roundTwoDecimals(1 / unitsPerDay) : null,
      last30DaysGrossSales: sumNullableNumbers(coveredSites.map((row) => row.last30DaysGrossSales)),
      onHand: sumNullableNumbers(coveredSites.map((row) => row.onHand)),
      reportDate: latestReportDate(coveredSites.map((row) => row.reportDate)),
      unitsPerDay,
    },
  }
}

function sumNullableNumbers(values: Array<number | null>): number | null {
  const presentValues = values.filter((value): value is number => value !== null)
  if (presentValues.length === 0) {
    return null
  }

  return roundTwoDecimals(presentValues.reduce((sum, value) => sum + value, 0))
}

function latestReportDate(values: Array<string | null>): string | null {
  let latestValue: string | null = null
  let latestTimestamp = Number.NEGATIVE_INFINITY

  for (const value of values) {
    if (!value) {
      continue
    }
    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp) || timestamp <= latestTimestamp) {
      continue
    }
    latestValue = value
    latestTimestamp = timestamp
  }

  return latestValue
}

function roundTwoDecimals(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

async function readExistingPacketId(packetJsonPath: string): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(packetJsonPath, 'utf8')) as { packetId?: unknown }
    return typeof parsed.packetId === 'string' && parsed.packetId.trim().length > 0 ? parsed.packetId : randomUUID()
  } catch {
    return randomUUID()
  }
}

async function writePacket(report: PacketReport, artifactPaths: PacketArtifactPaths): Promise<void> {
  const hydratedReport = hydratePacketHierarchy(report)
  assertPacketHasLiveRecentSales(hydratedReport)
  await mkdir(artifactPaths.packetDir, { recursive: true })
  await rm(artifactPaths.detailsDir, { force: true, recursive: true })
  await rm(artifactPaths.indexHtmlPath, { force: true })
  await rm(artifactPaths.packetJsonPath, { force: true })
  await rm(artifactPaths.packetUiOutputPath, { force: true })
  await rm(artifactPaths.reviewTreeNavOutputPath, { force: true })
  await mkdir(artifactPaths.detailsDir, { recursive: true })

  await writeFile(artifactPaths.packetJsonPath, `${JSON.stringify(hydratedReport, null, 2)}\n`, 'utf8')
  await writeFile(artifactPaths.packetUiOutputPath, await readFile(PACKET_UI_SOURCE_PATH, 'utf8'), 'utf8')
  await writeFile(artifactPaths.reviewTreeNavOutputPath, await readFile(REVIEW_TREE_NAV_SOURCE_PATH, 'utf8'), 'utf8')
  await writeFile(artifactPaths.indexHtmlPath, renderIndexHtml(hydratedReport), 'utf8')
  for (const row of hydratedReport.groups.flatMap((group) => group.generatedProducts)) {
    await writeFile(join(artifactPaths.detailsDir, `${row.productId}.html`), renderDetailHtml(hydratedReport, row), 'utf8')
  }
}

function hydratePacketHierarchy(report: PacketReport): PacketReport {
  const hydratedGroups = report.groups.map((group) => ({
    ...group,
    generatedProducts: group.generatedProducts.map((row) => {
      const hydratedRow = {
        ...row,
        brandMetadata: row.brandMetadata ?? buildBrandMetadataRef(row.hierarchy?.brandLabel ?? row.brand),
        hierarchy: row.hierarchy ?? buildPacketRowHierarchy({
          brand: row.brand,
          category: row.category,
          subcategory: row.subcategory,
          variant: row.tab,
        }),
      }
      return normalizeHydratedPacketRow(hydratedRow)
    }),
  }))

  return {
    ...report,
    groups: hydratedGroups,
    summary: buildPacketSummary(hydratedGroups.flatMap((group) => group.generatedProducts)),
  }
}

function assertPacketHasLiveRecentSales(report: Pick<PacketReport, 'recentSalesIssue'>): void {
  if (!report.recentSalesIssue) {
    return
  }

  throw new Error(
    `Recent sales velocity must load successfully before this packet can render. Fix the required runtime configuration and regenerate the packet: ${report.recentSalesIssue}`,
  )
}

function normalizeHydratedPacketRow(row: PacketRow): PacketRow {
  if (!row.isActionable) {
    return row
  }

  const normalizedActionLabel = determinePacketActionLabel(row.currentPrice, row.proposedPrice)
  return {
    ...row,
    actionLabel: normalizedActionLabel,
    actionType: mapActionType(normalizedActionLabel),
  }
}

function buildPacketSummary(rows: PacketRow[]): PacketReport['summary'] {
  return {
    groupCount: new Set(rows.map((row) => row.groupId)).size,
    keepPriceCount: rows.filter((row) => row.actionLabel === 'keep-price').length,
    lowerCount: rows.filter((row) => row.actionLabel === 'lower-price').length,
    marketEvidenceCount: rows.filter((row) => row.marketEvidence !== null).length,
    missingCostCount: rows.filter((row) => row.actionLabel === 'missing-cost').length,
    productCount: rows.length,
    raiseCount: rows.filter((row) => row.actionLabel === 'raise-price').length,
    reviewRowCount: rows.filter((row) => row.actionLabel !== 'missing-cost').length,
    setCount: rows.filter((row) => row.actionLabel === 'set-price').length,
  }
}

async function zipPacket(artifactPaths: PacketArtifactPaths): Promise<void> {
  await rm(artifactPaths.zipPath, { force: true })
  await execFileAsync('zip', ['-rq', artifactPaths.zipPath, basename(artifactPaths.packetDir)], {
    cwd: dirname(artifactPaths.packetDir),
    maxBuffer: 10 * 1024 * 1024,
  })
}

function renderIndexHtml(report: PacketReport): string {
  const groupedContent = renderGroupedPacket(report.groups)
  const navigationTree = renderPacketNavigation(report.groups)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Bronx + Midtown Catalog Pricing Review Packet</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4efe6;
      --card: #fffaf2;
      --ink: #241f1a;
      --muted: #6e665c;
      --line: #dccfb8;
      --raise: #8a4626;
      --lower: #8d2f52;
      --set: #27417e;
      --keep: #1f5d42;
      --warning: #8b5e11;
      --badge: #5d4b83;
      --accepted: #1f5d42;
      --rejected: #8d2f52;
      --unreviewed: #8b5e11;
      --near: #1ed760;
      --mid: #3d86d8;
      --far: #df574d;
      --very-far: #8b8b8b;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font: 13px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: radial-gradient(circle at top, #f8f2e8 0%, var(--bg) 65%); color: var(--ink); }
    a { color: #294f94; }
    code { font-family: 'SFMono-Regular', Menlo, monospace; }
    .packet-page { max-width: 1920px; margin: 0 auto; padding: 24px; display: grid; grid-template-columns: minmax(260px, 320px) minmax(0, 1fr); gap: 18px; align-items: start; }
    body.nav-hidden .packet-page { grid-template-columns: minmax(0, 1fr); }
    .packet-sidebar { position: sticky; top: 24px; min-width: 0; }
    body.nav-hidden .packet-sidebar { display: none; }
    .review-tree-nav { display: grid; gap: 12px; padding: 16px; border-radius: 20px; border: 1px solid var(--line); background: rgba(255,255,255,0.84); box-shadow: 0 18px 40px rgba(31, 27, 23, 0.08); max-height: calc(100vh - 48px); overflow: auto; }
    .review-tree-nav-header { display: flex; gap: 10px; align-items: flex-start; justify-content: space-between; }
    .review-tree-nav-header strong { display: block; margin-bottom: 2px; }
    .review-tree-nav-toggle, .review-tree-nav-show-button { border: 1px solid var(--line); border-radius: 999px; background: #fff; color: #294f94; font: inherit; font-size: 12px; font-weight: 700; padding: 7px 12px; cursor: pointer; }
    .review-tree-nav-show-button { margin-bottom: 12px; box-shadow: 0 8px 24px rgba(41, 79, 148, 0.14); }
    body:not(.nav-hidden) .review-tree-nav-show-button { display: none; }
    .review-tree-nav-tree { display: grid; gap: 10px; }
    .review-tree-nav-group + .review-tree-nav-group { margin-top: 0; }
    .review-tree-nav-group, .review-tree-nav-node { padding: 8px 0; border-bottom: 1px solid rgba(72, 45, 23, 0.08); }
    .review-tree-nav-group:last-child, .review-tree-nav-node:last-child { border-bottom: 0; }
    .review-tree-nav-group summary, .review-tree-nav-node summary { cursor: pointer; list-style: none; }
    .review-tree-nav-group summary::-webkit-details-marker, .review-tree-nav-node summary::-webkit-details-marker { display: none; }
    .review-tree-nav-group > summary { font-weight: 700; color: var(--ink); padding: 2px 0; }
    .review-tree-nav-node > summary { color: var(--ink); font-size: 13px; }
    .review-tree-nav-summary-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; }
    .review-tree-nav-summary-label { min-width: 0; }
    .review-tree-nav-count { color: var(--muted); font-size: 11px; white-space: nowrap; }
    .review-tree-nav-links { display: grid; gap: 6px; padding: 8px 0 0 12px; }
    .review-tree-nav-link { color: var(--muted); font-size: 12px; text-decoration: none; }
    .review-tree-nav-link:hover { color: #294f94; text-decoration: underline; }
    .review-tree-nav-link.is-active { color: #294f94; font-weight: 700; }
    .wrap { min-width: 0; }
    .hero { background: var(--card); border: 1px solid var(--line); border-radius: 20px; padding: 18px 20px; box-shadow: 0 18px 40px rgba(31, 27, 23, 0.08); }
    .hero-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px 18px; align-items: flex-start; }
    h1, h2 { margin: 0 0 12px; font-family: 'Palatino', 'Book Antiqua', serif; }
    h1 { font-size: 20px; margin-bottom: 6px; }
    .muted { color: var(--muted); }
    .summary { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
    .summary-card { background: rgba(255,255,255,0.72); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; }
    .summary-card strong { display: block; font-size: 18px; }
    .summary-toggle { margin-top: 12px; }
    .summary-toggle summary { cursor: pointer; color: #294f94; font-weight: 600; }
    .section-note { margin-top: 12px; }
    .packet-groups { display: grid; gap: 12px; margin-top: 18px; }
    .submit-bar { display: flex; flex-wrap: wrap; gap: 14px 18px; justify-content: space-between; align-items: center; margin-top: 18px; padding: 16px 18px; background: rgba(255,255,255,0.72); border: 1px solid var(--line); border-radius: 16px; }
    .submit-bar strong { display: block; margin-bottom: 4px; }
    .submit-bar-meta { display: grid; gap: 4px; }
    .submit-actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .follow-up-filter-toggle { display: inline-flex; align-items: center; gap: 8px; padding: 7px 12px; border-radius: 999px; border: 1px solid var(--line); background: rgba(255,255,255,0.9); color: #294f94; font-size: 12px; font-weight: 700; cursor: pointer; }
    .follow-up-filter-toggle input { margin: 0; }
    .follow-up-note-summary { min-width: 220px; }
    .progress-pill-row { display: flex; flex-wrap: wrap; gap: 8px; }
    .progress-pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line); background: rgba(255,255,255,0.86); font-size: 12px; font-weight: 700; }
    .progress-pill.unreviewed { color: var(--warning); }
    .progress-pill.accepted { color: var(--accepted); }
    .progress-pill.rejected { color: var(--rejected); }
    .submit-button { border: 0; border-radius: 999px; background: #294f94; color: #fff; font: inherit; font-weight: 700; padding: 11px 18px; cursor: pointer; box-shadow: 0 10px 24px rgba(41, 79, 148, 0.18); }
    .submit-button[disabled] { cursor: wait; opacity: 0.7; }
    .status-banner { margin-top: 14px; padding: 14px 16px; border-radius: 14px; border: 1px solid var(--line); background: rgba(255,255,255,0.72); }
    .status-idle { color: var(--muted); }
    .status-running { border-color: #27417e; background: rgba(39, 65, 126, 0.08); }
    .status-success { border-color: #1f5d42; background: rgba(31, 93, 66, 0.08); }
    .status-warning { border-color: #8b5e11; background: rgba(139, 94, 17, 0.09); }
    .status-error { border-color: #8d2f52; background: rgba(141, 47, 82, 0.08); }
    .group-block { background: var(--card); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 8px 24px rgba(31, 27, 23, 0.04); }
    .group-block summary { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; cursor: pointer; list-style: none; padding: 14px 18px; }
    .group-block summary::-webkit-details-marker { display: none; }
    .group-kicker { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); font-weight: 700; }
    .group-include-toggle { display: inline-flex; align-items: center; gap: 8px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line); background: rgba(255,255,255,0.82); font-size: 12px; font-weight: 600; color: #294f94; cursor: pointer; }
    .group-include-toggle input { margin: 0; }
    .group-count { margin-left: auto; color: var(--muted); font-size: 12px; }
    .group-review-stats { width: 100%; font-size: 12px; color: var(--muted); }
    .group-content { padding: 0 12px 12px; }
    .group-category > summary { background: rgba(39, 65, 126, 0.06); border-radius: 16px; }
    .group-subcategory > summary { background: rgba(93, 75, 131, 0.05); border-radius: 14px; }
    .group-variant > summary { background: rgba(145, 108, 30, 0.05); border-radius: 14px; }
    .group-brand > summary { background: rgba(31, 93, 66, 0.05); border-radius: 14px; }
    .group-review-toolbar, .brand-review-toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; margin: 10px 4px 12px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--line); background: rgba(255,255,255,0.78); }
    .group-review-toolbar strong, .brand-review-toolbar strong { display: block; margin-bottom: 2px; }
    .group-review-toolbar .review-status-buttons { justify-content: flex-end; }
    .brand-review-toolbar input { width: 120px; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--line); font: inherit; }
    .brand-review-toolbar button { border: 1px solid var(--line); border-radius: 999px; background: #fff; color: #294f94; font: inherit; font-weight: 700; padding: 8px 12px; cursor: pointer; }
    .brand-metadata-toolbar { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; justify-content: space-between; margin: 0 4px 12px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--line); background: rgba(255,255,255,0.78); }
    .brand-metadata-toolbar strong { display: block; margin-bottom: 2px; }
    .brand-metadata-controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .brand-summary-controls { display: inline-flex; align-items: center; gap: 8px; margin-left: auto; }
    .brand-summary-mso-toggle { display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 999px; border: 1px solid rgba(127, 60, 17, 0.2); background: rgba(255,255,255,0.92); color: #7f3c11; font-size: 11px; font-weight: 700; }
    .brand-summary-mso-toggle input { margin: 0; }
    .brand-mso-toggle { display: inline-flex; align-items: center; gap: 8px; padding: 7px 12px; border-radius: 999px; border: 1px solid var(--line); background: rgba(255,255,255,0.92); color: #7f3c11; font-size: 12px; font-weight: 700; }
    .brand-mso-toggle input { margin: 0; }
    .brand-note-input { width: min(360px, 100%); padding: 8px 10px; border-radius: 10px; border: 1px solid var(--line); background: #fff; font: inherit; }
    .brand-note-input:focus { outline: 2px solid rgba(41, 79, 148, 0.25); outline-offset: 1px; border-color: #294f94; }
    .group-footer { display: flex; justify-content: flex-end; padding: 8px 6px 2px; }
    .group-collapse-button { border: 1px solid var(--line); background: rgba(255,255,255,0.85); color: #294f94; border-radius: 999px; padding: 6px 12px; font: inherit; font-size: 12px; cursor: pointer; }
    table { width: 100%; border-collapse: collapse; background: transparent; }
    th, td { border-bottom: 1px solid var(--line); padding: 12px; text-align: left; vertical-align: top; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
    .product-row { cursor: pointer; }
    .product-row:hover td { background: rgba(145, 108, 30, 0.05); }
    .product-link { display: grid; gap: 2px; color: inherit; text-decoration: none; }
    .product-link strong { color: #294f94; }
    .product-link:hover strong { text-decoration: underline; }
    .product-link-hint { color: #294f94; font-size: 12px; font-weight: 600; }
    .brand-exposure { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
    .brand-exposure-text { min-width: 0; }
    .brand-exposure.is-mso .brand-exposure-text, .review-tree-nav-link.is-mso .brand-exposure-text, .group-brand.is-mso > summary strong { color: #7f3c11; font-weight: 700; }
    .brand-meta-indicators { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; }
    .brand-note-indicator { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 999px; background: #8d2f52; color: #fff; font-size: 12px; font-weight: 800; line-height: 1; }
    .brand-note-indicator::before { content: '!'; }
    .brand-mso-indicator { display: inline-flex; align-items: center; justify-content: center; padding: 2px 7px; border-radius: 999px; background: rgba(127, 60, 17, 0.12); border: 1px solid rgba(127, 60, 17, 0.2); color: #7f3c11; font-size: 10px; font-weight: 800; letter-spacing: 0.08em; }
    .velocity-summary-row { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; margin-top: 6px; }
    .velocity-indicator { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: 0.02em; border: 1px solid transparent; }
    .velocity-indicator-success { background: rgba(31, 93, 66, 0.1); border-color: rgba(31, 93, 66, 0.2); color: #1f5d42; }
    .velocity-indicator-danger { background: rgba(141, 47, 82, 0.1); border-color: rgba(141, 47, 82, 0.18); color: #8d2f52; }
    .velocity-indicator-muted { background: rgba(110, 102, 92, 0.12); border-color: rgba(110, 102, 92, 0.18); color: var(--muted); }
    .chip { display: inline-block; padding: 3px 8px; border-radius: 999px; color: white; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; margin: 0 6px 6px 0; }
    .chip.raise { background: var(--raise); }
    .chip.lower { background: var(--lower); }
    .chip.set { background: var(--set); }
    .chip.keep { background: var(--keep); }
    .chip.warning { background: var(--warning); }
    .chip.scope { background: var(--badge); }
    .thumb-link, .thumb-empty { display: inline-flex; width: 92px; height: 92px; align-items: center; justify-content: center; border-radius: 14px; border: 1px solid var(--line); overflow: hidden; background: #f8f1e5; }
    .thumb-link img { width: 100%; height: 100%; object-fit: cover; }
    .thumb-empty { color: var(--muted); font-size: 12px; }
    .review-price-cell { display: grid; gap: 10px; min-width: 180px; }
    .review-row-toggle { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; }
    .review-row-toggle input { margin: 0; }
    .review-price-field { display: grid; gap: 6px; min-width: 140px; }
    .review-price-field.is-excluded { opacity: 0.55; }
    .review-price-input-row { display: flex; align-items: stretch; gap: 8px; }
    .review-price-meta { display: grid; gap: 2px; }
    .review-price-input { width: 118px; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--line); background: #fff; font: inherit; }
    .review-price-input:focus { outline: 2px solid rgba(41, 79, 148, 0.25); outline-offset: 1px; border-color: #294f94; }
    .review-price-stepper { display: grid; grid-template-rows: repeat(2, minmax(0, 1fr)); gap: 4px; }
    .review-price-step-button { min-width: 30px; padding: 0 8px; border-radius: 8px; border: 1px solid var(--line); background: rgba(255,255,255,0.92); color: #294f94; font: inherit; font-size: 11px; font-weight: 700; line-height: 1; cursor: pointer; }
    .review-price-step-button:hover:not(:disabled) { background: rgba(41, 79, 148, 0.08); }
    .review-price-step-button:disabled { cursor: not-allowed; opacity: 0.6; }
    .review-status-field { display: grid; gap: 6px; }
    .review-status-buttons { display: flex; flex-wrap: wrap; gap: 6px; }
    .review-status-button { border: 1px solid var(--line); border-radius: 999px; background: rgba(255,255,255,0.9); color: var(--muted); font: inherit; font-size: 12px; font-weight: 700; padding: 6px 10px; cursor: pointer; }
    .review-status-button.is-active { color: #fff; border-color: transparent; }
    .review-status-button[data-status="unreviewed"].is-active { background: var(--unreviewed); }
    .review-status-button[data-status="accepted"].is-active { background: var(--accepted); }
    .review-status-button[data-status="rejected"].is-active { background: var(--rejected); }
    .follow-up-notes { display: grid; gap: 8px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--line); background: rgba(255,255,255,0.78); }
    .follow-up-notes-header { display: flex; flex-wrap: wrap; gap: 6px 10px; justify-content: space-between; align-items: baseline; }
    .follow-up-note-list { display: grid; gap: 8px; }
    .follow-up-note-empty { color: var(--muted); font-size: 12px; }
    .follow-up-inherited-context[hidden] { display: none !important; }
    .follow-up-inherited-context { display: grid; gap: 8px; padding: 10px 12px; border-radius: 12px; border: 1px dashed rgba(93, 75, 131, 0.34); background: rgba(93, 75, 131, 0.05); }
    .follow-up-inherited-header { display: flex; flex-wrap: wrap; gap: 6px 10px; justify-content: space-between; align-items: baseline; }
    .follow-up-inherited-note { display: grid; gap: 3px; padding: 8px 10px; border-radius: 10px; border: 1px solid rgba(93, 75, 131, 0.18); background: rgba(255,255,255,0.88); }
    .group-follow-up-label { margin-top: -2px; }
    .follow-up-note { display: flex; gap: 8px 10px; align-items: flex-start; padding: 8px 10px; border-radius: 10px; border: 1px solid rgba(220, 207, 184, 0.9); background: rgba(255,255,255,0.88); }
    .follow-up-note.is-completed { opacity: 0.78; background: rgba(244, 239, 230, 0.92); }
    .follow-up-note-body { display: grid; gap: 2px; min-width: 0; }
    .follow-up-note-text { font-weight: 600; color: var(--ink); word-break: break-word; }
    .follow-up-note-toggle { border: 1px solid var(--line); border-radius: 999px; background: rgba(255,255,255,0.96); color: var(--accepted); font: inherit; font-size: 11px; font-weight: 700; padding: 6px 10px; cursor: pointer; white-space: nowrap; }
    .follow-up-note-toggle.is-completed { color: var(--badge); }
    .follow-up-note-add-row { display: flex; gap: 8px; align-items: center; }
    .follow-up-note-input { flex: 1 1 180px; min-width: 0; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--line); background: #fff; font: inherit; }
    .follow-up-note-input:focus { outline: 2px solid rgba(41, 79, 148, 0.25); outline-offset: 1px; border-color: #294f94; }
    .follow-up-note-add-button { border: 1px solid var(--line); border-radius: 999px; background: #fff; color: #294f94; font: inherit; font-size: 12px; font-weight: 700; padding: 8px 12px; cursor: pointer; }
    .review-status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; color: #fff; }
    .review-status-badge.accepted { background: var(--accepted); }
    .review-status-badge.rejected { background: var(--rejected); }
    .review-status-badge.unreviewed { background: var(--unreviewed); }
    .product-row-collapsed td { background: rgba(255,255,255,0.54); }
    .collapsed-row-shell { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; justify-content: space-between; }
    .collapsed-row-main { display: grid; gap: 2px; }
    .collapsed-row-main strong { font-size: 13px; }
    .collapsed-row-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .collapsed-row-actions button { border: 1px solid var(--line); border-radius: 999px; background: #fff; color: #294f94; font: inherit; font-size: 12px; font-weight: 700; padding: 7px 11px; cursor: pointer; }
    .pricing-ladder-shell { margin-top: 6px; }
    .pricing-ladder-head { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: baseline; margin-bottom: 12px; }
    .pricing-ladder { position: relative; height: 110px; margin: 6px 0 8px; }
    .ladder-track { position: absolute; left: 0; right: 0; top: 34px; height: 4px; border-radius: 999px; background: #d9ceb7; }
    .ladder-iqr { position: absolute; top: 28px; height: 16px; border-radius: 999px; background: rgba(39, 65, 126, 0.18); border: 1px solid rgba(39, 65, 126, 0.26); }
    .ladder-median { position: absolute; top: 22px; width: 2px; height: 28px; background: #27417e; }
    .ladder-competitor { position: absolute; width: 10px; height: 10px; margin-left: -5px; border-radius: 999px; border: 1px solid rgba(31, 27, 23, 0.25); box-shadow: 0 0 0 2px rgba(255, 250, 241, 0.85); }
    .ladder-competitor.near { background: var(--near); }
    .ladder-competitor.mid { background: var(--mid); }
    .ladder-competitor.far { background: var(--far); }
    .ladder-competitor.very_far, .ladder-competitor.unknown { background: var(--very-far); }
    .ladder-marker { position: absolute; top: 44px; width: 2px; height: 24px; transform: translateX(-1px); }
    .ladder-marker::before { content: ''; position: absolute; left: 50%; top: -12px; width: 12px; height: 12px; transform: translateX(-50%) rotate(45deg); border: 2px solid currentColor; background: var(--card); }
    .ladder-marker span { position: absolute; top: 18px; left: 50%; transform: translateX(-50%); font-size: 11px; font-weight: 700; white-space: nowrap; background: rgba(255,250,241,0.92); padding: 1px 6px; border-radius: 999px; border: 1px solid currentColor; }
    .ladder-marker.current { color: #6d665b; }
    .ladder-marker.proposed { color: #8a4626; }
    .ladder-marker.proposed[data-review-ladder-marker] { cursor: grab; touch-action: none; }
    .ladder-marker.proposed[data-review-ladder-marker].is-dragging { cursor: grabbing; }
    .ladder-marker.market-average { top: 12px; height: 18px; color: #27417e; }
    .ladder-marker.market-average::before { top: auto; bottom: -12px; }
    .ladder-marker.market-average span { top: auto; bottom: 18px; }
    .ladder-axis { position: absolute; bottom: 0; font-size: 11px; color: var(--muted); }
    .ladder-axis.axis-min { left: 0; }
    .ladder-axis.axis-max { right: 0; }
    .pricing-ladder-meta { display: flex; flex-wrap: wrap; gap: 8px 12px; font-size: 12px; }
    .recent-sales-card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .recent-sales-card { background: rgba(255,255,255,0.72); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; }
    .recent-sales-card header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
    @media (max-width: 1200px) { .summary { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    @media (max-width: 980px) { .packet-page { grid-template-columns: 1fr; } .packet-sidebar { position: static; } body.nav-hidden .packet-sidebar { display: none; } }
    @media (max-width: 760px) { .packet-page { padding: 16px; } .summary { grid-template-columns: 1fr 1fr; } .hero-head { flex-direction: column; } }
  </style>
</head>
<body>
  <div class="packet-page">
    <aside class="packet-sidebar" data-packet-nav-shell>
      ${navigationTree}
    </aside>
    <div class="wrap">
      <button type="button" class="review-tree-nav-show-button" data-review-tree-nav-show>Show nav</button>
    <section class="hero">
      <div class="hero-head">
        <div>
          <h1>Midtown Ever-Received Catalog Pricing Review Packet</h1>
          <p class="muted" style="margin:0;">Review prices, mark each row as accepted or rejected, and submit accepted rows when ready.</p>
        </div>
        <div class="progress-pill-row">
          <span class="progress-pill unreviewed" data-review-progress-pill="unreviewed">0 unreviewed</span>
          <span class="progress-pill accepted" data-review-progress-pill="accepted">0 accepted</span>
          <span class="progress-pill rejected" data-review-progress-pill="rejected">0 rejected</span>
        </div>
      </div>
      <div class="summary">
        <div class="summary-card"><span class="muted">Rows in scope</span><strong>${report.summary.productCount}</strong></div>
        <div class="summary-card"><span class="muted">Actionable rows</span><strong>${report.summary.reviewRowCount}</strong></div>
        <div class="summary-card"><span class="muted">Keep current price</span><strong>${report.summary.keepPriceCount}</strong></div>
        <div class="summary-card"><span class="muted">With market evidence</span><strong>${report.summary.marketEvidenceCount}</strong></div>
        <div class="summary-card"><span class="muted">Missing cost</span><strong>${report.summary.missingCostCount}</strong></div>
      </div>
      <details class="summary-toggle">
        <summary>Packet summary and scope</summary>
        <p class="muted section-note">One-off repricing packet using the existing review workflow, now scoped to every live catalog product that Midtown has ever received on a purchase order with a received-like status. Pricing uses the current Helios deterministic methodology: <code>GM% = 1 - 1.13 * cost / price</code>, target GM band <strong>55%-65%</strong>, fallback <strong>64.5%</strong>, quarter-dollar snapping with <strong>.00 / .50</strong> preferred, below-market targeting when near/mid Lit Alerts evidence exists, Mantle-assisted Lit Alerts search adaptation when a SKU still has fewer than <strong>3</strong> near/mid comps, and same-brand same-lane family anchors when public market evidence is still thin. Brands manually marked MSO in this packet use an alternate managed band of <strong>62.5%-67.7%</strong> with a <strong>67.2%</strong> fallback target for the default reviewed price.</p>
        <p class="muted section-note">${escapeHtml(report.scopeDefinition)}</p>
        <div class="summary">
          <div class="summary-card"><span class="muted">Scoped products</span><strong>${report.summary.productCount}</strong></div>
          <div class="summary-card"><span class="muted">Scoped groups</span><strong>${report.summary.groupCount}</strong></div>
          <div class="summary-card"><span class="muted">Review rows</span><strong>${report.summary.reviewRowCount}</strong></div>
          <div class="summary-card"><span class="muted">Keep current price</span><strong>${report.summary.keepPriceCount}</strong></div>
          <div class="summary-card"><span class="muted">Raise</span><strong>${report.summary.raiseCount}</strong></div>
          <div class="summary-card"><span class="muted">Lower</span><strong>${report.summary.lowerCount}</strong></div>
          <div class="summary-card"><span class="muted">Set</span><strong>${report.summary.setCount}</strong></div>
          <div class="summary-card"><span class="muted">Missing cost</span><strong>${report.summary.missingCostCount}</strong></div>
          <div class="summary-card"><span class="muted">With market evidence</span><strong>${report.summary.marketEvidenceCount}</strong></div>
        </div>
        <div class="summary" style="margin-top:12px;">
          ${report.scopeSummary.siteBreakdown.map((site) => `<div class="summary-card"><span class="muted">${escapeHtml(site.siteLabel)}</span><strong>${site.productCount} products / ${site.receivedOrderCount} orders</strong><div class="muted">${site.positionCount} received positions${site.latestReceivedDate ? ` · latest ${escapeHtml(site.latestReceivedDate)}` : ''}</div></div>`).join('')}
        </div>
        <p class="muted section-note">${report.scopeSummary.receivedOrderCount} unique Midtown received orders contributed to this packet scope.</p>
        <p class="muted section-note">Every in-scope packet group on this page was rehydrated directly from live Sweed during generation; mirrored catalog_groups state is not trusted for packet category, subcategory, or product-group metadata.</p>
        ${report.scopeSummary.excludedProductCount > 0 ? `<p class="muted section-note">${report.scopeSummary.excludedProductCount} scoped product ids are excluded because live Sweed could not hydrate them during packet generation. First few ids: ${escapeHtml(report.scopeSummary.excludedProductIds.slice(0, 20).join(', '))}</p>` : ''}
      </details>
    </section>
    <form id="pricing-review-form" data-packet-id="${escapeHtml(report.packetId)}">
      ${renderSubmissionBar(report)}
      <div id="submission-status" class="status-banner status-idle">No live submission has been queued yet. Work through the unreviewed rows, then submit the accepted prices when you are ready.</div>
      <section class="packet-groups">
        ${groupedContent}
      </section>
      ${renderSubmissionBar(report)}
    </form>
    </div>
  </div>
  <script src="review-tree-nav.js"></script>
  <script>
    const nextCollapsibleAfter = (currentDetails) => {
      const allDetails = Array.from(document.querySelectorAll('details'));
      const currentIndex = allDetails.indexOf(currentDetails);
      if (currentIndex === -1) return null;
      for (let index = currentIndex + 1; index < allDetails.length; index += 1) {
        const candidate = allDetails[index];
        if (!currentDetails.contains(candidate)) return candidate;
      }
      return null;
    };
    document.querySelectorAll('.group-collapse-button').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const details = button.closest('details');
        if (!details) return;
        const targetTop = button.getBoundingClientRect().top;
        const nextDetails = nextCollapsibleAfter(details);
        details.open = false;
        requestAnimationFrame(() => {
          const anchor = nextDetails || details;
          const anchorTop = anchor.getBoundingClientRect().top;
          window.scrollBy(0, anchorTop - targetTop);
        });
      });
    });
    document.querySelectorAll('.product-row').forEach((row) => {
      row.addEventListener('click', (event) => {
        if (event.target.closest('a, button, input, label, form')) return;
        const selection = window.getSelection && window.getSelection();
        if (selection && selection.toString()) return;
        const href = row.dataset.detailHref;
        if (href) window.open(href, '_blank', 'noopener');
      });
    });
    const submissionForm = document.getElementById('pricing-review-form');
    const submissionStatus = document.getElementById('submission-status');
    const saveButtons = Array.from(document.querySelectorAll('[data-save-pricing-review]'));
    const packetNavItems = Array.from(document.querySelectorAll('[data-review-tree-nav-item]'));
    const submissionButtons = Array.from(document.querySelectorAll('[data-submit-pricing-review]'));
    const setButtonsDisabled = (disabled) => {
      saveButtons.forEach((button) => {
        button.disabled = disabled;
      });
      submissionButtons.forEach((button) => {
        button.disabled = disabled;
      });
    };
    const setSubmissionStatus = (tone, headline, detailHtml) => {
      if (!submissionStatus) return;
      submissionStatus.className = 'status-banner status-' + tone;
      submissionStatus.innerHTML = '<div><strong>' + headline + '</strong></div>' + (detailHtml ? '<div class="muted" style="margin-top:6px;">' + detailHtml + '</div>' : '');
    };
    const summarizeSubmission = (payload) => {
      const summary = payload.summary || {};
      const pieces = [
        (summary.processedCount || 0) + '/' + (summary.requestedRowCount || 0) + ' rows processed',
        (summary.appliedCount || 0) + ' applied',
        (summary.alreadyMatchingCount || 0) + ' already matched',
      ];
      if ((summary.blankCount || 0) > 0) {
        pieces.push((summary.blankCount || 0) + ' blank');
      }
      if ((summary.failedCount || 0) > 0) {
        pieces.push((summary.failedCount || 0) + ' failed');
      }
      return pieces.join(', ');
    };
    const renderResultLink = (payload) => {
      if (!payload.resultsHref) return '';
      return '<a href="' + payload.resultsHref + '" target="_blank" rel="noopener noreferrer">Open results ledger</a>';
    };
    const summarizeDraft = (payload) => {
      const summary = payload.summary || {};
      const pieces = [
        (summary.reviewedCount || 0) + '/' + (summary.rowCount || 0) + ' rows reviewed',
        (summary.acceptedCount || 0) + ' accepted',
        (summary.rejectedCount || 0) + ' rejected',
        (summary.unreviewedCount || 0) + ' unreviewed',
      ];
      if ((summary.outstandingProductCount || 0) > 0) {
        const hierarchyText = (summary.outstandingGroupCount || 0) > 0
          ? ' across ' + (summary.outstandingGroupCount || 0) + ' hierarchy block' + ((summary.outstandingGroupCount || 0) === 1 ? '' : 's')
          : '';
        pieces.push((summary.outstandingProductCount || 0) + ' products in follow-up pass' + hierarchyText);
      } else if ((summary.totalNoteCount || 0) > 0) {
        pieces.push((summary.completedNoteCount || 0) + ' completed notes');
      }
      return pieces.join(', ');
    };
    const packetId = submissionForm?.dataset.packetId || 'default';
    const storageKey = 'helios-pricing-review-packet:' + packetId;
    const navSidebarStorageKey = 'helios-pricing-review-packet-sidebar:' + packetId;
    const navTreeStorageKey = 'helios-pricing-review-packet-nav:' + packetId;
    const outstandingNoteFilterToggles = Array.from(document.querySelectorAll('[data-outstanding-follow-up-filter]'));
    const outstandingFollowUpSummaries = Array.from(document.querySelectorAll('[data-outstanding-follow-up-summary]'));
    const emptyStoredRowsState = () => ({
      brandMetadata: {},
      groupFollowUpNotes: {},
      lastLocalChangeAt: null,
      lastSavedAt: null,
      rows: {},
      showOutstandingFollowUpOnly: false,
    });
    const nowIsoString = () => new Date().toISOString();
    const parseIsoTimestamp = (value) => {
      const parsed = Date.parse(typeof value === 'string' ? value : '');
      return Number.isFinite(parsed) ? parsed : null;
    };
    const makeFollowUpNoteId = () => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : 'note-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const escapeHtml = (value) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    const formatDateTimeLabel = (value) => {
      const timestamp = parseIsoTimestamp(value);
      return timestamp === null ? 'Unknown time' : new Date(timestamp).toLocaleString();
    };
    let treeNavControl = null;
    const normalizeBrandMetadataEntries = (value) => {
      const entries = Array.isArray(value)
        ? value
        : value && typeof value === 'object'
          ? Object.values(value)
          : [];
      return entries.reduce((brands, entry) => {
        if (!entry || typeof entry !== 'object') {
          return brands;
        }
        const brandKey = typeof entry.brandKey === 'string' ? entry.brandKey.trim() : '';
        if (!brandKey) {
          return brands;
        }
        const label = typeof entry.label === 'string' && entry.label.trim()
          ? entry.label.trim().slice(0, 500)
          : brandKey;
        const note = typeof entry.note === 'string' && entry.note.trim()
          ? entry.note.trim().slice(0, 500)
          : null;
        const isMso = entry.isMso === true;
        if (!isMso && note === null) {
          return brands;
        }
        brands[brandKey] = {
          brandKey,
          isMso,
          label,
          note,
        };
        return brands;
      }, {});
    };
    const loadStoredRows = () => {
      try {
        const rawValue = window.localStorage.getItem(storageKey);
        if (!rawValue) {
          return emptyStoredRowsState();
        }
        const parsed = JSON.parse(rawValue);
        if (!parsed || !parsed.rows || typeof parsed.rows !== 'object') {
          return emptyStoredRowsState();
        }
        return {
          brandMetadata: normalizeBrandMetadataEntries(parsed.brandMetadata),
          groupFollowUpNotes: normalizeGroupFollowUpEntries(parsed.groupFollowUpNotes),
          lastLocalChangeAt: typeof parsed.lastLocalChangeAt === 'string' ? parsed.lastLocalChangeAt : null,
          lastSavedAt: typeof parsed.lastSavedAt === 'string' ? parsed.lastSavedAt : null,
          rows: parsed.rows,
          showOutstandingFollowUpOnly: parsed.showOutstandingFollowUpOnly === true,
        };
      } catch {
        return emptyStoredRowsState();
      }
    };
    const normalizeFollowUpNotes = (value) => Array.isArray(value)
      ? value.flatMap((note) => {
        if (!note || typeof note !== 'object') {
          return [];
        }
        const text = typeof note.text === 'string' ? note.text.trim().slice(0, 500) : '';
        if (!text) {
          return [];
        }
        const createdAt = typeof note.createdAt === 'string' && parseIsoTimestamp(note.createdAt) !== null
          ? note.createdAt
          : nowIsoString();
        const completedAt = typeof note.completedAt === 'string' && parseIsoTimestamp(note.completedAt) !== null
          ? note.completedAt
          : null;
        return [{
          completedAt,
          createdAt,
          id: typeof note.id === 'string' && note.id.trim() ? note.id : makeFollowUpNoteId(),
          text,
        }];
      })
      : [];
    const normalizeGroupLevel = (value) => value === 'brand' || value === 'category' || value === 'subcategory' || value === 'variant'
      ? value
      : 'brand';
    const normalizeGroupFollowUpEntries = (value) => {
      const entries = Array.isArray(value)
        ? value
        : value && typeof value === 'object'
          ? Object.values(value)
          : [];
      return entries.reduce((groups, entry) => {
        if (!entry || typeof entry !== 'object') {
          return groups;
        }
        const groupKey = typeof entry.groupKey === 'string' ? entry.groupKey.trim() : '';
        if (!groupKey) {
          return groups;
        }
        const groupLabel = typeof entry.label === 'string' ? entry.label.trim().slice(0, 500) : '';
        groups[groupKey] = {
          followUpNotes: normalizeFollowUpNotes(entry.followUpNotes),
          groupKey,
          groupLevel: normalizeGroupLevel(entry.groupLevel),
          label: groupLabel || groupKey,
        };
        return groups;
      }, {});
    };
    const storedRowsState = loadStoredRows();
    const loadStoredNavHidden = () => {
      try {
        const rawNavHidden = window.localStorage.getItem(navSidebarStorageKey);
        if (rawNavHidden === 'hidden' || rawNavHidden === 'visible' || rawNavHidden === 'open') {
          return rawNavHidden === 'hidden';
        }
        const rawLegacyState = window.localStorage.getItem(storageKey);
        if (!rawLegacyState) {
          return false;
        }
        const parsedLegacyState = JSON.parse(rawLegacyState);
        return parsedLegacyState?.navHidden === true;
      } catch {
        return false;
      }
    };
    const persistStoredRows = () => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(storedRowsState));
      } catch {
      }
    };
    const countOutstandingFollowUpNotes = (notes) => notes.filter((note) => note.completedAt === null).length;
    const formatFollowUpSummary = (notes) => {
      if (notes.length === 0) {
        return 'No follow-up notes';
      }
      const outstandingCount = countOutstandingFollowUpNotes(notes);
      const completedCount = notes.length - outstandingCount;
      if (outstandingCount === 0) {
        return completedCount === 1 ? '1 completed note' : completedCount + ' completed notes';
      }
      if (completedCount === 0) {
        return outstandingCount === 1 ? '1 open note' : outstandingCount + ' open notes';
      }
      return outstandingCount + ' open · ' + completedCount + ' done';
    };
    const normalizeCurrencyInput = (rawValue) => {
      const cleaned = rawValue.replace(/[^0-9.]/g, '');
      if (!cleaned) {
        return '';
      }
      const firstDotIndex = cleaned.indexOf('.');
      if (firstDotIndex === -1) {
        return cleaned;
      }
      const integerPart = cleaned.slice(0, firstDotIndex) || '0';
      const fractionalPart = cleaned.slice(firstDotIndex + 1).replace(/\\./g, '').slice(0, 2);
      return fractionalPart.length > 0 ? integerPart + '.' + fractionalPart : integerPart + '.';
    };
    const parseCurrencyValue = (rawValue) => {
      const normalized = normalizeCurrencyInput(rawValue).replace(/\\.$/, '');
      if (!normalized) {
        return null;
      }
      const parsed = Number.parseFloat(normalized);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const normalizeReviewStatus = (value) => value === 'accepted' || value === 'rejected' ? value : 'unreviewed';
    const labelReviewStatus = (value) => value === 'accepted' ? 'Accepted' : value === 'rejected' ? 'Rejected' : 'Unreviewed';
    const roundQuarterStep = (value) => Math.round((value + Number.EPSILON) * 4) / 4;
    const clampRatio = (value, min, max) => Math.min(Math.max(value, min), max);
    const escapeAttributeValue = (value) => CSS.escape(String(value ?? ''));
    const priceEpsilon = ${JSON.stringify(PRICE_EPSILON)};
    const getPriceInput = (productId) => document.querySelector('[data-review-price-input][data-product-id="' + CSS.escape(productId) + '"]');
    const getIncludeCheckbox = (productId) => document.querySelector('[data-review-include-checkbox][data-product-id="' + CSS.escape(productId) + '"]');
    const getFollowUpSummaryOutput = (productId) => document.querySelector('[data-follow-up-summary][data-product-id="' + CSS.escape(productId) + '"]');
    const getFollowUpList = (productId) => document.querySelector('[data-follow-up-note-list][data-product-id="' + CSS.escape(productId) + '"]');
    const getFollowUpInput = (productId) => document.querySelector('[data-follow-up-note-input][data-product-id="' + CSS.escape(productId) + '"]');
    const getGroupFollowUpSummaryOutput = (groupKey) => document.querySelector('[data-group-follow-up-summary][data-group-key="' + escapeAttributeValue(groupKey) + '"]');
    const getGroupFollowUpList = (groupKey) => document.querySelector('[data-group-follow-up-note-list][data-group-key="' + escapeAttributeValue(groupKey) + '"]');
    const getGroupFollowUpInput = (groupKey) => document.querySelector('[data-group-follow-up-note-input][data-group-key="' + escapeAttributeValue(groupKey) + '"]');
    const getInheritedFollowUpContext = (productId) => document.querySelector('[data-inherited-follow-up-context][data-product-id="' + CSS.escape(productId) + '"]');
    const getBrandMetadataTargets = (brandKey) => Array.from(document.querySelectorAll('[data-brand-meta-key="' + escapeAttributeValue(brandKey) + '"]'));
    const readBrandMetaFromDom = (brandKey) => {
      const target = document.querySelector('[data-brand-meta-key="' + escapeAttributeValue(brandKey) + '"]');
      if (!(target instanceof HTMLElement)) {
        return null;
      }
      return {
        brandKey,
        isMso: false,
        label: target.dataset.brandMetaLabel || brandKey,
        note: null,
      };
    };
    const readGroupMetaFromDom = (groupKey) => {
      const group = document.querySelector('[data-review-group][data-group-key="' + escapeAttributeValue(groupKey) + '"]');
      if (!(group instanceof HTMLElement)) {
        return null;
      }
      return {
        groupKey,
        groupLevel: normalizeGroupLevel(group.dataset.reviewGroupLevel),
        label: group.dataset.groupLabel || groupKey,
      };
    };
    const getAncestorGroupKeysFromRow = (row) => {
      const rawKeys = row?.dataset?.ancestorGroupKeys || '';
      return rawKeys.split(/\s+/).filter(Boolean);
    };
    const packetReviewRows = Array.from(document.querySelectorAll('[data-review-item]'));
    const packetReviewRowIds = packetReviewRows
      .map((row) => row.dataset.productId || '')
      .filter(Boolean);
    const packetReviewRowByProductId = packetReviewRows.reduce((rows, row) => {
      const productId = row.dataset.productId || '';
      if (productId) {
        rows[productId] = row;
      }
      return rows;
    }, {});
    const packetCollapsedRowByProductId = Array.from(document.querySelectorAll('[data-collapsed-review-row]')).reduce((rows, row) => {
      const productId = row.dataset.productId || '';
      if (productId) {
        rows[productId] = row;
      }
      return rows;
    }, {});
    const productIdsByGroupKey = packetReviewRows.reduce((groups, row) => {
      const productId = row.dataset.productId || '';
      if (!productId) {
        return groups;
      }
      getAncestorGroupKeysFromRow(row).forEach((groupKey) => {
        if (!groups[groupKey]) {
          groups[groupKey] = [];
        }
        groups[groupKey].push(productId);
      });
      return groups;
    }, {});
    const getDetailedRow = (productId) => packetReviewRowByProductId[productId] || null;
    const getCollapsedRow = (productId) => packetCollapsedRowByProductId[productId] || null;
    const getStoredRowState = (productId) => {
      const stored = storedRowsState.rows[productId] || {};
      return {
        include: stored.include !== false,
        followUpNotes: normalizeFollowUpNotes(stored.followUpNotes),
        reviewedPrice: typeof stored.reviewedPrice === 'string' && stored.reviewedPrice.trim()
          ? stored.reviewedPrice.trim()
          : null,
        status: normalizeReviewStatus(stored.status),
      };
    };
    const getStoredGroupState = (groupKey) => {
      const stored = storedRowsState.groupFollowUpNotes[groupKey] || {};
      const domMeta = readGroupMetaFromDom(groupKey);
      return {
        followUpNotes: normalizeFollowUpNotes(stored.followUpNotes),
        groupKey,
        groupLevel: normalizeGroupLevel(stored.groupLevel || domMeta?.groupLevel),
        label: typeof stored.label === 'string' && stored.label.trim()
          ? stored.label.trim().slice(0, 500)
          : (domMeta?.label || groupKey),
      };
    };
    const getStoredBrandState = (brandKey) => {
      const stored = storedRowsState.brandMetadata[brandKey] || {};
      const domMeta = readBrandMetaFromDom(brandKey);
      const label = typeof stored.label === 'string' && stored.label.trim()
        ? stored.label.trim().slice(0, 500)
        : (domMeta?.label || brandKey);
      const note = typeof stored.note === 'string' && stored.note.trim()
        ? stored.note.trim().slice(0, 500)
        : null;
      return {
        brandKey,
        isMso: stored.isMso === true,
        label,
        note,
      };
    };
    const readBrandMetaLabelFromElement = (element, fallback = '') => {
      const metaContainer = element instanceof Element ? element.closest('[data-brand-meta-label]') : null;
      const label = metaContainer instanceof HTMLElement ? metaContainer.dataset.brandMetaLabel || '' : '';
      return label || fallback;
    };
    const determineRuntimeActionLabel = (currentPrice, proposedPrice) => {
      if (proposedPrice === null || !Number.isFinite(proposedPrice)) {
        return 'keep-price';
      }
      if (currentPrice === null || !Number.isFinite(currentPrice) || currentPrice <= 0) {
        return 'set-price';
      }
      if (Math.abs(proposedPrice - currentPrice) < priceEpsilon) {
        return 'keep-price';
      }
      return proposedPrice > currentPrice ? 'raise-price' : 'lower-price';
    };
    const determineRuntimeActionType = (currentPrice, proposedPrice) => {
      const actionLabel = determineRuntimeActionLabel(currentPrice, proposedPrice);
      if (actionLabel === 'lower-price') {
        return 'lower';
      }
      if (actionLabel === 'raise-price') {
        return 'raise';
      }
      if (actionLabel === 'set-price') {
        return 'set';
      }
      return 'keep';
    };
    const formatRuntimeActionLabel = (actionLabel) => actionLabel.replace(/-/g, ' ');
    const hasExplicitReviewedPrice = (productId) => {
      const reviewedPrice = getStoredRowState(productId).reviewedPrice;
      return typeof reviewedPrice === 'string' && reviewedPrice.trim().length > 0;
    };
    const readDefaultReviewedPriceForInput = (input) => {
      if (!(input instanceof HTMLInputElement)) {
        return null;
      }
      const brandKey = input.dataset.brandMetaKey || '';
      const brandState = brandKey ? getStoredBrandState(brandKey) : null;
      const preferredRaw = brandState?.isMso === true ? input.dataset.defaultMsoPrice : input.dataset.defaultStandardPrice;
      return parseCurrencyValue(preferredRaw || '') ?? parseCurrencyValue(input.dataset.currentPrice || '');
    };
    const readEffectiveReviewedPriceForInput = (input) => {
      if (!(input instanceof HTMLInputElement)) {
        return null;
      }
      const parsedInputPrice = parseCurrencyValue(input.value);
      if (parsedInputPrice !== null) {
        return parsedInputPrice;
      }
      return hasExplicitReviewedPrice(input.dataset.productId || '') ? null : readDefaultReviewedPriceForInput(input);
    };
    const syncReviewActionChip = (productId, currentPrice, reviewedPrice) => {
      const chip = document.querySelector('[data-review-action-chip][data-product-id="' + CSS.escape(productId) + '"]');
      if (!(chip instanceof HTMLElement)) {
        return;
      }
      const actionLabel = determineRuntimeActionLabel(currentPrice, reviewedPrice);
      chip.className = 'chip ' + determineRuntimeActionType(currentPrice, reviewedPrice);
      chip.textContent = formatRuntimeActionLabel(actionLabel);
    };
    const buildEmptyOutstandingFollowUpRuntime = () => ({
      groupNotesByKey: {},
      inheritedNotesByProductId: {},
      outstandingGroupCount: 0,
      outstandingGroupNoteCount: 0,
      outstandingProductIds: {},
      outstandingRowNoteCountByProductId: {},
    });
    let outstandingFollowUpRuntime = buildEmptyOutstandingFollowUpRuntime();
    const rebuildOutstandingFollowUpRuntime = () => {
      const nextRuntime = buildEmptyOutstandingFollowUpRuntime();
      packetReviewRowIds.forEach((productId) => {
        const outstandingRowNoteCount = countOutstandingFollowUpNotes(getStoredRowState(productId).followUpNotes);
        nextRuntime.outstandingRowNoteCountByProductId[productId] = outstandingRowNoteCount;
        if (outstandingRowNoteCount > 0) {
          nextRuntime.outstandingProductIds[productId] = true;
        }
      });
      Object.keys(storedRowsState.groupFollowUpNotes || {}).forEach((groupKey) => {
        const groupState = getStoredGroupState(groupKey);
        const openNotes = groupState.followUpNotes.flatMap((note) => {
          if (note.completedAt !== null) {
            return [];
          }
          return [{
            groupKey,
            groupLabel: groupState.label,
            groupLevel: groupState.groupLevel,
            id: note.id,
            text: note.text,
          }];
        });
        if (openNotes.length > 0) {
          nextRuntime.groupNotesByKey[groupKey] = openNotes;
          nextRuntime.outstandingGroupCount += 1;
          nextRuntime.outstandingGroupNoteCount += openNotes.length;
          (productIdsByGroupKey[groupKey] || []).forEach((productId) => {
            if (!nextRuntime.inheritedNotesByProductId[productId]) {
              nextRuntime.inheritedNotesByProductId[productId] = [];
            }
            nextRuntime.inheritedNotesByProductId[productId].push(...openNotes);
            nextRuntime.outstandingProductIds[productId] = true;
          });
        }
      });
      outstandingFollowUpRuntime = nextRuntime;
    };
    const writeStoredRowState = (productId, patch) => {
      storedRowsState.rows[productId] = {
        ...getStoredRowState(productId),
        ...patch,
      };
      storedRowsState.lastLocalChangeAt = nowIsoString();
      persistStoredRows();
    };
    const writeStoredGroupState = (groupKey, patch) => {
      storedRowsState.groupFollowUpNotes[groupKey] = {
        ...getStoredGroupState(groupKey),
        ...patch,
      };
      rebuildOutstandingFollowUpRuntime();
      storedRowsState.lastLocalChangeAt = nowIsoString();
      persistStoredRows();
    };
    const writeStoredBrandState = (brandKey, patch) => {
      const nextState = {
        ...getStoredBrandState(brandKey),
        ...patch,
      };
      if (!nextState.isMso && !nextState.note) {
        delete storedRowsState.brandMetadata[brandKey];
      } else {
        storedRowsState.brandMetadata[brandKey] = nextState;
      }
      storedRowsState.lastLocalChangeAt = nowIsoString();
      persistStoredRows();
    };
    const overwriteStoredRowsFromDraft = (payload) => {
      const nextRows = {};
      Array.from(payload.rows || []).forEach((row) => {
        const productId = String(row?.productId ?? '');
        if (!productId) {
          return;
        }
        nextRows[productId] = {
          include: row.include !== false,
          followUpNotes: normalizeFollowUpNotes(row.followUpNotes),
          reviewedPrice: typeof row.reviewedPrice === 'string' && row.reviewedPrice.trim()
            ? row.reviewedPrice.trim()
            : null,
          status: normalizeReviewStatus(row.status),
        };
      });
      storedRowsState.brandMetadata = normalizeBrandMetadataEntries(payload.brandMetadata);
      storedRowsState.groupFollowUpNotes = normalizeGroupFollowUpEntries(payload.groupFollowUpNotes);
      storedRowsState.rows = nextRows;
      storedRowsState.lastSavedAt = typeof payload.savedAt === 'string' ? payload.savedAt : null;
      storedRowsState.lastLocalChangeAt = storedRowsState.lastSavedAt;
      rebuildOutstandingFollowUpRuntime();
      persistStoredRows();
    };
    const markDraftSaved = (savedAt) => {
      storedRowsState.lastSavedAt = typeof savedAt === 'string' ? savedAt : nowIsoString();
      storedRowsState.lastLocalChangeAt = storedRowsState.lastSavedAt;
      persistStoredRows();
    };
    const shouldHydrateFromLatestDraft = (payload) => {
      const serverSavedAt = parseIsoTimestamp(payload?.savedAt);
      if (serverSavedAt === null) {
        return false;
      }
      const localSavedAt = parseIsoTimestamp(storedRowsState.lastSavedAt);
      const localChangedAt = parseIsoTimestamp(storedRowsState.lastLocalChangeAt);
      const hasLocalRows = Object.keys(storedRowsState.rows || {}).length > 0;
      if (!hasLocalRows) {
        return true;
      }
      if (localChangedAt !== null && localSavedAt === null) {
        return false;
      }
      if (localChangedAt !== null && localSavedAt !== null && localChangedAt > localSavedAt) {
        return serverSavedAt > localChangedAt;
      }
      return localSavedAt === null || serverSavedAt > localSavedAt;
    };
    const openAncestorGroups = (element) => {
      let current = element?.parentElement || null;
      while (current) {
        if (current.tagName === 'DETAILS' && current.hasAttribute('data-review-group')) {
          current.open = true;
        }
        current = current.parentElement;
      }
    };
    const handleReviewedPriceInput = (input) => {
      syncReviewedPriceMeta(input);
      updateCollapsedRowSummary(input.dataset.productId || '');
      writeStoredRowState(input.dataset.productId || '', { reviewedPrice: input.value });
    };
    const calculateGmPercent = (cost, price) => {
      if (!Number.isFinite(cost) || !Number.isFinite(price) || price <= 0) {
        return null;
      }
      return (1 - (1.13 * cost) / price) * 100;
    };
    const formatInlineGmPercent = (value) => value === null ? 'n/a' : value.toFixed(1) + '%';
    const formatInlinePrice = (value) => value === null || !Number.isFinite(value) ? 'n/a' : '$' + value.toFixed(2);
    const syncReviewedPriceMeta = (input) => {
      const container = input.closest('[data-review-row-controls]');
      const gmOutput = container?.querySelector('[data-review-gm]');
      const productId = input.dataset.productId || '';
      const cost = Number.parseFloat(input.dataset.wholesaleCost || '');
      const currentPrice = parseCurrencyValue(input.dataset.currentPrice || '');
      const currentGmPercent = Number.parseFloat(input.dataset.currentGmPercent || '');
      const price = readEffectiveReviewedPriceForInput(input);
      if (gmOutput) {
        gmOutput.textContent = formatInlinePrice(currentPrice)
          + ' (' + formatInlineGmPercent(Number.isFinite(currentGmPercent) ? currentGmPercent : null) + ')'
          + ' -> '
          + formatInlinePrice(price)
          + ' (' + formatInlineGmPercent(calculateGmPercent(cost, price)) + ')';
      }
      syncReviewActionChip(productId, currentPrice, price);
      updateReviewLadder(productId, price);
    };
    const toLadderPercent = (value, minimum, maximum) => {
      if (!Number.isFinite(value) || !Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) {
        return 50;
      }
      return ((value - minimum) / (maximum - minimum)) * 100;
    };
    const updateReviewLadder = (productId, parsedPrice) => {
      if (!productId) {
        return;
      }
      const ladder = document.querySelector('[data-review-ladder][data-product-id="' + CSS.escape(productId) + '"]');
      const marker = ladder?.querySelector('[data-review-ladder-marker]');
      if (!ladder || !marker) {
        return;
      }
      const minimum = Number.parseFloat(ladder.dataset.ladderMin || '');
      const maximum = Number.parseFloat(ladder.dataset.ladderMax || '');
      const input = getPriceInput(productId);
      const fallbackPrice = readDefaultReviewedPriceForInput(input) ?? parseCurrencyValue(ladder.dataset.currentPrice || '') ?? null;
      const nextPrice = parsedPrice ?? fallbackPrice;
      if (nextPrice === null) {
        marker.setAttribute('hidden', 'hidden');
        return;
      }
      marker.removeAttribute('hidden');
      marker.style.left = toLadderPercent(nextPrice, minimum, maximum).toFixed(2) + '%';
    };
    const setReviewedPriceInputValue = (input, nextValue, options = {}) => {
      const normalizedValue = Math.max(0, roundQuarterStep(nextValue));
      input.value = normalizedValue.toFixed(2);
      handleReviewedPriceInput(input);
      if (options.focus === true) {
        input.focus();
        const caretPosition = input.value.length;
        input.setSelectionRange(caretPosition, caretPosition);
      }
    };
    const setReviewedPriceFromLadderPosition = (ladder, clientX, options = {}) => {
      const productId = ladder?.dataset?.productId || '';
      const input = getPriceInput(productId);
      if (!(input instanceof HTMLInputElement) || input.disabled) {
        return false;
      }
      const minimum = Number.parseFloat(ladder.dataset.ladderMin || '');
      const maximum = Number.parseFloat(ladder.dataset.ladderMax || '');
      if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) {
        return false;
      }
      const rect = ladder.getBoundingClientRect();
      if (!Number.isFinite(rect.width) || rect.width <= 0) {
        return false;
      }
      const ratio = clampRatio((clientX - rect.left) / rect.width, 0, 1);
      const nextValue = minimum + (maximum - minimum) * ratio;
      setReviewedPriceInputValue(input, nextValue, options);
      return true;
    };
    const adjustReviewedPriceInput = (input, delta) => {
      const currentValue = parseCurrencyValue(input.value) ?? 0;
      setReviewedPriceInputValue(input, currentValue + delta, { focus: true });
    };
    let activeReviewLadderDrag = null;
    const stopReviewLadderDrag = () => {
      if (!activeReviewLadderDrag) {
        return;
      }
      activeReviewLadderDrag.marker.classList.remove('is-dragging');
      activeReviewLadderDrag = null;
    };
    const setCollapsedBadge = (badge, status) => {
      if (!badge) {
        return;
      }
      badge.className = 'review-status-badge ' + status;
      badge.textContent = labelReviewStatus(status);
    };
    const getStoredOutstandingGroupNotes = (groupKey) => outstandingFollowUpRuntime.groupNotesByKey[groupKey] || [];
    const getInheritedOutstandingGroupNotes = (productId) => outstandingFollowUpRuntime.inheritedNotesByProductId[productId] || [];
    const hasOutstandingFollowUpForRow = (row) => {
      const productId = row?.dataset?.productId || '';
      return Boolean(productId && outstandingFollowUpRuntime.outstandingProductIds[productId]);
    };
    const renderFollowUpNotes = (productId) => {
      const notes = getStoredRowState(productId).followUpNotes;
      const summaryOutput = getFollowUpSummaryOutput(productId);
      if (summaryOutput) {
        summaryOutput.textContent = formatFollowUpSummary(notes);
      }
      const list = getFollowUpList(productId);
      if (!list) {
        return;
      }
      if (notes.length === 0) {
        list.innerHTML = '<div class="follow-up-note-empty">No follow-up notes yet.</div>';
        return;
      }
      list.innerHTML = notes.map((note) => {
        const detail = note.completedAt === null
          ? 'Outstanding · added ' + formatDateTimeLabel(note.createdAt)
          : 'Completed ' + formatDateTimeLabel(note.completedAt);
        return '<div class="follow-up-note' + (note.completedAt === null ? '' : ' is-completed') + '">' +
          '<button type="button" class="follow-up-note-toggle' + (note.completedAt === null ? '' : ' is-completed') + '" data-follow-up-note-toggle data-product-id="' + escapeHtml(productId) + '" data-note-id="' + escapeHtml(note.id) + '">' + (note.completedAt === null ? 'Complete' : 'Reopen') + '</button>' +
          '<div class="follow-up-note-body">' +
          '<div class="follow-up-note-text">' + escapeHtml(note.text) + '</div>' +
          '<div class="muted">' + escapeHtml(detail) + '</div>' +
          '</div>' +
          '</div>';
      }).join('');
    };
    const renderGroupFollowUpNotes = (groupKey) => {
      const groupState = getStoredGroupState(groupKey);
      const summaryOutput = getGroupFollowUpSummaryOutput(groupKey);
      if (summaryOutput) {
        summaryOutput.textContent = formatFollowUpSummary(groupState.followUpNotes);
      }
      const list = getGroupFollowUpList(groupKey);
      if (!list) {
        return;
      }
      if (groupState.followUpNotes.length === 0) {
        list.innerHTML = '<div class="follow-up-note-empty">No follow-up notes yet.</div>';
        return;
      }
      list.innerHTML = groupState.followUpNotes.map((note) => {
        const detail = note.completedAt === null
          ? 'Outstanding · added ' + formatDateTimeLabel(note.createdAt)
          : 'Completed ' + formatDateTimeLabel(note.completedAt);
        return '<div class="follow-up-note' + (note.completedAt === null ? '' : ' is-completed') + '">' +
          '<div data-group-follow-up-note-item data-group-key="' + escapeHtml(groupKey) + '" data-group-label="' + escapeHtml(groupState.label) + '" data-group-level="' + escapeHtml(groupState.groupLevel) + '" data-note-id="' + escapeHtml(note.id) + '" data-note-open="' + (note.completedAt === null ? 'true' : 'false') + '" data-note-text="' + escapeHtml(note.text) + '"></div>' +
          '<button type="button" class="follow-up-note-toggle' + (note.completedAt === null ? '' : ' is-completed') + '" data-group-follow-up-note-toggle data-group-key="' + escapeHtml(groupKey) + '" data-note-id="' + escapeHtml(note.id) + '">' + (note.completedAt === null ? 'Complete' : 'Reopen') + '</button>' +
          '<div class="follow-up-note-body">' +
          '<div class="follow-up-note-text">' + escapeHtml(note.text) + '</div>' +
          '<div class="muted">' + escapeHtml(detail) + '</div>' +
          '</div>' +
          '</div>';
      }).join('');
    };
    const renderInheritedFollowUpContext = (productId) => {
      const container = getInheritedFollowUpContext(productId);
      if (!container) {
        return;
      }
      const inheritedNotes = getInheritedOutstandingGroupNotes(productId);
      if (inheritedNotes.length === 0) {
        container.hidden = true;
        container.innerHTML = '';
        return;
      }
      container.hidden = false;
      container.innerHTML = '<div class="follow-up-inherited-header">'
        + '<span class="muted">Inherited follow-up keeping this row in the pass</span>'
        + '<span class="muted">' + inheritedNotes.length + ' open inherited note' + (inheritedNotes.length === 1 ? '' : 's') + '</span>'
        + '</div>'
        + inheritedNotes.map((note) => '<div class="follow-up-inherited-note">'
          + '<div class="follow-up-note-text">' + escapeHtml(note.text) + '</div>'
          + '<div class="muted">From ' + escapeHtml(note.groupLevel) + ' block · ' + escapeHtml(note.groupLabel) + '</div>'
          + '</div>').join('');
    };
    const syncBrandMetadata = (brandKey) => {
      const brandState = getStoredBrandState(brandKey);
      const noteTitle = brandState.note ? 'Brand note: ' + brandState.note : '';
      getBrandMetadataTargets(brandKey).forEach((target) => {
        if (!(target instanceof HTMLElement)) {
          return;
        }
        if (target.hasAttribute('data-brand-note-input')) {
          if (document.activeElement !== target) {
            target.value = brandState.note || '';
          }
          return;
        }
        if (target.hasAttribute('data-brand-mso-input')) {
          target.checked = brandState.isMso;
          return;
        }
        target.classList.toggle('is-mso', brandState.isMso);
        const noteIndicator = target.querySelector('[data-brand-note-indicator]');
        if (noteIndicator instanceof HTMLElement) {
          noteIndicator.hidden = brandState.note === null;
          noteIndicator.title = brandState.note === null ? '' : noteTitle;
          noteIndicator.setAttribute('aria-label', brandState.note === null ? 'No brand note' : noteTitle);
        }
        const msoIndicator = target.querySelector('[data-brand-mso-indicator]');
        if (msoIndicator instanceof HTMLElement) {
          msoIndicator.hidden = !brandState.isMso;
          msoIndicator.title = brandState.isMso ? brandState.label + ' is marked MSO.' : '';
        }
      });
    };
    const syncAllBrandMetadata = () => {
      const brandKeys = new Set(Array.from(document.querySelectorAll('[data-brand-meta-key]'))
        .map((element) => element.getAttribute('data-brand-meta-key') || '')
        .filter(Boolean));
      brandKeys.forEach((brandKey) => {
        syncBrandMetadata(brandKey);
      });
    };
    const openReviewGroupAncestors = (element) => {
      let current = element;
      while (current) {
        if (current instanceof HTMLDetailsElement && current.hasAttribute('data-review-group')) {
          current.open = true;
        }
        current = current.parentElement;
      }
    };
    const syncNavigationVisibility = () => {
      packetNavItems.forEach((item) => {
        const targetId = item.getAttribute('data-review-tree-nav-target-id') || '';
        const target = targetId ? document.getElementById(targetId) : null;
        item.hidden = target instanceof HTMLElement ? target.hidden : false;
      });
    };
    const jumpToReviewGroup = (targetId, options = {}) => {
      const updateHash = options.updateHash !== false;
      if (!targetId) {
        return;
      }
      const target = document.getElementById(targetId);
      if (!(target instanceof HTMLElement)) {
        return;
      }
      openReviewGroupAncestors(target);
      if (target instanceof HTMLDetailsElement) {
        target.open = true;
      }
      if (updateHash) {
        const nextHash = '#' + encodeURIComponent(targetId);
        if (window.location.hash !== nextHash) {
          window.history.replaceState(null, '', nextHash);
        }
      }
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      treeNavControl?.revealTarget(targetId);
    };
    const syncRowsForBrandMetaKey = (brandKey) => {
      Array.from(document.querySelectorAll('[data-review-price-input][data-brand-meta-key="' + escapeAttributeValue(brandKey) + '"]')).forEach((input) => {
        if (!(input instanceof HTMLInputElement)) {
          return;
        }
        const productId = input.dataset.productId || '';
        if (!hasExplicitReviewedPrice(productId)) {
          const defaultReviewedPrice = readDefaultReviewedPriceForInput(input);
          input.value = defaultReviewedPrice === null ? '' : defaultReviewedPrice.toFixed(2);
        }
        syncReviewedPriceMeta(input);
        updateCollapsedRowSummary(productId);
      });
    };
    const syncRowsForGroupKey = (groupKey) => {
      (productIdsByGroupKey[groupKey] || []).forEach((productId) => {
        renderInheritedFollowUpContext(productId);
        updateCollapsedRowSummary(productId);
        syncRowVisibility(productId);
      });
    };
    const updateCollapsedRowSummary = (productId) => {
      const collapsedRow = getCollapsedRow(productId);
      const input = getPriceInput(productId);
      const detailedRow = getDetailedRow(productId);
      if (!collapsedRow || !detailedRow) {
        return;
      }
      const status = normalizeReviewStatus(detailedRow.dataset.reviewStatus);
      setCollapsedBadge(collapsedRow.querySelector('[data-collapsed-status]'), status);
      const priceOutput = collapsedRow.querySelector('[data-collapsed-reviewed-price]');
      const reviewedPrice = input ? parseCurrencyValue(input.value) : null;
      if (priceOutput) {
        priceOutput.textContent = reviewedPrice === null ? 'No reviewed price' : 'Reviewed $' + reviewedPrice.toFixed(2);
      }
      const followUpSummary = collapsedRow.querySelector('[data-collapsed-follow-up-summary]');
      if (followUpSummary) {
        const rowNotes = getStoredRowState(productId).followUpNotes;
        const inheritedOutstanding = getInheritedOutstandingGroupNotes(productId);
        if (rowNotes.length === 0 && inheritedOutstanding.length === 0) {
          followUpSummary.textContent = 'Follow-up: none';
        } else {
          const pieces = [];
          if (rowNotes.length > 0) {
            pieces.push(formatFollowUpSummary(rowNotes).toLowerCase().replace('follow-up: ', ''));
          }
          if (inheritedOutstanding.length > 0) {
            pieces.push(inheritedOutstanding.length + ' inherited open');
          }
          followUpSummary.textContent = 'Follow-up: ' + pieces.join(' · ');
        }
      }
    };
    const isOutstandingFollowUpFilterEnabled = () => outstandingNoteFilterToggles.some((toggle) => toggle.checked);
    const syncRowVisibility = (productId) => {
      const detailedRow = getDetailedRow(productId);
      const collapsedRow = getCollapsedRow(productId);
      if (!detailedRow || !collapsedRow) {
        return;
      }
      if (isOutstandingFollowUpFilterEnabled() && !hasOutstandingFollowUpForRow(detailedRow)) {
        detailedRow.hidden = true;
        collapsedRow.hidden = true;
        return;
      }
      const status = normalizeReviewStatus(detailedRow.dataset.reviewStatus);
      const showDetailedRow = status === 'unreviewed' || detailedRow.dataset.reviewExpanded === 'true';
      detailedRow.hidden = !showDetailedRow;
      collapsedRow.hidden = showDetailedRow || status === 'unreviewed';
      detailedRow.dataset.reviewExpanded = showDetailedRow ? 'true' : 'false';
    };
    const syncAllRowVisibility = () => {
      packetReviewRows.forEach((row) => {
        syncRowVisibility(row.dataset.productId || '');
      });
    };
    const syncVisibleGroupState = () => {
      Array.from(document.querySelectorAll('[data-review-group]')).forEach((group) => {
        const hasVisibleRows = Array.from(group.querySelectorAll('[data-review-item], [data-collapsed-review-row]'))
          .some((row) => !row.hidden && !row.closest('[data-review-group][hidden]'));
        group.hidden = !hasVisibleRows;
      });
      syncNavigationVisibility();
    };
    const syncOutstandingFollowUpControls = () => {
      const outstandingProductCount = Object.keys(outstandingFollowUpRuntime.outstandingProductIds).length;
      const outstandingRowNoteCount = Object.values(outstandingFollowUpRuntime.outstandingRowNoteCountByProductId)
        .reduce((total, count) => total + count, 0);
      const totalOpenNotes = outstandingRowNoteCount + outstandingFollowUpRuntime.outstandingGroupNoteCount;
      const baseText = outstandingProductCount === 0
        ? 'No outstanding follow-up notes'
        : outstandingProductCount + ' product' + (outstandingProductCount === 1 ? '' : 's') + ' in follow-up pass · ' + totalOpenNotes + ' open note' + (totalOpenNotes === 1 ? '' : 's') + (outstandingFollowUpRuntime.outstandingGroupCount > 0 ? ' across ' + outstandingFollowUpRuntime.outstandingGroupCount + ' hierarchy block' + (outstandingFollowUpRuntime.outstandingGroupCount === 1 ? '' : 's') : '');
      const summaryText = isOutstandingFollowUpFilterEnabled() && outstandingProductCount > 0
        ? 'Showing only ' + baseText.toLowerCase()
        : baseText;
      outstandingFollowUpSummaries.forEach((summary) => {
        summary.textContent = summaryText;
      });
    };
    const syncStatusButtons = (productId) => {
      const detailedRow = getDetailedRow(productId);
      if (!detailedRow) {
        return;
      }
      const status = normalizeReviewStatus(detailedRow.dataset.reviewStatus);
      detailedRow.querySelectorAll('[data-review-status-button]').forEach((button) => {
        const isActive = button.dataset.status === status;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
    };
    const syncRowControlState = (checkbox) => {
      const productId = checkbox.dataset.productId || '';
      const priceInput = getPriceInput(productId);
      const rowControls = checkbox.closest('[data-review-row-controls]');
      const priceField = rowControls?.querySelector('[data-review-price-field]');
      const stepButtons = rowControls?.querySelectorAll('[data-review-price-step-button]') || [];
      if (priceInput) {
        priceInput.disabled = !checkbox.checked;
      }
      stepButtons.forEach((button) => {
        button.disabled = !checkbox.checked;
      });
      if (priceField) {
        priceField.classList.toggle('is-excluded', !checkbox.checked);
      }
    };
    const syncReviewRow = (productId) => {
      const detailedRow = getDetailedRow(productId);
      const checkbox = getIncludeCheckbox(productId);
      if (!detailedRow || !checkbox) {
        return;
      }
      const status = normalizeReviewStatus(detailedRow.dataset.reviewStatus);
      if (status === 'accepted') {
        checkbox.checked = true;
      }
      if (status === 'rejected') {
        checkbox.checked = false;
      }
      syncRowControlState(checkbox);
      syncStatusButtons(productId);
      renderFollowUpNotes(productId);
      renderInheritedFollowUpContext(productId);
      updateCollapsedRowSummary(productId);
      syncRowVisibility(productId);
    };
    const setRowReviewStatusState = (productId, nextStatus) => {
      const detailedRow = getDetailedRow(productId);
      const checkbox = getIncludeCheckbox(productId);
      if (!detailedRow || !checkbox) {
        return null;
      }
      const normalizedStatus = normalizeReviewStatus(nextStatus);
      detailedRow.dataset.reviewStatus = normalizedStatus;
      if (normalizedStatus === 'accepted') {
        checkbox.checked = true;
      } else if (normalizedStatus === 'rejected') {
        checkbox.checked = false;
      }
      detailedRow.dataset.reviewExpanded = normalizedStatus === 'unreviewed' ? 'true' : 'false';
      syncReviewRow(productId);
      writeStoredRowState(productId, {
        include: checkbox.checked,
        reviewedPrice: getPriceInput(productId)?.value ?? '',
        status: normalizedStatus,
      });
      return detailedRow;
    };
    const countStatuses = (rows) => rows.reduce((counts, row) => {
      const status = normalizeReviewStatus(row.dataset.reviewStatus);
      counts[status] += 1;
      return counts;
    }, { accepted: 0, rejected: 0, unreviewed: 0 });
    const syncReviewProgress = () => {
      const reviewRows = Array.from(document.querySelectorAll('[data-review-item]'));
      const totalCounts = countStatuses(reviewRows);
      document.querySelectorAll('[data-review-progress-pill]').forEach((pill) => {
        const key = pill.dataset.reviewProgressPill;
        const count = totalCounts[key] ?? 0;
        pill.textContent = count + ' ' + key;
      });
      document.querySelectorAll('[data-review-progress-summary]').forEach((summary) => {
        summary.textContent = totalCounts.unreviewed + ' unreviewed · ' + totalCounts.accepted + ' accepted · ' + totalCounts.rejected + ' rejected';
      });
      Array.from(document.querySelectorAll('[data-review-group]')).forEach((group) => {
        const groupRows = Array.from(group.querySelectorAll('[data-review-item]'));
        const counts = countStatuses(groupRows);
        const stats = group.querySelector('[data-review-group-stats]');
        if (stats) {
          stats.textContent = counts.unreviewed + ' unreviewed · ' + counts.accepted + ' accepted · ' + counts.rejected + ' rejected';
        }
        const statusToolbar = group.querySelector('[data-group-review-toolbar]');
        const statusSummary = statusToolbar?.querySelector('[data-group-status-summary]');
        if (statusSummary) {
          statusSummary.textContent = counts.unreviewed + ' unreviewed · ' + counts.accepted + ' accepted · ' + counts.rejected + ' rejected';
        }
        statusToolbar?.querySelectorAll('[data-group-status-button]').forEach((button) => {
          const isActive = groupRows.length > 0 && counts[normalizeReviewStatus(button.dataset.status)] === groupRows.length;
          button.classList.toggle('is-active', isActive);
          button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
        const previousUnreviewed = Number.parseInt(group.dataset.reviewUnreviewedCount || '-1', 10);
        if ((previousUnreviewed === -1 && counts.unreviewed === 0 && groupRows.length > 0) || (previousUnreviewed > 0 && counts.unreviewed === 0)) {
          group.open = false;
        }
        group.dataset.reviewUnreviewedCount = String(counts.unreviewed);
      });
      syncAllRowVisibility();
      syncVisibleGroupState();
      syncOutstandingFollowUpControls();
    };
    const focusNextUnreviewedRow = (currentProductId) => {
      const reviewRows = Array.from(document.querySelectorAll('[data-review-item]'));
      const currentIndex = reviewRows.findIndex((row) => row.dataset.productId === currentProductId);
      if (currentIndex === -1) {
        return;
      }
      const orderedRows = reviewRows.slice(currentIndex + 1).concat(reviewRows.slice(0, currentIndex));
      const nextRow = orderedRows.find((row) => !row.hidden && normalizeReviewStatus(row.dataset.reviewStatus) === 'unreviewed');
      if (!nextRow) {
        return;
      }
      openAncestorGroups(nextRow);
      const nextInput = getPriceInput(nextRow.dataset.productId || '');
      if (nextInput) {
        nextInput.focus();
        nextInput.select();
      }
    };
    const applyReviewStatus = (productId, nextStatus) => {
      const detailedRow = setRowReviewStatusState(productId, nextStatus);
      if (!detailedRow) {
        return;
      }
      const normalizedStatus = normalizeReviewStatus(nextStatus);
      syncGroupToggleStates();
      syncReviewProgress();
      if (normalizedStatus === 'unreviewed') {
        openAncestorGroups(detailedRow);
        const input = getPriceInput(productId);
        if (input) {
          input.focus();
          input.select();
        }
      } else {
        focusNextUnreviewedRow(productId);
      }
    };
    const applyGroupReviewStatus = (group, nextStatus) => {
      const groupRows = Array.from(group.querySelectorAll('[data-review-item]'));
      if (groupRows.length === 0) {
        return;
      }
      const normalizedStatus = normalizeReviewStatus(nextStatus);
      groupRows.forEach((row) => {
        const productId = row.dataset.productId || '';
        if (productId) {
          setRowReviewStatusState(productId, normalizedStatus);
        }
      });
      syncGroupToggleStates();
      syncReviewProgress();
      if (normalizedStatus === 'unreviewed') {
        const firstRow = groupRows[0];
        if (!firstRow) {
          return;
        }
        group.open = true;
        openAncestorGroups(firstRow);
        const input = getPriceInput(firstRow.dataset.productId || '');
        if (input) {
          input.focus();
          input.select();
        }
        return;
      }
      const lastRow = groupRows[groupRows.length - 1];
      if (lastRow) {
        focusNextUnreviewedRow(lastRow.dataset.productId || '');
      }
    };
    const addFollowUpNote = (productId, rawText) => {
      const text = String(rawText || '').trim();
      if (!text) {
        return false;
      }
      const nextNotes = getStoredRowState(productId).followUpNotes.concat([{
        completedAt: null,
        createdAt: nowIsoString(),
        id: makeFollowUpNoteId(),
        text: text.slice(0, 500),
      }]);
      writeStoredRowState(productId, { followUpNotes: nextNotes });
      rebuildOutstandingFollowUpRuntime();
      syncReviewRow(productId);
      syncReviewProgress();
      return true;
    };
    const toggleFollowUpNote = (productId, noteId) => {
      const nextNotes = getStoredRowState(productId).followUpNotes.map((note) => note.id === noteId
        ? {
          ...note,
          completedAt: note.completedAt === null ? nowIsoString() : null,
        }
        : note);
      writeStoredRowState(productId, { followUpNotes: nextNotes });
      rebuildOutstandingFollowUpRuntime();
      syncReviewRow(productId);
      syncReviewProgress();
    };
    const addGroupFollowUpNote = (groupKey, rawText) => {
      const text = String(rawText || '').trim();
      if (!text) {
        return false;
      }
      const nextNotes = getStoredGroupState(groupKey).followUpNotes.concat([{
        completedAt: null,
        createdAt: nowIsoString(),
        id: makeFollowUpNoteId(),
        text: text.slice(0, 500),
      }]);
      writeStoredGroupState(groupKey, { followUpNotes: nextNotes });
      renderGroupFollowUpNotes(groupKey);
      syncRowsForGroupKey(groupKey);
      syncReviewProgress();
      return true;
    };
    const toggleGroupFollowUpNote = (groupKey, noteId) => {
      const nextNotes = getStoredGroupState(groupKey).followUpNotes.map((note) => note.id === noteId
        ? {
          ...note,
          completedAt: note.completedAt === null ? nowIsoString() : null,
        }
        : note);
      writeStoredGroupState(groupKey, { followUpNotes: nextNotes });
      renderGroupFollowUpNotes(groupKey);
      syncRowsForGroupKey(groupKey);
      syncReviewProgress();
    };
    const getGroupRowCheckboxes = (group) => Array.from(group.querySelectorAll('[data-review-include-checkbox]'));
    const syncGroupToggleStates = () => {
      Array.from(document.querySelectorAll('[data-review-group]')).forEach((group) => {
        const toggle = group.querySelector('[data-review-group-toggle]');
        if (!toggle) return;
        const rowCheckboxes = getGroupRowCheckboxes(group);
        const checkedCount = rowCheckboxes.filter((checkbox) => checkbox.checked).length;
        toggle.checked = rowCheckboxes.length > 0 && checkedCount === rowCheckboxes.length;
        toggle.indeterminate = checkedCount > 0 && checkedCount < rowCheckboxes.length;
      });
    };
    const applyStoredStateToRows = () => {
      rebuildOutstandingFollowUpRuntime();
      Array.from(document.querySelectorAll('[data-group-follow-up-notes]')).forEach((groupPanel) => {
        const groupKey = groupPanel.dataset.groupKey || '';
        if (groupKey) {
          renderGroupFollowUpNotes(groupKey);
        }
      });
      packetReviewRows.forEach((row) => {
        const productId = row.dataset.productId || '';
        const storedRowState = getStoredRowState(productId);
        const checkbox = getIncludeCheckbox(productId);
        const input = getPriceInput(productId);
        if (checkbox) {
          checkbox.checked = storedRowState.include;
        }
        if (input) {
          input.value = storedRowState.reviewedPrice !== null
            ? storedRowState.reviewedPrice
            : (readDefaultReviewedPriceForInput(input)?.toFixed(2) ?? '');
        }
        row.dataset.reviewStatus = storedRowState.status;
        row.dataset.reviewExpanded = storedRowState.status === 'unreviewed' ? 'true' : 'false';
        if (input) {
          syncReviewedPriceMeta(input);
        }
        syncReviewRow(productId);
        updateReviewLadder(productId, parseCurrencyValue(input?.value || ''));
      });
      syncAllBrandMetadata();
      syncGroupToggleStates();
      syncReviewProgress();
    };
    treeNavControl = window.ReviewTreeNavControl && typeof window.ReviewTreeNavControl.init === 'function'
      ? window.ReviewTreeNavControl.init({
          getCurrentTargetId: () => decodeURIComponent((window.location.hash || '').replace(/^#/, '')),
          loadSidebarHidden: loadStoredNavHidden,
          navStorageKey: navTreeStorageKey,
          onNavigate: (targetId) => jumpToReviewGroup(targetId, { updateHash: true }),
          sidebarHiddenClassName: 'nav-hidden',
          sidebarHiddenTarget: document.body,
          sidebarStorageKey: navSidebarStorageKey,
        })
      : null;
    applyStoredStateToRows();
    treeNavControl?.revealTarget(decodeURIComponent((window.location.hash || '').replace(/^#/, '')));
    Array.from(document.querySelectorAll('[data-brand-note-input]')).forEach((input) => {
      input.addEventListener('input', () => {
        writeStoredBrandState(input.dataset.brandMetaKey || '', {
          label: readBrandMetaLabelFromElement(input, input.dataset.brandMetaKey || ''),
          note: input.value.trim().slice(0, 500) || null,
        });
        syncBrandMetadata(input.dataset.brandMetaKey || '');
      });
    });
    Array.from(document.querySelectorAll('[data-brand-mso-input]')).forEach((checkbox) => {
      checkbox.addEventListener('click', (event) => {
        event.stopPropagation();
      });
      checkbox.closest('label')?.addEventListener('click', (event) => {
        event.stopPropagation();
      });
      checkbox.addEventListener('change', () => {
        const brandKey = checkbox.dataset.brandMetaKey || '';
        writeStoredBrandState(brandKey, {
          isMso: checkbox.checked,
          label: readBrandMetaLabelFromElement(checkbox, brandKey),
        });
        syncBrandMetadata(brandKey);
        syncRowsForBrandMetaKey(brandKey);
      });
    });
    Array.from(document.querySelectorAll('[data-follow-up-note-input]')).forEach((input) => {
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const productId = input.dataset.productId || '';
        if (!productId || !addFollowUpNote(productId, input.value)) {
          return;
        }
        input.value = '';
      });
    });
    Array.from(document.querySelectorAll('[data-group-follow-up-note-input]')).forEach((input) => {
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const groupKey = input.dataset.groupKey || '';
        if (!groupKey || !addGroupFollowUpNote(groupKey, input.value)) {
          return;
        }
        input.value = '';
      });
    });
    document.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) {
        return;
      }
      const groupToggleButton = event.target.closest('[data-group-follow-up-note-toggle]');
      if (groupToggleButton) {
        event.preventDefault();
        event.stopPropagation();
        const groupKey = groupToggleButton.dataset.groupKey || '';
        const noteId = groupToggleButton.dataset.noteId || '';
        if (groupKey && noteId) {
          toggleGroupFollowUpNote(groupKey, noteId);
        }
        return;
      }
      const toggleButton = event.target.closest('[data-follow-up-note-toggle]');
      if (toggleButton) {
        event.preventDefault();
        event.stopPropagation();
        const productId = toggleButton.dataset.productId || '';
        const noteId = toggleButton.dataset.noteId || '';
        if (productId && noteId) {
          toggleFollowUpNote(productId, noteId);
        }
        return;
      }
      const groupAddButton = event.target.closest('[data-group-follow-up-note-add]');
      if (groupAddButton) {
        event.preventDefault();
        event.stopPropagation();
        const groupKey = groupAddButton.dataset.groupKey || '';
        const input = getGroupFollowUpInput(groupKey);
        if (!groupKey || !(input instanceof HTMLInputElement) || !addGroupFollowUpNote(groupKey, input.value)) {
          return;
        }
        input.value = '';
        return;
      }
      const addButton = event.target.closest('[data-follow-up-note-add]');
      if (addButton) {
        event.preventDefault();
        event.stopPropagation();
        const productId = addButton.dataset.productId || '';
        const input = getFollowUpInput(productId);
        if (!productId || !(input instanceof HTMLInputElement) || !addFollowUpNote(productId, input.value)) {
          return;
        }
        input.value = '';
      }
    });
    outstandingNoteFilterToggles.forEach((toggle) => {
      toggle.checked = storedRowsState.showOutstandingFollowUpOnly === true;
      toggle.addEventListener('change', () => {
        outstandingNoteFilterToggles.forEach((peer) => {
          peer.checked = toggle.checked;
        });
        storedRowsState.showOutstandingFollowUpOnly = toggle.checked;
        persistStoredRows();
        syncAllRowVisibility();
        syncVisibleGroupState();
        syncOutstandingFollowUpControls();
      });
    });
    Array.from(document.querySelectorAll('[data-review-include-checkbox]')).forEach((checkbox) => {
      syncRowControlState(checkbox);
      checkbox.addEventListener('change', () => {
        syncRowControlState(checkbox);
        syncGroupToggleStates();
        writeStoredRowState(checkbox.dataset.productId || '', { include: checkbox.checked });
      });
    });
    Array.from(document.querySelectorAll('[data-review-price-input]')).forEach((input) => {
      input.addEventListener('input', () => {
        handleReviewedPriceInput(input);
      });
    });
    Array.from(document.querySelectorAll('[data-review-price-step-button]')).forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const productId = button.dataset.productId || '';
        const step = Number.parseFloat(button.dataset.step || '0');
        if (!productId || !Number.isFinite(step)) {
          return;
        }
        const input = document.querySelector('[data-review-price-input][data-product-id="' + CSS.escape(productId) + '"]');
        if (!(input instanceof HTMLInputElement) || input.disabled) {
          return;
        }
        adjustReviewedPriceInput(input, step);
      });
    });
    Array.from(document.querySelectorAll('[data-review-ladder-marker]')).forEach((marker) => {
      marker.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      marker.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const ladder = marker.closest('[data-review-ladder]');
        if (!(ladder instanceof HTMLElement)) {
          return;
        }
        if (!setReviewedPriceFromLadderPosition(ladder, event.clientX, { focus: true })) {
          return;
        }
        stopReviewLadderDrag();
        marker.classList.add('is-dragging');
        activeReviewLadderDrag = { ladder, marker, pointerId: event.pointerId };
      });
    });
    document.addEventListener('pointermove', (event) => {
      if (!activeReviewLadderDrag || event.pointerId !== activeReviewLadderDrag.pointerId) {
        return;
      }
      event.preventDefault();
      setReviewedPriceFromLadderPosition(activeReviewLadderDrag.ladder, event.clientX, { focus: false });
    });
    document.addEventListener('pointerup', (event) => {
      if (!activeReviewLadderDrag || event.pointerId !== activeReviewLadderDrag.pointerId) {
        return;
      }
      event.preventDefault();
      stopReviewLadderDrag();
    });
    document.addEventListener('pointercancel', (event) => {
      if (!activeReviewLadderDrag || event.pointerId !== activeReviewLadderDrag.pointerId) {
        return;
      }
      stopReviewLadderDrag();
    });
    Array.from(document.querySelectorAll('[data-review-status-button]')).forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const productId = button.dataset.productId || '';
        if (!productId) {
          return;
        }
        applyReviewStatus(productId, button.dataset.status);
      });
    });
    Array.from(document.querySelectorAll('[data-expand-reviewed-row]')).forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const productId = button.dataset.productId || '';
        const detailedRow = getDetailedRow(productId);
        if (!detailedRow) {
          return;
        }
        detailedRow.dataset.reviewExpanded = 'true';
        syncRowVisibility(productId);
        openAncestorGroups(detailedRow);
      });
    });
    Array.from(document.querySelectorAll('[data-brand-batch-controls]')).forEach((toolbar) => {
      const input = toolbar.querySelector('[data-brand-price-input]');
      const button = toolbar.querySelector('[data-brand-price-apply]');
      const summary = toolbar.querySelector('[data-brand-price-summary]');
      if (input) {
        input.addEventListener('blur', () => {
          const parsed = parseCurrencyValue(input.value);
          input.value = parsed === null ? '' : roundQuarterStep(parsed).toFixed(2);
        });
      }
      if (button) {
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const reviewedPrice = parseCurrencyValue(input?.value || '');
          const brandGroup = toolbar.closest('[data-review-group-level="brand"]');
          if (reviewedPrice === null || !brandGroup) {
            if (summary) {
              summary.textContent = 'Enter a numeric price first.';
            }
            return;
          }
          const brandRows = Array.from(brandGroup.querySelectorAll('[data-review-item]'))
            .filter((row) => row.dataset.reviewStatus === 'unreviewed' && row.dataset.reviewIsActionable === 'true');
          if (brandRows.length === 0) {
            if (summary) {
              summary.textContent = 'No unreviewed actionable rows left in this brand block.';
            }
            return;
          }
          brandRows.forEach((row) => {
            const productId = row.dataset.productId || '';
            const priceInput = getPriceInput(productId);
            if (!priceInput) {
              return;
            }
            setReviewedPriceInputValue(priceInput, reviewedPrice);
          });
          if (summary) {
            summary.textContent = 'Applied $' + reviewedPrice.toFixed(2) + ' to ' + brandRows.length + ' unreviewed row' + (brandRows.length === 1 ? '' : 's') + '.';
          }
        });
      }
    });
    Array.from(document.querySelectorAll('[data-group-status-button]')).forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const group = button.closest('[data-review-group]');
        if (!group) {
          return;
        }
        applyGroupReviewStatus(group, button.dataset.status);
      });
    });
    Array.from(document.querySelectorAll('[data-review-group-toggle]')).forEach((toggle) => {
      const group = toggle.closest('[data-review-group]');
      if (!group) return;
      toggle.addEventListener('click', (event) => {
        event.stopPropagation();
      });
      toggle.closest('label')?.addEventListener('click', (event) => {
        event.stopPropagation();
      });
      toggle.addEventListener('change', () => {
        getGroupRowCheckboxes(group).forEach((checkbox) => {
          checkbox.checked = toggle.checked;
          syncRowControlState(checkbox);
          writeStoredRowState(checkbox.dataset.productId || '', { include: checkbox.checked });
        });
        syncGroupToggleStates();
      });
    });
    const hydrateLatestDraft = async () => {
      if (!submissionForm || window.location.protocol === 'file:') {
        return;
      }
      try {
        const response = await fetch('/api/pricing-review/drafts/latest');
        if (response.status === 404) {
          return;
        }
        const payload = await response.json();
        if (!response.ok || !shouldHydrateFromLatestDraft(payload)) {
          return;
        }
        overwriteStoredRowsFromDraft(payload);
        applyStoredStateToRows();
        setSubmissionStatus('idle', 'Loaded saved review state.', [summarizeDraft(payload), renderResultLink(payload), 'Saved ' + formatDateTimeLabel(payload.savedAt)].filter(Boolean).join(' · '));
      } catch {
      }
    };
    void hydrateLatestDraft();
    const submissionEndpointUrl = (path) => {
      try {
        return new URL(path, window.location.href).toString();
      } catch {
        return path;
      }
    };
    const describeSubmissionTransportError = (error, path) => {
      const message = error instanceof Error ? error.message : 'Unknown submission error.';
      const endpoint = submissionEndpointUrl(path);
      if (window.location.protocol === 'file:') {
        return 'This pricing review packet is open from file://, so the browser cannot submit to ' + endpoint + '. Open the packet through the local pricing review service URL instead, then submit again.';
      }
      if (/networkerror|failed to fetch|load failed/i.test(message)) {
        return message + ' Request URL: ' + endpoint;
      }
      return message;
    };
    const readSubmissionRows = () => Array.from(document.querySelectorAll('[data-review-item]')).flatMap((row) => {
      const productId = row.dataset.productId || '';
      const status = normalizeReviewStatus(row.dataset.reviewStatus);
      const checkbox = getIncludeCheckbox(productId);
      if (status !== 'accepted' || !checkbox?.checked) {
        return [];
      }
      const productIdNumber = Number.parseInt(productId, 10);
      const input = getPriceInput(productId);
      const rawValue = input ? input.value.trim() : '';
      if (!rawValue) {
        return [{ productId: productIdNumber, reviewedPrice: null }];
      }
      const reviewedPrice = parseCurrencyValue(rawValue);
      if (!Number.isFinite(reviewedPrice)) {
        throw new Error('Accepted row prices must be numeric before submitting.');
      }
      return [{
        productId: productIdNumber,
        reviewedPrice: Math.round(reviewedPrice * 100) / 100,
      }];
    });
    const readDraftRows = () => Array.from(document.querySelectorAll('[data-review-item]')).map((row) => {
      const productId = row.dataset.productId || '';
      const checkbox = getIncludeCheckbox(productId);
      const input = getPriceInput(productId);
      return {
        followUpNotes: getStoredRowState(productId).followUpNotes,
        include: checkbox?.checked !== false,
        productId: Number.parseInt(productId, 10),
        reviewedPrice: input?.value.trim() ? input.value.trim() : null,
        status: normalizeReviewStatus(row.dataset.reviewStatus),
      };
    });
    const readDraftGroupFollowUpNotes = () => Object.values(storedRowsState.groupFollowUpNotes || {})
      .map((groupState) => ({
        followUpNotes: normalizeFollowUpNotes(groupState.followUpNotes),
        groupKey: groupState.groupKey,
        groupLevel: normalizeGroupLevel(groupState.groupLevel),
        label: typeof groupState.label === 'string' && groupState.label.trim() ? groupState.label.trim().slice(0, 500) : groupState.groupKey,
      }))
      .filter((groupState) => groupState.followUpNotes.length > 0);
    const readDraftBrandMetadata = () => Object.values(storedRowsState.brandMetadata || {})
      .map((brandState) => ({
        brandKey: brandState.brandKey,
        isMso: brandState.isMso === true,
        label: typeof brandState.label === 'string' && brandState.label.trim() ? brandState.label.trim().slice(0, 500) : brandState.brandKey,
        note: typeof brandState.note === 'string' && brandState.note.trim() ? brandState.note.trim().slice(0, 500) : null,
      }))
      .filter((brandState) => brandState.isMso || brandState.note !== null);
    const pollSubmission = async (submissionId) => {
      while (true) {
        const response = await fetch('/api/pricing-review/submissions/' + encodeURIComponent(submissionId));
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || 'Could not read submission status.');
        }
        const detailBits = [summarizeSubmission(payload), renderResultLink(payload)].filter(Boolean);
        if (payload.status === 'queued' || payload.status === 'running') {
          setSubmissionStatus('running', 'Applying accepted prices...', detailBits.join(' · '));
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
          continue;
        }
        if (payload.status === 'completed') {
          setSubmissionStatus('success', 'Accepted prices applied successfully.', detailBits.join(' · '));
          return;
        }
        if (payload.status === 'completed_with_errors') {
          const errorText = payload.errorMessage ? ' · ' + payload.errorMessage : '';
          setSubmissionStatus('warning', 'Accepted prices finished with row-level errors.', detailBits.join(' · ') + errorText);
          return;
        }
        const errorDetail = [summarizeSubmission(payload), payload.errorMessage, renderResultLink(payload)].filter(Boolean).join(' · ');
        setSubmissionStatus('error', 'Accepted price submission failed.', errorDetail);
        return;
      }
    };
    saveButtons.forEach((button) => {
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        try {
          if (!submissionForm) {
            throw new Error('Review form is unavailable.');
          }
          if (window.location.protocol === 'file:') {
            throw new Error(describeSubmissionTransportError(new Error('NetworkError'), '/api/pricing-review/drafts'));
          }
          setButtonsDisabled(true);
          setSubmissionStatus('running', 'Saving review state...', 'Writing the current review checkpoint to the local review service.');
          const response = await fetch('/api/pricing-review/drafts', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              brandMetadata: readDraftBrandMetadata(),
              groupFollowUpNotes: readDraftGroupFollowUpNotes(),
              packetId: submissionForm.dataset.packetId,
              rows: readDraftRows(),
            }),
          });
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.error || 'Could not save the review state.');
          }
          markDraftSaved(payload.savedAt);
          setSubmissionStatus('success', 'Review state saved.', [summarizeDraft(payload), renderResultLink(payload)].filter(Boolean).join(' · '));
        } catch (error) {
          const message = describeSubmissionTransportError(error, '/api/pricing-review/drafts');
          setSubmissionStatus('error', 'Review state save failed.', message);
        } finally {
          setButtonsDisabled(false);
        }
      });
    });
    if (submissionForm) {
      submissionForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          const rows = readSubmissionRows();
          if (rows.length === 0) {
            throw new Error('Accept at least one included row before submitting prices.');
          }
          if (window.location.protocol === 'file:') {
            throw new Error(describeSubmissionTransportError(new Error('NetworkError'), '/api/pricing-review/submissions'));
          }
          setButtonsDisabled(true);
          setSubmissionStatus('running', 'Queueing accepted prices...', 'Preparing the local apply request.');
          const response = await fetch('/api/pricing-review/submissions', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              packetId: submissionForm.dataset.packetId,
              rows,
            }),
          });
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.error || 'Could not queue accepted prices.');
          }
          await pollSubmission(payload.submissionId);
        } catch (error) {
          const message = describeSubmissionTransportError(error, '/api/pricing-review/submissions');
          setSubmissionStatus('error', 'Accepted price submission failed.', message);
        } finally {
          setButtonsDisabled(false);
        }
      });
    }
    window.addEventListener('storage', (event) => {
      if (event.key !== storageKey) {
        return;
      }
      const reloadedState = loadStoredRows();
      storedRowsState.brandMetadata = reloadedState.brandMetadata;
      storedRowsState.groupFollowUpNotes = reloadedState.groupFollowUpNotes;
      storedRowsState.lastLocalChangeAt = reloadedState.lastLocalChangeAt;
      storedRowsState.lastSavedAt = reloadedState.lastSavedAt;
      storedRowsState.rows = reloadedState.rows;
      storedRowsState.showOutstandingFollowUpOnly = reloadedState.showOutstandingFollowUpOnly;
      rebuildOutstandingFollowUpRuntime();
      outstandingNoteFilterToggles.forEach((toggle) => {
        toggle.checked = storedRowsState.showOutstandingFollowUpOnly === true;
      });
      applyStoredStateToRows();
      treeNavControl?.revealTarget(decodeURIComponent((window.location.hash || '').replace(/^#/, '')));
    });
  </script>
  <script src="review-packet-ui.js"></script>
</body>
</html>
`
}

function buildReviewGroupDomId(groupKey: string): string {
  return `review-group-${groupKey.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'section'}`
}

function renderBrandExposure(label: string, brandMetadata: PricingReviewBrandMetadataRef): string {
  return `
    <span class="brand-exposure" data-brand-meta-key="${escapeHtml(brandMetadata.key)}" data-brand-meta-label="${escapeHtml(brandMetadata.label)}">
      <span class="brand-exposure-text">${escapeHtml(label)}</span>
      <span class="brand-meta-indicators">
        <span class="brand-note-indicator" data-brand-note-indicator hidden aria-hidden="true" title=""></span>
        <span class="brand-mso-indicator" data-brand-mso-indicator hidden>MSO</span>
      </span>
    </span>
  `
}

function renderBrandSummaryMsoToggle(brandMetadata: PricingReviewBrandMetadataRef): string {
  return `
    <span class="brand-summary-controls">
      <label class="brand-summary-mso-toggle" title="Switch the default reviewed price for this brand between the standard and MSO pricing bands.">
        <input type="checkbox" data-brand-mso-input data-brand-meta-key="${escapeHtml(brandMetadata.key)}">
        <span>MSO price band</span>
      </label>
    </span>
  `
}

function renderBrandMetadataToolbar(brandMetadata: PricingReviewBrandMetadataRef): string {
  return `
    <div class="brand-metadata-toolbar" data-brand-metadata-toolbar data-brand-meta-key="${escapeHtml(brandMetadata.key)}" data-brand-meta-label="${escapeHtml(brandMetadata.label)}">
      <div>
        <strong>Brand metadata</strong>
        <div class="muted">Shared brand note + MSO flag across every packet mention of this brand. Leave the checkbox off unless you want this brand annotated as an MSO.</div>
      </div>
      <div class="brand-metadata-controls">
        <label class="brand-mso-toggle">
          <input type="checkbox" data-brand-mso-input data-brand-meta-key="${escapeHtml(brandMetadata.key)}">
          <span>Mark brand as MSO</span>
        </label>
        <input
          type="text"
          class="brand-note-input"
          autocomplete="off"
          spellcheck="false"
          maxlength="500"
          placeholder="Add a hover note for ${escapeHtml(brandMetadata.label)}"
          data-brand-note-input
          data-brand-meta-key="${escapeHtml(brandMetadata.key)}"
        >
      </div>
    </div>
  `
}

function renderDetailBrandMetadataPanel(brandMetadata: PricingReviewBrandMetadataRef): string {
  return `
    <div class="brand-metadata-panel" data-brand-metadata-panel data-brand-meta-key="${escapeHtml(brandMetadata.key)}" data-brand-meta-label="${escapeHtml(brandMetadata.label)}">
      <div>
        <strong>Brand metadata</strong>
        <div class="muted">Shared note + MSO flag across the packet and this detail page. Leave the checkbox off unless you want this brand annotated as an MSO.</div>
      </div>
      <div class="brand-metadata-controls">
        <label class="brand-mso-toggle">
          <input type="checkbox" data-brand-mso-input data-brand-meta-key="${escapeHtml(brandMetadata.key)}">
          <span>Mark brand as MSO</span>
        </label>
        <input
          type="text"
          class="brand-note-input"
          autocomplete="off"
          spellcheck="false"
          maxlength="500"
          placeholder="Add a hover note for ${escapeHtml(brandMetadata.label)}"
          data-brand-note-input
          data-brand-meta-key="${escapeHtml(brandMetadata.key)}"
        >
      </div>
    </div>
  `
}

function buildPacketNavigationNodes(groups: PacketGroup[]): PacketNavigationNode[] {
  const categoryMap = new Map<string, PacketNavigationNode>()

  const ensureNode = (
    collection: Map<string, PacketNavigationNode>,
    key: string,
    label: string,
    level: PacketNavigationNode['level'],
  ): PacketNavigationNode => {
    const existing = collection.get(key)
    if (existing) {
      return existing
    }
    const created: PacketNavigationNode = {
      childCount: 0,
      children: [],
      key,
      label,
      level,
      targetId: buildReviewGroupDomId(key),
    }
    collection.set(key, created)
    return created
  }

  const ensureChildNode = (
    parent: PacketNavigationNode,
    key: string,
    label: string,
    level: PacketNavigationNode['level'],
  ): PacketNavigationNode => {
    const existing = parent.children.find((child) => child.key === key)
    if (existing) {
      return existing
    }
    const created: PacketNavigationNode = {
      childCount: 0,
      children: [],
      key,
      label,
      level,
      targetId: buildReviewGroupDomId(key),
    }
    parent.children.push(created)
    return created
  }

  for (const group of groups) {
    for (const row of group.generatedProducts) {
      const categoryNode = ensureNode(
        categoryMap,
        row.hierarchy.categoryKey,
        row.hierarchy.categoryLabel,
        'category',
      )
      categoryNode.childCount += 1
      const subcategoryNode = ensureChildNode(
        categoryNode,
        row.hierarchy.subcategoryKey,
        row.hierarchy.subcategoryLabel,
        'subcategory',
      )
      subcategoryNode.childCount += 1
      const variantNode = ensureChildNode(
        subcategoryNode,
        row.hierarchy.variantKey,
        row.hierarchy.variantLabel,
        'variant',
      )
      variantNode.childCount += 1
      const brandNode = ensureChildNode(
        variantNode,
        row.hierarchy.brandKey,
        row.hierarchy.brandLabel,
        'brand',
      )
      brandNode.childCount += 1
    }
  }

  return [...categoryMap.values()]
}

function renderPacketNavigation(groups: PacketGroup[]): string {
  const nodes = buildPacketNavigationNodes(groups).map(mapPacketNavigationNode)
  return renderReviewTreeNav(nodes, {
    ariaLabel: 'Packet navigation',
    description: 'Jump across the packet hierarchy. Tree nodes collapse independently.',
    hideButtonLabel: 'Hide nav',
    title: 'Packet Navigation',
  })
}

function mapPacketNavigationNode(node: PacketNavigationNode): ReviewTreeNavNode {
  const selfLinkLabel = node.level === 'brand'
    ? 'Review block'
    : node.level === 'category'
      ? 'Open category block'
      : node.level === 'subcategory'
        ? 'Open subcategory block'
        : 'Open variant block'

  return {
    childCount: node.childCount,
    children: node.children.map(mapPacketNavigationNode),
    defaultOpen: node.level === 'category',
    key: `nav:${node.key}`,
    labelHtml: node.level === 'brand'
      ? renderBrandExposure(node.label, buildBrandMetadataRef(node.label))
      : escapeHtml(node.label),
    selfLinkLabel,
    targetId: node.targetId,
    tone: node.level === 'category' ? 'group' : 'node',
  }
}

function renderGroupedPacket(groups: PacketGroup[]): string {
  const hierarchy = new Map<string, Map<string, Map<string, Map<string, PacketRow[]>>>>()
  for (const group of groups) {
    for (const row of group.generatedProducts) {
      const category = row.hierarchy?.categoryLabel ?? group.categoryName ?? 'Uncategorized'
      const subcategory = row.hierarchy?.subcategoryLabel ?? group.subcategoryName ?? 'No subcategory'
      const variant = row.hierarchy?.variantLabel ?? row.tab ?? 'Unknown size'
      const brand = row.hierarchy?.brandLabel ?? row.brand ?? group.brandName ?? 'No brand'
      const categoryMap = getOrCreateMap(hierarchy, category)
      const subcategoryMap = getOrCreateMap(categoryMap, subcategory)
      const variantMap = getOrCreateMap(subcategoryMap, variant)
      const brandRows = getOrCreateArray(variantMap, brand)
      brandRows.push(row)
    }
  }

  const sections: string[] = []
  for (const [category, subcategoryMap] of hierarchy) {
    const categoryCount = countNestedRows(subcategoryMap)
    const subcategorySections: string[] = []
    for (const [subcategory, variantMap] of subcategoryMap) {
      const subcategoryCount = countNestedRows(variantMap)
      const variantSections: string[] = []
      for (const [variant, brandMap] of variantMap) {
        const variantCount = countNestedRows(brandMap)
        const brandSections = [...brandMap.entries()].map(([brand, rows]) => {
          const brandHierarchy = rows[0]?.hierarchy
          const brandMetadata = rows[0]?.brandMetadata
          if (!brandHierarchy) {
            return ''
          }
          return `
          <details class="group-block group-brand" id="${escapeHtml(buildReviewGroupDomId(brandHierarchy.brandKey))}" data-review-group data-review-group-level="brand" data-group-key="${escapeHtml(brandHierarchy.brandKey)}" data-group-label="${escapeHtml(brandHierarchy.brandScopeLabel)}" data-brand-meta-key="${escapeHtml((brandMetadata ?? buildBrandMetadataRef(brand)).key)}" data-brand-meta-label="${escapeHtml((brandMetadata ?? buildBrandMetadataRef(brand)).label)}" open>
            <summary>
              <span class="group-kicker">Brand</span>
              <strong>${renderBrandExposure(brand, brandMetadata ?? buildBrandMetadataRef(brand))}</strong>
              ${renderBrandSummaryMsoToggle(brandMetadata ?? buildBrandMetadataRef(brand))}
              ${renderGroupIncludeToggle('Brand', brand)}
              <span class="group-count">${rows.length} product${rows.length === 1 ? '' : 's'}</span>
              <span class="group-review-stats" data-review-group-stats></span>
            </summary>
            <div class="group-content">
              ${renderGroupReviewToolbar('Brand', brand, brandHierarchy.brandKey, brandHierarchy.brandScopeLabel)}
              ${renderBrandReviewToolbar(rows)}
              ${renderBrandMetadataToolbar(brandMetadata ?? buildBrandMetadataRef(brand))}
              ${renderBrandTable(rows.sort(comparePacketRows))}
              ${renderGroupFooter('Brand')}
            </div>
          </details>
        `
        }).join('')
        const firstVariantRow = [...brandMap.values()][0]?.[0]
        const variantHierarchy = firstVariantRow?.hierarchy
        if (!variantHierarchy) {
          continue
        }
        variantSections.push(`
          <details class="group-block group-variant" id="${escapeHtml(buildReviewGroupDomId(variantHierarchy.variantKey))}" data-review-group data-review-group-level="variant" data-group-key="${escapeHtml(variantHierarchy.variantKey)}" data-group-label="${escapeHtml(variantHierarchy.variantScopeLabel)}" open>
            <summary>
              <span class="group-kicker">Variant</span>
              <strong>${escapeHtml(variant)}</strong>
              ${renderGroupIncludeToggle('Variant', variant)}
              <span class="group-count">${variantCount} product${variantCount === 1 ? '' : 's'}</span>
              <span class="group-review-stats" data-review-group-stats></span>
            </summary>
            <div class="group-content">
              ${renderGroupReviewToolbar('Variant', variant, variantHierarchy.variantKey, variantHierarchy.variantScopeLabel)}
              ${brandSections}
              ${renderGroupFooter('Variant')}
            </div>
          </details>
        `)
      }
      const firstSubcategoryRow = [...variantMap.values()][0]?.values().next().value?.[0] as PacketRow | undefined
      const subcategoryHierarchy = firstSubcategoryRow?.hierarchy
      if (!subcategoryHierarchy) {
        continue
      }
      subcategorySections.push(`
        <details class="group-block group-subcategory" id="${escapeHtml(buildReviewGroupDomId(subcategoryHierarchy.subcategoryKey))}" data-review-group data-review-group-level="subcategory" data-group-key="${escapeHtml(subcategoryHierarchy.subcategoryKey)}" data-group-label="${escapeHtml(subcategoryHierarchy.subcategoryScopeLabel)}" open>
          <summary>
            <span class="group-kicker">Subcategory / lane</span>
            <strong>${escapeHtml(subcategory)}</strong>
            ${renderGroupIncludeToggle('Subcategory', subcategory)}
            <span class="group-count">${subcategoryCount} product${subcategoryCount === 1 ? '' : 's'}</span>
            <span class="group-review-stats" data-review-group-stats></span>
          </summary>
          <div class="group-content">
            ${renderGroupReviewToolbar('Subcategory', subcategory, subcategoryHierarchy.subcategoryKey, subcategoryHierarchy.subcategoryScopeLabel)}
            ${variantSections.join('')}
            ${renderGroupFooter('Subcategory')}
          </div>
        </details>
      `)
    }
    const firstCategoryRow = [...subcategoryMap.values()][0]?.values().next().value?.values().next().value?.[0] as PacketRow | undefined
    const categoryHierarchy = firstCategoryRow?.hierarchy
    if (!categoryHierarchy) {
      continue
    }
    sections.push(`
      <details class="group-block group-category" id="${escapeHtml(buildReviewGroupDomId(categoryHierarchy.categoryKey))}" data-review-group data-review-group-level="category" data-group-key="${escapeHtml(categoryHierarchy.categoryKey)}" data-group-label="${escapeHtml(categoryHierarchy.categoryScopeLabel)}" open>
        <summary>
          <span class="group-kicker">Category</span>
          <strong>${escapeHtml(category)}</strong>
          ${renderGroupIncludeToggle('Category', category)}
          <span class="group-count">${categoryCount} product${categoryCount === 1 ? '' : 's'}</span>
          <span class="group-review-stats" data-review-group-stats></span>
        </summary>
        <div class="group-content">
          ${renderGroupReviewToolbar('Category', category, categoryHierarchy.categoryKey, categoryHierarchy.categoryScopeLabel)}
          ${subcategorySections.join('')}
          ${renderGroupFooter('Category')}
        </div>
      </details>
    `)
  }
  return sections.join('')
}

function renderBrandTable(rows: PacketRow[]): string {
  return `
    <table>
      <thead>
        <tr>
          <th>Product</th>
          <th>Picture</th>
          <th>Pricing</th>
          <th>Reviewed price</th>
          <th>Scope</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => renderPacketRow(row)).join('')}
      </tbody>
    </table>
  `
}

function renderBrandReviewToolbar(rows: PacketRow[]): string {
  const actionableCount = rows.filter((row) => row.isActionable).length
  return `
    <div class="brand-review-toolbar" data-brand-batch-controls>
      <div>
        <strong>Brand batch price</strong>
        <div class="muted">Stamp one reviewed price across the unreviewed rows in this brand block.</div>
      </div>
      <div class="submit-actions">
        <input
          type="text"
          inputmode="decimal"
          autocomplete="off"
          spellcheck="false"
          placeholder="32.00"
          data-brand-price-input
        >
        <button type="button" data-brand-price-apply>Apply to unreviewed rows</button>
        <span class="muted" data-brand-price-summary>${actionableCount} actionable row${actionableCount === 1 ? '' : 's'}</span>
      </div>
    </div>
  `
}

function renderGroupReviewToolbar(level: string, label: string, groupKey: string, groupScopeLabel: string): string {
  return `
    <div class="group-review-toolbar" data-group-review-toolbar>
      <div>
        <strong>${escapeHtml(level)} status</strong>
        <div class="muted">Mark the full ${escapeHtml(level.toLowerCase())} block for review in one pass.</div>
      </div>
      <div class="submit-actions">
        <div class="review-status-buttons" role="group" aria-label="Set review status for ${escapeHtml(label)} ${escapeHtml(level.toLowerCase())} block">
          <button type="button" class="review-status-button" data-group-status-button data-status="unreviewed" aria-pressed="false">Unreviewed</button>
          <button type="button" class="review-status-button" data-group-status-button data-status="accepted" aria-pressed="false">Accepted</button>
          <button type="button" class="review-status-button" data-group-status-button data-status="rejected" aria-pressed="false">Rejected</button>
        </div>
        <span class="muted" data-group-status-summary>0 unreviewed · 0 accepted · 0 rejected</span>
      </div>
    </div>
    <div class="follow-up-notes group-follow-up-notes" data-group-follow-up-notes data-group-key="${escapeHtml(groupKey)}" data-group-level="${escapeHtml(level.toLowerCase())}" data-group-label="${escapeHtml(groupScopeLabel)}">
      <div class="follow-up-notes-header">
        <span class="muted">Follow-up notes for ${escapeHtml(level.toLowerCase())} block</span>
        <span class="muted" data-group-follow-up-summary data-group-key="${escapeHtml(groupKey)}">No follow-up notes</span>
      </div>
      <div class="muted group-follow-up-label">${escapeHtml(groupScopeLabel)}</div>
      <div class="follow-up-note-list" data-group-follow-up-note-list data-group-key="${escapeHtml(groupKey)}">
        <div class="follow-up-note-empty">No follow-up notes yet.</div>
      </div>
      <div class="follow-up-note-add-row">
        <input
          class="follow-up-note-input"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="Add a follow-up task or note for this ${escapeHtml(level.toLowerCase())} block"
          data-group-follow-up-note-input
          data-group-key="${escapeHtml(groupKey)}"
        >
        <button type="button" class="follow-up-note-add-button" data-group-follow-up-note-add data-group-key="${escapeHtml(groupKey)}">Add note</button>
      </div>
    </div>
  `
}

function renderPacketRow(row: PacketRow): string {
  const actionLabel = determinePacketActionLabel(row.currentPrice, row.proposedPrice)
  const actionType = determinePacketActionType(row.currentPrice, row.proposedPrice)
  const standardReviewedPrice = row.proposedPrice ?? row.currentPrice
  const imageHtml = row.imageUrl
    ? `<a class="thumb-link" href="${escapeHtml(row.imageUrl)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(row.imageUrl)}" alt="${escapeHtml(row.productName)} image"></a>`
    : '<div class="thumb-empty">No image</div>'
  const pricingHtml = renderPricingLadder(row, false)
  const reviewHtml = renderReviewInputCell(row)
  const scopeHtml = `${row.scopeBadges.map((badge) => `<span class="chip scope">${escapeHtml(badge)}</span>`).join('')}<div class="muted">${escapeHtml(row.scopeNotes.join(' '))}</div>`
  const chips = [`<span class="chip ${actionType}" data-review-action-chip data-product-id="${row.productId}">${escapeHtml(actionLabel.replace(/-/g, ' '))}</span>`].join('')
  const reviewedPrice = standardReviewedPrice
  const recentSalesIndicator = describePacketRecentSales(row.recentSales.summary)
  const productSummaryHtml = `
    <a
      class="product-link"
      href="${escapeHtml(row.detailHref)}"
      target="_blank"
      rel="noopener noreferrer"
      title="Open the full detail page with every retained competitor listing for this SKU"
    >
      <strong>${escapeHtml(row.productName)}</strong>
      <span class="muted">${renderBrandExposure(row.brandMetadata.label, row.brandMetadata)} - product ${row.productId} / group ${row.groupId}</span>
      <span class="muted">${escapeHtml(row.groupName)} - ${escapeHtml(row.tab)}</span>
      <span class="velocity-summary-row"><span class="velocity-indicator velocity-indicator-${recentSalesIndicator.tone}">${escapeHtml(recentSalesIndicator.detailLabel)}</span><span class="muted">${escapeHtml(formatPacketCoverage(row.recentSales.summary))}</span></span>
      <span class="product-link-hint">Open full detail page and competitor evidence</span>
    </a>
  `
  const collapsedSummaryHtml = `
    <a class="product-link" href="${escapeHtml(row.detailHref)}" target="_blank" rel="noopener noreferrer">
      <strong>${escapeHtml(row.productName)}</strong>
      <span class="muted">${renderBrandExposure(row.brandMetadata.label, row.brandMetadata)} - ${escapeHtml(row.groupName)} - ${escapeHtml(row.tab)}</span>
    </a>
  `
  return `
    <tr
      class="product-row"
      data-ancestor-group-keys="${escapeHtml([row.hierarchy.categoryKey, row.hierarchy.subcategoryKey, row.hierarchy.variantKey, row.hierarchy.brandKey].join(' '))}"
      data-brand-key="${escapeHtml(row.hierarchy.brandKey)}"
      data-category-key="${escapeHtml(row.hierarchy.categoryKey)}"
      data-detail-href="${escapeHtml(row.detailHref)}"
      data-product-id="${row.productId}"
      data-review-is-actionable="${row.isActionable ? 'true' : 'false'}"
      data-review-item
      data-review-status="unreviewed"
      data-brand-meta-key="${escapeHtml(row.brandMetadata.key)}"
      data-subcategory-key="${escapeHtml(row.hierarchy.subcategoryKey)}"
      data-variant-key="${escapeHtml(row.hierarchy.variantKey)}"
    >
      <td>
        ${productSummaryHtml}
      </td>
      <td>${imageHtml}</td>
      <td>${chips}${pricingHtml}</td>
      <td>${reviewHtml}</td>
      <td>${scopeHtml}</td>
      <td><div>${escapeHtml(row.reason)}</div><div class="muted" style="margin-top:8px;">${escapeHtml(marketCoverageText(row))}</div></td>
    </tr>
    <tr class="product-row-collapsed" data-collapsed-review-row data-product-id="${row.productId}" hidden>
      <td colspan="6">
        <div class="collapsed-row-shell">
          <div class="collapsed-row-main">
            ${collapsedSummaryHtml}
          </div>
          <div class="collapsed-row-actions">
            <span class="review-status-badge unreviewed" data-collapsed-status>Unreviewed</span>
            <span class="muted" data-collapsed-reviewed-price>${compactCurrency(reviewedPrice)}</span>
            <span class="muted" data-collapsed-follow-up-summary>Follow-up: none</span>
          <button type="button" data-expand-reviewed-row data-product-id="${row.productId}">Expand row</button>
        </div>
      </div>
    </td>
  </tr>
  `
}

function renderDetailHtml(report: PacketReport, row: PacketRow): string {
  const imageHtml = row.imageUrl
    ? `<a class="thumb-link detail-thumb" href="${escapeHtml(row.imageUrl)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(row.imageUrl)}" alt="${escapeHtml(row.productName)} image"></a>`
    : '<div class="thumb-empty detail-thumb">No image</div>'
  const marketRows = row.marketEvidence?.matchedListings ?? []
  const marketSummaryHtml = renderMarketEvidenceSummary(row)
  const recentSalesSummary = describePacketRecentSales(row.recentSales.summary)
  const detailReviewHtml = renderDetailReviewControls(row)
  const familyAnchorHtml = row.familyAnchor
    ? `<div><span class="muted">Family anchor</span><br><span class="metric">${escapeHtml(row.familyAnchor.sourceProductName)} @ ${compactCurrency(row.familyAnchor.anchorPrice)}</span><div class="muted">${escapeHtml(row.familyAnchor.note)}</div></div>`
    : '<div><span class="muted">Family anchor</span><br><span class="metric">None retained</span></div>'
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(row.productName)} - Pricing Review Detail</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4efe6;
      --card: #fffaf2;
      --ink: #241f1a;
      --muted: #6e665c;
      --line: #dccfb8;
      --raise: #8a4626;
      --lower: #8d2f52;
      --set: #27417e;
      --keep: #1f5d42;
      --warning: #8b5e11;
      --near: #1ed760;
      --mid: #3d86d8;
      --far: #df574d;
      --very-far: #8b8b8b;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--ink); }
    .wrap { max-width: 1300px; margin: 0 auto; padding: 28px 24px 40px; }
    a { color: inherit; }
    .topbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 18px; }
    .back-link { color: var(--muted); text-decoration: none; font-size: 14px; }
    .hero { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 22px; align-items: start; }
    .hero-card, .section { background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 18px; box-shadow: 0 8px 24px rgba(31, 27, 23, 0.05); }
    h1 { margin: 0 0 8px; font-size: 26px; line-height: 1.15; }
    h2 { margin: 0 0 12px; font-size: 17px; }
    .meta { color: var(--muted); font-size: 14px; line-height: 1.5; }
    .muted { color: var(--muted); }
    .metric { font-weight: 600; }
    .brand-exposure { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
    .brand-exposure-text { min-width: 0; }
    .brand-exposure.is-mso .brand-exposure-text { color: #7f3c11; font-weight: 700; }
    .brand-meta-indicators { display: inline-flex; align-items: center; gap: 6px; }
    .brand-note-indicator { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 999px; background: #8d2f52; color: #fff; font-size: 12px; font-weight: 800; line-height: 1; }
    .brand-note-indicator::before { content: '!'; }
    .brand-mso-indicator { display: inline-flex; align-items: center; justify-content: center; padding: 2px 7px; border-radius: 999px; background: rgba(127, 60, 17, 0.12); border: 1px solid rgba(127, 60, 17, 0.2); color: #7f3c11; font-size: 10px; font-weight: 800; letter-spacing: 0.08em; }
    .chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #fff; margin: 0 6px 6px 0; }
    .chip.raise { background: var(--raise); }
    .chip.lower { background: var(--lower); }
    .chip.set { background: var(--set); }
    .chip.keep { background: var(--keep); }
    .chip.warning { background: var(--warning); }
    .chip.scope { background: #5d4b83; }
    .thumb-link, .thumb-empty { display: inline-flex; width: 100%; aspect-ratio: 1 / 1; align-items: center; justify-content: center; border-radius: 16px; border: 1px solid var(--line); overflow: hidden; background: #f8f1e5; }
    .thumb-link img { width: 100%; height: 100%; object-fit: cover; }
    .detail-thumb { max-width: 240px; }
    .section-grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(320px, 0.9fr); gap: 18px; margin-top: 18px; }
    .detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 18px; }
    .detail-grid div { font-size: 14px; line-height: 1.5; }
    .pricing-ladder-shell { margin-top: 12px; }
    .pricing-ladder-head { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: baseline; margin-bottom: 12px; }
    .pricing-ladder { position: relative; height: 176px; margin: 10px 0 12px; }
    .ladder-track { position: absolute; left: 0; right: 0; top: 88px; height: 4px; border-radius: 999px; background: #d9ceb7; }
    .ladder-iqr { position: absolute; top: 80px; height: 16px; border-radius: 999px; background: rgba(39, 65, 126, 0.18); border: 1px solid rgba(39, 65, 126, 0.26); }
    .ladder-median { position: absolute; top: 74px; width: 2px; height: 32px; background: #27417e; }
    .ladder-competitor { position: absolute; width: 10px; height: 10px; margin-left: -5px; border-radius: 999px; border: 1px solid rgba(31, 27, 23, 0.25); box-shadow: 0 0 0 2px rgba(255, 250, 241, 0.85); }
    .ladder-competitor.near { background: var(--near); }
    .ladder-competitor.mid { background: var(--mid); }
    .ladder-competitor.far { background: var(--far); }
    .ladder-competitor.very_far, .ladder-competitor.unknown { background: var(--very-far); }
    .ladder-marker { position: absolute; width: 2px; transform: translateX(-1px); }
    .ladder-marker.current, .ladder-marker.proposed { top: 98px; height: 28px; }
    .ladder-marker::before { content: ''; position: absolute; left: 50%; width: 12px; height: 12px; transform: translateX(-50%) rotate(45deg); border: 2px solid currentColor; background: var(--card); }
    .ladder-marker.current::before, .ladder-marker.proposed::before { top: -12px; }
    .ladder-marker span { position: absolute; left: 50%; transform: translateX(-50%); font-size: 12px; font-weight: 700; white-space: nowrap; background: rgba(255,250,241,0.92); padding: 1px 6px; border-radius: 999px; border: 1px solid currentColor; }
    .ladder-marker.current span, .ladder-marker.proposed span { top: 18px; }
    .ladder-marker.current { color: #6d665b; }
    .ladder-marker.proposed { color: #8a4626; }
    .ladder-marker.proposed[data-review-ladder-marker] { cursor: grab; touch-action: none; }
    .ladder-marker.proposed[data-review-ladder-marker].is-dragging { cursor: grabbing; }
    .ladder-marker.market-average { top: 16px; height: 54px; color: #27417e; }
    .ladder-marker.market-average::before { bottom: -12px; }
    .ladder-marker.market-average span { bottom: 18px; }
    .ladder-axis { position: absolute; bottom: 0; font-size: 11px; color: var(--muted); }
    .ladder-axis.axis-min { left: 0; }
    .ladder-axis.axis-max { right: 0; }
    .pricing-ladder-meta { display: flex; flex-wrap: wrap; gap: 8px 12px; font-size: 12px; }
    .detail-review-panel { margin-top: 16px; padding: 14px 16px; border-radius: 16px; border: 1px solid var(--line); background: rgba(255,255,255,0.7); }
    .detail-review-grid { display: grid; grid-template-columns: minmax(0, 280px) minmax(0, 1fr); gap: 12px 18px; align-items: start; }
    .review-price-field { display: grid; gap: 6px; min-width: 160px; }
    .review-price-input-row { display: flex; align-items: stretch; gap: 8px; }
    .review-price-input { width: 118px; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--line); background: #fff; font: inherit; }
    .review-price-input:focus { outline: 2px solid rgba(41, 79, 148, 0.25); outline-offset: 1px; border-color: #294f94; }
    .review-price-stepper { display: grid; grid-template-rows: repeat(2, minmax(0, 1fr)); gap: 4px; }
    .review-price-step-button { min-width: 30px; padding: 0 8px; border-radius: 8px; border: 1px solid var(--line); background: rgba(255,255,255,0.92); color: #294f94; font: inherit; font-size: 11px; font-weight: 700; line-height: 1; cursor: pointer; }
    .review-price-step-button:hover:not(:disabled) { background: rgba(41, 79, 148, 0.08); }
    .review-price-step-button:disabled { cursor: not-allowed; opacity: 0.6; }
    .review-price-meta { display: grid; gap: 2px; }
    .review-price-field.is-excluded { opacity: 0.55; }
    .review-status-field { display: grid; gap: 6px; }
    .review-status-buttons { display: flex; flex-wrap: wrap; gap: 6px; }
    .review-status-button { border: 1px solid var(--line); border-radius: 999px; background: rgba(255,255,255,0.9); color: var(--muted); font: inherit; font-size: 12px; font-weight: 700; padding: 6px 10px; cursor: pointer; }
    .review-status-button.is-active { color: #fff; border-color: transparent; }
    .review-status-button[data-status="unreviewed"].is-active { background: var(--warning); }
    .review-status-button[data-status="accepted"].is-active { background: var(--keep); }
    .review-status-button[data-status="rejected"].is-active { background: var(--lower); }
    .follow-up-notes { display: grid; gap: 8px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--line); background: rgba(255,255,255,0.78); margin-top: 14px; }
    .follow-up-notes-header { display: flex; flex-wrap: wrap; gap: 6px 10px; justify-content: space-between; align-items: baseline; }
    .follow-up-note-list { display: grid; gap: 8px; }
    .follow-up-note-empty { color: var(--muted); font-size: 12px; }
    .follow-up-note { display: flex; gap: 8px 10px; align-items: flex-start; padding: 8px 10px; border-radius: 10px; border: 1px solid rgba(220, 207, 184, 0.9); background: rgba(255,255,255,0.88); }
    .follow-up-note.is-completed { opacity: 0.78; background: rgba(244, 239, 230, 0.92); }
    .follow-up-note-body { display: grid; gap: 2px; min-width: 0; }
    .follow-up-note-text { font-weight: 600; color: var(--ink); word-break: break-word; }
    .follow-up-note-toggle { border: 1px solid var(--line); border-radius: 999px; background: rgba(255,255,255,0.96); color: var(--keep); font: inherit; font-size: 11px; font-weight: 700; padding: 6px 10px; cursor: pointer; white-space: nowrap; }
    .follow-up-note-toggle.is-completed { color: #5d4b83; }
    .follow-up-note-add-row { display: flex; gap: 8px; align-items: center; }
    .follow-up-note-input { flex: 1 1 220px; min-width: 0; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--line); background: #fff; font: inherit; }
    .follow-up-note-input:focus { outline: 2px solid rgba(41, 79, 148, 0.25); outline-offset: 1px; border-color: #294f94; }
    .follow-up-note-add-button { border: 1px solid var(--line); border-radius: 999px; background: #fff; color: #294f94; font: inherit; font-size: 12px; font-weight: 700; padding: 8px 12px; cursor: pointer; }
    .brand-metadata-panel { display: grid; gap: 10px; margin-top: 14px; padding: 12px 14px; border-radius: 16px; border: 1px solid var(--line); background: rgba(255,255,255,0.74); }
    .brand-metadata-panel strong { display: block; margin-bottom: 2px; }
    .brand-metadata-controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .brand-mso-toggle { display: inline-flex; align-items: center; gap: 8px; padding: 7px 12px; border-radius: 999px; border: 1px solid var(--line); background: rgba(255,255,255,0.92); color: #7f3c11; font-size: 12px; font-weight: 700; }
    .brand-mso-toggle input { margin: 0; }
    .brand-note-input { width: min(360px, 100%); padding: 8px 10px; border-radius: 10px; border: 1px solid var(--line); background: #fff; font: inherit; }
    .brand-note-input:focus { outline: 2px solid rgba(41, 79, 148, 0.25); outline-offset: 1px; border-color: #294f94; }
    .velocity-indicator { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: 0.02em; border: 1px solid transparent; }
    .velocity-indicator-success { background: rgba(31, 93, 66, 0.1); border-color: rgba(31, 93, 66, 0.2); color: #1f5d42; }
    .velocity-indicator-danger { background: rgba(141, 47, 82, 0.1); border-color: rgba(141, 47, 82, 0.18); color: #8d2f52; }
    .velocity-indicator-muted { background: rgba(110, 102, 92, 0.12); border-color: rgba(110, 102, 92, 0.18); color: var(--muted); }
    .recent-sales-card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .recent-sales-card { background: rgba(255,255,255,0.72); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; }
    .recent-sales-card header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
    .market-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .market-table th, .market-table td { padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    .market-table th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
    @media (max-width: 960px) { .hero { grid-template-columns: 1fr; } .section-grid, .detail-grid, .detail-review-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <a class="back-link" href="../index.html">Back to pricing packet</a>
      <span class="muted">Generated ${escapeHtml(new Date(report.generatedAt).toLocaleString())}</span>
    </div>
    <section class="hero">
      <div class="hero-card">${imageHtml}</div>
      <div class="hero-card">
        <h1>${escapeHtml(row.productName)}</h1>
        <div class="meta">${renderBrandExposure(row.brandMetadata.label, row.brandMetadata)} - product ${row.productId} / group ${row.groupId}<br>${escapeHtml(row.groupName)}<br>${escapeHtml(row.category ?? 'Uncategorized')} / ${escapeHtml(row.subcategory ?? 'No subcategory')} / ${escapeHtml(row.tab)}</div>
        <p class="muted" style="margin: 12px 0 0;">This detail page shares the same local reviewed-price draft as the main packet page. You can drag the proposed diamond here, use the quarter-step buttons, or free-type a reviewed price while inspecting the full retained competitor evidence.</p>
        <div style="margin-top: 12px;">
          <span class="chip ${determinePacketActionType(row.currentPrice, row.proposedPrice)}" data-detail-review-action-chip>${escapeHtml(determinePacketActionLabel(row.currentPrice, row.proposedPrice).replace(/-/g, ' '))}</span>
          ${row.scopeBadges.map((badge) => `<span class="chip scope">${escapeHtml(badge)}</span>`).join('')}
          <span class="velocity-indicator velocity-indicator-${recentSalesSummary.tone}">${escapeHtml(recentSalesSummary.detailLabel)}</span>
        </div>
        ${detailReviewHtml}
        ${renderDetailBrandMetadataPanel(row.brandMetadata)}
        ${renderPricingLadder(row, true)}
      </div>
    </section>
    <div class="section-grid">
      <section class="section">
        <h2>Pricing Context</h2>
        <div class="detail-grid">
          <div><span class="muted">Current</span><br><span class="metric">${compactCurrency(row.currentPrice)}</span> <span class="muted">(${formatPercent(row.currentGmPercent)})</span></div>
          <div><span class="muted">Reviewed</span><br><span class="metric" data-detail-reviewed-price>${compactCurrency(row.proposedPrice ?? row.currentPrice)}</span> <span class="muted" data-detail-reviewed-gm>(${formatPercent(computePacketGmPercent(row.wholesaleCost, row.proposedPrice ?? row.currentPrice))})</span></div>
          <div><span class="muted">Cost</span><br><span class="metric">${compactCurrency(row.wholesaleCost)}</span></div>
          <div><span class="muted">Market coverage</span><br><span class="metric">${escapeHtml(marketCoverageText(row))}</span></div>
          <div style="grid-column: 1 / -1;"><span class="muted">Pricing reason</span><br>${escapeHtml(row.reason)}</div>
          <div style="grid-column: 1 / -1;"><span class="muted">Market note</span><br>${escapeHtml(row.marketNote ?? 'No market note recorded.')}</div>
        </div>
      </section>
      <section class="section">
        <h2>Scope and Family Context</h2>
        <div class="detail-grid">
          <div style="grid-column: 1 / -1;"><span class="muted">Scope notes</span><br>${escapeHtml(row.scopeNotes.join(' '))}</div>
          ${row.siteScope.map((site) => `<div><span class="muted">${escapeHtml(site.siteLabel)}</span><br><span class="metric">${site.metrics.receivedOrderCount} received order${site.metrics.receivedOrderCount === 1 ? '' : 's'}</span><div class="muted">${site.metrics.receivedPositionCount} positions${site.metrics.lastReceivedDate ? ` · latest ${escapeHtml(site.metrics.lastReceivedDate)}` : ''}</div></div>`).join('')}
          ${familyAnchorHtml}
        </div>
      </section>
    </div>
    <section class="section" style="margin-top: 18px;">
      <h2>Recent Sales</h2>
      ${renderRecentSalesSummary(row.recentSales.summary)}
      <div class="recent-sales-card-grid" style="margin-top: 14px;">
        ${row.recentSales.sites.map((site) => renderRecentSalesSiteCard(site)).join('')}
      </div>
    </section>
    <section class="section" style="margin-top: 18px;">
      <h2>All Retained Competitor Pricing Data</h2>
      ${marketSummaryHtml}
      ${renderMarketTable(marketRows)}
    </section>
  </div>
  <script src="../review-packet-ui.js"></script>
  ${renderDetailReviewScript(report, row)}
</body>
</html>
`
}

function renderDetailReviewControls(row: PacketRow): string {
  const defaultReviewedPrice = row.proposedPrice ?? row.currentPrice
  const msoReviewedPrice = computeBandAwarePacketPrice(row, MSO_PACKET_PRICING_BAND)
  const pricingControlHtml = defaultReviewedPrice === null
    ? '<div class="review-price-field is-excluded"><span class="muted">Reviewed price</span><span class="muted">No packet price is available for this SKU yet, so the detail-page price controls are disabled.</span></div>'
    : (() => {
        const reviewedPriceSummary = `${compactCurrency(defaultReviewedPrice)} (${formatCompactPercent(computePacketGmPercent(row.wholesaleCost, defaultReviewedPrice))})`
        const currentPriceSummary = `${compactCurrency(row.currentPrice)} (${formatCompactPercent(row.currentGmPercent)})`
        return `
          <label class="review-price-field" for="detail-review-price-${row.productId}">
            <span class="muted">Reviewed price</span>
            <div class="review-price-input-row">
              <input
                id="detail-review-price-${row.productId}"
                class="review-price-input"
                type="text"
                inputmode="decimal"
                value="${defaultReviewedPrice.toFixed(2)}"
                autocomplete="off"
                spellcheck="false"
                data-detail-review-price-input
                data-brand-meta-key="${escapeHtml(row.brandMetadata.key)}"
                data-current-gm-percent="${row.currentGmPercent ?? ''}"
                data-current-price="${row.currentPrice ?? ''}"
                data-default-mso-price="${msoReviewedPrice ?? ''}"
                data-default-standard-price="${defaultReviewedPrice ?? ''}"
                data-wholesale-cost="${row.wholesaleCost ?? ''}"
              >
              <div class="review-price-stepper" aria-label="Adjust reviewed price by quarter-dollar steps">
                <button
                  type="button"
                  class="review-price-step-button"
                  data-detail-review-price-step-button
                  data-step="0.25"
                  aria-label="Increase reviewed price by 25 cents"
                  title="Increase by $0.25"
                >▲</button>
                <button
                  type="button"
                  class="review-price-step-button"
                  data-detail-review-price-step-button
                  data-step="-0.25"
                  aria-label="Decrease reviewed price by 25 cents"
                  title="Decrease by $0.25"
                >▼</button>
              </div>
            </div>
            <span class="review-price-meta muted">
              <span data-detail-review-gm>${escapeHtml(currentPriceSummary)} -&gt; ${escapeHtml(reviewedPriceSummary)}</span>
              <span>Saved into the same local review draft ledger as the packet page.</span>
            </span>
          </label>
        `
      })()
  return `
    <div class="detail-review-panel">
      <div class="detail-review-grid">
        ${pricingControlHtml}
        <div class="review-status-field">
          <span class="muted">Review status</span>
          <div class="review-status-buttons" role="group" aria-label="Review status for ${escapeHtml(row.productName)}">
            <button type="button" class="review-status-button is-active" data-detail-review-status-button data-status="unreviewed" aria-pressed="true">Unreviewed</button>
            <button type="button" class="review-status-button" data-detail-review-status-button data-status="accepted" aria-pressed="false">Accepted</button>
            <button type="button" class="review-status-button" data-detail-review-status-button data-status="rejected" aria-pressed="false">Rejected</button>
          </div>
        </div>
      </div>
      <div class="follow-up-notes" data-detail-follow-up-notes>
        <div class="follow-up-notes-header">
          <span class="muted">Comments / follow-up</span>
          <span class="muted" data-detail-follow-up-summary>No follow-up notes</span>
        </div>
        <div class="follow-up-note-list" data-detail-follow-up-note-list>
          <div class="follow-up-note-empty">No follow-up notes yet.</div>
        </div>
        <div class="follow-up-note-add-row">
          <input
            class="follow-up-note-input"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="Add a comment or follow-up note"
            data-detail-follow-up-note-input
          >
          <button type="button" class="follow-up-note-add-button" data-detail-follow-up-note-add>Add note</button>
        </div>
      </div>
    </div>
  `
}

function renderDetailReviewScript(report: PacketReport, row: PacketRow): string {
  const defaultReviewedPrice = row.proposedPrice ?? row.currentPrice
  return `
  <script>
    (() => {
      const packetId = ${JSON.stringify(report.packetId)};
      const productId = ${JSON.stringify(String(row.productId))};
      const brandMetaKey = ${JSON.stringify(row.brandMetadata.key)};
      const brandMetaLabel = ${JSON.stringify(row.brandMetadata.label)};
      const defaultReviewedPrice = ${defaultReviewedPrice === null ? 'null' : String(defaultReviewedPrice)};
      const storageKey = 'helios-pricing-review-packet:' + packetId;
      const brandMsoInputs = Array.from(document.querySelectorAll('[data-brand-mso-input]'));
      const brandNoteInputs = Array.from(document.querySelectorAll('[data-brand-note-input]'));
      const priceInput = document.querySelector('[data-detail-review-price-input]');
      const priceStepButtons = Array.from(document.querySelectorAll('[data-detail-review-price-step-button]'));
      const statusButtons = Array.from(document.querySelectorAll('[data-detail-review-status-button]'));
      const followUpSummary = document.querySelector('[data-detail-follow-up-summary]');
      const followUpList = document.querySelector('[data-detail-follow-up-note-list]');
      const followUpInput = document.querySelector('[data-detail-follow-up-note-input]');
      const followUpAddButton = document.querySelector('[data-detail-follow-up-note-add]');
      const gmOutput = document.querySelector('[data-detail-review-gm]');
      const ladder = document.querySelector('[data-review-ladder][data-product-id="' + CSS.escape(productId) + '"]');
      const marker = ladder?.querySelector('[data-review-ladder-marker]');
      const contextReviewedPrice = document.querySelector('[data-detail-reviewed-price]');
      const contextReviewedGm = document.querySelector('[data-detail-reviewed-gm]');
      const ladderReviewedPrice = document.querySelector('[data-detail-ladder-reviewed-price]');
      const ladderReviewedGm = document.querySelector('[data-detail-ladder-reviewed-gm]');
      const nowIsoString = () => new Date().toISOString();
      const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
      const roundQuarterStep = (value) => Math.round((value + Number.EPSILON) * 4) / 4;
      const makeFollowUpNoteId = () => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : 'note-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      const parseIsoTimestamp = (value) => {
        const parsed = Date.parse(typeof value === 'string' ? value : '');
        return Number.isFinite(parsed) ? parsed : null;
      };
      const escapeHtml = (value) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
      const normalizeReviewStatus = (value) => value === 'accepted' || value === 'rejected' ? value : 'unreviewed';
      const formatDateTimeLabel = (value) => {
        const timestamp = parseIsoTimestamp(value);
        return timestamp === null ? 'Unknown time' : new Date(timestamp).toLocaleString();
      };
      const normalizeFollowUpNotes = (value) => Array.isArray(value)
        ? value.flatMap((note) => {
            if (!note || typeof note !== 'object') {
              return [];
            }
            const text = typeof note.text === 'string' ? note.text.trim().slice(0, 500) : '';
            if (!text) {
              return [];
            }
            const createdAt = typeof note.createdAt === 'string' && parseIsoTimestamp(note.createdAt) !== null
              ? note.createdAt
              : nowIsoString();
            const completedAt = typeof note.completedAt === 'string' && parseIsoTimestamp(note.completedAt) !== null
              ? note.completedAt
              : null;
            return [{
              completedAt,
              createdAt,
              id: typeof note.id === 'string' && note.id.trim() ? note.id : makeFollowUpNoteId(),
              text,
            }];
          })
        : [];
      const normalizeCurrencyInput = (rawValue) => {
        const cleaned = rawValue.replace(/[^0-9.]/g, '');
        if (!cleaned) {
          return '';
        }
        const firstDotIndex = cleaned.indexOf('.');
        if (firstDotIndex === -1) {
          return cleaned;
        }
        const integerPart = cleaned.slice(0, firstDotIndex) || '0';
        const fractionalPart = cleaned.slice(firstDotIndex + 1).replace(/\\./g, '').slice(0, 2);
        return fractionalPart.length > 0 ? integerPart + '.' + fractionalPart : integerPart + '.';
      };
      const parseCurrencyValue = (rawValue) => {
        const normalized = normalizeCurrencyInput(rawValue).replace(/\\.$/, '');
        if (!normalized) {
          return null;
        }
        const parsed = Number.parseFloat(normalized);
        return Number.isFinite(parsed) ? parsed : null;
      };
      const calculateGmPercent = (cost, price) => {
        if (!Number.isFinite(cost) || !Number.isFinite(price) || price <= 0) {
          return null;
        }
        return (1 - (1.13 * cost) / price) * 100;
      };
      const formatInlinePrice = (value) => value === null || !Number.isFinite(value) ? 'n/a' : '$' + value.toFixed(2);
      const formatInlineGmPercent = (value) => value === null ? 'n/a' : value.toFixed(1) + '%';
      const priceEpsilon = ${JSON.stringify(PRICE_EPSILON)};
      const loadStoredState = () => {
        try {
          const rawValue = window.localStorage.getItem(storageKey);
          if (!rawValue) {
            return { brandMetadata: {}, rows: {} };
          }
          const parsed = JSON.parse(rawValue);
          return parsed && typeof parsed === 'object' ? parsed : { brandMetadata: {}, rows: {} };
        } catch {
          return { brandMetadata: {}, rows: {} };
        }
      };
      const normalizeBrandState = (value) => {
        const brandKey = typeof value?.brandKey === 'string' && value.brandKey.trim() ? value.brandKey.trim() : brandMetaKey;
        const label = typeof value?.label === 'string' && value.label.trim() ? value.label.trim().slice(0, 500) : brandMetaLabel;
        const note = typeof value?.note === 'string' && value.note.trim() ? value.note.trim().slice(0, 500) : null;
        return {
          brandKey,
          isMso: value?.isMso === true,
          label,
          note,
        };
      };
      const getStoredRowState = () => {
        const state = loadStoredState();
        const rows = state.rows && typeof state.rows === 'object' ? state.rows : {};
        const storedRow = rows[productId];
        return {
          followUpNotes: normalizeFollowUpNotes(storedRow && typeof storedRow === 'object' ? storedRow.followUpNotes : []),
          include: !(storedRow && typeof storedRow === 'object' && storedRow.include === false),
          reviewedPrice: storedRow && typeof storedRow === 'object' && typeof storedRow.reviewedPrice === 'string'
            && storedRow.reviewedPrice.trim()
            ? storedRow.reviewedPrice.trim()
            : null,
          status: normalizeReviewStatus(storedRow && typeof storedRow === 'object' ? storedRow.status : null),
        };
      };
      const getStoredBrandState = () => {
        const state = loadStoredState();
        const brandMetadata = state.brandMetadata && typeof state.brandMetadata === 'object' ? state.brandMetadata : {};
        return normalizeBrandState(brandMetadata[brandMetaKey]);
      };
      const writeStoredRowState = (patch) => {
        const state = loadStoredState();
        const rows = state.rows && typeof state.rows === 'object' ? state.rows : {};
        const storedRow = rows[productId] && typeof rows[productId] === 'object'
          ? rows[productId]
          : getStoredRowState();
        state.rows = {
          ...rows,
          [productId]: {
            ...storedRow,
            ...patch,
          },
        };
        state.lastLocalChangeAt = nowIsoString();
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(state));
        } catch {
        }
      };
      const writeStoredBrandState = (patch) => {
        const state = loadStoredState();
        const brandMetadata = state.brandMetadata && typeof state.brandMetadata === 'object' ? state.brandMetadata : {};
        const nextBrandState = {
          ...getStoredBrandState(),
          ...patch,
        };
        state.brandMetadata = {
          ...brandMetadata,
          [brandMetaKey]: nextBrandState,
        };
        if (!nextBrandState.isMso && !nextBrandState.note) {
          delete state.brandMetadata[brandMetaKey];
        }
        state.lastLocalChangeAt = nowIsoString();
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(state));
        } catch {
        }
      };
      const determineRuntimeActionLabel = (currentPrice, proposedPrice) => {
        if (proposedPrice === null || !Number.isFinite(proposedPrice)) {
          return 'keep-price';
        }
        if (currentPrice === null || !Number.isFinite(currentPrice) || currentPrice <= 0) {
          return 'set-price';
        }
        if (Math.abs(proposedPrice - currentPrice) < priceEpsilon) {
          return 'keep-price';
        }
        return proposedPrice > currentPrice ? 'raise-price' : 'lower-price';
      };
      const determineRuntimeActionType = (currentPrice, proposedPrice) => {
        const actionLabel = determineRuntimeActionLabel(currentPrice, proposedPrice);
        if (actionLabel === 'lower-price') {
          return 'lower';
        }
        if (actionLabel === 'raise-price') {
          return 'raise';
        }
        if (actionLabel === 'set-price') {
          return 'set';
        }
        return 'keep';
      };
      const formatRuntimeActionLabel = (actionLabel) => actionLabel.replace(/-/g, ' ');
      const hasExplicitReviewedPrice = () => {
        const reviewedPrice = getStoredRowState().reviewedPrice;
        return typeof reviewedPrice === 'string' && reviewedPrice.trim().length > 0;
      };
      const readDefaultReviewedPrice = () => {
        if (!(priceInput instanceof HTMLInputElement)) {
          return defaultReviewedPrice;
        }
        const brandState = getStoredBrandState();
        const preferredRaw = brandState.isMso ? priceInput.dataset.defaultMsoPrice : priceInput.dataset.defaultStandardPrice;
        return parseCurrencyValue(preferredRaw || '') ?? parseCurrencyValue(priceInput.dataset.currentPrice || '') ?? defaultReviewedPrice;
      };
      const readEffectiveReviewedPrice = () => {
        if (!(priceInput instanceof HTMLInputElement)) {
          return defaultReviewedPrice;
        }
        const parsedInputPrice = parseCurrencyValue(priceInput.value);
        if (parsedInputPrice !== null) {
          return parsedInputPrice;
        }
        return hasExplicitReviewedPrice() ? null : readDefaultReviewedPrice();
      };
      const syncActionChip = (currentPrice, reviewedPrice) => {
        const chip = document.querySelector('[data-detail-review-action-chip]');
        if (!(chip instanceof HTMLElement)) {
          return;
        }
        const actionLabel = determineRuntimeActionLabel(currentPrice, reviewedPrice);
        chip.className = 'chip ' + determineRuntimeActionType(currentPrice, reviewedPrice);
        chip.textContent = formatRuntimeActionLabel(actionLabel);
      };
      const countOutstandingFollowUpNotes = (notes) => notes.filter((note) => note.completedAt === null).length;
      const formatFollowUpSummary = (notes) => {
        if (notes.length === 0) {
          return 'No follow-up notes';
        }
        const outstandingCount = countOutstandingFollowUpNotes(notes);
        const completedCount = notes.length - outstandingCount;
        if (outstandingCount === 0) {
          return completedCount === 1 ? '1 completed note' : completedCount + ' completed notes';
        }
        if (completedCount === 0) {
          return outstandingCount === 1 ? '1 open note' : outstandingCount + ' open notes';
        }
        return outstandingCount + ' open · ' + completedCount + ' done';
      };
      const renderStatusButtons = (status) => {
        statusButtons.forEach((button) => {
          const isActive = button.dataset.status === status;
          button.classList.toggle('is-active', isActive);
          button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
      };
      const renderFollowUpNotes = (notes) => {
        if (followUpSummary) {
          followUpSummary.textContent = formatFollowUpSummary(notes);
        }
        if (!followUpList) {
          return;
        }
        if (notes.length === 0) {
          followUpList.innerHTML = '<div class="follow-up-note-empty">No follow-up notes yet.</div>';
          return;
        }
        followUpList.innerHTML = notes.map((note) => {
          const detail = note.completedAt === null
            ? 'Outstanding · added ' + formatDateTimeLabel(note.createdAt)
            : 'Completed ' + formatDateTimeLabel(note.completedAt);
          return '<div class="follow-up-note' + (note.completedAt === null ? '' : ' is-completed') + '">' +
            '<button type="button" class="follow-up-note-toggle' + (note.completedAt === null ? '' : ' is-completed') + '" data-detail-follow-up-note-toggle data-note-id="' + escapeHtml(note.id) + '">' + (note.completedAt === null ? 'Complete' : 'Reopen') + '</button>' +
            '<div class="follow-up-note-body">' +
            '<div class="follow-up-note-text">' + escapeHtml(note.text) + '</div>' +
            '<div class="muted">' + escapeHtml(detail) + '</div>' +
            '</div>' +
            '</div>';
        }).join('');
      };
      const syncBrandMetadata = () => {
        const brandState = getStoredBrandState();
        const noteTitle = brandState.note ? 'Brand note: ' + brandState.note : '';
        Array.from(document.querySelectorAll('[data-brand-meta-key="' + CSS.escape(brandMetaKey) + '"]')).forEach((target) => {
          if (!(target instanceof HTMLElement)) {
            return;
          }
          if (target.hasAttribute('data-brand-note-input')) {
            if (document.activeElement !== target) {
              target.value = brandState.note || '';
            }
            return;
          }
          if (target.hasAttribute('data-brand-mso-input')) {
            target.checked = brandState.isMso;
            return;
          }
          target.classList.toggle('is-mso', brandState.isMso);
          const noteIndicator = target.querySelector('[data-brand-note-indicator]');
          if (noteIndicator instanceof HTMLElement) {
            noteIndicator.hidden = brandState.note === null;
            noteIndicator.title = brandState.note === null ? '' : noteTitle;
            noteIndicator.setAttribute('aria-label', brandState.note === null ? 'No brand note' : noteTitle);
          }
          const msoIndicator = target.querySelector('[data-brand-mso-indicator]');
          if (msoIndicator instanceof HTMLElement) {
            msoIndicator.hidden = !brandState.isMso;
            msoIndicator.title = brandState.isMso ? brandState.label + ' is marked MSO.' : '';
          }
        });
      };
      const toLadderPercent = (value, minimum, maximum) => {
        if (!Number.isFinite(value) || !Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) {
          return 50;
        }
        return ((value - minimum) / (maximum - minimum)) * 100;
      };
      const updateReviewLadder = (parsedPrice) => {
        if (!(ladder instanceof HTMLElement) || !(marker instanceof HTMLElement)) {
          return;
        }
        const minimum = Number.parseFloat(ladder.dataset.ladderMin || '');
        const maximum = Number.parseFloat(ladder.dataset.ladderMax || '');
        const fallbackPrice = readDefaultReviewedPrice();
        const nextPrice = parsedPrice ?? fallbackPrice;
        if (nextPrice === null) {
          marker.setAttribute('hidden', 'hidden');
          return;
        }
        marker.removeAttribute('hidden');
        marker.style.left = toLadderPercent(nextPrice, minimum, maximum).toFixed(2) + '%';
      };
      const syncReviewedPriceMeta = (parsedPrice) => {
        const currentPrice = priceInput instanceof HTMLInputElement
          ? parseCurrencyValue(priceInput.dataset.currentPrice || '')
          : null;
        const currentGmPercent = priceInput instanceof HTMLInputElement
          ? Number.parseFloat(priceInput.dataset.currentGmPercent || '')
          : Number.NaN;
        const wholesaleCost = priceInput instanceof HTMLInputElement
          ? Number.parseFloat(priceInput.dataset.wholesaleCost || '')
          : Number.NaN;
        const reviewedPrice = parsedPrice ?? readEffectiveReviewedPrice();
        const nextGm = calculateGmPercent(wholesaleCost, reviewedPrice);
        if (gmOutput) {
          gmOutput.textContent = formatInlinePrice(currentPrice)
            + ' (' + formatInlineGmPercent(Number.isFinite(currentGmPercent) ? currentGmPercent : null) + ')'
            + ' -> '
            + formatInlinePrice(reviewedPrice)
            + ' (' + formatInlineGmPercent(nextGm) + ')';
        }
        if (contextReviewedPrice) {
          contextReviewedPrice.textContent = formatInlinePrice(reviewedPrice);
        }
        if (contextReviewedGm) {
          contextReviewedGm.textContent = '(' + formatInlineGmPercent(nextGm) + ')';
        }
        if (ladderReviewedPrice) {
          ladderReviewedPrice.textContent = formatInlinePrice(reviewedPrice);
        }
        if (ladderReviewedGm) {
          ladderReviewedGm.textContent = '(' + formatInlineGmPercent(nextGm) + ')';
        }
        syncActionChip(currentPrice, reviewedPrice);
        updateReviewLadder(reviewedPrice);
      };
      const handleReviewedPriceInput = () => {
        if (!(priceInput instanceof HTMLInputElement)) {
          return;
        }
        syncReviewedPriceMeta(parseCurrencyValue(priceInput.value));
        writeStoredRowState({ reviewedPrice: priceInput.value });
      };
      const setReviewedPriceInputValue = (nextValue, options = {}) => {
        if (!(priceInput instanceof HTMLInputElement)) {
          return;
        }
        const normalizedValue = Math.max(0, roundQuarterStep(nextValue));
        priceInput.value = normalizedValue.toFixed(2);
        handleReviewedPriceInput();
        if (options.focus === true) {
          priceInput.focus();
          const caretPosition = priceInput.value.length;
          priceInput.setSelectionRange(caretPosition, caretPosition);
        }
      };
      const setReviewedPriceFromLadderPosition = (clientX, options = {}) => {
        if (!(ladder instanceof HTMLElement)) {
          return false;
        }
        const minimum = Number.parseFloat(ladder.dataset.ladderMin || '');
        const maximum = Number.parseFloat(ladder.dataset.ladderMax || '');
        if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) {
          return false;
        }
        const rect = ladder.getBoundingClientRect();
        if (!Number.isFinite(rect.width) || rect.width <= 0) {
          return false;
        }
        const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
        const nextValue = minimum + (maximum - minimum) * ratio;
        setReviewedPriceInputValue(nextValue, options);
        return true;
      };
      const applyStoredRowState = () => {
        const storedRowState = getStoredRowState();
        if (priceInput instanceof HTMLInputElement && storedRowState.reviewedPrice !== null) {
          priceInput.value = storedRowState.reviewedPrice;
        } else if (priceInput instanceof HTMLInputElement) {
          priceInput.value = readDefaultReviewedPrice()?.toFixed(2) ?? '';
        }
        syncBrandMetadata();
        renderStatusButtons(storedRowState.status);
        renderFollowUpNotes(storedRowState.followUpNotes);
        if (!(priceInput instanceof HTMLInputElement)) {
          return;
        }
        syncReviewedPriceMeta(readEffectiveReviewedPrice());
      };
      let activeReviewLadderDrag = null;
      const stopReviewLadderDrag = () => {
        if (!activeReviewLadderDrag) {
          return;
        }
        activeReviewLadderDrag.classList.remove('is-dragging');
        activeReviewLadderDrag = null;
      };
      const setReviewStatus = (nextStatus) => {
        const normalizedStatus = normalizeReviewStatus(nextStatus);
        writeStoredRowState({
          include: normalizedStatus !== 'rejected',
          status: normalizedStatus,
        });
        renderStatusButtons(normalizedStatus);
      };
      const addFollowUpNote = (rawText) => {
        const text = String(rawText || '').trim();
        if (!text) {
          return false;
        }
        const nextNotes = getStoredRowState().followUpNotes.concat([{
          completedAt: null,
          createdAt: nowIsoString(),
          id: makeFollowUpNoteId(),
          text: text.slice(0, 500),
        }]);
        writeStoredRowState({ followUpNotes: nextNotes });
        renderFollowUpNotes(nextNotes);
        return true;
      };
      const toggleFollowUpNote = (noteId) => {
        const nextNotes = getStoredRowState().followUpNotes.map((note) => note.id === noteId
          ? {
            ...note,
            completedAt: note.completedAt === null ? nowIsoString() : null,
          }
          : note);
        writeStoredRowState({ followUpNotes: nextNotes });
        renderFollowUpNotes(nextNotes);
      };
      applyStoredRowState();
      brandNoteInputs.forEach((input) => {
        input.addEventListener('input', () => {
          writeStoredBrandState({ label: brandMetaLabel, note: input.value.trim().slice(0, 500) || null });
          syncBrandMetadata();
        });
      });
      brandMsoInputs.forEach((input) => {
        input.addEventListener('change', () => {
          writeStoredBrandState({ isMso: input.checked, label: brandMetaLabel });
          syncBrandMetadata();
          if (priceInput instanceof HTMLInputElement && !hasExplicitReviewedPrice()) {
            priceInput.value = readDefaultReviewedPrice()?.toFixed(2) ?? '';
          }
          syncReviewedPriceMeta(readEffectiveReviewedPrice());
        });
      });
      if (priceInput instanceof HTMLInputElement) {
        priceInput.addEventListener('input', () => {
          handleReviewedPriceInput();
        });
      }
      priceStepButtons.forEach((button) => {
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const step = Number.parseFloat(button.dataset.step || '0');
          if (!Number.isFinite(step)) {
            return;
          }
          const currentValue = priceInput instanceof HTMLInputElement ? parseCurrencyValue(priceInput.value) ?? 0 : 0;
          setReviewedPriceInputValue(currentValue + step, { focus: true });
        });
      });
      statusButtons.forEach((button) => {
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          setReviewStatus(button.dataset.status);
        });
      });
      if (followUpInput instanceof HTMLInputElement) {
        followUpInput.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (!addFollowUpNote(followUpInput.value)) {
            return;
          }
          followUpInput.value = '';
        });
      }
      if (followUpAddButton instanceof HTMLButtonElement) {
        followUpAddButton.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!(followUpInput instanceof HTMLInputElement) || !addFollowUpNote(followUpInput.value)) {
            return;
          }
          followUpInput.value = '';
        });
      }
      document.addEventListener('click', (event) => {
        if (!(event.target instanceof Element)) {
          return;
        }
        const toggleButton = event.target.closest('[data-detail-follow-up-note-toggle]');
        if (!toggleButton) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const noteId = toggleButton.dataset.noteId || '';
        if (noteId) {
          toggleFollowUpNote(noteId);
        }
      });
      if (marker instanceof HTMLElement) {
        marker.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        marker.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!setReviewedPriceFromLadderPosition(event.clientX, { focus: true })) {
            return;
          }
          stopReviewLadderDrag();
          marker.classList.add('is-dragging');
          activeReviewLadderDrag = marker;
        });
      }
      document.addEventListener('pointermove', (event) => {
        if (!activeReviewLadderDrag) {
          return;
        }
        event.preventDefault();
        setReviewedPriceFromLadderPosition(event.clientX, { focus: false });
      });
      document.addEventListener('pointerup', (event) => {
        if (!activeReviewLadderDrag) {
          return;
        }
        event.preventDefault();
        stopReviewLadderDrag();
      });
      document.addEventListener('pointercancel', () => {
        stopReviewLadderDrag();
      });
      window.addEventListener('storage', (event) => {
        if (event.key !== storageKey) {
          return;
        }
        applyStoredRowState();
      });
    })();
  </script>
  `
}

function renderMarketEvidenceSummary(row: PacketRow): string {
  const evidence = row.marketEvidence
  if (!evidence) {
    return '<p class="muted">No competitor listings were retained for this SKU, so the detail table is empty.</p>'
  }

  const nearMidAveragePostTaxPrice = readPacketNumber(evidence.averagePostTaxPrice)
  const nearMidAveragePreTaxPrice = readPacketNumber(evidence.averagePreTaxPrice)
  const nearMidMedianPostTaxPrice = readPacketNumber(evidence.medianPostTaxPrice)
  const nearMidMedianPreTaxPrice = readPacketNumber(evidence.medianPreTaxPrice)
  const farAveragePostTaxPrice = readPacketNumber(evidence.farAveragePostTaxPrice)
  const farAveragePreTaxPrice = readPacketNumber(evidence.farAveragePreTaxPrice)
  const farListingCount = readPacketInteger(evidence.farListingCount)

  const excludedCount = evidence.matchedListings.filter((listing) => !listing.eligibleForPricing).length

  const sourceLabel = evidence.source === 'mixed'
    ? 'Nearby + statewide Lit Alerts pulls'
    : evidence.source === 'nearby'
      ? 'Nearby Lit Alerts pull only'
      : evidence.source === 'statewide'
        ? 'Statewide Lit Alerts pull only'
        : 'No retained source label'

  return `
    <div class="detail-grid" style="margin-bottom: 16px;">
      <div><span class="muted">Near/mid weighted avg</span><br><span class="metric">${compactCurrency(nearMidAveragePostTaxPrice)}</span><div class="muted">${compactCurrency(nearMidAveragePreTaxPrice)} pre-tax</div></div>
      <div><span class="muted">Near/mid median</span><br><span class="metric">${compactCurrency(nearMidMedianPostTaxPrice)}</span><div class="muted">${compactCurrency(nearMidMedianPreTaxPrice)} pre-tax</div></div>
      <div><span class="muted">Retained listings</span><br><span class="metric">${evidence.listingCount}</span><div class="muted">All retained family listings, including faded weaker-format or weaker-size rows.</div></div>
      <div><span class="muted">Distinct dispensaries</span><br><span class="metric">${evidence.dispensaryCount}</span><div class="muted">Across all retained nearby and statewide evidence.</div></div>
      <div><span class="muted">Near/mid pricing rows</span><br><span class="metric">${evidence.pricingEligibleListingCount}</span><div class="muted">Only these rows can influence the market average.</div></div>
      <div><span class="muted">Faded / excluded rows</span><br><span class="metric">${excludedCount}</span><div class="muted">Shown for context only when stronger matches exist or the row is outside near/mid distance.</div></div>
      <div><span class="muted">Near/mid dispensaries</span><br><span class="metric">${evidence.pricingEligibleDispensaryCount}</span><div class="muted">Pricing-eligible stores inside the near/mid buckets.</div></div>
      ${farAveragePostTaxPrice !== null ? `<div><span class="muted">Far-only market pressure</span><br><span class="metric">${compactCurrency(farAveragePostTaxPrice)}</span><div class="muted">${farListingCount} far listing${farListingCount === 1 ? '' : 's'} · ${compactCurrency(farAveragePreTaxPrice)} pre-tax</div></div>` : ''}
      <div><span class="muted">Search term</span><br><span class="metric">${escapeHtml(evidence.searchTerm)}</span></div>
      <div><span class="muted">Evidence source</span><br><span class="metric">${escapeHtml(sourceLabel)}</span></div>
    </div>
    <p class="muted" style="margin: 0 0 16px;">This table shows all retained competitor pricing data for the SKU, including weaker-format or weaker-size rows that stayed display-only and did not feed the near/mid market average.</p>
  `
}

function renderMarketTable(listings: NonNullable<ProductPricingMarketEvidence['matchedListings']>): string {
  if (listings.length === 0) {
    return '<p class="muted">No retained competitor listings are available for this row.</p>'
  }
  return `
    <table class="market-table">
      <thead>
        <tr>
          <th>Post-tax</th>
          <th>Pre-tax</th>
          <th>Status</th>
          <th>Distance</th>
          <th>Source</th>
          <th>Competitor product</th>
          <th>Dispensary</th>
          <th>Category</th>
          <th>Link</th>
        </tr>
      </thead>
      <tbody>
        ${listings
          .slice()
          .sort(
            (left, right) => (left.distanceMiles ?? 999) - (right.distanceMiles ?? 999)
              || left.postTaxPrice - right.postTaxPrice,
          )
          .map((listing) => `
            <tr${listing.eligibleForPricing ? '' : ' style="opacity:0.55;"'}>
              <td>${compactCurrency(listing.postTaxPrice)}</td>
              <td>${compactCurrency(listing.preTaxPrice)}</td>
              <td>${listing.eligibleForPricing ? 'Used in comps' : escapeHtml(listing.exclusionReason ?? 'Display only')}</td>
              <td>${escapeHtml(formatDistance(listing.distanceBand, listing.distanceMiles))}</td>
              <td>${escapeHtml(listing.source)}</td>
              <td>${escapeHtml(listing.listingName)}</td>
              <td>${escapeHtml(listing.dispensaryName)}</td>
              <td>${escapeHtml(listing.category ?? '-')}</td>
              <td>${listing.url ? `<a href="${escapeHtml(listing.url)}" target="_blank" rel="noopener noreferrer">Open listing</a>` : '-'}</td>
            </tr>
          `).join('')}
      </tbody>
    </table>
  `
}

function renderPricingLadder(row: PacketRow, detail: boolean): string {
  const listings = row.marketEvidence?.matchedListings ?? []
  const pricingListings = listings.filter((listing) => listing.eligibleForPricing)
  const postTaxValues = pricingListings.map((listing) => listing.postTaxPrice).sort((left, right) => left - right)
  const currentPrice = row.currentPrice ?? row.proposedPrice ?? 0
  const proposedPrice = row.proposedPrice ?? row.currentPrice ?? 0
  const msoProposedPrice = computeBandAwarePacketPrice(row, MSO_PACKET_PRICING_BAND)
  const reviewedSummaryPrice = row.proposedPrice ?? row.currentPrice
  const reviewedSummaryGm = computePacketGmPercent(row.wholesaleCost, reviewedSummaryPrice)
  const marketAverage = readPacketNumber(row.averageCompetitorPostTaxPrice)
  const q1 = postTaxValues.length > 0 ? quantile(postTaxValues, 0.25) : null
  const q3 = postTaxValues.length > 0 ? quantile(postTaxValues, 0.75) : null
  const median = readPacketNumber(row.marketEvidence?.medianPostTaxPrice) ?? (postTaxValues.length > 0 ? quantile(postTaxValues, 0.5) : null)
  const domainValues = [currentPrice, proposedPrice, marketAverage, ...listings.map((listing) => listing.postTaxPrice), q1, q3].filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  const domainMinBase = domainValues.length > 0 ? Math.min(...domainValues) : 0
  const domainMaxBase = domainValues.length > 0 ? Math.max(...domainValues) : Math.max(currentPrice, proposedPrice, 1)
  const padding = Math.max((domainMaxBase - domainMinBase) * 0.08, 1)
  const domainMin = domainMinBase - padding
  const domainMax = domainMaxBase + padding
  const competitorMarks = listings.map((listing, index) => {
    const left = pricePositionPercent(listing.postTaxPrice, domainMin, domainMax)
    const top = detail ? 24 + (index % 8) * 9 : 12 + (index % 3) * 8
    const tooltipSummary = [
      listing.dispensaryName,
      compactCurrency(listing.postTaxPrice),
      formatDistance(listing.distanceBand, listing.distanceMiles),
      listing.eligibleForPricing ? 'Included in pricing comps' : (listing.exclusionReason ?? 'Display only'),
    ].join(' - ')
    const tooltip = escapeHtml(`${tooltipSummary}\n${listing.listingName}`)
    const distanceMilesAttr = listing.distanceMiles === null ? '' : ` data-distance-miles="${listing.distanceMiles.toFixed(4)}"`
    const opacity = listing.eligibleForPricing ? 1 : 0.35
    return listing.url
      ? `<a class="ladder-competitor ${escapeHtml(listing.distanceBand)}" data-distance-band="${escapeHtml(listing.distanceBand)}"${distanceMilesAttr} style="left:${left.toFixed(2)}%; top:${top}px; opacity:${opacity};" href="${escapeHtml(listing.url)}" target="_blank" rel="noopener noreferrer" title="${tooltip}"></a>`
      : `<span class="ladder-competitor ${escapeHtml(listing.distanceBand)}" data-distance-band="${escapeHtml(listing.distanceBand)}"${distanceMilesAttr} style="left:${left.toFixed(2)}%; top:${top}px; opacity:${opacity};" title="${tooltip}"></span>`
  }).join('')
  const iqrWidth = q1 !== null && q3 !== null ? Math.max(pricePositionPercent(q3, domainMin, domainMax) - pricePositionPercent(q1, domainMin, domainMax), 0.8) : 0
  return `
    <div class="pricing-ladder-shell">
      <div class="pricing-ladder-head">
        <span class="metric">${compactCurrency(row.currentPrice)} <span class="muted">(${formatPercent(row.currentGmPercent)})</span> -> <span data-detail-ladder-reviewed-price>${compactCurrency(reviewedSummaryPrice)}</span> <span class="muted" data-detail-ladder-reviewed-gm>(${formatPercent(reviewedSummaryGm)})</span></span>
      </div>
      <div class="pricing-ladder" data-current-price="${row.currentPrice ?? ''}" data-default-mso-price="${msoProposedPrice ?? ''}" data-default-proposed-price="${row.proposedPrice ?? ''}" data-default-standard-price="${row.proposedPrice ?? ''}" data-ladder-max="${domainMax.toFixed(4)}" data-ladder-min="${domainMin.toFixed(4)}" data-ladder-mode="${detail ? 'detail' : 'summary'}" data-product-id="${row.productId}" data-review-ladder>
        <div class="ladder-track"></div>
        ${q1 !== null && q3 !== null ? `<div class="ladder-iqr" style="left:${pricePositionPercent(q1, domainMin, domainMax).toFixed(2)}%; width:${iqrWidth.toFixed(2)}%;"></div>` : ''}
        ${median !== null ? `<div class="ladder-median" style="left:${pricePositionPercent(median, domainMin, domainMax).toFixed(2)}%;"></div>` : ''}
        ${competitorMarks}
        ${marketAverage !== null ? `<div class="ladder-marker market-average" style="left:${pricePositionPercent(marketAverage, domainMin, domainMax).toFixed(2)}%;"><span>Market avg</span></div>` : ''}
        <div class="ladder-marker current" style="left:${pricePositionPercent(currentPrice, domainMin, domainMax).toFixed(2)}%;"><span>Current</span></div>
        <div class="ladder-marker proposed" data-review-ladder-marker style="left:${pricePositionPercent(proposedPrice, domainMin, domainMax).toFixed(2)}%;"><span>Proposed</span></div>
        <div class="ladder-axis axis-min">${compactCurrency(domainMin)}</div>
        <div class="ladder-axis axis-max">${compactCurrency(domainMax)}</div>
      </div>
      <div class="pricing-ladder-meta muted">
        <span>${escapeHtml(marketCoverageText(row))}</span>
        ${median !== null ? `<span>Near/mid median ${compactCurrency(median)}</span>` : ''}
        ${q1 !== null && q3 !== null ? `<span>IQR ${compactCurrency(q1)}-${compactCurrency(q3)}</span>` : ''}
      </div>
    </div>
  `
}

function renderGroupFooter(label: string): string {
  return `<div class="group-footer"><button class="group-collapse-button" type="button">Collapse ${escapeHtml(label)}</button></div>`
}

function renderSubmissionBar(report: PacketReport): string {
  return `
    <div class="submit-bar">
      <div>
        <strong>Submit Accepted Prices</strong>
        <div class="muted">Use Save review state any time you want a durable checkpoint without touching Sweed. Accepted rows still collapse out of the queue, rejected rows stay out of the apply set, and group checkboxes still control inclusion for accepted rows.</div>
      </div>
      <div class="submit-actions">
        <div class="submit-bar-meta">
          <div class="muted" data-review-progress-summary>${report.summary.productCount} rows in scope / ${report.summary.reviewRowCount} review rows prefilled</div>
          <div class="muted follow-up-note-summary" data-outstanding-follow-up-summary>No outstanding follow-up notes</div>
        </div>
        <label class="follow-up-filter-toggle">
          <input type="checkbox" data-outstanding-follow-up-filter>
          <span>Outstanding follow-up only</span>
        </label>
        <button class="submit-button" type="button" data-save-pricing-review>Save review state</button>
        <button class="submit-button" type="submit" data-submit-pricing-review>Submit accepted prices</button>
      </div>
    </div>
  `
}

function renderReviewInputCell(row: PacketRow): string {
  const defaultReviewedPrice = row.proposedPrice ?? row.currentPrice
  const msoReviewedPrice = computeBandAwarePacketPrice(row, MSO_PACKET_PRICING_BAND)
  if (defaultReviewedPrice === null) {
    return '<div class="muted">No packet price available</div>'
  }
  const currentPriceSummary = `${compactCurrency(row.currentPrice)} (${formatCompactPercent(row.currentGmPercent)})`
  const reviewedPriceSummary = `${compactCurrency(defaultReviewedPrice)} (${formatCompactPercent(computePacketGmPercent(row.wholesaleCost, defaultReviewedPrice))})`
  return `
    <div class="review-price-cell" data-review-row-controls>
      <label class="review-row-toggle" for="review-include-${row.productId}">
        <input
          id="review-include-${row.productId}"
          type="checkbox"
          checked
          data-review-include-checkbox
          data-product-id="${row.productId}"
        >
        <span>Include in repricing</span>
      </label>
      <label class="review-price-field" for="review-price-${row.productId}" data-review-price-field>
        <span class="muted">Reviewed price</span>
        <div class="review-price-input-row">
          <input
            id="review-price-${row.productId}"
            class="review-price-input"
            type="text"
            inputmode="decimal"
            value="${defaultReviewedPrice.toFixed(2)}"
            autocomplete="off"
            spellcheck="false"
            data-review-price-input
            data-brand-meta-key="${escapeHtml(row.brandMetadata.key)}"
            data-product-id="${row.productId}"
            data-current-gm-percent="${row.currentGmPercent ?? ''}"
            data-current-price="${row.currentPrice ?? ''}"
            data-default-mso-price="${msoReviewedPrice ?? ''}"
            data-default-standard-price="${defaultReviewedPrice ?? ''}"
            data-wholesale-cost="${row.wholesaleCost ?? ''}"
          >
          <div class="review-price-stepper" aria-label="Adjust reviewed price by quarter-dollar steps">
            <button
              type="button"
              class="review-price-step-button"
              data-review-price-step-button
              data-product-id="${row.productId}"
              data-step="0.25"
              aria-label="Increase reviewed price by 25 cents"
              title="Increase by $0.25"
            >▲</button>
            <button
              type="button"
              class="review-price-step-button"
              data-review-price-step-button
              data-product-id="${row.productId}"
              data-step="-0.25"
              aria-label="Decrease reviewed price by 25 cents"
              title="Decrease by $0.25"
            >▼</button>
          </div>
        </div>
        <span class="review-price-meta muted">
          <span data-review-gm>${escapeHtml(currentPriceSummary)} -&gt; ${escapeHtml(reviewedPriceSummary)}</span>
        </span>
      </label>
      <div class="review-status-field">
        <span class="muted">Review status</span>
        <div class="review-status-buttons" role="group" aria-label="Review status for ${escapeHtml(row.productName)}">
          <button type="button" class="review-status-button is-active" data-review-status-button data-product-id="${row.productId}" data-status="unreviewed" aria-pressed="true">Unreviewed</button>
          <button type="button" class="review-status-button" data-review-status-button data-product-id="${row.productId}" data-status="accepted" aria-pressed="false">Accepted</button>
          <button type="button" class="review-status-button" data-review-status-button data-product-id="${row.productId}" data-status="rejected" aria-pressed="false">Rejected</button>
        </div>
      </div>
      <div class="follow-up-notes" data-follow-up-notes data-product-id="${row.productId}">
        <div class="follow-up-inherited-context" data-inherited-follow-up-context data-product-id="${row.productId}" hidden></div>
        <div class="follow-up-notes-header">
          <span class="muted">Follow-up notes</span>
          <span class="muted" data-follow-up-summary data-product-id="${row.productId}">No follow-up notes</span>
        </div>
        <div class="follow-up-note-list" data-follow-up-note-list data-product-id="${row.productId}">
          <div class="follow-up-note-empty">No follow-up notes yet.</div>
        </div>
        <div class="follow-up-note-add-row">
          <input
            class="follow-up-note-input"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="Add a follow-up task or note"
            data-follow-up-note-input
            data-product-id="${row.productId}"
          >
          <button type="button" class="follow-up-note-add-button" data-follow-up-note-add data-product-id="${row.productId}">Add note</button>
        </div>
      </div>
    </div>
  `
}

function renderGroupIncludeToggle(level: string, label: string): string {
  return `
    <label class="group-include-toggle" title="Check or uncheck every row in this ${escapeHtml(level.toLowerCase())} block: ${escapeHtml(label)}">
      <input type="checkbox" checked data-review-group-toggle>
      <span>Include group</span>
    </label>
  `
}

function marketCoverageText(row: PacketRow): string {
  if (!row.marketEvidence) {
    return 'No market evidence retained'
  }
  const nearMidAverage = readPacketNumber(row.marketEvidence.averagePostTaxPrice)
  const nearMidMedian = readPacketNumber(row.marketEvidence.medianPostTaxPrice)
  const farAverage = readPacketNumber(row.marketEvidence.farAveragePostTaxPrice)
  const farListingCount = readPacketInteger(row.marketEvidence.farListingCount)
  if (nearMidAverage === null) {
    if (farAverage !== null) {
      return `${farListingCount} far listing${farListingCount === 1 ? '' : 's'} set market pressure at ${compactCurrency(farAverage)} while staying inside the GM band.`
    }
    return `${row.marketEvidence.listingCount} listing${row.marketEvidence.listingCount === 1 ? '' : 's'} retained for display only; no near/mid pricing average.`
  }
  const medianText = nearMidMedian === null ? '' : `, median ${compactCurrency(nearMidMedian)}`
  return `${row.marketEvidence.pricingEligibleDispensaryCount} stores / ${row.marketEvidence.pricingEligibleListingCount} near-mid listings, avg ${compactCurrency(nearMidAverage)}${medianText}.`
}

function readPacketNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readPacketInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function renderRecentSalesSummary(summary: RecentSalesSummary): string {
  const indicator = describePacketRecentSales(summary)
  return `
    <div class="detail-grid">
      <div><span class="muted">Velocity</span><br><span class="velocity-indicator velocity-indicator-${indicator.tone}">${escapeHtml(indicator.detailLabel)}</span></div>
      <div><span class="muted">Coverage</span><br><span class="metric">${escapeHtml(formatPacketCoverage(summary))}</span></div>
      <div><span class="muted">On hand</span><br><span class="metric">${formatPacketCount(summary.onHand)}</span></div>
      <div><span class="muted">30-day gross</span><br><span class="metric">${formatPacketCurrency(summary.last30DaysGrossSales)}</span></div>
      <div><span class="muted">Units / day</span><br><span class="metric">${formatPacketCount(summary.unitsPerDay)}</span></div>
      <div><span class="muted">Latest report</span><br><span class="metric">${escapeHtml(formatPacketDate(summary.reportDate))}</span></div>
    </div>
  `
}

function renderRecentSalesSiteCard(site: GroupRecentSalesProductRow): string {
  const indicator = describePacketRecentSales({
    combinationCount: 1,
    coverageCount: site.hasCoverage ? 1 : 0,
    daysPerUnit: site.daysPerUnit,
    last30DaysGrossSales: site.last30DaysGrossSales,
    onHand: site.onHand,
    reportDate: site.reportDate,
    unitsPerDay: site.unitsPerDay,
  })
  return `
    <article class="recent-sales-card">
      <header>
        <strong>${escapeHtml(site.siteLabel)}</strong>
        <span class="velocity-indicator velocity-indicator-${indicator.tone}">${escapeHtml(indicator.detailLabel)}</span>
      </header>
      <div class="muted" style="margin-top: 8px;">${formatPacketCount(site.onHand)} on hand · ${formatPacketCurrency(site.last30DaysGrossSales)} gross / 30d</div>
      <div class="muted" style="margin-top: 4px;">${escapeHtml(site.productTab)} · latest ${escapeHtml(formatPacketDate(site.reportDate))}</div>
    </article>
  `
}

function describePacketRecentSales(summary: RecentSalesSummary): { detailLabel: string; tone: 'danger' | 'muted' | 'success' } {
  if (summary.coverageCount === 0) {
    return { detailLabel: 'No sales data', tone: 'muted' }
  }

  const unitsPerDay = summary.unitsPerDay ?? 0
  if (unitsPerDay >= 1) {
    return { detailLabel: `${formatPacketRate(unitsPerDay)} units/day`, tone: 'success' }
  }
  if (unitsPerDay > 0 && summary.daysPerUnit !== null) {
    return { detailLabel: `${formatPacketRate(summary.daysPerUnit)} days/unit`, tone: 'danger' }
  }
  return { detailLabel: 'No recent sales', tone: 'danger' }
}

function formatPacketCoverage(summary: RecentSalesSummary): string {
  return `${summary.coverageCount}/${summary.combinationCount} covered`
}

function formatPacketCurrency(value: number | null): string {
  return value === null ? '—' : compactCurrency(value)
}

function formatPacketCount(value: number | null): string {
  if (value === null) {
    return '—'
  }
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: value >= 10 ? 0 : 2,
    minimumFractionDigits: value >= 10 ? 0 : 2,
  }).format(value)
}

function formatPacketRate(value: number): string {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: value >= 10 ? 1 : 2,
    minimumFractionDigits: value >= 10 ? 1 : 2,
  }).format(value)
}

function formatPacketDate(value: string | null): string {
  if (!value) {
    return 'No report date'
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    return value
  }
  return new Date(timestamp).toLocaleDateString()
}

function computePacketGmPercent(cost: number | null, price: number | null): number | null {
  if (cost === null || price === null || !Number.isFinite(cost) || !Number.isFinite(price) || price <= 0) {
    return null
  }
  return (1 - (POST_TAX_MULTIPLIER * cost) / price) * 100
}

function determinePacketActionLabel(currentPrice: number | null, proposedPrice: number | null): string {
  if (proposedPrice === null || !Number.isFinite(proposedPrice)) {
    return 'keep-price'
  }
  if (currentPrice === null || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return 'set-price'
  }
  if (Math.abs(proposedPrice - currentPrice) < PRICE_EPSILON) {
    return 'keep-price'
  }
  return proposedPrice > currentPrice ? 'raise-price' : 'lower-price'
}

function determinePacketActionType(currentPrice: number | null, proposedPrice: number | null): PacketRow['actionType'] {
  return mapActionType(determinePacketActionLabel(currentPrice, proposedPrice))
}

function computeBandAwarePacketPrice(
  row: PacketRow,
  pricingBand: PacketPricingBandConfig,
): number | null {
  const cost = row.wholesaleCost
  if (cost === null || !Number.isFinite(cost) || cost <= 0) {
    return row.proposedPrice ?? row.currentPrice
  }

  const minimumPrice = packetMinimumPriceForGm(cost, pricingBand.minGmPercent)
  const maximumPrice = packetMaximumPriceForGm(cost, pricingBand.maxGmPercent)
  if (minimumPrice > maximumPrice + PRICE_EPSILON) {
    return row.proposedPrice ?? row.currentPrice
  }

  const marketAveragePostTaxPrice = readPacketNumber(row.marketEvidence?.averagePostTaxPrice)
  if (marketAveragePostTaxPrice !== null) {
    const belowMarketTarget = choosePacketPreferredBelowMarketPrice(marketAveragePostTaxPrice)
    if (belowMarketTarget < minimumPrice - PRICE_EPSILON) {
      return belowMarketTarget
    }
    if (belowMarketTarget > maximumPrice + PRICE_EPSILON) {
      return maximumPrice
    }
    return belowMarketTarget
  }

  const farAveragePostTaxPrice = readPacketNumber(row.marketEvidence?.farAveragePostTaxPrice)
  if (farAveragePostTaxPrice !== null) {
    return clampPacketPriceToManagedBand(
      choosePacketPreferredBelowMarketPrice(farAveragePostTaxPrice),
      minimumPrice,
      maximumPrice,
    )
  }

  if (row.familyAnchor) {
    return clampPacketPriceToManagedBand(row.familyAnchor.anchorPrice, minimumPrice, maximumPrice)
  }

  return choosePacketFallbackBandPrice(minimumPrice, maximumPrice, pricingBand)
}

function packetMinimumPriceForGm(cost: number, gmPercentTarget: number): number {
  return roundPacketPriceUpToQuarter((POST_TAX_MULTIPLIER * cost) / (1 - gmPercentTarget / 100))
}

function packetMaximumPriceForGm(cost: number, gmPercentTarget: number): number {
  return roundPacketPriceDownToQuarter((POST_TAX_MULTIPLIER * cost) / (1 - gmPercentTarget / 100))
}

function choosePacketFallbackBandPrice(
  minimumPrice: number,
  maximumPrice: number,
  pricingBand: PacketPricingBandConfig,
): number {
  const fallbackTarget = packetFallbackPriceForGm(minimumPrice, maximumPrice, pricingBand)
  let bestCandidate = minimumPrice
  let bestDistance = Math.abs(bestCandidate - fallbackTarget)
  let bestPreferredEnding = hasPacketPreferredEnding(bestCandidate)

  for (
    let candidate = minimumPrice;
    candidate <= maximumPrice + PRICE_EPSILON;
    candidate = roundPacketPrice(candidate + QUARTER_INCREMENT)
  ) {
    const distance = Math.abs(candidate - fallbackTarget)
    const preferredEnding = hasPacketPreferredEnding(candidate)
    if (distance < bestDistance - PRICE_EPSILON) {
      bestCandidate = candidate
      bestDistance = distance
      bestPreferredEnding = preferredEnding
      continue
    }
    if (Math.abs(distance - bestDistance) <= PRICE_EPSILON && preferredEnding && !bestPreferredEnding) {
      bestCandidate = candidate
      bestDistance = distance
      bestPreferredEnding = true
      continue
    }
    if (
      Math.abs(distance - bestDistance) <= PRICE_EPSILON
      && preferredEnding === bestPreferredEnding
      && candidate > bestCandidate
    ) {
      bestCandidate = candidate
      bestDistance = distance
      bestPreferredEnding = preferredEnding
    }
  }

  return bestCandidate
}

function choosePacketPreferredBelowMarketPrice(averagePostTaxPrice: number): number {
  const marketTarget = averagePostTaxPrice * 0.97
  const roundedTarget = roundPacketPriceDownToQuarter(marketTarget)
  if (hasPacketPreferredEnding(roundedTarget)) {
    return roundedTarget
  }

  let fallback = roundedTarget
  for (let candidate = roundedTarget; candidate > PRICE_EPSILON; candidate = roundPacketPrice(candidate - QUARTER_INCREMENT)) {
    if (hasPacketPreferredEnding(candidate)) {
      return candidate
    }
    fallback = candidate
  }

  return fallback
}

function packetFallbackPriceForGm(
  minimumPrice: number,
  maximumPrice: number,
  pricingBand: PacketPricingBandConfig,
): number {
  const bandWidth = maximumPrice - minimumPrice
  const fallbackOffset = (pricingBand.fallbackTargetGmPercent - pricingBand.minGmPercent)
    / (pricingBand.maxGmPercent - pricingBand.minGmPercent)
  return roundPacketPrice(minimumPrice + bandWidth * fallbackOffset)
}

function clampPacketPriceToManagedBand(price: number, minimumPrice: number, maximumPrice: number): number {
  if (price < minimumPrice - PRICE_EPSILON) {
    return minimumPrice
  }
  if (price > maximumPrice + PRICE_EPSILON) {
    return maximumPrice
  }
  return roundPacketPrice(price)
}

function hasPacketPreferredEnding(value: number): boolean {
  const cents = Math.round((value - Math.floor(value)) * 100)
  return cents === 0 || cents === 50
}

function roundPacketPriceUpToQuarter(value: number): number {
  return roundPacketPrice(Math.ceil(value / QUARTER_INCREMENT - 1e-9) * QUARTER_INCREMENT)
}

function roundPacketPriceDownToQuarter(value: number): number {
  return roundPacketPrice(Math.floor(value / QUARTER_INCREMENT + 1e-9) * QUARTER_INCREMENT)
}

function roundPacketPrice(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function classifySkippedAction(reason: string): string {
  if (/no usable wholesale cost/i.test(reason)) {
    return 'missing-cost'
  }
  if (/already inside the managed/i.test(reason) || /already matches the live price/i.test(reason)) {
    return 'keep-price'
  }
  return 'skip-review'
}

function mapActionType(action: string): PacketRow['actionType'] {
  if (action === 'raise-price') {
    return 'raise'
  }
  if (action === 'lower-price') {
    return 'lower'
  }
  if (action === 'set-price') {
    return 'set'
  }
  return 'keep'
}

let sweedSessionQueue: Promise<void> = Promise.resolve()

function withSweedSessionLock<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
  const run = sweedSessionQueue.then(operation, operation)
  sweedSessionQueue = run.then(() => undefined, () => undefined)
  return run
}

async function ensureDealerContext(dealerId: number): Promise<void> {
  const result = await callSweedRpcRaw<{ user?: { currentDealerId?: number; currentDealerName?: string | null } }>('store.auth.dealer.set', { dealerId })
  if (result.user?.currentDealerId !== dealerId) {
    throw new Error(`Sweed dealer context mismatch. Expected ${dealerId}, got ${result.user?.currentDealerId ?? 'unknown'} ${result.user?.currentDealerName ?? ''}`.trim())
  }
}

async function callSweedRpcRaw<TResult>(name: string, params?: Record<string, unknown>): Promise<TResult> {
  const env = getWorkerEnv()
  if (!env.sweedAuthToken) {
    throw new Error('SWEED_AUTH_TOKEN is required for this pricing packet generator.')
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
      'user-agent': 'helios-one-off-pricing-packet/1.0',
    },
    method: 'POST',
    signal: AbortSignal.timeout(env.sweedRequestTimeoutMs),
  })
  const responseText = await response.text()
  if (!response.ok) {
    throw new Error(`${name} returned HTTP ${response.status}: ${responseText.slice(0, 300)}`)
  }
  const envelope = JSON.parse(responseText) as RawRpcEnvelope<TResult>
  if (envelope.error) {
    throw new Error(`${name} failed: ${envelope.error.message ?? 'Unknown Sweed RPC error.'}`)
  }
  if (envelope.result === undefined) {
    throw new Error(`${name} returned no result payload.`)
  }
  return envelope.result
}

function ensureScopedProduct(map: Map<number, ScopedProductAggregate>, productId: number): ScopedProductAggregate {
  const existing = map.get(productId)
  if (existing) {
    return existing
  }
  const created: ScopedProductAggregate = { productId, sites: {} }
  map.set(productId, created)
  return created
}

function ensureSiteSummary(aggregate: ScopedProductAggregate, siteKey: SiteKey, siteLabel: string): ScopedProductSiteSummary {
  const existing = aggregate.sites[siteKey]
  if (existing) {
    return existing
  }
  const created: ScopedProductSiteSummary = {
    siteKey,
    siteLabel,
    metrics: {
      averageDailySold: null,
      currentQty: null,
      daysLeft: null,
      inStockQty: null,
      lastReceivedDate: null,
      last30DaysQtySold: null,
      orderIds: [],
      price: null,
      receivedOrderCount: 0,
      receivedPositionCount: 0,
      recentOos: false,
    },
  }
  aggregate.sites[siteKey] = created
  return created
}

function comparePacketRows(left: PacketRow, right: PacketRow): number {
  if (left.isActionable !== right.isActionable) {
    return left.isActionable ? -1 : 1
  }
  const leftDelta = Math.abs((left.proposedPrice ?? left.currentPrice ?? 0) - (left.currentPrice ?? 0))
  const rightDelta = Math.abs((right.proposedPrice ?? right.currentPrice ?? 0) - (right.currentPrice ?? 0))
  if (leftDelta !== rightDelta) {
    return rightDelta - leftDelta
  }
  return left.productName.localeCompare(right.productName) || left.productId - right.productId
}

function countNestedRows(value: Map<string, Map<string, Map<string, PacketRow[]>>> | Map<string, Map<string, PacketRow[]>> | Map<string, PacketRow[]>): number {
  let total = 0
  for (const nested of value.values()) {
    if (nested instanceof Map) {
      total += countNestedRows(nested as Map<string, Map<string, PacketRow[]>> | Map<string, PacketRow[]>)
    } else {
      total += nested.length
    }
  }
  return total
}

function getOrCreateMap<TValue>(map: Map<string, TValue>, key: string, factory?: () => TValue): TValue {
  const existing = map.get(key)
  if (existing) {
    return existing
  }
  const created = factory ? factory() : (new Map() as unknown as TValue)
  map.set(key, created)
  return created
}

function getOrCreateArray<T>(map: Map<string, T[]>, key: string): T[] {
  const existing = map.get(key)
  if (existing) {
    return existing
  }
  const created: T[] = []
  map.set(key, created)
  return created
}

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  worker: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results = new Array<TOutput>(items.length)
  let nextIndex = 0
  let firstError: unknown = null

  async function runWorker(): Promise<void> {
    while (true) {
      if (firstError !== null) {
        return
      }
      const currentIndex = nextIndex
      nextIndex += 1
      if (currentIndex >= items.length) {
        return
      }

      try {
        results[currentIndex] = await worker(items[currentIndex] as TInput, currentIndex)
      } catch (error) {
        firstError = error
        return
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => runWorker()))
  if (firstError !== null) {
    throw firstError
  }
  return results
}

function quantile(values: number[], fraction: number): number {
  if (values.length === 0) {
    return 0
  }
  if (values.length === 1) {
    return values[0] as number
  }
  const position = (values.length - 1) * fraction
  const lowerIndex = Math.floor(position)
  const upperIndex = Math.ceil(position)
  const lowerValue = values[lowerIndex] as number
  const upperValue = values[upperIndex] as number
  if (lowerIndex === upperIndex) {
    return lowerValue
  }
  return lowerValue + (upperValue - lowerValue) * (position - lowerIndex)
}

function pricePositionPercent(value: number, domainMin: number, domainMax: number): number {
  if (domainMax <= domainMin) {
    return 50
  }
  const percent = ((value - domainMin) / (domainMax - domainMin)) * 100
  return Math.max(0, Math.min(100, percent))
}

function compactCurrency(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'n/a'
  }
  return `$${value.toFixed(2)}`
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'n/a'
  }
  return `${value.toFixed(2)}% GM`
}

function formatCompactPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'n/a'
  }
  return `${value.toFixed(1)}%`
}

function formatDistance(distanceBand: string, distanceMiles: number | null): string {
  if (distanceMiles !== null && Number.isFinite(distanceMiles)) {
    return `${distanceBand} (${distanceMiles.toFixed(2)}mi)`
  }
  return distanceBand
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function progress(message: string): void {
  const timestamp = new Date().toISOString().slice(11, 19)
  console.log(`[${timestamp}] ${message}`)
}

main().catch(async (error) => {
  console.error(error)
  await closePool().catch(() => undefined)
  process.exitCode = 1
})
