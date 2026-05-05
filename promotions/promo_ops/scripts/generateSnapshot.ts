import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  DashboardResponse,
  EvidenceTable,
  ExistingPromoDetailResponse,
  MetricDefinition,
  PlacementRow,
  PerformanceDetailResponse,
  PromoOpsSnapshot,
  ProposalDetailResponse,
  SourceReference,
} from '../src/shared/contracts.js'
import { PromoOpsSnapshotSchema } from '../src/shared/contracts.js'

type VelocityBannerRun = {
  enabledPromos: Array<{
    actionId: string
    actionName: string
    bannerName: string
    discountPercent: number
    enabled: boolean
  }>
  finishedAt: string
  screens: Array<{
    createdProductMenuBanners: Array<{
      afterEnableEnabled: boolean
      afterEnableTotalDuration: number
      bannerId: string
      bannerName: string
      duration: number
      finalEnabled: boolean
      finalTotalDuration: number
      promoActionId: string
      promoActionName: string
    }>
    screenId: number
    screenName: string
  }>
  startedAt: string
}

type FreshAndIntenseRun = {
  action: {
    enabled: boolean
    id: string
    name: string
    selectorProductCount: number
  }
  campaign: {
    enabled: boolean
    fromDate: string
    id: string
    name: string
  }
  finishedAt: string
  screens: Array<{
    newProductMenuBanner: {
      afterEnableEnabled: boolean
      afterEnableTotalDuration: number
      bannerId: string
      bannerName: string
      finalEnabled: boolean
      finalTotalDuration: number
      promoActionId: string
    }
    screenId: number
    screenName: string
  }>
}

type BannerReadback = {
  readAt: string
  sites: Array<{
    dealerName: string
    screens: Array<{
      banners: Array<{
        bannerId: string
        bannerName: string
        duration: number | null
        enabled: boolean
        promoActionId: string | null
        totalDuration: number
        type: string
      }>
      screenEnabled: boolean
      screenId: number
      screenName: string
      totalScreenDuration: number
    }>
  }>
  sourceRun: string
}

type HarFile = {
  log: {
    entries: Array<{
      request: { url: string }
      response: { content: { text: string } }
    }>
  }
}

type CubeMeasureAnnotation = {
  format?: string
  meta?: {
    hint?: string
    type?: string
  }
  shortTitle?: string
  title?: string
}

type CubeQuery = {
  dimensions: string[]
  measures: string[]
  timeDimensions: Array<{
    dateRange: [string, string]
    dimension: string
    granularity?: string
  }>
  total?: boolean
}

type CubeResult = {
  annotation: {
    measures: Record<string, CubeMeasureAnnotation>
  }
  data: Array<Record<string, string | null>>
}

type PromoAggregate = {
  buyers: number
  fulfillmentType: string
  grossMargin: number
  netSales: number
  promoDiscount: number
  promoName: string
  quantity: number
}

type PromoBannerStats = {
  enabledBannerCount: number
  totalBannerCount: number
  totalDurationSeconds: number
  zeroDurationBannerCount: number
}

type ResolvedBannerPlacement = {
  actionId: string | null
  actionName: string | null
  bannerId: string
  bannerName: string
  campaignName: string | null
  enabled: boolean
  screenName: string
  totalDuration: number
  type: string
}

type CapturedNamedValue = {
  id?: string
  name?: string
}

type PromoMetadataSelector = {
  applicationMode?: CapturedNamedValue | null
  distributionLevel?: CapturedNamedValue | null
  enabled?: boolean
  productCount?: number | null
}

type PromoMetadataAction = {
  buySelector?: PromoMetadataSelector | null
  discountAmounts: Array<Record<string, number | null>>
  displayInEcommerceProducts?: boolean
  ecommerceDiscountMenuActionDisplayType?: CapturedNamedValue | null
  ecommerceHomePageActionDisplayType?: CapturedNamedValue | null
  enabled: boolean
  fromDate?: string | null
  getSelector?: PromoMetadataSelector | null
  id: string
  listedRow?: {
    enabled?: boolean
    name?: string
  }
  name: string
  toDate?: string | null
}

type PromoMetadataCampaign = {
  actions: PromoMetadataAction[]
  enabled: boolean
  fromDate?: string | null
  id: string
  name: string
  toDate?: string | null
}

type PromoMetadataSnapshot = {
  capturedAt: string
  sites: Array<{
    campaigns: PromoMetadataCampaign[]
    dealerId: number
    dealerName: string
    siteKey: string
    storeId: number
    storeName: string
  }>
}

type InventorySellthroughSelector = {
  applicationMode?: CapturedNamedValue | null
  brands?: Array<{ id?: string; name?: string }>
  categories?: Array<{ id?: string; name?: string }>
  distributionLevel?: CapturedNamedValue | null
  enabled?: boolean
  filterRuleCount?: number
  id?: string | null
  productCount?: number | null
  products?: Array<{ id?: string; name?: string }>
  selectorRuleCount?: number
  shelfTimeInDays?: {
    greaterThan?: number
    lessThan?: number
  } | null
}

type InventorySellthroughRow = {
  categoryName?: string | null
  daysUntilThreshold?: number | null
  expectedSelloutDate?: string | null
  maxShelfAgeDays?: number | null
  productId?: string | null
  productName?: string | null
  qualifyingAvailableQty?: number | null
  qualifyingMaxShelfAgeDays?: number | null
  qualifyingMinShelfAgeDays?: number | null
  totalAvailableQty?: number | null
  weeklyUnits?: number | null
  weeksOfSupply?: number | null
}

type InventorySellthroughSummary = {
  closestDaysUntilThreshold?: number | null
  missingSellthroughSkuCount?: number
  qualifyingSkuCount?: number
  qualifyingUnits?: number | null
  sellthroughMatchedSkuCount?: number
  sellthroughMatchedUnits?: number | null
}

type InventorySellthroughPool = {
  qualifyingProducts: InventorySellthroughRow[]
  summary: InventorySellthroughSummary
}

type ActionInventoryAction = {
  buySelector?: InventorySellthroughSelector | null
  campaignId?: string | null
  campaignName?: string | null
  discountPercent?: number | null
  getSelector?: InventorySellthroughSelector | null
  id?: string | null
  name?: string | null
}

type ActionInventorySnapshot = {
  action: ActionInventoryAction
  buyPool?: InventorySellthroughPool | null
  dealerId: number
  dealerName: string
  getPool?: InventorySellthroughPool | null
  groupedInventoryTotalRows: number
  overlapPool?: InventorySellthroughPool | null
  reorderReportDate?: string | null
  reorderTotalRows: number
  siteKey: string
  storeId: number
  storeName: string
}

type ActionInventorySiteSnapshot = {
  actions: ActionInventorySnapshot[]
  dealerId: number
  dealerName: string
  siteKey: string
  storeId: number
  storeName: string
}

type MfnySiteInventorySnapshot = {
  action: {
    buySelector?: InventorySellthroughSelector | null
    campaignId?: string | null
    campaignName?: string | null
    getSelector?: InventorySellthroughSelector | null
    id?: string | null
    name?: string | null
  }
  dealerId: number
  dealerName: string
  groupedInventoryTotalRows: number
  qualifyingProducts: InventorySellthroughRow[]
  reorderReportDate?: string | null
  reorderTotalRows: number
  siteKey: string
  storeId: number
  storeName: string
  summary: InventorySellthroughSummary
}

type VelocityTierInventorySnapshot = {
  action: {
    campaignId?: string | null
    campaignName?: string | null
    discountPercent?: number | null
    getSelector?: InventorySellthroughSelector | null
    id?: string | null
    name?: string | null
  }
  qualifyingProducts: InventorySellthroughRow[]
  summary: InventorySellthroughSummary
}

type VelocityInventorySnapshot = {
  approachingFirstThresholdProducts: InventorySellthroughRow[]
  dealerId: number
  dealerName: string
  groupedInventoryTotalRows: number
  reorderReportDate?: string | null
  reorderTotalRows: number
  siteKey: string
  storeId: number
  storeName: string
  summary: InventorySellthroughSummary
  tiers: VelocityTierInventorySnapshot[]
}

type PromoInventorySellthroughSnapshot = {
  actionSnapshotsBySite: ActionInventorySiteSnapshot[]
  capturedAt: string
  mfnyBySite: MfnySiteInventorySnapshot[]
  notes: string[]
  sourceHar: string
  velocityMidtown: VelocityInventorySnapshot
}

type PromoSelectorAuditSelectorReport = {
  distributionLevel?: {
    id?: number
    name?: string
  } | null
  id?: string | null
  label?: string | null
  needsUpdate?: boolean
  productCount?: number | null
}

type PromoSelectorAuditAction = {
  actionId?: string | null
  actionName?: string | null
  enabled?: boolean
  remainingIssues: Array<{ needsUpdate: boolean }>
  selectorReportsAfter?: PromoSelectorAuditSelectorReport[]
}

type PromoSelectorAuditSnapshot = {
  sites: Array<{
    siteKey?: string
    campaigns: Array<{
      campaignId?: string
      campaignName?: string
      actions: PromoSelectorAuditAction[]
    }>
  }>
}

type PricedToMoveActionView = {
  action: PromoMetadataAction
  audit: PromoSelectorAuditAction
  inventory: ActionInventorySnapshot
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(scriptDir, '..')
const automationRoot = resolve(appRoot, '../..')
const bulkDir = resolve(automationRoot, 'bulk_additions/2026-04-16')
const screensDir = resolve(automationRoot, 'screens')
const docsDir = resolve(automationRoot, 'docs/sweed/marketing')
const outputPath = resolve(appRoot, 'data/promoSnapshot.generated.json')

const sourcePaths = {
  agentTodo: resolve(bulkDir, 'AGENT_TODO.md'),
  copyPricedToMoveBronxToMidtown: resolve(bulkDir, 'copy_priced_to_move_bronx_to_midtown.py'),
  promoSelectorDistributionAudit: resolve(bulkDir, 'promo_selector_distribution_audit.json'),
  enableBronxFourTwenty26: resolve(bulkDir, 'enable_bronx_four_twenty26_actions.py'),
  eventAndPromoDocs: resolve(docsDir, 'segments-and-events.md'),
  fourTwenty26Descriptions: resolve(bulkDir, 'update_four_twenty26_promo_descriptions.py'),
  fourTwenty26Replacement: resolve(bulkDir, 'replace_four_twenty26_bogo_placeholders.py'),
  freshAndIntenseScreens: resolve(
    screensDir,
    'replace_midtown_fresh_and_intense_image_banners_with_dynamic_promo_results.json',
  ),
  latestBannerReadback: resolve(screensDir, 'banner_direct_readback_post_refresh_2026-04-18_201611.json'),
  promoInventorySellthroughSnapshot: resolve(bulkDir, 'promo_inventory_sellthrough_snapshot.json'),
  promoMetadataSnapshot: resolve(bulkDir, 'promo_metadata_snapshot.json'),
  promoCubeHar: resolve(bulkDir, 'prime.sweedpos.com_cube_v1_load_Archive [26-04-18 18-00-55].har'),
  screensDoc: resolve(docsDir, 'screens-and-banners.md'),
  velocityBannerBind: resolve(screensDir, 'tie_midtown_priced_to_move_banners_to_velocity_promos_results.json'),
  velocityPromoScript: resolve(bulkDir, 'replace_midtown_priced_to_move_with_velocity_boosters.py'),
}

const currencyFormatter = new Intl.NumberFormat('en-US', {
  currency: 'USD',
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: 'currency',
})

const integerFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
})

const quantityFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
})

function readText(path: string): string {
  return readFileSync(path, 'utf8')
}

function readJson<T>(path: string): T {
  return JSON.parse(readText(path)) as T
}

function countAuditedActions(audit: PromoSelectorAuditSnapshot): number {
  return audit.sites.reduce(
    (siteTotal, site) =>
      siteTotal +
      site.campaigns.reduce((campaignTotal, campaign) => campaignTotal + campaign.actions.length, 0),
    0,
  )
}

function countRemainingSelectorIssues(audit: PromoSelectorAuditSnapshot): number {
  return audit.sites.reduce(
    (siteTotal, site) =>
      siteTotal +
      site.campaigns.reduce(
        (campaignTotal, campaign) =>
          campaignTotal +
          campaign.actions.reduce(
            (actionTotal, action) =>
              actionTotal + action.remainingIssues.filter((issue) => issue.needsUpdate).length,
            0,
          ),
        0,
      ),
    0,
  )
}

function formatCurrency(value: number): string {
  return currencyFormatter.format(value)
}

function formatCount(value: number): string {
  return integerFormatter.format(value)
}

function formatQuantity(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return 'Not captured'
  }
  return quantityFormatter.format(value)
}

function formatPercent(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`
}

function formatShortDate(value: string | null | undefined, fallback = 'Not captured'): string {
  return value ? value.slice(0, 10) : fallback
}

function formatTerminationDate(value: string | null | undefined): string {
  return formatShortDate(value, 'No explicit end date captured locally')
}

function formatAgeDays(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return 'Not captured'
  }
  return `${value.toFixed(1)}d`
}

function formatAgeRange(minValue: number | null | undefined, maxValue: number | null | undefined): string {
  if (minValue === null || minValue === undefined || maxValue === null || maxValue === undefined) {
    return 'Not captured'
  }
  if (Math.abs(minValue - maxValue) < 0.05) {
    return formatAgeDays(maxValue)
  }
  return `${minValue.toFixed(1)}-${maxValue.toFixed(1)}d`
}

function formatWeeklyUnits(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return 'No reorder row'
  }
  return `${value.toFixed(2)}/wk`
}

function formatWeeksOfSupply(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return 'Not enough velocity data'
  }
  return `${value.toFixed(1)} weeks`
}

function formatSelloutDate(value: string | null | undefined): string {
  return value ?? 'Not enough velocity data'
}

function toNumber(value: string | null | undefined): number {
  return value ? Number(value) : 0
}

function getRequiredMatch(text: string, expression: RegExp, label: string): string {
  const match = expression.exec(text)
  if (!match?.[1]) {
    throw new Error(`Unable to extract ${label} from ${sourcePaths.agentTodo}`)
  }
  return match[1]
}

function parseTodoMetric(text: string, expression: RegExp, label: string): number {
  return Number(getRequiredMatch(text, expression, label))
}

function makeSource(label: string, detail: string, path: string): SourceReference {
  return { detail, label, path }
}

const promoNameOverrides: Record<string, string> = {
  "Freshly Baked NYC - Midtown - Bundles - Moony's 2x0.5g 2 for $25, 4 for $35, 6 for $40":
    "Freshly Baked NYC - Midtown - Bundles - Moony's 2x0.5g 2 for $25, 3 for $35, 4 for $40",
}

function normalizePromoName(name: string): string {
  return promoNameOverrides[name] ?? name
}

function simplifyPromoName(name: string): string {
  return normalizePromoName(name)
    .replace(/^Freshly Baked NYC - Midtown - /, '')
    .replace(/^Freshly Baked NY - /, '')
}

function requireMetadataCampaign(
  metadata: PromoMetadataSnapshot,
  siteKey: string,
  campaignId: string,
  label: string,
): PromoMetadataCampaign {
  const site = metadata.sites.find((entry) => entry.siteKey === siteKey)
  if (!site) {
    throw new Error(`Unable to locate ${label} site ${siteKey} in ${sourcePaths.promoMetadataSnapshot}`)
  }

  const campaign = site.campaigns.find((entry) => entry.id === campaignId)
  if (!campaign) {
    throw new Error(`Unable to locate ${label} campaign ${campaignId} in ${sourcePaths.promoMetadataSnapshot}`)
  }

  return campaign
}

function requireMetadataAction(
  metadata: PromoMetadataSnapshot,
  siteKey: string,
  campaignId: string,
  actionId: string,
  label: string,
): { action: PromoMetadataAction; campaign: PromoMetadataCampaign } {
  const campaign = requireMetadataCampaign(metadata, siteKey, campaignId, label)
  const action = campaign.actions.find((entry) => entry.id === actionId)
  if (!action) {
    throw new Error(`Unable to locate ${label} action ${actionId} in ${sourcePaths.promoMetadataSnapshot}`)
  }

  return { action, campaign }
}

function requireSelectorAuditCampaign(
  audit: PromoSelectorAuditSnapshot,
  siteKey: string,
  campaignId: string,
  label: string,
): PromoSelectorAuditSnapshot['sites'][number]['campaigns'][number] {
  const site = audit.sites.find((entry) => entry.siteKey === siteKey)
  if (!site) {
    throw new Error(
      `Unable to locate selector audit site ${siteKey} for ${label} in ${sourcePaths.promoSelectorDistributionAudit}`,
    )
  }

  const campaign = site.campaigns.find((entry) => entry.campaignId === campaignId)
  if (!campaign) {
    throw new Error(
      `Unable to locate selector audit campaign ${campaignId} for ${label} in ${sourcePaths.promoSelectorDistributionAudit}`,
    )
  }

  return campaign
}

function requireMfnyInventorySite(
  snapshot: PromoInventorySellthroughSnapshot,
  siteKey: string,
): MfnySiteInventorySnapshot {
  const site = snapshot.mfnyBySite.find((entry) => entry.siteKey === siteKey)
  if (!site) {
    throw new Error(
      `Unable to locate MFNY inventory snapshot for ${siteKey} in ${sourcePaths.promoInventorySellthroughSnapshot}`,
    )
  }
  return site
}

function requireActionInventorySnapshot(
  snapshot: PromoInventorySellthroughSnapshot,
  siteKey: string,
  actionId: string,
  label: string,
): ActionInventorySnapshot {
  const site = snapshot.actionSnapshotsBySite.find((entry) => entry.siteKey === siteKey)
  if (!site) {
    throw new Error(
      `Unable to locate action inventory site ${siteKey} for ${label} in ${sourcePaths.promoInventorySellthroughSnapshot}`,
    )
  }

  const action = site.actions.find((entry) => entry.action.id === actionId)
  if (!action) {
    throw new Error(
      `Unable to locate action inventory snapshot ${actionId} for ${label} in ${sourcePaths.promoInventorySellthroughSnapshot}`,
    )
  }

  return action
}

function countTrackedInventoryActions(snapshot: PromoInventorySellthroughSnapshot): number {
  return snapshot.actionSnapshotsBySite.reduce((total, site) => total + site.actions.length, 0)
}

function maxWeeksOfSupply(rows: InventorySellthroughRow[]): number | null {
  const values = rows
    .map((row) => row.weeksOfSupply)
    .filter((value): value is number => value !== null && value !== undefined)
  return values.length ? Math.max(...values) : null
}

function buildEvidenceTable(
  title: string,
  summary: string,
  columns: string[],
  rows: Array<{ id: string; values: string[] }>,
  emptyState?: string,
): EvidenceTable {
  return {
    columns: columns.map((label) => ({ label })),
    emptyState,
    rows,
    summary,
    title,
  }
}

function buildInventoryPoolTable(
  title: string,
  summary: string,
  rows: InventorySellthroughRow[],
  emptyState: string,
): EvidenceTable {
  return buildEvidenceTable(
    title,
    summary,
    ['SKU', 'On hand', 'Weekly units', 'Weeks of supply', 'Expected sellout', 'Shelf age'],
    rows.map((row) => ({
      id: row.productId ?? row.productName ?? `${title}-row`,
      values: [
        row.productName ?? 'Unknown product',
        formatQuantity(row.qualifyingAvailableQty),
        formatWeeklyUnits(row.weeklyUnits),
        formatWeeksOfSupply(row.weeksOfSupply),
        formatSelloutDate(row.expectedSelloutDate),
        formatAgeRange(row.qualifyingMinShelfAgeDays, row.qualifyingMaxShelfAgeDays),
      ],
    })),
    emptyState,
  )
}

function buildMfnyInventoryTable(site: MfnySiteInventorySnapshot): EvidenceTable {
  return buildInventoryPoolTable(
    `${site.dealerName} in-stock MFNY rows`,
    `Saved grouped inventory rows are joined to store.reports.reorder by product id here. Weeks of supply follows the workspace's earlier proposal-pass assumption that reorder lastWeekSellingPerDay behaves like weekly units, while rows missing from reorder stay explicit instead of faking zero velocity.`,
    site.qualifyingProducts,
    'No saved MFNY rows matched this site snapshot.',
  )
}

function buildVelocityTierTable(tier: VelocityTierInventorySnapshot): EvidenceTable {
  const bounds = tier.action.getSelector?.shelfTimeInDays
  const lower = bounds?.greaterThan
  const upper = bounds?.lessThan
  const title =
    lower !== undefined && upper !== undefined
      ? `${tier.action.name ?? 'Velocity tier'}: >${lower} and <${upper} days`
      : lower !== undefined
        ? `${tier.action.name ?? 'Velocity tier'}: >${lower} days`
        : tier.action.name ?? 'Velocity tier'

  return buildInventoryPoolTable(
    title,
    'Qualifying units are derived item by item from grouped inventory dateTimeReceived so the age-gated thresholds reflect saved receipt-age evidence rather than banner health alone.',
    tier.qualifyingProducts,
    'No current Midtown inventory rows satisfy this saved shelf-age window.',
  )
}

function buildVelocityApproachingTable(snapshot: VelocityInventorySnapshot): EvidenceTable {
  const firstTierBounds = snapshot.tiers[0]?.action.getSelector?.shelfTimeInDays
  const lowerBound = firstTierBounds?.greaterThan ?? 30
  return buildEvidenceTable(
    `Closest products to the >${lowerBound}-day gate`,
    'These rows stay outside the current qualifying pool today, but they are the nearest saved inventory to the first Velocity threshold.',
    ['SKU', 'On hand', 'Current max age', `Days until >${lowerBound}`, 'Weekly units', 'Weeks of supply'],
    snapshot.approachingFirstThresholdProducts.map((row) => ({
      id: row.productId ?? row.productName ?? 'unknown-approaching-row',
      values: [
        row.productName ?? 'Unknown product',
        formatQuantity(row.totalAvailableQty),
        formatAgeDays(row.maxShelfAgeDays),
        row.daysUntilThreshold === null || row.daysUntilThreshold === undefined
          ? 'Not captured'
          : `${row.daysUntilThreshold.toFixed(1)}d`,
        formatWeeklyUnits(row.weeklyUnits),
        formatWeeksOfSupply(row.weeksOfSupply),
      ],
    })),
    'No near-threshold rows were saved for the first Velocity age gate.',
  )
}

function formatPoolScope(pool: InventorySellthroughPool | null | undefined): string {
  return `${formatCount(pool?.summary.qualifyingSkuCount ?? 0)} SKUs / ${formatQuantity(pool?.summary.qualifyingUnits ?? null)} units`
}

function maxPoolWeeksOfSupply(pool: InventorySellthroughPool | null | undefined): number | null {
  return maxWeeksOfSupply(pool?.qualifyingProducts ?? [])
}

function buildActionPoolTable(
  title: string,
  summary: string,
  pool: InventorySellthroughPool | null | undefined,
  emptyState: string,
): EvidenceTable {
  return buildInventoryPoolTable(title, summary, pool?.qualifyingProducts ?? [], emptyState)
}

function describeSelectorScope(selector: InventorySellthroughSelector | null | undefined): string {
  if (!selector) {
    return 'No selector captured'
  }

  const directProducts = selector.products?.map((entry) => entry.name).filter(Boolean) ?? []
  const brands = selector.brands?.map((entry) => entry.name).filter(Boolean) ?? []
  const categories = selector.categories?.map((entry) => entry.name).filter(Boolean) ?? []
  const parts: string[] = []

  if (directProducts.length === 1) {
    parts.push(directProducts[0] as string)
  } else if (directProducts.length > 1) {
    parts.push(`${formatCount(directProducts.length)} direct products`)
  }

  if (brands.length === 1) {
    parts.push(brands[0] as string)
  } else if (brands.length > 1) {
    parts.push(`${formatCount(brands.length)} brands`)
  }

  if (categories.length === 1) {
    parts.push(categories[0] as string)
  } else if (categories.length > 1) {
    parts.push(`${formatCount(categories.length)} categories`)
  }

  if (parts.length > 0) {
    return parts.join(' + ')
  }

  if ((selector.productCount ?? 0) > 0) {
    return `${formatCount(selector.productCount ?? 0)} resolved products`
  }

  if ((selector.selectorRuleCount ?? 0) > 0) {
    return `${formatCount(selector.selectorRuleCount ?? 0)} saved selector rules`
  }

  return 'No saved selector scope'
}

function describeSelectorModes(view: PricedToMoveActionView): string {
  const buyMode = view.inventory.action.buySelector?.applicationMode?.name
  const getMode = view.inventory.action.getSelector?.applicationMode?.name

  if (buyMode && getMode) {
    return buyMode === getMode ? buyMode : `Buy ${buyMode} / Get ${getMode}`
  }

  return getMode ?? buyMode ?? 'Not captured'
}

function describeSelectorCounts(view: PricedToMoveActionView): string {
  const buyCount = view.inventory.action.buySelector?.productCount
  const getCount = view.inventory.action.getSelector?.productCount

  if (view.inventory.action.buySelector && view.inventory.action.getSelector) {
    return `Buy ${formatCount(buyCount ?? 0)} / Get ${formatCount(getCount ?? 0)}`
  }

  return formatCount(getCount ?? buyCount ?? 0)
}

function describeOfferShape(view: PricedToMoveActionView): string {
  const hasBundle = Boolean(view.inventory.action.buySelector && view.inventory.action.getSelector)
  const hasDirectProducts =
    (view.inventory.action.getSelector?.products?.length ?? 0) > 0 ||
    (view.inventory.action.buySelector?.products?.length ?? 0) > 0

  if (hasBundle) {
    return 'Bundle promo-price'
  }

  if (hasDirectProducts) {
    return 'Direct-product markdown'
  }

  return 'Rule-based markdown'
}

function describeLaneInventoryRow(
  actionName: string,
  laneLabel: string,
  selector: InventorySellthroughSelector | null | undefined,
  pool: InventorySellthroughPool | null | undefined,
): { id: string; values: string[] } {
  return {
    id: `${actionName}-${laneLabel}`,
    values: [
      laneLabel === 'Get' ? actionName : `${actionName} (${laneLabel})`,
      describeSelectorScope(selector),
      formatPoolScope(pool),
      `${formatCount(pool?.summary.sellthroughMatchedSkuCount ?? 0)} / ${formatCount(pool?.summary.qualifyingSkuCount ?? 0)} rows`,
      formatWeeksOfSupply(maxPoolWeeksOfSupply(pool)),
    ],
  }
}

function countInventoryPositiveActions(actions: PricedToMoveActionView[]): number {
  return actions.filter(
    (view) =>
      (view.inventory.buyPool?.summary.qualifyingSkuCount ?? 0) > 0 ||
      (view.inventory.getPool?.summary.qualifyingSkuCount ?? 0) > 0,
  ).length
}

function countInventoryPositiveLanes(actions: PricedToMoveActionView[]): number {
  return actions.reduce((total, view) => {
    const buyCount = (view.inventory.buyPool?.summary.qualifyingSkuCount ?? 0) > 0 ? 1 : 0
    const getCount = (view.inventory.getPool?.summary.qualifyingSkuCount ?? 0) > 0 ? 1 : 0
    return total + buyCount + getCount
  }, 0)
}

function countDirectProductActions(actions: PricedToMoveActionView[]): number {
  return actions.filter(
    (view) =>
      (view.inventory.action.getSelector?.products?.length ?? 0) > 0 ||
      (view.inventory.action.buySelector?.products?.length ?? 0) > 0,
  ).length
}

function countBundleActions(actions: PricedToMoveActionView[]): number {
  return actions.filter((view) => Boolean(view.inventory.action.buySelector && view.inventory.action.getSelector)).length
}

function countPricingVisibleActions(actions: PricedToMoveActionView[]): number {
  return actions.filter((view) => view.action.displayInEcommerceProducts).length
}

function countDiscountMenuVisibleActions(actions: PricedToMoveActionView[]): number {
  return actions.filter(
    (view) => view.action.ecommerceDiscountMenuActionDisplayType?.name === 'Show to all',
  ).length
}

function countHomepageVisibleActions(actions: PricedToMoveActionView[]): number {
  return actions.filter((view) => view.action.ecommerceHomePageActionDisplayType?.name === 'Show to all').length
}

function countClearedSelectorReports(actions: PricedToMoveActionView[]): number {
  return actions.reduce(
    (total, view) =>
      total +
      (view.audit.selectorReportsAfter?.filter((report) => report.needsUpdate === false).length ?? 0),
    0,
  )
}

function countSelectorReports(actions: PricedToMoveActionView[]): number {
  return actions.reduce((total, view) => total + (view.audit.selectorReportsAfter?.length ?? 0), 0)
}

function buildPricedToMoveScheduleTable(
  actions: PricedToMoveActionView[],
  campaign: PromoMetadataCampaign,
): EvidenceTable {
  return buildEvidenceTable(
    'Action windows and live state',
    'The saved metadata snapshot keeps the entire site-owned Priced To Move family visible in one place, which is more useful operationally than jumping through isolated action IDs.',
    ['Action', 'Start', 'End', 'State'],
    actions.map((view) => ({
      id: view.action.id,
      values: [
        view.action.name,
        formatShortDate(view.action.fromDate ?? campaign.fromDate),
        formatTerminationDate(view.action.toDate ?? campaign.toDate),
        describeActionState(campaign, view.action),
      ],
    })),
  )
}

function buildPricedToMoveSelectorTable(actions: PricedToMoveActionView[]): EvidenceTable {
  return buildEvidenceTable(
    'Offer mix and selector shape',
    'Direct-product markdowns, broad rule-based markdowns, and the Enigma bundle now share one saved review table so selector shape and live state are not split across separate notes.',
    ['Action', 'Offer type', 'Selector mode', 'Selector scope', 'Known selector count'],
    actions.map((view) => ({
      id: view.action.id,
      values: [
        view.action.name,
        describeOfferShape(view),
        describeSelectorModes(view),
        view.inventory.action.buySelector && view.inventory.action.getSelector
          ? `Buy ${describeSelectorScope(view.inventory.action.buySelector)} / Get ${describeSelectorScope(view.inventory.action.getSelector)}`
          : describeSelectorScope(view.inventory.action.getSelector ?? view.inventory.action.buySelector),
        describeSelectorCounts(view),
      ],
    })),
  )
}

function buildPricedToMoveInventoryTable(actions: PricedToMoveActionView[]): EvidenceTable {
  const rows = actions.flatMap((view) => {
    if (view.inventory.action.buySelector && view.inventory.action.getSelector) {
      return [
        describeLaneInventoryRow(
          view.action.name,
          'Buy',
          view.inventory.action.buySelector,
          view.inventory.buyPool,
        ),
        describeLaneInventoryRow(
          view.action.name,
          'Get',
          view.inventory.action.getSelector,
          view.inventory.getPool,
        ),
      ]
    }

    return [
      describeLaneInventoryRow(
        view.action.name,
        'Get',
        view.inventory.action.getSelector ?? view.inventory.action.buySelector,
        view.inventory.getPool ?? view.inventory.buyPool,
      ),
    ]
  })

  return buildEvidenceTable(
    'Current saved qualifying scope by action',
    'The saved grouped inventory plus reorder join currently resolves to zero qualifying rows across this Priced To Move family, and that absence is itself the useful operator signal to keep visible.',
    ['Action', 'Selector scope', 'Current scope', 'Sellthrough coverage', 'Slowest WOS'],
    rows,
  )
}

function buildPricedToMoveAssetTable(actions: PricedToMoveActionView[]): EvidenceTable {
  return buildEvidenceTable(
    'Ecommerce placement by action',
    'Every saved action row still carries ecommerce placement metadata even when the action is disabled, which keeps merchandising review grounded in evidence instead of memory.',
    ['Action', 'Promo pricing', 'Discount menu', 'Homepage'],
    actions.map((view) => ({
      id: view.action.id,
      values: [
        view.action.name,
        view.action.displayInEcommerceProducts ? 'Visible' : 'Hidden',
        describeDisplayType(view.action.ecommerceDiscountMenuActionDisplayType),
        describeDisplayType(view.action.ecommerceHomePageActionDisplayType),
      ],
    })),
  )
}

function buildPricedToMoveVerificationTable(
  actions: PricedToMoveActionView[],
  campaign: PromoMetadataCampaign,
): EvidenceTable {
  return buildEvidenceTable(
    'Site ownership and selector audit state',
    'Ownership should still be verified from the site-scoped campaign/action lists, but the saved selector-audit artifact now preserves the all-clear state for every Priced To Move selector under that site-owned campaign.',
    ['Action', 'Current state', 'Audit result', 'Distribution', 'Selector reports'],
    actions.map((view) => {
      const distributions = Array.from(
        new Set(
          (view.audit.selectorReportsAfter ?? [])
            .map((report) => report.distributionLevel?.name)
            .filter((value): value is string => Boolean(value)),
        ),
      )
      const remainingIssues = view.audit.remainingIssues.filter((issue) => issue.needsUpdate).length
      return {
        id: view.action.id,
        values: [
          view.action.name,
          describeActionState(campaign, view.action),
          remainingIssues === 0 ? 'Clear' : `${formatCount(remainingIssues)} issue${remainingIssues === 1 ? '' : 's'}`,
          distributions.join(', ') || 'Not captured',
          formatCount(view.audit.selectorReportsAfter?.length ?? 0),
        ],
      }
    }),
  )
}

function buildNamedEcommercePlacementRows(actions: PricedToMoveActionView[]): PlacementRow[] {
  return actions.flatMap((view) =>
    buildEcommercePlacementRows(view.action).map((row) => ({
      ...row,
      slot: `${view.action.name} - ${row.slot}`,
    })),
  )
}

function describePromoWindow(campaign: PromoMetadataCampaign, action?: PromoMetadataAction): string {
  const start = action?.fromDate ?? campaign.fromDate
  const end = action?.toDate ?? campaign.toDate

  if (start && end) {
    return `${formatShortDate(start)} to ${formatShortDate(end)}`
  }

  if (start) {
    return `Starts ${formatShortDate(start)}`
  }

  return 'No explicit schedule captured locally'
}

function describeActionState(campaign: PromoMetadataCampaign, action: PromoMetadataAction): string {
  if (campaign.enabled && action.enabled) {
    return 'Enabled'
  }

  if (campaign.enabled) {
    return 'Campaign enabled, action disabled'
  }

  return 'Disabled'
}

function describeCampaignActionState(campaign: PromoMetadataCampaign, actions: PromoMetadataAction[]): string {
  const enabledCount = actions.filter((action) => action.enabled).length
  if (!campaign.enabled) {
    return 'Campaign disabled'
  }
  if (enabledCount === actions.length) {
    return 'Campaign enabled, all actions enabled'
  }
  if (enabledCount === 0) {
    return 'Campaign enabled, actions disabled'
  }
  return `Campaign enabled, ${enabledCount}/${actions.length} actions enabled`
}

function describeDisplayType(value: CapturedNamedValue | null | undefined): string {
  return value?.name ?? 'Not captured'
}

function buildEcommercePlacementRows(action: PromoMetadataAction): PlacementRow[] {
  return [
    {
      detail: `Saved action metadata captured displayInEcommerceProducts = ${String(action.displayInEcommerceProducts ?? false)}.`,
      slot: 'Promo pricing',
      status: action.displayInEcommerceProducts ? 'Visible' : 'Hidden',
      surface: 'Ecommerce',
    },
    {
      detail: `Saved action metadata captured ecommerceDiscountMenuActionDisplayType = ${describeDisplayType(action.ecommerceDiscountMenuActionDisplayType)}.`,
      slot: 'Discount menu',
      status: describeDisplayType(action.ecommerceDiscountMenuActionDisplayType),
      surface: 'Ecommerce',
    },
    {
      detail: `Saved action metadata captured ecommerceHomePageActionDisplayType = ${describeDisplayType(action.ecommerceHomePageActionDisplayType)}.`,
      slot: 'Homepage exposure',
      status: describeDisplayType(action.ecommerceHomePageActionDisplayType),
      surface: 'Ecommerce',
    },
  ]
}

function buildBannerStats(readback: BannerReadback, dealerName: string, actionIds: string[]): PromoBannerStats {
  const targetSite = readback.sites.find((site) => site.dealerName === dealerName)
  if (!targetSite) {
    throw new Error(`Unable to locate banner readback site ${dealerName}`)
  }

  const stats: PromoBannerStats = {
    enabledBannerCount: 0,
    totalBannerCount: 0,
    totalDurationSeconds: 0,
    zeroDurationBannerCount: 0,
  }

  for (const screen of targetSite.screens) {
    for (const banner of screen.banners) {
      if (!banner.promoActionId || !actionIds.includes(banner.promoActionId)) {
        continue
      }
      stats.totalBannerCount += 1
      stats.totalDurationSeconds += banner.totalDuration
      if (banner.enabled) {
        stats.enabledBannerCount += 1
      }
      if (banner.totalDuration === 0) {
        stats.zeroDurationBannerCount += 1
      }
    }
  }

  return stats
}

function requireTodoEvidence(text: string, expression: RegExp, label: string) {
  if (!expression.test(text)) {
    throw new Error(`Unable to confirm ${label} from ${sourcePaths.agentTodo}`)
  }
}

function bannerPlacementStatus(banner: {
  enabled: boolean
  totalDuration: number
}): string {
  const state = banner.enabled ? 'Enabled' : 'Disabled'
  return `${state} at ${banner.totalDuration}s`
}

function buildBannerPlacementRows(
  readback: BannerReadback,
  dealerName: string,
  actionIds: string[],
): PlacementRow[] {
  const targetSite = readback.sites.find((site) => site.dealerName === dealerName)
  if (!targetSite) {
    throw new Error(`Unable to locate banner readback site ${dealerName}`)
  }

  const placements: PlacementRow[] = []

  for (const screen of targetSite.screens) {
    for (const banner of screen.banners) {
      if (!banner.promoActionId || !actionIds.includes(banner.promoActionId)) {
        continue
      }

      placements.push({
        detail: `Banner ${banner.bannerId} is linked to action ${banner.promoActionId} with configured duration ${banner.duration ?? 0}s and current total duration ${banner.totalDuration}s.`,
        slot: `${banner.bannerName} (${banner.type})`,
        status: bannerPlacementStatus(banner),
        surface: screen.screenName,
      })
    }
  }

  return placements
}

function buildActionContextIndex(
  metadata: PromoMetadataSnapshot,
): Map<string, { actionName: string; campaignName: string }> {
  const index = new Map<string, { actionName: string; campaignName: string }>()
  for (const site of metadata.sites) {
    for (const campaign of site.campaigns) {
      for (const action of campaign.actions) {
        index.set(action.id, { actionName: action.name, campaignName: campaign.name })
      }
    }
  }
  return index
}

function collectResolvedBannerPlacements(
  readback: BannerReadback,
  metadata: PromoMetadataSnapshot,
  dealerName: string,
  filters: { actionIds?: string[]; bannerNameIncludes?: string },
): ResolvedBannerPlacement[] {
  const targetSite = readback.sites.find((site) => site.dealerName === dealerName)
  if (!targetSite) {
    throw new Error(`Unable to locate banner readback site ${dealerName}`)
  }

  const trackedActionIds = new Set(filters.actionIds ?? [])
  const loweredToken = filters.bannerNameIncludes?.toLowerCase()
  const actionIndex = buildActionContextIndex(metadata)
  const placements: ResolvedBannerPlacement[] = []

  for (const screen of targetSite.screens) {
    for (const banner of screen.banners) {
      const bannerActionId = banner.promoActionId ?? null
      const matchesActionIds = trackedActionIds.size > 0 && bannerActionId !== null && trackedActionIds.has(bannerActionId)
      const matchesName = loweredToken
        ? banner.bannerName.toLowerCase().includes(loweredToken)
        : false

      if (!matchesActionIds && !matchesName) {
        continue
      }

      const context = bannerActionId ? actionIndex.get(bannerActionId) : undefined
      placements.push({
        actionId: bannerActionId,
        actionName: context?.actionName ?? null,
        bannerId: banner.bannerId,
        bannerName: banner.bannerName,
        campaignName: context?.campaignName ?? null,
        enabled: banner.enabled,
        screenName: screen.screenName,
        totalDuration: banner.totalDuration,
        type: banner.type,
      })
    }
  }

  return placements.sort(
    (left, right) =>
      left.screenName.localeCompare(right.screenName) || left.bannerName.localeCompare(right.bannerName),
  )
}

function countPlacementScreens(placements: ResolvedBannerPlacement[]): number {
  return new Set(placements.map((placement) => placement.screenName)).size
}

function describeResolvedBannerState(placement: ResolvedBannerPlacement): string {
  return `${placement.enabled ? 'Enabled' : 'Disabled'} at ${placement.totalDuration}s`
}

function describeResolvedBannerOwner(placement: ResolvedBannerPlacement): string {
  if (!placement.actionId) {
    return 'No linked promo action'
  }

  if (placement.actionName && placement.campaignName) {
    return `${placement.campaignName}: ${placement.actionName} (${placement.actionId})`
  }

  return `Action ${placement.actionId}`
}

function buildResolvedBannerPlacementTable(
  title: string,
  summary: string,
  placements: ResolvedBannerPlacement[],
  emptyState: string,
): EvidenceTable {
  return buildEvidenceTable(
    title,
    summary,
    ['Screen', 'Banner', 'Linked promo', 'State'],
    placements.map((placement) => ({
      id: placement.bannerId,
      values: [
        placement.screenName,
        `${placement.bannerName} (${placement.type})`,
        describeResolvedBannerOwner(placement),
        describeResolvedBannerState(placement),
      ],
    })),
    emptyState,
  )
}

function buildBannerCoverageAuditTable(
  siteLabel: string,
  directPlacements: ResolvedBannerPlacement[],
  relatedPlacements: ResolvedBannerPlacement[],
): EvidenceTable {
  return buildEvidenceTable(
    'Banner carryover audit',
    'Banner carryover now needs an explicit direct-link audit plus a same-name check, because visible screen labels can belong to a different promo family.',
    ['Scope', 'Linked banners', 'Screens', 'Interpretation'],
    [
      {
        id: `${siteLabel}-direct-banner-audit`,
        values: [
          `${siteLabel} copied family`,
          formatCount(directPlacements.length),
          formatCount(countPlacementScreens(directPlacements)),
          directPlacements.length === 0
            ? 'No current screen rows are directly bound to this family\'s action ids.'
            : 'Direct promo-linked banner rows are already present for this family.',
        ],
      },
      {
        id: `${siteLabel}-related-banner-audit`,
        values: [
          `${siteLabel} same-name labels`,
          formatCount(relatedPlacements.length),
          formatCount(countPlacementScreens(relatedPlacements)),
          relatedPlacements.length === 0
            ? 'No captured Priced to MOVE labels exist on this site.'
            : 'These labels are real, but the linked promo ids below show whether they belong to this family or another one.',
        ],
      },
    ],
  )
}

function parsePromoCubeCapture() {
  const har = readJson<HarFile>(sourcePaths.promoCubeHar)
  const entry = har.log.entries[0]
  if (!entry) {
    throw new Error(`No entries found in ${sourcePaths.promoCubeHar}`)
  }

  const requestUrl = new URL(entry.request.url)
  const rawQuery = requestUrl.searchParams.get('query')
  if (!rawQuery) {
    throw new Error(`Promo HAR query payload was missing in ${sourcePaths.promoCubeHar}`)
  }

  const query = JSON.parse(rawQuery) as CubeQuery
  const result = (JSON.parse(entry.response.content.text) as { results: CubeResult[] }).results[0]
  if (!result) {
    throw new Error(`Promo HAR response did not include a result payload in ${sourcePaths.promoCubeHar}`)
  }

  const namedAggregates = new Map<string, PromoAggregate>()
  const promoTotals = new Map<string, PromoAggregate>()

  let namedNetSales = 0
  let namedGrossMargin = 0
  let namedPromoDiscount = 0
  let namedBuyers = 0
  let namedQuantity = 0
  let unlinkedRows = 0
  let unlinkedNetSales = 0

  for (const row of result.data) {
    const rawPromoName = row['PromosLight.promoFullName']
    const promoName = rawPromoName ? normalizePromoName(rawPromoName) : rawPromoName
    const fulfillmentType = row['PromotionEffectiveness.fulfillmentType'] ?? 'Unknown'
    const netSales = toNumber(row['PromotionEffectiveness.netSales'])
    const grossMargin = toNumber(row['PromotionEffectiveness.grossMargin'])
    const promoDiscount = toNumber(row['PromotionEffectiveness.promoDiscount'])
    const quantity = toNumber(row['PromotionEffectiveness.quantity'])
    const buyers = toNumber(row['PromotionEffectiveness.cutomersCount'])

    if (!promoName) {
      unlinkedRows += 1
      unlinkedNetSales += netSales
      continue
    }

    namedNetSales += netSales
    namedGrossMargin += grossMargin
    namedPromoDiscount += promoDiscount
    namedQuantity += quantity
    namedBuyers += buyers

    const rowKey = `${promoName}::${fulfillmentType}`
    const aggregate = namedAggregates.get(rowKey) ?? {
      buyers: 0,
      fulfillmentType,
      grossMargin: 0,
      netSales: 0,
      promoDiscount: 0,
      promoName,
      quantity: 0,
    }
    aggregate.buyers += buyers
    aggregate.grossMargin += grossMargin
    aggregate.netSales += netSales
    aggregate.promoDiscount += promoDiscount
    aggregate.quantity += quantity
    namedAggregates.set(rowKey, aggregate)

    const promoAggregate = promoTotals.get(promoName) ?? {
      buyers: 0,
      fulfillmentType: 'All fulfillment types',
      grossMargin: 0,
      netSales: 0,
      promoDiscount: 0,
      promoName,
      quantity: 0,
    }
    promoAggregate.buyers += buyers
    promoAggregate.grossMargin += grossMargin
    promoAggregate.netSales += netSales
    promoAggregate.promoDiscount += promoDiscount
    promoAggregate.quantity += quantity
    promoTotals.set(promoName, promoAggregate)
  }

  const namedRows = Array.from(namedAggregates.values()).sort((left, right) => right.netSales - left.netSales)
  const topPromos = Array.from(promoTotals.values()).sort((left, right) => right.netSales - left.netSales)
  const topDiscountPromo = Array.from(promoTotals.values()).sort(
    (left, right) => right.promoDiscount - left.promoDiscount,
  )[0]

  return {
    measures: result.annotation.measures,
    namedBuyers,
    namedGrossMargin,
    namedNetSales,
    namedPromoDiscount,
    namedQuantity,
    namedRows,
    query,
    topDiscountPromo,
    topPromos,
    totalRows: result.data.length,
    unlinkedNetSales,
    unlinkedRows,
  }
}

function metricFromAnnotation(
  annotations: Record<string, CubeMeasureAnnotation>,
  key: string,
): MetricDefinition {
  const annotation = annotations[key]
  if (!annotation) {
    return {
      format: 'number',
      label: key,
      note: `Captured cube metric ${key}.`,
    }
  }

  return {
    format: annotation.format ?? annotation.meta?.type ?? 'number',
    label: annotation.shortTitle ?? annotation.title ?? key,
    note: annotation.meta?.hint
      ? `${annotation.meta.hint} Source key: ${key}.`
      : `Captured cube metric ${key}.`,
  }
}

function buildDashboard(
  promoCube: ReturnType<typeof parsePromoCubeCapture>,
  selectorAudit: PromoSelectorAuditSnapshot,
  inventorySnapshot: PromoInventorySellthroughSnapshot,
): DashboardResponse {
  const auditedActionCount = countAuditedActions(selectorAudit)
  const remainingSelectorIssues = countRemainingSelectorIssues(selectorAudit)
  const trackedInventoryActions = countTrackedInventoryActions(inventorySnapshot)

  return {
    architectureDecision: [
      'Keep the lightweight Fastify + React + Vite runtime from communications_ops for fast operator iteration.',
      'Generate one typed snapshot manifest from local promo scripts, banner artifacts, docs, and HAR captures instead of keeping page data hardcoded in server code.',
      'Preserve a read-only server-normalized model now, then replace individual snapshot inputs with live adapters only when a query path is proven safe.',
    ],
    identifiedApps: [
      {
        name: 'Communications Ops',
        path: resolve(automationRoot, 'communications/midtown-delivery/communications_ops'),
        patterns: [
          'Fastify serves the operator app and API together without extra deployment layers.',
          'Card-led navigation works well for live operations queues and drill-ins.',
          'The runtime stays intentionally thin while server endpoints shape page-ready payloads.',
        ],
        reuseNow: ['single-process runtime', 'Fastify + Vite bootstrap', 'operator card rhythm'],
        stack: 'Fastify + React + Vite + lightweight JSON routes',
      },
      {
        name: 'Helios',
        path: resolve(automationRoot, 'helios'),
        patterns: [
          'Typed shared contracts keep route payloads stable while server data sources evolve.',
          'Route-loader discipline avoids ad hoc client fetch waterfalls.',
          'Review pages are organized around operator decisions, not raw entities.',
        ],
        reuseNow: ['typed contracts', 'screen-oriented payloads', 'route-loader discipline'],
        stack: 'Fastify + React + Vite + typed contracts',
      },
      {
        name: 'Static Review Packets',
        path: resolve(bulkDir, 'pending_catalog_update_candidates_review_package'),
        patterns: [
          'Generated HTML, JSON, and CSV artifacts already capture the workspace habit of shipping evidence with the recommendation.',
          'Source-linked detail siblings are the right pattern for promo evidence too.',
          'Artifacts are a good first manifest source while live adapters are still being confirmed.',
        ],
        reuseNow: ['artifact source linking', 'detail packet references', 'generated snapshot mentality'],
        stack: 'Python-generated HTML + JSON + CSV packets',
      },
    ],
    implementationPhases: [
      {
        label: 'Phase 0 - scaffold',
        deliverables: [
          'App shell, typed contracts, and route-loader pages for dashboard, proposals, promos, and performance.',
          'A read-only server surface that can evolve without rewriting client navigation.',
        ],
      },
      {
        label: 'Phase 1 - generated manifests',
        deliverables: [
          'Snapshot generator that reads current promo scripts, banner artifacts, docs, and HAR captures into one manifest file.',
          'Server routes that now load the generated manifest instead of hand-authored TypeScript objects.',
        ],
      },
      {
        label: 'Phase 2 - richer evidence adapters',
        deliverables: [
          'Expand the saved inventory/sellthrough snapshot coverage beyond MFNY and Velocity so proposal detail stays source-backed across more promo families.',
          'Promote confirmed Cube/HAR surfaces into live server-side performance adapters.',
        ],
      },
      {
        label: 'Phase 3 - operator hardening',
        deliverables: [
          'Add saved review state only if operators truly need persistence or mutations.',
          'Lift stable promo review routes into the eventual consolidated internal app.',
        ],
      },
    ],
    keyMetrics: [
      {
        detail:
          'The generator currently reads the handoff note, four live promo scripts, one saved promo metadata snapshot, one saved inventory/sellthrough snapshot, one saved selector-validity audit, two banner result JSONs, one direct banner readback artifact, one promo Cube HAR, and the marketing docs.',
        label: 'Normalized sources',
        value: '12 artifact families',
      },
      {
        detail: 'Current manifest coverage is grounded in FourTwenty26, Priced To Move, Velocity Boosters, and Fresh & Intense instead of abstract placeholders.',
        label: 'Live promo anchors',
        value: '4 promo families',
      },
      {
        detail: 'The saved inventory snapshot now keeps reusable per-action buy/get selector pools across the tracked queue so live promo detail can render exact SKU evidence instead of falling back to selector counts alone.',
        label: 'Inventory-backed actions',
        value: formatCount(trackedInventoryActions),
      },
      {
        detail:
          remainingSelectorIssues === 0
            ? 'The saved selector audit now confirms that every audited action across FourTwenty26, Priced To Move, Velocity Boosters, and Fresh & Intense reads back with All stores distribution level.'
            : 'The saved selector audit still shows at least one action whose selector distribution level needs repair before that promo shape is trustworthy.',
        label: 'Selector validity audit',
        value:
          remainingSelectorIssues === 0
            ? `${formatCount(auditedActionCount)} / ${formatCount(auditedActionCount)} valid`
            : `${formatCount(remainingSelectorIssues)} issue${remainingSelectorIssues === 1 ? '' : 's'} open`,
      },
      {
        detail: 'Latest Midtown direct readback proves 12 Velocity banners remain gated at 0 duration while 4 Fresh & Intense banners are healthy and enabled.',
        label: 'Screen asset proof',
        value: '16 promo-backed banners',
      },
      {
        detail: 'The direct promo-effectiveness HAR already contains 52 cube rows, with 6 named promo/fulfillment aggregates worth surfacing now.',
        label: 'Performance snapshot',
        value: `${promoCube.totalRows} captured rows`,
      },
    ],
    overview:
      'Promo Ops now reads from a generated manifest assembled from real workspace artifacts, which makes the app a durable bridge between one-off promo scripts, banner operations, and the future live analytics adapters.',
  }
}

function buildMfnyProposal(
  todoText: string,
  promoMetadata: PromoMetadataSnapshot,
  inventorySnapshot: PromoInventorySellthroughSnapshot,
): ProposalDetailResponse {
  const bronxMfny = requireMetadataAction(
    promoMetadata,
    'bronx',
    '12743',
    '42238',
    'Bronx FourTwenty26 MFNY',
  )
  const midtownMfny = requireMetadataAction(
    promoMetadata,
    'midtown',
    '12742',
    '42239',
    'Midtown FourTwenty26 MFNY',
  )
  const bronxSelectorCount = bronxMfny.action.buySelector?.productCount ?? 0
  const midtownSelectorCount = midtownMfny.action.buySelector?.productCount ?? 0
  const bronxGetMode = bronxMfny.action.getSelector?.applicationMode?.name ?? 'Not captured'
  const midtownGetMode = midtownMfny.action.getSelector?.applicationMode?.name ?? 'Not captured'
  const bronxInventory = requireMfnyInventorySite(inventorySnapshot, 'bronx')
  const midtownInventory = requireMfnyInventorySite(inventorySnapshot, 'midtown')
  const bronxWos = maxWeeksOfSupply(bronxInventory.qualifyingProducts)
  const midtownWos = maxWeeksOfSupply(midtownInventory.qualifyingProducts)
  requireTodoEvidence(
    todoText,
    /no Bronx on-hand rows for `MFNY`, `Presidential`, or `Dumbo Electric`/,
    'Bronx MFNY placeholder inventory signal',
  )
  requireTodoEvidence(
    todoText,
    /Midtown in-stock inventory did return active on-hand rows for `MFNY` across multiple lanes/,
    'Midtown MFNY placeholder inventory signal',
  )

  return {
    detailSections: {
      genesis: {
        entries: [
          {
            detail: 'The original FourTwenty26 placeholder actions were replaced in place in both site-owned campaigns so later refinements can preserve the same action IDs.',
            label: 'Placeholder replacement',
          },
          {
            detail: 'The description update pass locked in customer-facing copy that promises the same item on the second unit.',
            label: 'Copy finalized',
          },
          {
            detail: 'Bronx action 42238 was then enabled after site-scoped verification confirmed the Bronx campaign/action ownership.',
            label: 'Launch pass',
          },
        ],
        headline: 'This proposal is a refinement of a live offer whose payload shape is already proven safe in Sweed.',
        title: 'Genesis',
      },
      inventory: {
        bullets: [
          `The saved inventory/sellthrough snapshot now shows ${formatCount(bronxInventory.summary.qualifyingSkuCount ?? 0)} Bronx MFNY SKUs on hand and ${formatCount(midtownInventory.summary.qualifyingSkuCount ?? 0)} Midtown SKUs on hand instead of relying only on the earlier placeholder sweep note.`,
          `Sellthrough coverage is intentionally partial and explicit: reorder matched ${formatCount(bronxInventory.summary.sellthroughMatchedSkuCount ?? 0)} Bronx MFNY rows and ${formatCount(midtownInventory.summary.sellthroughMatchedSkuCount ?? 0)} Midtown rows, while the remaining SKUs stay visible with blank WOS rather than an invented zero.`,
          `Saved selector metadata now shows the Bronx get selector still reading ${bronxGetMode}, while Midtown reads ${midtownGetMode}; the semantic question is no longer abstract, it is now a cross-store parity check.`,
        ],
        headline: 'The selector remains broad at the brand level in both stores, but the saved snapshot now makes the current in-stock MFNY assortment concrete enough to review SKU by SKU and compare the saved get-side mode.',
        stats: [
          {
            detail: 'Enabled Bronx readback populated selector productCount after the launch pass.',
            label: 'Bronx eligible count',
            value: formatCount(bronxSelectorCount),
          },
          {
            detail: 'Midtown enabled readback confirmed the same broad MFNY selector cardinality.',
            label: 'Midtown eligible count',
            value: formatCount(midtownSelectorCount),
          },
          {
            detail: 'Saved grouped inventory rows now show the exact Bronx MFNY in-stock scope that the live broad selector could discount today.',
            label: 'Bronx in-stock now',
            value: `${formatCount(bronxInventory.summary.qualifyingSkuCount ?? 0)} SKUs / ${formatQuantity(bronxInventory.summary.qualifyingUnits ?? null)} units`,
          },
          {
            detail: 'Midtown still carries the materially broader current MFNY in-stock pool according to the saved grouped inventory snapshot.',
            label: 'Midtown in-stock now',
            value: `${formatCount(midtownInventory.summary.qualifyingSkuCount ?? 0)} SKUs / ${formatQuantity(midtownInventory.summary.qualifyingUnits ?? null)} units`,
          },
          {
            detail: 'Saved promo metadata now captures the cross-store difference in the get-side selector application mode.',
            label: 'Get-side mode parity',
            value: `Bronx ${bronxGetMode} / Midtown ${midtownGetMode}`,
          },
        ],
        tables: [buildMfnyInventoryTable(bronxInventory), buildMfnyInventoryTable(midtownInventory)],
        title: 'Inventory and scope',
      },
      margin: {
        bullets: [
          'The pricing risk is still semantic, not technical: a broader mix-and-match scope can unintentionally discount premium MFNY items against cheaper qualifying buys.',
          'Even before cost joins land, the page can now show exact saved WOS and expected sellout dates for the subset of in-stock MFNY SKUs that also surfaced in reorder, which is already more trustworthy than a selector count alone.',
          'Rows missing from reorder are a real coverage gap, not a hidden assumption; the snapshot keeps them visible so the operator can see which products still need a better sellthrough adapter.',
        ],
        headline: 'The BOGO shape is valid already; the saved WOS rows now narrow the margin question to the SKUs that are actually on hand and slow enough to matter.',
        stats: [
          {
            detail: 'The live safe shape keeps the discount in discountAmounts rather than top-level discountPercent.',
            label: 'Discount payload',
            value: '30% off second item',
          },
          {
            detail: 'When both items have the same price, the saved BOGO behaves like a 15% blended discount across the pair.',
            label: 'Equal-price basket effect',
            value: '15% blended discount',
          },
          {
            detail: 'The longest saved MFNY sellthrough horizon currently visible in reorder is already long enough to justify deeper review before broad mix-and-match discounting is left untouched.',
            label: 'Slowest saved WOS',
            value:
              bronxWos !== null || midtownWos !== null
                ? formatWeeksOfSupply(Math.max(bronxWos ?? 0, midtownWos ?? 0))
                : 'Not captured yet',
          },
          {
            detail: 'Workspace pricing heuristics still target roughly 55%-65% GM unless a below-competitor case is explicitly justified.',
            label: 'GM target band',
            value: '55%-65%',
          },
        ],
        tables: [],
        title: 'Margin and pricing',
      },
      marketSupport: {
        bullets: [
          'Join statewide Lit Alerts MFNY clusters into this page once price-comp normalization exists so selector tightening and market support stay on the same screen.',
          'Keep external market support separate from selector safety; strong market evidence still does not prove a same-item expression is Sweed-safe.',
          'Internal MFNY sellthrough, aged inventory, and replenishment risk should sit beside the market comp layer rather than in a separate workbook.',
        ],
        headline: 'Market evidence belongs on the proposal page too, but the first current blocker is still selector semantics.',
        title: 'Market data support',
      },
      rationale: {
        bullets: [
          'The current BOGO payload is already live and validated, so this is a precision edit rather than a risky re-launch.',
          `The saved metadata now narrows the review question: should Bronx be lifted to Midtown's ${midtownGetMode} get-side shape, or do both stores still need a different explicit same-item expression?`,
          'If exact same-item matching is not safely expressible, the operator surface should make the fallback interpretation explicit before another live edit.',
        ],
        headline: 'The goal is semantic trust and promotional precision, not a pricing rewrite or a new promo row.',
        title: 'Why this makes sense',
      },
      schedulePlan: {
        bullets: [
          'Re-read Bronx and Midtown dealer contexts separately before any selector change.',
          'Resolve the existing site-owned campaign/action rows from store.promo.campaign.list and store.promo.action.list rather than trusting readable IDs alone.',
          'If the selector expression changes, explicitly restore the intended enabled state after the edit and verify productCount again from the active site context.',
        ],
        headline: 'This should stay an in-place selector refinement under the existing FourTwenty26 action IDs.',
        title: 'Schedule and promotion plan',
      },
    },
    openQuestions: [
      'What exact Sweed-safe selector expression enforces same-item semantics without breaking the currently valid live BOGO shape?',
      'If exact same-item is not safely expressible, is the acceptable fallback a tighter family/size match or revised customer-facing copy?',
    ],
    proposal: {
      id: 'mfny-same-item-refinement',
      keyStats: [
        {
          detail: 'Enabled Bronx and Midtown readback both show broad MFNY brand qualification instead of exact same-item matching.',
          label: 'Current selector scope',
          value: `${formatCount(bronxSelectorCount)} MFNY items`,
        },
        {
          detail: 'The saved inventory snapshot now shows the exact current MFNY in-stock scope per store instead of only the earlier placeholder note.',
          label: 'Current in-stock scope',
          value: `${formatCount(bronxInventory.summary.qualifyingSkuCount ?? 0)} Bronx / ${formatCount(midtownInventory.summary.qualifyingSkuCount ?? 0)} Midtown SKUs`,
        },
        {
          detail: 'The saved metadata no longer shows identical get-side selector modes across both stores.',
          label: 'Mode mismatch',
          value: `Bronx ${bronxGetMode} / Midtown ${midtownGetMode}`,
        },
        {
          detail: 'The promo payload itself is already proven live-safe; the question is now a selector-design question.',
          label: 'Payload status',
          value: 'Live-safe BOGO',
        },
      ],
      nextAction: 'Confirm a Sweed-safe same-item selector strategy before editing the live FourTwenty26 selectors again.',
      promoType: 'BOGO percent discount',
      status: 'Needs selector design',
      stores: 'Bronx + Midtown',
      synopsis:
        'The live MFNY FourTwenty26 copy promises the same item on the second unit, and the saved snapshot now shows both the real in-stock SKU scope and a cross-store get-side mode mismatch that should drive the next selector review.',
      title: 'MFNY same-item refinement',
    },
    sources: [
      makeSource(
        'Placeholder replacement script',
        'Current FourTwenty26 action names, descriptions, and selector intent were saved in place here.',
        sourcePaths.fourTwenty26Replacement,
      ),
      makeSource(
        'Description update script',
        'Customer-facing MFNY and Dumbo copy was finalized here.',
        sourcePaths.fourTwenty26Descriptions,
      ),
      makeSource(
        'Bronx launch script',
        'Bronx enable-state change was executed here after site-scoped verification.',
        sourcePaths.enableBronxFourTwenty26,
      ),
      makeSource(
        'Current handoff note',
        'Latest selector counts, enabled state, and open product question live here.',
        sourcePaths.agentTodo,
      ),
      makeSource(
        'Promo metadata snapshot',
        'Current FourTwenty26 campaign and action schedule metadata are captured here from site-scoped reads.',
        sourcePaths.promoMetadataSnapshot,
      ),
      makeSource(
        'Inventory and sellthrough snapshot',
        'Current in-stock MFNY rows plus joined reorder velocity were captured here with the same site-scoped dealer discipline.',
        sourcePaths.promoInventorySellthroughSnapshot,
      ),
      makeSource(
        'Promo behavior reference',
        'Workspace rules for promo verification and BOGO payload shape are documented here.',
        sourcePaths.eventAndPromoDocs,
      ),
    ],
  }
}

function buildVelocityThresholdProposal(
  velocityStats: PromoBannerStats,
  bannerReadback: BannerReadback,
  inventorySnapshot: PromoInventorySellthroughSnapshot,
): ProposalDetailResponse {
  const velocityInventory = inventorySnapshot.velocityMidtown
  const qualifyingSkuCount = velocityInventory.summary.qualifyingSkuCount ?? 0
  const qualifyingUnits = velocityInventory.summary.qualifyingUnits ?? 0
  const closestThresholdGap = velocityInventory.summary.closestDaysUntilThreshold ?? null
  return {
    detailSections: {
      genesis: {
        entries: [
          {
            detail: 'The Bronx Velocity Boosters pattern was copied into Midtown with normalized age tiers instead of a raw one-to-one clone.',
            label: 'Campaign copy',
          },
          {
            detail: 'The Midtown Priced to MOVE image banners were rebound to the new promo actions across four screens.',
            label: 'Screen rebinding',
          },
          {
            detail: 'Direct banner readback later confirmed the promo-backed banners still have zero duration because no current inventory qualifies.',
            label: 'Readback confirmation',
          },
        ],
        headline: 'This proposal is about deciding whether the current age-gated configuration should wait for inventory to age in or be adjusted with better evidence.',
        title: 'Genesis',
      },
      inventory: {
        bullets: [
          `The saved item-age snapshot now confirms ${formatCount(qualifyingSkuCount)} qualifying Midtown SKUs and ${formatQuantity(qualifyingUnits)} qualifying units across all three Velocity tiers, which is the same concrete answer the zero-duration banners were hinting at from the merchandising side.`,
          'Because the grouped inventory rows include per-item dateTimeReceived, the empty tier tables below are derived from true receipt-age evidence rather than guesswork from selector counts or stale placeholder notes.',
          'The closest upcoming products table keeps the near-threshold rows visible so operators can see whether inventory is simply too fresh or whether the tiers are misaligned with current movement.',
        ],
        headline: 'Velocity Boosters is already fully wired through promos and banners, and the saved inventory snapshot now proves the current qualifying pool is empty rather than merely hidden.',
        stats: [
          {
            detail: 'Three Velocity tiers were rebound across four Midtown screens.',
            label: 'Promo-backed banners',
            value: formatCount(velocityStats.totalBannerCount),
          },
          {
            detail: 'Every current readback row still shows totalDuration = 0, which matches the empty saved qualifying tier tables below.',
            label: 'Healthy banners',
            value: `${formatCount(velocityStats.enabledBannerCount)} / ${formatCount(velocityStats.totalBannerCount)}`,
          },
          {
            detail: `The saved grouped inventory snapshot scanned ${formatCount(velocityInventory.groupedInventoryTotalRows)} Midtown grouped rows and found no item-aged inventory inside the current Velocity thresholds.`,
            label: 'Qualifying rows now',
            value: `${formatCount(qualifyingSkuCount)} SKUs / ${formatQuantity(qualifyingUnits)} units`,
          },
          {
            detail: `Latest direct readback was captured at ${bannerReadback.readAt}, and the saved inventory snapshot shows how far current rows still are from the first >30-day tier.`,
            label: 'Closest threshold gap',
            value: closestThresholdGap === null ? 'Not captured' : `${closestThresholdGap.toFixed(1)} days`,
          },
        ],
        tables: [
          ...velocityInventory.tiers.map((tier) => buildVelocityTierTable(tier)),
          buildVelocityApproachingTable(velocityInventory),
        ],
        title: 'Qualifying inventory',
      },
      margin: {
        bullets: [
          'Because the discount depth is modest, the GM question is mostly whether the targeted aged inventory really needs that discount to move once it actually exists in the saved qualifying pool.',
          'The new snapshot already joins reorder velocity onto the closest upcoming rows, so operators can see whether inventory is likely to sell before it ever reaches the >30-day tier.',
          'A future refinement should still add cost and discounted-GM math, but the app no longer needs to guess whether the current configuration is failing because of selector wiring or because the shelf-age pool is empty.',
        ],
        headline: 'This remains a clearance-control problem, but the saved snapshot now proves the immediate issue is inventory age, not broken promo plumbing.',
        stats: [
          {
            detail: 'The current Midtown tiers mirror the copied Velocity structure.',
            label: 'Discount tiers',
            value: '5% / 10% / 15%',
          },
          {
            detail: 'Each threshold step increases pressure by a clean five-point discount increment.',
            label: 'Tier spread',
            value: '5-point steps',
          },
          {
            detail: 'The saved approaching rows can already forecast whether the first qualifying products look genuinely slow or merely too fresh for the current gate.',
            label: 'Sellthrough adapter status',
            value: 'Joined to approaching rows',
          },
          {
            detail: 'Workspace pricing heuristics still expect review against the 55%-65% GM band when inventory and cost data are joined.',
            label: 'GM review band',
            value: '55%-65%',
          },
        ],
        tables: [],
        title: 'Margin and relief',
      },
      marketSupport: {
        bullets: [
          'This proposal is primarily internally driven by aged inventory pressure, but market comps can still confirm whether the discounted prices stay directionally sane.',
          'Future proposal detail should make it obvious when a promo is inventory-remediation first and market-response second.',
          'Keep external market context, internal inventory pressure, and banner-readiness evidence in one drill-in instead of splitting them across scripts and notes.',
        ],
        headline: 'External market comp is secondary here; the first proof point is whether Midtown has enough aging inventory to justify the thresholds as configured.',
        title: 'Market data support',
      },
      rationale: {
        bullets: [
          'Velocity Boosters is already the clearest current example of promo logic and merchandising assets moving together.',
          'The app should help operators decide whether to wait, re-threshold, or widen categories based on evidence instead of guesswork.',
          'Zero-duration banners are a useful signal, not a nuisance; they show the promo is wired correctly but inventory is not there yet.',
        ],
        headline: 'This is the right proving case for proposal review because it connects selector design, banner health, inventory age, and discount depth.',
        title: 'Why this makes sense',
      },
      schedulePlan: {
        bullets: [
          'Keep the current zero-duration banners disabled until a fresh readback shows real payload duration.',
          'Capture a Midtown aged-inventory snapshot before changing thresholds so the proposal is evidence-backed.',
          'If the user wants a live threshold change later, re-read Midtown campaign 12748 and actions 42260-42262 immediately before editing.',
        ],
        headline: 'The next operational step is evidence capture, not another blind selector edit.',
        title: 'Schedule and promotion plan',
      },
    },
    openQuestions: [
      'Should Velocity Boosters wait for qualifying inventory to age in, or should the thresholds be revisited with a fresh Midtown inventory snapshot?',
      'When sellthrough data lands, should this page forecast banner health as well as units moved so operators can see when screens should wake up?',
    ],
    proposal: {
      id: 'velocity-boosters-threshold-review',
      keyStats: [
        {
          detail: 'All 12 linked Midtown banners still read back at totalDuration = 0.',
          label: 'Screen readiness',
          value: `${formatCount(velocityStats.zeroDurationBannerCount)} / ${formatCount(velocityStats.totalBannerCount)} zero-duration`,
        },
        {
          detail: 'The current copied tier windows are >30/<61, >60/<91, and >90 days.',
          label: 'Aging windows',
          value: '3 non-overlapping tiers',
        },
        {
          detail: 'The saved item-age snapshot agrees with the banner readback: there are still no qualifying inventory rows under the current thresholds.',
          label: 'Inventory signal',
          value: `${formatCount(qualifyingSkuCount)} qualifying SKUs`,
        },
      ],
      nextAction: 'Use the saved approaching-threshold rows before deciding whether to keep or change the current Velocity thresholds.',
      promoType: 'Age-gated discount tiers',
      status: 'Needs threshold decision',
      stores: 'Midtown',
      synopsis:
        'Midtown Velocity Boosters is already wired through promo actions and product-menu banners, and the saved item-age snapshot now shows that no current Midtown inventory has actually crossed the configured shelf-age thresholds yet.',
      title: 'Velocity Boosters threshold review',
    },
    sources: [
      makeSource(
        'Velocity promo script',
        'The Midtown Velocity campaign, action thresholds, and copied selector logic were built here.',
        sourcePaths.velocityPromoScript,
      ),
      makeSource(
        'Velocity banner bind artifact',
        'The promo-backed Midtown banner replacement run and zero-duration outcomes are captured here.',
        sourcePaths.velocityBannerBind,
      ),
      makeSource(
        'Latest banner readback',
        'The post-refresh direct readback confirms the current disabled/zero-duration banner state.',
        sourcePaths.latestBannerReadback,
      ),
      makeSource(
        'Inventory and sellthrough snapshot',
        'Current Midtown item-age qualification and joined reorder velocity were captured here from read-only site-scoped inventory/report reads.',
        sourcePaths.promoInventorySellthroughSnapshot,
      ),
      makeSource(
        'Screen workflow reference',
        'The safe zero-duration rule and product-menu banner workflow are documented here.',
        sourcePaths.screensDoc,
      ),
    ],
  }
}

function buildBronxFourTwentySixPromo(
  promoMetadata: PromoMetadataSnapshot,
  inventorySnapshot: PromoInventorySellthroughSnapshot,
): ExistingPromoDetailResponse {
  const bronxMfny = requireMetadataAction(
    promoMetadata,
    'bronx',
    '12743',
    '42238',
    'Bronx FourTwenty26 MFNY',
  )
  const bronxInventory = requireMfnyInventorySite(inventorySnapshot, 'bronx')
  const bronxSelectorCount = bronxMfny.action.buySelector?.productCount ?? 0
  const bronxGetMode = bronxMfny.action.getSelector?.applicationMode?.name ?? 'Not captured'
  const promoWindow = describePromoWindow(bronxMfny.campaign, bronxMfny.action)
  const actionState = describeActionState(bronxMfny.campaign, bronxMfny.action)
  const bronxWos = maxWeeksOfSupply(bronxInventory.qualifyingProducts)

  return {
    linkedPlacements: [
      ...buildEcommercePlacementRows(bronxMfny.action),
      {
        detail: 'No normalized banner or screen artifact has been attached to this action yet.',
        slot: 'Product-menu banners',
        status: 'Not captured',
        surface: 'In-store screens',
      },
    ],
    performanceViewId: null,
    promo: {
      assetStatus: `${actionState} ecommerce placement metadata captured; no screen assets captured`,
      campaignName: 'FourTwenty26',
      id: 'bronx-fourtwenty26-mfny-42238',
      performanceStatus: 'Promo dashboard filter still pending',
      scheduleLabel: promoWindow,
      status: 'Live',
      store: 'Bronx',
      terminationDate: formatTerminationDate(bronxMfny.action.toDate ?? bronxMfny.campaign.toDate),
      title: 'Bronx MFNY 30% second item',
    },
    sections: {
      assets: {
        bullets: [
          'The workspace now captures saved action metadata for the ecommerce pricing row, discount menu, and homepage exposure rather than inferring those states from the edit script alone.',
          'No screen/banner artifact has been normalized for this action yet, so in-store merchandising still remains a real evidence gap.',
          'Promo Ops should eventually show ecommerce placements, homepage exposure, and in-store merchandising on the same detail page.',
        ],
        headline: 'FourTwenty26 now has source-backed ecommerce placement evidence, but not yet a normalized screen-asset packet.',
        stats: [
          {
            detail: 'Saved action metadata captures whether the promo surfaces directly on ecommerce pricing.',
            label: 'Promo pricing',
            value: bronxMfny.action.displayInEcommerceProducts ? 'Visible' : 'Hidden',
          },
          {
            detail: 'Saved action metadata captures the current discount-menu placement state.',
            label: 'Discount menu',
            value: describeDisplayType(bronxMfny.action.ecommerceDiscountMenuActionDisplayType),
          },
          {
            detail: 'Saved action metadata captures the current homepage placement state.',
            label: 'Homepage exposure',
            value: describeDisplayType(bronxMfny.action.ecommerceHomePageActionDisplayType),
          },
          {
            detail: 'No banner artifact has been wired into this action yet.',
            label: 'Screen assets',
            value: '0 captured',
          },
        ],
        tables: [],
        title: 'Merchandising assets',
      },
      copyAndSelectors: {
        bullets: [
          'The current live payload is a valid percent-discount BOGO; the unresolved issue is selector semantics rather than action-shape safety.',
          'The same-item promise in copy still deserves review because the saved selectors currently cover the broader MFNY brand set.',
        ],
        headline: 'Copy is customer-ready, but selector precision still matters because the current MFNY scope is broad.',
        stats: [
          {
            detail: 'Descriptions were updated to the final customer-facing wording on 2026-04-18.',
            label: 'Offer copy',
            value: 'Buy 1, get 2nd 30% off',
          },
          {
            detail: 'Both buy and get selectors currently cover MFNY brand scope rather than exact same-item matching.',
            label: 'Selector scope',
            value: 'MFNY brand-wide',
          },
          {
            detail: 'Saved promo metadata captured the current Bronx get-side selector application mode.',
            label: 'Get-side mode',
            value: bronxGetMode,
          },
          {
            detail: 'The saved promo metadata snapshot captures the current Bronx buy-selector productCount.',
            label: 'Known product count',
            value: formatCount(bronxSelectorCount),
          },
        ],
        tables: [],
        title: 'Copy and selectors',
      },
      inventoryAndSellthrough: {
        bullets: [
          'The saved inventory snapshot now lets this live promo page show the actual Bronx MFNY assortment on hand rather than only the broad selector count.',
          'Reorder coverage stays intentionally partial and explicit so the operator can tell which in-stock SKUs still lack a better sellthrough adapter.',
          'The inventory evidence reinforces the same-item review question instead of leaving selector semantics and current stock in separate places.',
        ],
        headline: 'The Bronx MFNY promo is live, and its detail page now carries the saved in-stock and sellthrough evidence for the actual Bronx MFNY pool.',
        stats: [
          {
            detail: 'Saved grouped inventory rows matching the current Bronx MFNY selector overlap.',
            label: 'Current in-stock scope',
            value: `${formatCount(bronxInventory.summary.qualifyingSkuCount ?? 0)} SKUs / ${formatQuantity(bronxInventory.summary.qualifyingUnits ?? null)} units`,
          },
          {
            detail: 'Current reorder join coverage for the Bronx MFNY rows on hand.',
            label: 'Sellthrough coverage',
            value: `${formatCount(bronxInventory.summary.sellthroughMatchedSkuCount ?? 0)} / ${formatCount(bronxInventory.summary.qualifyingSkuCount ?? 0)} rows`,
          },
          {
            detail: 'The broad selector count remains larger than the current in-stock saved Bronx assortment.',
            label: 'Eligible vs in-stock',
            value: `${formatCount(bronxSelectorCount)} eligible / ${formatCount(bronxInventory.summary.qualifyingSkuCount ?? 0)} on hand`,
          },
          {
            detail: 'The slowest saved Bronx MFNY row already visible in reorder.',
            label: 'Slowest saved WOS',
            value: formatWeeksOfSupply(bronxWos),
          },
        ],
        tables: [buildMfnyInventoryTable(bronxInventory)],
        title: 'Inventory and sellthrough',
      },
      performanceSummary: {
        bullets: [
          'The first direct promo dashboard for this action should relate attributed sales and discount dollars back to the selector semantics question.',
          'Until a direct FourTwenty26 performance capture exists, keep this page explicit that performance remains a planned adapter rather than a live metric source.',
        ],
        headline: 'Performance is still a known gap for this action, so the review surface should be honest about what is not yet measured.',
        stats: [
          {
            detail: 'No direct FourTwenty26 cube capture is normalized into the app yet.',
            label: 'Linked dashboard',
            value: 'Not yet captured',
          },
          {
            detail: 'A future detail page should show attributed net sales, units moved, and promo discount dollars for the MFNY set.',
            label: 'Best next KPI',
            value: 'Attributed net sales',
          },
          {
            detail: 'Performance context should stay tied to the same-item selector question rather than living in a separate report.',
            label: 'Current blocker',
            value: 'Promo filter not normalized',
          },
        ],
        tables: [],
        title: 'Performance summary',
      },
      schedule: {
        bullets: [
          'Review should stay site-scoped because campaign/action IDs can cross-read from the wrong dealer context.',
          'If another live pass is needed, re-read the Bronx campaign/action pair immediately before editing or enabling anything.',
        ],
        headline: 'The Bronx MFNY action is already live, and the schedule summary now comes from a saved site-scoped metadata capture instead of a script assumption.',
        stats: [
          {
            detail: 'Bronx site-owned FourTwenty26 campaign and MFNY action IDs from the metadata capture.',
            label: 'Campaign / action',
            value: `${bronxMfny.campaign.id} / ${bronxMfny.action.id}`,
          },
          {
            detail: 'Saved action metadata captured the current live start date for this offer window.',
            label: 'Window start',
            value: formatShortDate(bronxMfny.action.fromDate ?? bronxMfny.campaign.fromDate),
          },
          {
            detail: 'Saved action metadata captured the current live end-date state for this offer window.',
            label: 'Window end',
            value: formatTerminationDate(bronxMfny.action.toDate ?? bronxMfny.campaign.toDate),
          },
          {
            detail: 'Derived from the captured enabled state of the Bronx campaign and MFNY action.',
            label: 'Current state',
            value: actionState,
          },
        ],
        tables: [],
        title: 'Schedule and state',
      },
      siteVerification: {
        bullets: [
          'Always reset dealer context with store.auth.dealer.set before reading or writing this action.',
          'Verify campaign and action ownership through store.promo.campaign.list and store.promo.action.list before trusting store.promo.action.get.',
        ],
        headline: 'Site ownership is more important than readable IDs for promo review or mutation.',
        stats: [
          {
            detail: 'Live review and write work for this action belongs in the Bronx site dealer context.',
            label: 'Dealer context',
            value: 'Bronx 210249',
          },
          {
            detail: 'Known campaign/action IDs can cross-read across sites.',
            label: 'Verification path',
            value: 'Site lists first',
          },
          {
            detail: 'The workspace treats cross-read risk as an established fact, not a theoretical edge case.',
            label: 'Cross-read risk',
            value: 'Confirmed',
          },
        ],
        tables: [],
        title: 'Verification guardrails',
      },
    },
    sources: [
      makeSource(
        'Description update script',
        'Customer-facing MFNY copy was updated here.',
        sourcePaths.fourTwenty26Descriptions,
      ),
      makeSource(
        'Bronx launch script',
        'Bronx action enablement was executed here.',
        sourcePaths.enableBronxFourTwenty26,
      ),
      makeSource(
        'Current handoff note',
        'Latest live state and remaining selector question are preserved here.',
        sourcePaths.agentTodo,
      ),
      makeSource(
        'Promo metadata snapshot',
        'Current FourTwenty26 campaign and action schedule metadata are captured here from site-scoped reads.',
        sourcePaths.promoMetadataSnapshot,
      ),
      makeSource(
        'Inventory and sellthrough snapshot',
        'Current Bronx MFNY in-stock rows plus joined reorder velocity were captured here from read-only site-scoped inventory/report reads.',
        sourcePaths.promoInventorySellthroughSnapshot,
      ),
      makeSource(
        'Selector validity audit',
        'The saved audit artifact confirms the current All stores selector distribution state across the promo campaigns in this queue.',
        sourcePaths.promoSelectorDistributionAudit,
      ),
      makeSource(
        'Promo API reference',
        'Promo verification and action behavior rules are documented here.',
        sourcePaths.eventAndPromoDocs,
      ),
    ],
  }
}

function buildMidtownDumboPromo(
  promoMetadata: PromoMetadataSnapshot,
  inventorySnapshot: PromoInventorySellthroughSnapshot,
): ExistingPromoDetailResponse {
  const midtownDumbo = requireMetadataAction(
    promoMetadata,
    'midtown',
    '12742',
    '42242',
    'Midtown FourTwenty26 Dumbo Electric',
  )
  const dumboInventory = requireActionInventorySnapshot(
    inventorySnapshot,
    'midtown',
    '42242',
    'Midtown FourTwenty26 Dumbo Electric',
  )
  const promoWindow = describePromoWindow(midtownDumbo.campaign, midtownDumbo.action)
  const actionState = describeActionState(midtownDumbo.campaign, midtownDumbo.action)
  const dumboWos = maxPoolWeeksOfSupply(dumboInventory.getPool)

  return {
    linkedPlacements: [
      ...buildEcommercePlacementRows(midtownDumbo.action),
      {
        detail: 'No normalized Dumbo Electric screen/banner artifact has been attached to this action yet.',
        slot: 'Product-menu banners',
        status: 'Not captured',
        surface: 'In-store screens',
      },
    ],
    performanceViewId: null,
    promo: {
      assetStatus: `${actionState} ecommerce placement metadata captured; no screen assets captured`,
      campaignName: 'FourTwenty26',
      id: 'midtown-fourtwenty26-dumbo-42242',
      performanceStatus: 'Promo dashboard filter still pending',
      scheduleLabel: promoWindow,
      status: 'Live',
      store: 'Midtown',
      terminationDate: formatTerminationDate(midtownDumbo.action.toDate ?? midtownDumbo.campaign.toDate),
      title: 'Midtown Dumbo Electric $4.20 add-on',
    },
    sections: {
      assets: {
        bullets: [
          'Saved action metadata now captures the ecommerce pricing/menu/homepage placement state for this live FourTwenty26 action.',
          'No normalized screen/banner artifact has been attached yet, so in-store merchandising remains a true evidence gap rather than an implied healthy state.',
        ],
        headline: 'Midtown Dumbo Electric now has source-backed ecommerce placement evidence, but not yet a normalized screen packet.',
        stats: [
          {
            detail: 'Saved action metadata captures whether the promo surfaces directly on ecommerce pricing.',
            label: 'Promo pricing',
            value: midtownDumbo.action.displayInEcommerceProducts ? 'Visible' : 'Hidden',
          },
          {
            detail: 'Saved action metadata captures the current discount-menu placement state.',
            label: 'Discount menu',
            value: describeDisplayType(midtownDumbo.action.ecommerceDiscountMenuActionDisplayType),
          },
          {
            detail: 'Saved action metadata captures the current homepage placement state.',
            label: 'Homepage exposure',
            value: describeDisplayType(midtownDumbo.action.ecommerceHomePageActionDisplayType),
          },
          {
            detail: 'No banner artifact has been wired into this action yet.',
            label: 'Screen assets',
            value: '0 captured',
          },
        ],
        tables: [],
        title: 'Merchandising assets',
      },
      copyAndSelectors: {
        bullets: [
          'This is a fixed-price BOGO, so the operator review should keep the qualifying buy-side lane and the discounted Dumbo get-side lane distinct.',
          'The selector-distribution audit already confirmed this action now uses the required All stores selector distribution shape.',
        ],
        headline: 'The Dumbo Electric add-on is operationally simple, but the operator still needs the qualifying pre-roll lane and the discounted Dumbo lane on the same page.',
        stats: [
          {
            detail: 'Descriptions were updated to the final customer-facing wording during the FourTwenty26 replacement pass.',
            label: 'Offer copy',
            value: 'Buy any preroll, get Dumbo Electric for $4.20',
          },
          {
            detail: 'The buy selector remains the broad preroll lane, while the get selector stays on Dumbo Electric prerolls.',
            label: 'Selector split',
            value: 'Preroll trigger / Dumbo reward',
          },
          {
            detail: 'Saved promo metadata captures the current Dumbo get-side selector product count.',
            label: 'Discounted selector count',
            value: formatCount(midtownDumbo.action.getSelector?.productCount ?? 0),
          },
          {
            detail: 'This live action keeps the customer price on the BOGO discountAmounts payload rather than a top-level promoPrice field.',
            label: 'Discount payload',
            value: '$4.20 reward item',
          },
        ],
        tables: [],
        title: 'Copy and selectors',
      },
      inventoryAndSellthrough: {
        bullets: [
          'The expanded snapshot now shows both the current qualifying pre-roll buy-side pool and the current Dumbo Electric reward-side pool for this live action.',
          'Joined reorder coverage on the Dumbo reward rows stays explicit instead of hiding missing velocity behind a zero.',
          'Keeping the two pools separate makes it easier to judge whether the offer is constrained by reward inventory or simply by normal shopper traffic.',
        ],
        headline: 'Midtown Dumbo Electric now carries exact saved buy-side and reward-side inventory evidence instead of only a selector count.',
        stats: [
          {
            detail: 'Current Midtown in-stock rows that match the broad preroll trigger lane.',
            label: 'Trigger lane now',
            value: formatPoolScope(dumboInventory.buyPool),
          },
          {
            detail: 'Current Midtown in-stock rows that match the discounted Dumbo Electric reward lane.',
            label: 'Reward lane now',
            value: formatPoolScope(dumboInventory.getPool),
          },
          {
            detail: 'Saved reorder join coverage for the Dumbo reward-side rows currently on hand.',
            label: 'Reward sellthrough coverage',
            value: `${formatCount(dumboInventory.getPool?.summary.sellthroughMatchedSkuCount ?? 0)} / ${formatCount(dumboInventory.getPool?.summary.qualifyingSkuCount ?? 0)} rows`,
          },
          {
            detail: 'The slowest saved Dumbo reward row already visible in reorder.',
            label: 'Slowest reward WOS',
            value: formatWeeksOfSupply(dumboWos),
          },
        ],
        tables: [
          buildActionPoolTable(
            'Current qualifying preroll trigger rows',
            'Saved grouped inventory rows matching the buy-side preroll trigger lane are joined to store.reports.reorder by product id here so the operator can see the current size of the lane that can wake up this promo.',
            dumboInventory.buyPool,
            'No saved Midtown rows currently match the Dumbo buy-side trigger lane.',
          ),
          buildActionPoolTable(
            'Current Dumbo Electric reward rows',
            'Saved grouped inventory rows matching the Dumbo Electric reward lane are joined to store.reports.reorder by product id here so the discounted add-on stock can be reviewed directly.',
            dumboInventory.getPool,
            'No saved Midtown Dumbo Electric reward rows are currently on hand.',
          ),
        ],
        title: 'Inventory and sellthrough',
      },
      performanceSummary: {
        bullets: [
          'The first direct performance capture for this action should keep buy-side volume and reward-side movement together instead of looking only at aggregate promo totals.',
          'Until a direct FourTwenty26 promo slice exists, keep the page explicit that performance evidence is still pending even though inventory evidence is now real.',
        ],
        headline: 'Performance is still a planned adapter for this action, but the page no longer needs to guess at current inventory readiness.',
        stats: [
          {
            detail: 'No direct Dumbo Electric promo-effectiveness slice is normalized into the app yet.',
            label: 'Linked dashboard',
            value: 'Not yet captured',
          },
          {
            detail: 'A future detail page should compare attributed reward uptake to the current trigger-lane inventory on hand.',
            label: 'Best next KPI',
            value: 'Reward units redeemed',
          },
          {
            detail: 'The current missing surface is a promo-specific filter, not another inventory read.',
            label: 'Current blocker',
            value: 'Promo filter not normalized',
          },
        ],
        tables: [],
        title: 'Performance summary',
      },
      schedule: {
        bullets: [
          'Review should stay site-scoped because campaign/action IDs can still cross-read from the wrong dealer context.',
          'If another live pass is needed, re-read the Midtown campaign/action pair immediately before editing or enabling anything.',
        ],
        headline: 'The Midtown Dumbo Electric action is already live, and the schedule summary now comes from a saved site-scoped metadata capture instead of a script assumption.',
        stats: [
          {
            detail: 'Midtown site-owned FourTwenty26 campaign and Dumbo action IDs from the metadata capture.',
            label: 'Campaign / action',
            value: `${midtownDumbo.campaign.id} / ${midtownDumbo.action.id}`,
          },
          {
            detail: 'Saved action metadata captured the current live start date for this offer window.',
            label: 'Window start',
            value: formatShortDate(midtownDumbo.action.fromDate ?? midtownDumbo.campaign.fromDate),
          },
          {
            detail: 'Saved action metadata captured the current live end-date state for this offer window.',
            label: 'Window end',
            value: formatTerminationDate(midtownDumbo.action.toDate ?? midtownDumbo.campaign.toDate),
          },
          {
            detail: 'Derived from the captured enabled state of the Midtown campaign and Dumbo action.',
            label: 'Current state',
            value: actionState,
          },
        ],
        tables: [],
        title: 'Schedule and state',
      },
      siteVerification: {
        bullets: [
          'Always reset dealer context with store.auth.dealer.set before reading or writing this action.',
          'Verify campaign and action ownership through store.promo.campaign.list and store.promo.action.list before trusting store.promo.action.get.',
        ],
        headline: 'Site ownership is more important than readable IDs for promo review or mutation.',
        stats: [
          {
            detail: 'Live review and write work for this action belongs in the Midtown site dealer context.',
            label: 'Dealer context',
            value: 'Midtown 210705',
          },
          {
            detail: 'Known campaign/action IDs can cross-read across sites.',
            label: 'Verification path',
            value: 'Site lists first',
          },
          {
            detail: 'The selector audit already confirmed the current Midtown Dumbo selectors now read back at All stores distribution level.',
            label: 'Selector audit',
            value: 'All stores confirmed',
          },
        ],
        tables: [],
        title: 'Verification guardrails',
      },
    },
    sources: [
      makeSource(
        'Description update script',
        'Customer-facing Dumbo Electric copy was updated here.',
        sourcePaths.fourTwenty26Descriptions,
      ),
      makeSource(
        'FourTwenty26 replacement script',
        'The Midtown Dumbo action payload and selectors were finalized in place here.',
        sourcePaths.fourTwenty26Replacement,
      ),
      makeSource(
        'Promo metadata snapshot',
        'Current Midtown FourTwenty26 campaign and Dumbo action metadata are captured here from site-scoped reads.',
        sourcePaths.promoMetadataSnapshot,
      ),
      makeSource(
        'Inventory and sellthrough snapshot',
        'Current Midtown Dumbo buy-side and reward-side rows plus joined reorder velocity were captured here from read-only site-scoped inventory/report reads.',
        sourcePaths.promoInventorySellthroughSnapshot,
      ),
      makeSource(
        'Selector validity audit',
        'The saved audit artifact confirms the current All stores selector distribution state across the promo campaigns in this queue.',
        sourcePaths.promoSelectorDistributionAudit,
      ),
      makeSource(
        'Promo API reference',
        'Promo verification and FourTwenty26 behavior rules are documented here.',
        sourcePaths.eventAndPromoDocs,
      ),
    ],
  }
}

function buildPricedToMovePromo(
  promoMetadata: PromoMetadataSnapshot,
  inventorySnapshot: PromoInventorySellthroughSnapshot,
  selectorAudit: PromoSelectorAuditSnapshot,
  bannerReadback: BannerReadback,
  siteKey: 'bronx' | 'midtown',
): ExistingPromoDetailResponse {
  const isBronx = siteKey === 'bronx'
  const label = isBronx ? 'Bronx Priced To Move' : 'Midtown Priced To Move'
  const siteLabel = isBronx ? 'Bronx' : 'Midtown'
  const dealerName = isBronx ? 'Freshly Baked NYC - The Bronx' : 'Freshly Baked NYC - Midtown'
  const campaignId = isBronx ? '876' : '12747'
  const promoId = isBronx ? 'bronx-priced-to-move-876' : 'midtown-priced-to-move-12747'
  const detailTitle = isBronx ? 'Bronx Priced To Move' : 'Midtown Priced To Move staging set'
  const campaign = requireMetadataCampaign(promoMetadata, siteKey, campaignId, label)
  const auditCampaign = requireSelectorAuditCampaign(selectorAudit, siteKey, campaignId, label)
  const actions: PricedToMoveActionView[] = campaign.actions.map((action) => {
    const auditAction = auditCampaign.actions.find((entry) => entry.actionId === action.id)
    if (!auditAction) {
      throw new Error(
        `Unable to locate selector audit action ${action.id} for ${label} in ${sourcePaths.promoSelectorDistributionAudit}`,
      )
    }

    return {
      action,
      audit: auditAction,
      inventory: requireActionInventorySnapshot(inventorySnapshot, siteKey, action.id, `${label} ${action.name}`),
    }
  })

  const enabledCount = actions.filter((view) => view.action.enabled).length
  const inventoryPositiveActions = countInventoryPositiveActions(actions)
  const inventoryPositiveLanes = countInventoryPositiveLanes(actions)
  const groupedInventoryRows = actions[0]?.inventory.groupedInventoryTotalRows ?? 0
  const reorderRows = actions[0]?.inventory.reorderTotalRows ?? 0
  const directProductActions = countDirectProductActions(actions)
  const bundleActions = countBundleActions(actions)
  const ruleBasedActions = actions.length - directProductActions - bundleActions
  const pricingVisibleCount = countPricingVisibleActions(actions)
  const discountMenuVisibleCount = countDiscountMenuVisibleActions(actions)
  const homepageVisibleCount = countHomepageVisibleActions(actions)
  const clearedSelectorReports = countClearedSelectorReports(actions)
  const selectorReportCount = countSelectorReports(actions)
  const campaignState = describeCampaignActionState(campaign, campaign.actions)
  const directBannerPlacements = collectResolvedBannerPlacements(
    bannerReadback,
    promoMetadata,
    dealerName,
    { actionIds: actions.map((view) => view.action.id) },
  )
  const relatedNamedPlacements = collectResolvedBannerPlacements(
    bannerReadback,
    promoMetadata,
    dealerName,
    { bannerNameIncludes: 'priced to move' },
  )
  const relatedOtherPromoPlacements = relatedNamedPlacements.filter(
    (placement) => !actions.some((view) => view.action.id === placement.actionId),
  )
  const relatedOtherCampaignNames = Array.from(
    new Set(
      relatedOtherPromoPlacements
        .map((placement) => placement.campaignName)
        .filter((value): value is string => Boolean(value)),
    ),
  )
  const directBannerSummaryRow: PlacementRow = {
    detail:
      directBannerPlacements.length === 0
        ? `Latest direct banner readback found no ${siteLabel} screen rows linked to the ${siteLabel} Priced To Move action ids.`
        : `Latest direct banner readback found ${formatCount(directBannerPlacements.length)} ${siteLabel} banner row${directBannerPlacements.length === 1 ? '' : 's'} linked to the ${siteLabel} Priced To Move action ids.`,
    slot: 'Direct promo-linked banners',
    status: directBannerPlacements.length === 0 ? '0 captured' : `${formatCount(directBannerPlacements.length)} captured`,
    surface: 'In-store screens',
  }
  const relatedNamedSummaryRow: PlacementRow = {
    detail:
      relatedNamedPlacements.length === 0
        ? `No captured ${siteLabel} screen rows currently use the Priced to MOVE naming pattern.`
        : relatedOtherCampaignNames.length === 0
          ? `Captured ${formatCount(relatedNamedPlacements.length)} ${siteLabel} screen row${relatedNamedPlacements.length === 1 ? '' : 's'} using the Priced to MOVE naming pattern.`
          : `Captured ${formatCount(relatedNamedPlacements.length)} ${siteLabel} screen row${relatedNamedPlacements.length === 1 ? '' : 's'} using the Priced to MOVE naming pattern, but they currently belong to ${relatedOtherCampaignNames.join(', ')} instead of the copied Priced To Move family.`,
    slot: 'Same-name screen labels',
    status:
      relatedOtherCampaignNames.length === 0
        ? relatedNamedPlacements.length === 0
          ? 'None captured'
          : 'Family-owned labels'
        : `${relatedOtherCampaignNames.join(', ')} linked`,
    surface: 'In-store screens',
  }

  return {
    linkedPlacements: [
      ...buildNamedEcommercePlacementRows(actions),
      directBannerSummaryRow,
      relatedNamedSummaryRow,
    ],
    performanceViewId: isBronx ? null : 'midtown-promo-effectiveness-snapshot',
    promo: {
      assetStatus: `${formatCount(pricingVisibleCount)} ecommerce pricing rows captured; ${formatCount(directBannerPlacements.length)} direct banner links audited`,
      campaignName: campaign.name,
      id: promoId,
      performanceStatus: isBronx
        ? 'No direct promo metrics yet'
        : 'Cube proving snapshot exists, but not yet promo-filtered',
      scheduleLabel: `${describePromoWindow(campaign)}; ${campaignState.toLowerCase()}`,
      status: campaign.enabled ? (enabledCount === actions.length ? 'Live' : 'Mixed') : 'Staged',
      store: siteLabel,
      terminationDate: formatTerminationDate(campaign.toDate),
      title: detailTitle,
    },
    sections: {
      assets: {
        bullets: [
          'Priced To Move is no longer treated as having an implicit screen gap; the page now carries a direct-link banner audit so banner carryover can be reviewed explicitly during Bronx-to-Midtown promo copies.',
          'Keeping the full family on one page makes it obvious which actions still expose homepage placement and which ones are pricing-only.',
          relatedOtherCampaignNames.length === 0
            ? 'No same-name screen labels currently point somewhere else on this site, so the direct-link audit is the main banner signal to trust here.'
            : `The visible Priced to MOVE screen labels on this site currently belong to ${relatedOtherCampaignNames.join(', ')}, which is why name matching alone is not a safe proxy for promo ownership.`,
        ],
        headline: `${siteLabel} Priced To Move now keeps ecommerce placement evidence and banner carryover audit on the same family page instead of treating screens as an unspoken follow-up.`,
        stats: [
          {
            detail: 'Saved metadata rows where the promo surfaces directly on ecommerce pricing.',
            label: 'Promo pricing visible',
            value: `${formatCount(pricingVisibleCount)} / ${formatCount(actions.length)} actions`,
          },
          {
            detail: 'Saved metadata rows currently set to Show to all in the ecommerce discount menu.',
            label: 'Discount menu visible',
            value: `${formatCount(discountMenuVisibleCount)} / ${formatCount(actions.length)} actions`,
          },
          {
            detail: 'Only part of the family still uses homepage exposure.',
            label: 'Homepage visible',
            value: `${formatCount(homepageVisibleCount)} / ${formatCount(actions.length)} actions`,
          },
          {
            detail: 'Latest direct banner readback rows tied specifically to this family\'s action ids.',
            label: 'Direct family banner links',
            value: formatCount(directBannerPlacements.length),
          },
          {
            detail: 'Captured rows that still use the Priced to MOVE naming pattern on this site, regardless of which promo action currently owns them.',
            label: 'Same-name screen labels',
            value: formatCount(relatedNamedPlacements.length),
          },
        ],
        tables: [
          buildPricedToMoveAssetTable(actions),
          buildBannerCoverageAuditTable(siteLabel, directBannerPlacements, relatedNamedPlacements),
          buildResolvedBannerPlacementTable(
            `Current ${siteLabel} Priced to MOVE screen labels`,
            'These rows are name-related only; the linked promo column is the evidence-backed way to tell whether a visible banner belongs to this family or to a different promo set.',
            relatedNamedPlacements,
            `No current ${siteLabel} screen rows using the Priced to MOVE naming pattern were captured in the latest direct readback.`,
          ),
        ],
        title: 'Merchandising assets',
      },
      copyAndSelectors: {
        bullets: [
          'The family mixes direct-product markdowns, broader brand/category markdowns, and one bundle action, so a campaign page is the right review unit.',
          'The selector-distribution audit matters here because Priced To Move had several of the original Selected stores mistakes before the normalization pass.',
          'Keeping selector scope beside each offer name prevents the operator from treating every markdown as the same kind of promo.',
        ],
        headline: `${siteLabel} Priced To Move now exposes the full offer mix and selector shape in one saved table instead of leaving the family as an uninspected campaign shell.`,
        stats: [
          {
            detail: 'Two actions still resolve as direct-product markdowns, while the rest remain broader rule-based or bundle selectors.',
            label: 'Selector mix',
            value: `${formatCount(directProductActions)} direct / ${formatCount(ruleBasedActions)} rule-based / ${formatCount(bundleActions)} bundle`,
          },
          {
            detail: 'Every selector in the saved audit now reads back at the required All stores distribution level.',
            label: 'Distribution level',
            value: `${formatCount(clearedSelectorReports)} / ${formatCount(selectorReportCount)} clear`,
          },
          {
            detail: 'The family-level action state still matters because selectors can be valid even when actions are staged.',
            label: 'Enabled actions',
            value: `${formatCount(enabledCount)} / ${formatCount(actions.length)}`,
          },
          {
            detail: 'Selector mode is preserved action by action instead of being flattened into one family label.',
            label: 'Primary selector mode',
            value: actions[0] ? describeSelectorModes(actions[0]) : 'Not captured',
          },
        ],
        tables: [buildPricedToMoveSelectorTable(actions)],
        title: 'Copy and selectors',
      },
      inventoryAndSellthrough: {
        bullets: [
          'The saved action-level inventory snapshot currently resolves to zero qualifying on-hand rows across the entire Priced To Move family, and the page keeps that zero visible instead of hiding it.',
          'Because the family is now rendered from saved action snapshots rather than prose, later inventory reappearing will show up here without redesigning the page model.',
          'The grouped inventory and reorder row counts stay visible so operators can tell this was a real saved scan, not a missing capture.',
        ],
        headline: `${siteLabel} Priced To Move currently reads as a zero-inventory family in the saved snapshot, which makes this detail page a good operator checkpoint rather than a decorative card.`,
        stats: [
          {
            detail: 'Actions with any saved qualifying on-hand rows in the current snapshot.',
            label: 'Actions with inventory now',
            value: `${formatCount(inventoryPositiveActions)} / ${formatCount(actions.length)}`,
          },
          {
            detail: 'Buy/get selector lanes with current saved qualifying rows.',
            label: 'Inventory-positive lanes',
            value: `${formatCount(inventoryPositiveLanes)} / ${formatCount(selectorReportCount)}`,
          },
          {
            detail: 'Whole-store grouped inventory rows scanned for this saved site snapshot.',
            label: 'Grouped inventory scan',
            value: formatCount(groupedInventoryRows),
          },
          {
            detail: 'Whole-store reorder rows available for sellthrough joins in the same saved site snapshot.',
            label: 'Reorder rows',
            value: formatCount(reorderRows),
          },
        ],
        tables: [buildPricedToMoveInventoryTable(actions)],
        title: 'Inventory and sellthrough',
      },
      performanceSummary: {
        bullets: [
          'The next useful performance surface for this family is still a promo-filtered cube adapter rather than another inventory capture.',
          'For Midtown, the current proving snapshot is still worth linking because it keeps the future query path concrete even before Priced To Move filters are normalized.',
          'For Bronx, the honest state is still that no direct Priced To Move metric slice has been captured yet.',
        ],
        headline: isBronx
          ? 'Performance for Bronx Priced To Move is still uncaptured in Promo Ops, so the page stays explicit about the missing metric layer.'
          : 'Midtown Priced To Move can at least point to the current promo-effectiveness proving capture, even though that cube slice is not yet filtered to this family.',
        stats: [
          {
            detail: 'This family still needs promo-name or action-level cube filtering before it can graduate from evidence page to real dashboard.',
            label: 'Direct dashboard',
            value: isBronx ? 'Not yet captured' : 'Proving snapshot only',
          },
          {
            detail: 'A future adapter should answer whether these markdowns are actually moving the intended stale inventory lanes.',
            label: 'Best next KPI',
            value: 'Attributed units moved',
          },
          {
            detail: 'The blocker is query/filter confirmation, not another page-model change.',
            label: 'Current blocker',
            value: 'Promo filter not normalized',
          },
        ],
        tables: [],
        title: 'Performance summary',
      },
      schedule: {
        bullets: [
          'Review should stay site-scoped because campaign and action IDs can still cross-read from the wrong dealer context.',
          isBronx
            ? 'Bronx now shows why a family page matters: one Enigma bundle remains live while the rest of the markdown set is still staged under the same campaign.'
            : 'Midtown now shows why the family page still matters after the Velocity replacement pass: the staged Priced To Move copy is preserved in saved metadata even though the campaign is disabled.',
          'The saved family table is a better operator surface than manually reopening each action in Sweed just to confirm start dates and enablement.',
        ],
        headline: isBronx
          ? 'Bronx Priced To Move is partially live: the campaign is enabled and one action is on, while the rest of the family remains staged.'
          : 'Midtown Priced To Move is currently preserved as a staged family after the Velocity replacement pass, so the saved campaign view is the durable source of truth here.',
        stats: [
          {
            detail: 'Site-owned campaign id from the saved metadata snapshot.',
            label: 'Campaign',
            value: campaign.id,
          },
          {
            detail: 'Derived from the saved enabled state of the campaign plus all child actions.',
            label: 'Current state',
            value: campaignState,
          },
          {
            detail: 'The family currently contains five saved action rows under this site-owned campaign.',
            label: 'Action count',
            value: formatCount(actions.length),
          },
          {
            detail: 'Saved action windows currently start from the same September launch period for this family.',
            label: 'Window start',
            value: formatShortDate(campaign.fromDate),
          },
        ],
        tables: [buildPricedToMoveScheduleTable(actions, campaign)],
        title: 'Schedule and live state',
      },
      siteVerification: {
        bullets: [
          'Site ownership should still be verified from site-scoped campaign/action lists, not from action.get by id alone.',
          'The saved selector-audit artifact now preserves the all-clear state, so this family page can show selector validity without another live read.',
          'If a future live edit is needed, reset dealer context first and then re-verify this same campaign/action set under the active site dealer before touching any selector.',
        ],
        headline: `${siteLabel} Priced To Move now keeps the site-owned campaign scope and selector-audit outcome together, which closes the last major verification gap for this family inside Promo Ops.`,
        stats: [
          {
            detail: 'The saved metadata and action-inventory artifacts were captured in the site dealer context for this family.',
            label: 'Dealer context',
            value: `${actions[0]?.inventory.dealerName ?? siteLabel} (${actions[0]?.inventory.dealerId ?? 'not captured'})`,
          },
          {
            detail: 'All selector reports for this family currently read back clear in the saved audit artifact.',
            label: 'Selector audit',
            value: `${formatCount(clearedSelectorReports)} / ${formatCount(selectorReportCount)} clear`,
          },
          {
            detail: 'The site-scoped campaign snapshot still shows the full action count under this family.',
            label: 'Site-owned actions',
            value: formatCount(actions.length),
          },
          {
            detail: 'All remaining saved selector reports now read back at the required All stores distribution level.',
            label: 'Distribution',
            value: 'All stores',
          },
        ],
        tables: [buildPricedToMoveVerificationTable(actions, campaign)],
        title: 'Site verification and selector audit',
      },
    },
    sources: [
      makeSource(
        'Promo metadata snapshot',
        'Saved site-scoped campaign/action metadata for the Priced To Move family comes from this artifact.',
        sourcePaths.promoMetadataSnapshot,
      ),
      makeSource(
        'Inventory and sellthrough snapshot',
        'Saved action-level buy/get inventory pools for the Priced To Move family come from this artifact.',
        sourcePaths.promoInventorySellthroughSnapshot,
      ),
      makeSource(
        'Selector audit snapshot',
        'Saved selector-distribution validation for the Priced To Move family comes from this artifact.',
        sourcePaths.promoSelectorDistributionAudit,
      ),
      makeSource(
        isBronx ? 'Priced To Move copy script' : 'Velocity replacement script',
        isBronx
          ? 'This script is the saved local reference for copying the Bronx Priced To Move family forward into Midtown.'
          : 'This script is the saved local reference for why the Midtown Priced To Move family stayed as a preserved staging set after Velocity Boosters replaced it operationally.',
        isBronx ? sourcePaths.copyPricedToMoveBronxToMidtown : sourcePaths.velocityPromoScript,
      ),
      makeSource(
        'Latest banner readback',
        'Current direct banner ownership for Priced To Move and same-name screen labels is captured here.',
        sourcePaths.latestBannerReadback,
      ),
      makeSource(
        'Screen workflow reference',
        'The workspace rules for promo-backed banner replacement, zero-duration handling, and screen verification are documented here.',
        sourcePaths.screensDoc,
      ),
      makeSource(
        'Promo API reference',
        'Promo verification and selector-distribution rules for this family are documented here.',
        sourcePaths.eventAndPromoDocs,
      ),
    ],
  }
}

function buildVelocityPromo(
  velocityRun: VelocityBannerRun,
  velocityStats: PromoBannerStats,
  bannerReadback: BannerReadback,
  promoMetadata: PromoMetadataSnapshot,
  inventorySnapshot: PromoInventorySellthroughSnapshot,
): ExistingPromoDetailResponse {
  const totalScreenCount = velocityRun.screens.length
  const velocityCampaign = requireMetadataCampaign(
    promoMetadata,
    'midtown',
    '12748',
    'Midtown Velocity Boosters',
  )
  const velocityActions = ['42260', '42261', '42262'].map(
    (actionId) =>
      requireMetadataAction(
        promoMetadata,
        'midtown',
        '12748',
        actionId,
        'Midtown Velocity Boosters',
      ).action,
  )
  const velocityWindow = describePromoWindow(velocityCampaign, velocityActions[0])
  const velocityInventory = inventorySnapshot.velocityMidtown

  return {
    linkedPlacements: buildBannerPlacementRows(bannerReadback, 'Freshly Baked NYC - Midtown', [
      '42260',
      '42261',
      '42262',
    ]),
    performanceViewId: 'midtown-promo-effectiveness-snapshot',
    promo: {
      assetStatus: `${formatCount(velocityStats.totalBannerCount)} linked banners; ${formatCount(velocityStats.zeroDurationBannerCount)} still at 0s`,
      campaignName: 'Velocity Boosters',
      id: 'midtown-velocity-boosters-12748',
      performanceStatus: 'Cube capture exists, but not yet promo-filtered',
      scheduleLabel: `${velocityWindow} with >30 / >60 / >90 day selector windows`,
      status: 'Mixed',
      store: 'Midtown',
      terminationDate: formatTerminationDate(velocityActions[0].toDate ?? velocityCampaign.toDate),
      title: 'Midtown Velocity Boosters',
    },
    sections: {
      assets: {
        bullets: [
          'The promo-backed banners are linked correctly across all four Midtown screens, which means the remaining problem is qualifying inventory rather than broken banner wiring.',
          'The zero-duration rule is doing the right thing by leaving those banners disabled until they have real payload.',
        ],
        headline: 'Velocity Boosters already proves the promo-to-banner linkage, even though current inventory keeps the banners visually off.',
        stats: [
          {
            detail: 'Three tier banners were created on each of the four Midtown screens.',
            label: 'Linked banners',
            value: formatCount(velocityStats.totalBannerCount),
          },
          {
            detail: 'Latest direct readback still shows no healthy duration on any of the linked Velocity banners.',
            label: 'Healthy banners',
            value: `${formatCount(velocityStats.enabledBannerCount)} / ${formatCount(velocityStats.totalBannerCount)}`,
          },
          {
            detail: 'Every current Velocity banner row remains gated by totalDuration = 0.',
            label: 'Zero-duration rows',
            value: formatCount(velocityStats.zeroDurationBannerCount),
          },
        ],
        tables: [],
        title: 'Merchandising assets',
      },
      copyAndSelectors: {
        bullets: [
          'Selector category rules and shelf-age filterData must be reviewed together because the inventory behavior depends on both.',
          'Velocity Boosters is the clearest current example of why Promo Ops should expose promo logic and banner state on one page.',
        ],
        headline: 'The copied Midtown actions are simple percent-discount promos, but the real complexity sits in the age-gated selector rules.',
        stats: [
          {
            detail: 'The enabled Midtown action set remains the three familiar movers tiers.',
            label: 'Action set',
            value: velocityRun.enabledPromos.map((promo) => promo.actionId).join(' / '),
          },
          {
            detail: 'The current copied windows remain >30/<61, >60/<91, and >90 days.',
            label: 'Aging tiers',
            value: '30+ / 60+ / 90+',
          },
          {
            detail: 'The copied tiers are straight percent discounts rather than bundle-style promo prices.',
            label: 'Discount depth',
            value: '5% / 10% / 15%',
          },
        ],
        tables: [],
        title: 'Copy and selectors',
      },
      inventoryAndSellthrough: {
        bullets: [
          'The saved inventory snapshot now proves on the promo page itself that the current zero-duration banners reflect an empty qualifying pool rather than broken promo wiring.',
          'Closest-upcoming rows stay visible here so the operator can tell whether products are merely too fresh or whether the thresholds themselves need revision.',
          'Joined reorder coverage on the near-threshold rows already gives the page a first sellthrough view without waiting for a new performance adapter.',
        ],
        headline: 'Velocity Boosters now carries the same saved item-age evidence on its live promo page that originally powered the proposal review.',
        stats: [
          {
            detail: 'Current Midtown rows that truly satisfy the three saved age-gated selector windows.',
            label: 'Qualifying inventory',
            value: formatPoolScope({
              qualifyingProducts: [],
              summary: velocityInventory.summary,
            }),
          },
          {
            detail: 'Latest saved gap between current inventory and the first >30-day gate.',
            label: 'Closest threshold gap',
            value:
              velocityInventory.summary.closestDaysUntilThreshold === null ||
              velocityInventory.summary.closestDaysUntilThreshold === undefined
                ? 'Not captured'
                : `${velocityInventory.summary.closestDaysUntilThreshold.toFixed(1)} days`,
          },
          {
            detail: 'Current reorder join coverage sits on the saved approaching rows rather than inside the qualifying pool, because the qualifying pool is still empty.',
            label: 'Sellthrough adapter',
            value: 'Attached to approaching rows',
          },
        ],
        tables: [
          ...velocityInventory.tiers.map((tier) => buildVelocityTierTable(tier)),
          buildVelocityApproachingTable(velocityInventory),
        ],
        title: 'Inventory and sellthrough',
      },
      performanceSummary: {
        bullets: [
          'The linked performance view currently proves the cube shape, but it does not yet isolate Velocity Boosters itself.',
          'A future live adapter should compare discount dollars, units moved, and qualifying aged inventory by tier so operators can see whether the configuration is working.',
        ],
        headline: 'This promo has the right shape for a dashboard, but the current normalized performance evidence is still only a proving capture.',
        stats: [
          {
            detail: 'The current linked dashboard is a Midtown-wide promo-effectiveness capture rather than a Velocity-only filter.',
            label: 'Linked performance view',
            value: 'Proving snapshot',
          },
          {
            detail: 'Velocity review should eventually compare discount spend to units relieved from aging inventory.',
            label: 'Best next KPI',
            value: 'Units moved by tier',
          },
          {
            detail: 'Current banner evidence says the inventory side of the equation is still the main blocker.',
            label: 'Current blocker',
            value: 'No qualifying inventory',
          },
        ],
        tables: [],
        title: 'Performance summary',
      },
      schedule: {
        bullets: [
          'The campaign can remain enabled while zero-duration banner rows stay off, which is the safest current posture.',
          'Any future threshold edit should re-read the Midtown campaign and actions immediately before mutation.',
        ],
        headline: 'Velocity Boosters is live enough to review as an active promo system, and the saved metadata capture now anchors its schedule window instead of leaving that implied.',
        stats: [
          {
            detail: 'Midtown site-owned replacement campaign for the Bronx source logic.',
            label: 'Campaign',
            value: velocityCampaign.id,
          },
          {
            detail: 'The banner-bind run touched four Midtown screens.',
            label: 'Screens touched',
            value: formatCount(totalScreenCount),
          },
          {
            detail: 'Saved campaign metadata captured the current start date for the Velocity window.',
            label: 'Window start',
            value: formatShortDate(velocityActions[0].fromDate ?? velocityCampaign.fromDate),
          },
          {
            detail: 'Current page reflects the enabled campaign, enabled actions, and disabled zero-duration screen rows.',
            label: 'Current state',
            value: `${describeCampaignActionState(velocityCampaign, velocityActions)} + gated assets`,
          },
        ],
        tables: [],
        title: 'Schedule and state',
      },
      siteVerification: {
        bullets: [
          'Promo review and screen review both belong in the Midtown site context because each surface is site-owned.',
          'Keep the direct banner readback artifact linked from the promo so operators do not have to trust summary prose alone.',
        ],
        headline: 'Velocity Boosters mixes promo logic and screen state, so verification needs both the promo list context and the banner readback artifact.',
        stats: [
          {
            detail: 'Promo writes and screen operations for this promo were executed from the Midtown site dealer.',
            label: 'Dealer context',
            value: 'Midtown 210705',
          },
          {
            detail: 'The direct readback artifact is the authoritative proof of current banner health.',
            label: 'Banner verification',
            value: 'Direct readback JSON',
          },
          {
            detail: 'The safe banner rule in this workspace is to leave any totalDuration = 0 row disabled.',
            label: 'Asset safety rule',
            value: '0 duration stays off',
          },
        ],
        tables: [],
        title: 'Verification guardrails',
      },
    },
    sources: [
      makeSource(
        'Velocity promo script',
        'The Midtown Velocity campaign, action thresholds, and copied selector logic were built here.',
        sourcePaths.velocityPromoScript,
      ),
      makeSource(
        'Velocity banner bind artifact',
        'This artifact captured the promo-backed replacement of the Midtown Priced to MOVE image banners.',
        sourcePaths.velocityBannerBind,
      ),
      makeSource(
        'Latest banner readback',
        'Current Velocity banner duration and enabled-state proof lives here.',
        sourcePaths.latestBannerReadback,
      ),
      makeSource(
        'Promo metadata snapshot',
        'Current Midtown campaign and action schedule metadata are captured here from site-scoped reads.',
        sourcePaths.promoMetadataSnapshot,
      ),
      makeSource(
        'Inventory and sellthrough snapshot',
        'Current Midtown item-age qualification, approaching rows, and joined reorder velocity were captured here from read-only site-scoped inventory/report reads.',
        sourcePaths.promoInventorySellthroughSnapshot,
      ),
      makeSource(
        'Screen workflow reference',
        'The safe product-menu banner replacement and zero-duration rule are documented here.',
        sourcePaths.screensDoc,
      ),
    ],
  }
}

function buildFreshAndIntensePromo(
  freshRun: FreshAndIntenseRun,
  freshStats: PromoBannerStats,
  bannerReadback: BannerReadback,
  promoMetadata: PromoMetadataSnapshot,
  inventorySnapshot: PromoInventorySellthroughSnapshot,
): ExistingPromoDetailResponse {
  const freshPromo = requireMetadataAction(
    promoMetadata,
    'midtown',
    '12749',
    '42264',
    'Midtown Fresh & Intense',
  )
  const freshInventory = requireActionInventorySnapshot(
    inventorySnapshot,
    'midtown',
    '42264',
    'Midtown Fresh & Intense',
  )
  const freshPool = freshInventory.getPool
  const freshWos = maxPoolWeeksOfSupply(freshPool)

  return {
    linkedPlacements: buildBannerPlacementRows(bannerReadback, 'Freshly Baked NYC - Midtown', ['42264']),
    performanceViewId: null,
    promo: {
      assetStatus: `${formatCount(freshStats.enabledBannerCount)} healthy product-menu banners at ${formatCount(freshStats.totalDurationSeconds / Math.max(freshStats.enabledBannerCount, 1))}s each`,
      campaignName: freshRun.campaign.name,
      id: 'midtown-fresh-and-intense-42264',
      performanceStatus: 'No direct promo cube capture yet',
      scheduleLabel: describePromoWindow(freshPromo.campaign, freshPromo.action),
      status: 'Live',
      store: 'Midtown',
      terminationDate: formatTerminationDate(freshPromo.action.toDate ?? freshPromo.campaign.toDate),
      title: 'Midtown Fresh & Intense',
    },
    sections: {
      assets: {
        bullets: [
          'Fresh & Intense is the strongest current proof that a selector-driven promo can immediately translate into healthy product-menu screen content.',
          'Because all four replacement banners are healthy, this page can already show true asset readiness instead of only banner creation counts.',
        ],
        headline: 'This promo is already doing what Velocity Boosters still wants to do: drive healthy product-menu banners from a live selector-backed action.',
        stats: [
          {
            detail: 'One replacement product-menu banner now runs on each Midtown screen in the captured set.',
            label: 'Healthy banners',
            value: formatCount(freshStats.enabledBannerCount),
          },
          {
            detail: 'Each replacement banner read back at a healthy 25-second duration.',
            label: 'Per-banner duration',
            value: '25 seconds',
          },
          {
            detail: `Latest direct readback was captured at ${bannerReadback.readAt}.`,
            label: 'Readback proof',
            value: '4 screens confirmed',
          },
        ],
        tables: [],
        title: 'Merchandising assets',
      },
      copyAndSelectors: {
        bullets: [
          'This is a non-discount loyalty-style action, so the operator review should focus on selector quality and merchandising health rather than promo math.',
          'The saved selector rules make the action a clean proving case for future proposal evidence around new arrivals and potency thresholds.',
        ],
        headline: 'Fresh & Intense shows that selector-driven merchandising can still be powerful even when the action is not a classic discount promo.',
        stats: [
          {
            detail: 'The action read back immediately with live qualifying products.',
            label: 'Selector product count',
            value: formatCount(freshRun.action.selectorProductCount),
          },
          {
            detail: 'The working filter remains shelf_time_in_days < 15 plus thc > 40.',
            label: 'Filter rules',
            value: '<15 days and THC > 40',
          },
          {
            detail: 'The action shape is loyalty-based rather than percent-discount or promo-price.',
            label: 'Action style',
            value: 'Selector-driven loyalty promo',
          },
        ],
        tables: [],
        title: 'Copy and selectors',
      },
      inventoryAndSellthrough: {
        bullets: [
          'The saved inventory snapshot now lets this live promo page show the exact current qualifying pool behind the healthy Fresh & Intense banners.',
          'Rows missing from reorder stay visible here so the operator can see which current New Arrivals products still need stronger sellthrough evidence.',
          'This is the clearest current example of a selector-driven promo whose inventory evidence and screen evidence already tell the same story on one page.',
        ],
        headline: 'Fresh & Intense now pairs healthy banner proof with a saved current-qualifier table for the New Arrivals selector itself.',
        stats: [
          {
            detail: 'Current Midtown grouped inventory rows matching the saved Fresh & Intense get-side selector.',
            label: 'Current qualifying scope',
            value: formatPoolScope(freshPool),
          },
          {
            detail: 'Saved reorder join coverage for the currently qualifying Fresh & Intense rows.',
            label: 'Sellthrough coverage',
            value: `${formatCount(freshPool?.summary.sellthroughMatchedSkuCount ?? 0)} / ${formatCount(freshPool?.summary.qualifyingSkuCount ?? 0)} rows`,
          },
          {
            detail: 'The saved live action readback showed 30 selector products, while the table below shows the current in-stock subset.',
            label: 'Selector vs on-hand',
            value: `${formatCount(freshRun.action.selectorProductCount)} selector / ${formatCount(freshPool?.summary.qualifyingSkuCount ?? 0)} on hand`,
          },
          {
            detail: 'The slowest saved qualifying Fresh & Intense row already visible in reorder.',
            label: 'Slowest saved WOS',
            value: formatWeeksOfSupply(freshWos),
          },
        ],
        tables: [
          buildActionPoolTable(
            'Current Fresh & Intense qualifying rows',
            'Saved grouped inventory rows matching the Fresh & Intense selector are joined to store.reports.reorder by product id here so the live screen success can be reviewed against real current SKU-level stock and sellthrough evidence.',
            freshPool,
            'No saved Midtown rows currently match the Fresh & Intense selector.',
          ),
        ],
        title: 'Inventory and sellthrough',
      },
      performanceSummary: {
        bullets: [
          'The next useful capture for this promo is a direct cube slice that can prove whether the selector-driven merchandising actually influences movement.',
          'Because this action is banner-first rather than discount-first, useful performance should likely include product impressions or attributable units rather than only discount dollars.',
        ],
        headline: 'Fresh & Intense is operationally healthy already, but performance evidence has not been normalized into Promo Ops yet.',
        stats: [
          {
            detail: 'No promo-effectiveness capture filtered to this action has been added to the manifest yet.',
            label: 'Direct dashboard',
            value: 'Pending capture',
          },
          {
            detail: 'Because the action already resolved products, a later dashboard should focus on what the screens helped move.',
            label: 'Best next KPI',
            value: 'Attributed units',
          },
          {
            detail: 'Performance data should stay attached to the same selector and asset proof visible on this page.',
            label: 'Current gap',
            value: 'No linked metrics yet',
          },
        ],
        tables: [],
        title: 'Performance summary',
      },
      schedule: {
        bullets: [
          'This campaign is already enabled and healthy enough that future review should focus more on refinement and proof than on launch mechanics.',
          'If a later change is needed, treat the campaign and action as site-owned Midtown records and re-verify them from the active dealer context first.',
        ],
        headline: 'Fresh & Intense is already in the state Promo Ops ultimately wants most promos to reach, and the saved metadata capture now anchors that current window explicitly.',
        stats: [
          {
            detail: 'Midtown current-store campaign created for the selector-driven New Arrivals concept.',
            label: 'Campaign',
            value: freshPromo.campaign.id,
          },
          {
            detail: 'The selector-backed Midtown action that powers the banners.',
            label: 'Action',
            value: freshPromo.action.id,
          },
          {
            detail: 'Saved campaign metadata captured the current start date for this selector-driven window.',
            label: 'Window start',
            value: formatShortDate(freshPromo.action.fromDate ?? freshPromo.campaign.fromDate),
          },
          {
            detail: 'Both the action and the replacement product-menu banners are currently enabled.',
            label: 'Current state',
            value: describeActionState(freshPromo.campaign, freshPromo.action),
          },
        ],
        tables: [],
        title: 'Schedule and state',
      },
      siteVerification: {
        bullets: [
          'Keep promo and screen review in the Midtown site context because both the action and the banners are Midtown-owned.',
          'Future refreshes should keep linking back to the direct banner readback artifact so banner health stays evidence-backed.',
        ],
        headline: 'Fresh & Intense is a good example of site-scoped promo verification and banner verification lining up cleanly.',
        stats: [
          {
            detail: 'The action and banner workflow were executed from the Midtown site context.',
            label: 'Dealer context',
            value: 'Midtown 210705',
          },
          {
            detail: 'Healthy banner duration is confirmed in the latest direct readback artifact.',
            label: 'Asset verification',
            value: 'Direct readback JSON',
          },
          {
            detail: 'This promo already demonstrates positive screen payload duration instead of 0-duration gating.',
            label: 'Current health',
            value: 'Healthy and enabled',
          },
        ],
        tables: [],
        title: 'Verification guardrails',
      },
    },
    sources: [
      makeSource(
        'Fresh & Intense banner replacement artifact',
        'Campaign, action, selector product count, and replacement banner results were captured here.',
        sourcePaths.freshAndIntenseScreens,
      ),
      makeSource(
        'Latest banner readback',
        'Current Fresh & Intense banner health can be re-verified from this direct readback artifact.',
        sourcePaths.latestBannerReadback,
      ),
      makeSource(
        'Promo metadata snapshot',
        'Current Midtown campaign and action schedule metadata are captured here from site-scoped reads.',
        sourcePaths.promoMetadataSnapshot,
      ),
      makeSource(
        'Inventory and sellthrough snapshot',
        'Current Midtown Fresh & Intense qualifying rows plus joined reorder velocity were captured here from read-only site-scoped inventory/report reads.',
        sourcePaths.promoInventorySellthroughSnapshot,
      ),
      makeSource(
        'Screen workflow reference',
        'The screen replacement and zero-duration rules are documented here.',
        sourcePaths.screensDoc,
      ),
      makeSource(
        'Promo API reference',
        'The Fresh & Intense action shape and site-scoped promo rules are documented here.',
        sourcePaths.eventAndPromoDocs,
      ),
    ],
  }
}

function buildPromoEffectivenessPerformance(promoCube: ReturnType<typeof parsePromoCubeCapture>): PerformanceDetailResponse {
  const [windowStart, windowEnd] = promoCube.query.timeDimensions[0]?.dateRange ?? ['Unknown', 'Unknown']
  const topPromo = promoCube.topPromos[0]
  const namedGrossMarginPercent = promoCube.namedNetSales
    ? (promoCube.namedGrossMargin / promoCube.namedNetSales) * 100
    : 0

  return {
    breakoutColumns: [
      { label: 'Promo' },
      { label: 'Fulfillment' },
      { label: 'Unique buyers' },
      { label: 'Quantity' },
      { label: 'Promo discount' },
      { label: 'Net sales' },
      { label: 'Gross margin %' },
    ],
    breakoutHeadline:
      'This table keeps only rows with a named promo, aggregated by promo and fulfillment type, so the page shows useful promo slices without pretending the unlinked rows are campaign data.',
    breakoutRows: promoCube.namedRows.map((row) => ({
      id: `${row.promoName}::${row.fulfillmentType}`,
      values: [
        simplifyPromoName(row.promoName),
        row.fulfillmentType,
        formatCount(row.buyers),
        formatCount(row.quantity),
        formatCurrency(row.promoDiscount),
        formatCurrency(row.netSales),
        formatPercent(row.netSales ? (row.grossMargin / row.netSales) * 100 : 0),
      ],
    })),
    breakoutTitle: 'Named promo performance by promo and fulfillment',
    dashboardModules: [
      {
        bullets: [
          'This first module should stay simple: prove that direct promo-effectiveness measures can be normalized and read without hand-assembling the cube response each time.',
          'Keep the summary tied to named promos only so the operator can quickly see the attributable slice before drilling into coverage gaps.',
        ],
        metrics: [
          {
            detail: 'Named promo rows only, excluding the null promo-name slice.',
            label: 'Named promo net sales',
            value: formatCurrency(promoCube.namedNetSales),
          },
          {
            detail: 'Total promoDiscount across named promo rows in the capture window.',
            label: 'Promo discount',
            value: formatCurrency(promoCube.namedPromoDiscount),
          },
          {
            detail: 'Gross margin divided by net sales across named promo rows.',
            label: 'Named gross margin %',
            value: formatPercent(namedGrossMarginPercent),
          },
        ],
        summary: 'The HAR already proves a useful top-line rollup for named promos.',
        title: 'Named promo rollup',
      },
      {
        bullets: [
          'Do not hide the null promo-name rows; they are the main reason this capture is a proving snapshot instead of a finished live dashboard.',
          'A future live adapter should prove the right filters before this page is trusted as a promo-complete report.',
        ],
        metrics: [
          {
            detail: 'These rows had no promoFullName even though they were returned in the same cube capture.',
            label: 'Unlinked rows',
            value: `${formatCount(promoCube.unlinkedRows)} of ${formatCount(promoCube.totalRows)}`,
          },
          {
            detail: 'Unlinked rows still carried substantial sales volume, so they cannot be treated as harmless noise.',
            label: 'Unlinked net sales',
            value: formatCurrency(promoCube.unlinkedNetSales),
          },
          {
            detail: 'Named promo rows are useful, but they are not yet the full commerce picture.',
            label: 'Current posture',
            value: 'Use as proof, not truth',
          },
        ],
        summary: 'Coverage gaps are part of the current story and should stay visible on the page.',
        title: 'Coverage gap',
      },
      {
        bullets: [
          'The next dashboard step after this proving snapshot is a filter-confirmed live query, not a prettier static mock.',
          'Operators will care most about the top named promo family and the heaviest discount family before they care about the full measure catalog.',
        ],
        metrics: [
          {
            detail: 'Highest named promo family by net sales in the captured window.',
            label: 'Top promo family',
            value: topPromo ? simplifyPromoName(topPromo.promoName) : 'Unknown',
          },
          {
            detail: 'Net sales attributed to the top named promo family.',
            label: 'Top promo sales',
            value: topPromo ? formatCurrency(topPromo.netSales) : formatCurrency(0),
          },
          {
            detail: 'Largest promoDiscount family in the named slice.',
            label: 'Largest discount family',
            value: promoCube.topDiscountPromo
              ? simplifyPromoName(promoCube.topDiscountPromo.promoName)
              : 'Unknown',
          },
        ],
        summary: 'The capture already hints at which promo families matter most in the current window.',
        title: 'Top promo families',
      },
    ],
    notes: [
      'This capture is Midtown-wide and unfiltered, so null promo-name rows are expected and must stay explicit.',
      'The current page uses direct cube evidence as a snapshot, not a fully normalized live adapter.',
      'Annotation metadata should remain the formatting and glossary source of truth when this moves server-side.',
    ],
    performance: {
      headline:
        'A direct cube capture now proves that promo-effectiveness measures and annotation metadata are available for a promo-focused dashboard, even though the filter recipe still needs hardening.',
      id: 'midtown-promo-effectiveness-snapshot',
      status: 'HAR-backed snapshot',
      title: 'Midtown promo-effectiveness snapshot',
    },
    retrievalFlow: [
      'Capture the direct GET /cube/v1/load request from the browser promo-performance view rather than assuming the marketing-event BI flow is the only analytics surface.',
      `Use the captured time window ${windowStart} through ${windowEnd} with PromotionEffectiveness.invoiceDatetime hour granularity, PromotionEffectiveness.fulfillmentType, and PromosLight.promoFullName.`,
      'Read the returned annotation payload and normalize labels, formats, and hints from the cube response instead of hard-coding a glossary.',
      'Keep rows with null promoFullName visible as a coverage gap until a safer promo filter recipe is confirmed live.',
      'Promote this from static capture to live server adapter only after the intended promo-specific filter members are confirmed.',
    ],
    sourceReferences: [
      makeSource(
        'Direct promo-effectiveness HAR',
        'The current snapshot is generated directly from this cube capture.',
        sourcePaths.promoCubeHar,
      ),
      makeSource(
        'Marketing analytics doc',
        'The confirmed event and promo analytics notes now live together here.',
        sourcePaths.eventAndPromoDocs,
      ),
    ],
    summaryCards: [
      {
        detail: 'Extracted from the captured PromotionEffectiveness invoiceDatetime dateRange.',
        label: 'Capture window',
        value: `${windowStart} to ${windowEnd}`,
      },
      {
        detail: 'Net sales across rows with a non-null PromosLight.promoFullName.',
        label: 'Named promo net sales',
        value: formatCurrency(promoCube.namedNetSales),
      },
      {
        detail: 'Total promoDiscount across the named promo slice.',
        label: 'Promo discount',
        value: formatCurrency(promoCube.namedPromoDiscount),
      },
      {
        detail: 'Unique buyers across named promo rows.',
        label: 'Named promo buyers',
        value: formatCount(promoCube.namedBuyers),
      },
      {
        detail: 'Rows returned without a promo name, which means this capture is still a proving slice rather than a final filtered dashboard.',
        label: 'Rows without promo name',
        value: `${formatCount(promoCube.unlinkedRows)} / ${formatCount(promoCube.totalRows)}`,
      },
    ],
    supportedMetrics: [
      metricFromAnnotation(promoCube.measures, 'PromotionEffectiveness.netSales'),
      metricFromAnnotation(promoCube.measures, 'PromotionEffectiveness.grossMargin'),
      metricFromAnnotation(promoCube.measures, 'PromotionEffectiveness.grossMarginProc'),
      metricFromAnnotation(promoCube.measures, 'PromotionEffectiveness.quantity'),
      metricFromAnnotation(promoCube.measures, 'PromotionEffectiveness.cutomersCount'),
      metricFromAnnotation(promoCube.measures, 'PromotionEffectiveness.avgNetSalesPerInvoice'),
      metricFromAnnotation(promoCube.measures, 'PromotionEffectiveness.avgQtyPerInvoice'),
      metricFromAnnotation(promoCube.measures, 'PromosLight.promoEngineDiscountAmountPerPromo'),
      metricFromAnnotation(promoCube.measures, 'PromotionEffectiveness.promoDiscount'),
      metricFromAnnotation(promoCube.measures, 'PromotionEffectiveness.totalDiscounts'),
    ],
  }
}

function buildEventPerformanceBlueprint(): PerformanceDetailResponse {
  return {
    breakoutColumns: [
      { label: 'Channel' },
      { label: 'Audience' },
      { label: 'Delivered' },
      { label: 'Open rate' },
      { label: 'Click rate' },
      { label: 'Net sales' },
    ],
    breakoutHeadline:
      'This remains the previously confirmed event-performance target shape, kept alongside the new promo HAR snapshot so the app can compare both analytics surfaces.',
    breakoutRows: [
      {
        id: 'email',
        values: ['Email', 'Live adapter pending', 'Live adapter pending', 'Live adapter pending', 'Live adapter pending', 'Live adapter pending'],
      },
      {
        id: 'text-notification',
        values: ['Text Notification', 'Live adapter pending', 'Live adapter pending', 'Live adapter pending', 'Live adapter pending', 'Live adapter pending'],
      },
    ],
    breakoutTitle: 'Event-performance breakout target',
    dashboardModules: [
      {
        bullets: [
          'Keep the first row quick to scan for owners.',
          'Make the cards clickable so operators can zoom into the supporting table immediately.',
        ],
        metrics: [
          {
            detail: 'Pull directly from MarketingStat.audience once the live adapter exists.',
            label: 'Audience',
            value: 'Top-line KPI',
          },
          {
            detail: 'Use delivered and deliveryRate together to show reach quality.',
            label: 'Delivered',
            value: 'Top-line KPI',
          },
          {
            detail: 'Prefer the combined online + offline contribution when available.',
            label: 'Net sales',
            value: 'Top-line KPI',
          },
        ],
        summary: 'A compact top row should answer whether the campaign is healthy before the operator scrolls.',
        title: 'Executive summary cards',
      },
      {
        bullets: [
          'Keep per-channel audience, delivery, open/click, and sales together on one row.',
          'Let operators click a channel row into a time-series zoom page later.',
        ],
        metrics: [
          {
            detail: 'This remains the confirmed breakout dimension from the captured event-performance HAR.',
            label: 'Breakout dimension',
            value: 'MarketingStat.notificationType',
          },
          {
            detail: 'The confirmed captured row query uses day granularity.',
            label: 'Default granularity',
            value: 'Day',
          },
          {
            detail: 'Hourly drill-ins remain a likely extension but still need direct live confirmation.',
            label: 'Likely extension',
            value: 'Hour',
          },
        ],
        summary: 'Operators need a fast Email vs Text view before they care about the long metric glossary.',
        title: 'Channel breakout table',
      },
      {
        bullets: [
          'Mirror Sweed naming closely enough that operators can reconcile the dashboard with the native UI.',
          'Do not bury metric meaning in tooltips alone; keep the glossary visible on dense pages.',
        ],
        metrics: [
          {
            detail: 'Use shortTitle, format, and hint directly from Cube annotations.',
            label: 'Source of truth',
            value: 'Annotation metadata',
          },
          {
            detail: 'The confirmed event capture already proved a wide metric surface.',
            label: 'Current count',
            value: '30+ measures',
          },
          {
            detail: 'Staff should not have to guess whether a metric is currency, percent, or a count.',
            label: 'Why it matters',
            value: 'Consistent semantics',
          },
        ],
        summary: 'Sweed already tells us how to format event metrics; the app should preserve that.',
        title: 'Metric glossary and semantics',
      },
    ],
    notes: [
      'Keep BI JWT handling and Cube query composition on the server.',
      'Use Cube annotation metadata as the formatting and glossary source of truth.',
      'The event-performance flow remains a confirmed live path even now that a direct promo cube capture also exists.',
    ],
    performance: {
      headline: 'Keep the confirmed event-performance BI path visible while the promo-specific cube surfaces are still being hardened.',
      id: 'sweed-event-performance-blueprint',
      status: 'Confirmed flow',
      title: 'Sweed event-performance adapter blueprint',
    },
    retrievalFlow: [
      'Call store.bi.auth.jwt in the active site dealer context to obtain the BI JWT.',
      'Run the main cube/v1/load row query grouped by MarketingStat.notificationType with day granularity.',
      'Optionally rerun the same query with total=true when row-count metadata is needed for the page shell.',
      'Call store.bi.cube.totals with the normalized Cube query string plus the BI JWT for footer totals.',
      'Run a second dimensionless cube/v1/load query for the aggregate card row, then normalize annotation metadata into the metric glossary.',
    ],
    sourceReferences: [
      makeSource(
        'Marketing analytics doc',
        'The confirmed event-performance workflow is documented here.',
        sourcePaths.eventAndPromoDocs,
      ),
    ],
    summaryCards: [
      {
        detail: 'The BI token comes from the normal RPC surface before Cube requests begin.',
        label: 'JWT bootstrap',
        value: 'store.bi.auth.jwt',
      },
      {
        detail: 'Main row query is grouped by MarketingStat.notificationType with day granularity.',
        label: 'Main row query',
        value: 'cube/v1/load',
      },
      {
        detail: 'Footer totals and annotation metadata should come from the normal RPC wrapper.',
        label: 'Totals query',
        value: 'store.bi.cube.totals',
      },
      {
        detail: 'Labels, formats, and hints should be normalized from annotation instead of hard-coded.',
        label: 'Metric metadata',
        value: 'Cube annotation',
      },
    ],
    supportedMetrics: [
      {
        format: 'count',
        label: 'MarketingStat.audience',
        note: 'Top-line audience size for the scoped event and channel breakout.',
      },
      {
        format: 'count',
        label: 'MarketingStat.sent',
        note: 'Send volume for the selected date window and breakout.',
      },
      {
        format: 'percent',
        label: 'MarketingStat.deliveryRate',
        note: 'Delivery success rate as formatted by Cube annotation.',
      },
      {
        format: 'percent',
        label: 'MarketingStat.openRate',
        note: 'Open rate where channel semantics support it.',
      },
      {
        format: 'percent',
        label: 'MarketingStat.clickRate',
        note: 'Click rate for the current channel or aggregate view.',
      },
      {
        format: 'currency',
        label: 'MarketingStat.netSalesOnline',
        note: 'Online attributable net sales when present.',
      },
      {
        format: 'currency',
        label: 'MarketingStat.netSalesOffline',
        note: 'Offline attributable net sales when present.',
      },
      {
        format: 'currency',
        label: 'MarketingStat.grossMarginOnline',
        note: 'Gross margin contribution for online attributed sales.',
      },
      {
        format: 'currency',
        label: 'MarketingStat.grossMarginOffline',
        note: 'Gross margin contribution for offline attributed sales.',
      },
      {
        format: 'percent',
        label: 'MarketingStat.optOutRate',
        note: 'Important operator sanity check for promo fatigue and list quality.',
      },
      {
        format: 'percent',
        label: 'MarketingStat.spamOfDeliveredRate',
        note: 'Useful quality guardrail when reviewing Email-heavy promo pushes.',
      },
      {
        format: 'count',
        label: 'MarketingStat.totalTicketsOffline',
        note: 'Lets operators correlate message delivery with in-store transaction outcomes.',
      },
    ],
  }
}

function main() {
  const todoText = readText(sourcePaths.agentTodo)
  const promoInventorySnapshot = readJson<PromoInventorySellthroughSnapshot>(
    sourcePaths.promoInventorySellthroughSnapshot,
  )
  const selectorAudit = readJson<PromoSelectorAuditSnapshot>(sourcePaths.promoSelectorDistributionAudit)
  const promoMetadata = readJson<PromoMetadataSnapshot>(sourcePaths.promoMetadataSnapshot)
  const velocityRun = readJson<VelocityBannerRun>(sourcePaths.velocityBannerBind)
  const freshRun = readJson<FreshAndIntenseRun>(sourcePaths.freshAndIntenseScreens)
  const bannerReadback = readJson<BannerReadback>(sourcePaths.latestBannerReadback)
  const promoCube = parsePromoCubeCapture()

  const velocityStats = buildBannerStats(bannerReadback, 'Freshly Baked NYC - Midtown', ['42260', '42261', '42262'])
  const freshStats = buildBannerStats(bannerReadback, 'Freshly Baked NYC - Midtown', ['42264'])

  const snapshot: PromoOpsSnapshot = {
    dashboard: buildDashboard(promoCube, selectorAudit, promoInventorySnapshot),
    generatedAt: new Date().toISOString(),
    performanceViews: [
      buildPromoEffectivenessPerformance(promoCube),
      buildEventPerformanceBlueprint(),
    ],
    promos: [
      buildBronxFourTwentySixPromo(promoMetadata, promoInventorySnapshot),
      buildPricedToMovePromo(promoMetadata, promoInventorySnapshot, selectorAudit, bannerReadback, 'bronx'),
      buildMidtownDumboPromo(promoMetadata, promoInventorySnapshot),
      buildPricedToMovePromo(promoMetadata, promoInventorySnapshot, selectorAudit, bannerReadback, 'midtown'),
      buildVelocityPromo(velocityRun, velocityStats, bannerReadback, promoMetadata, promoInventorySnapshot),
      buildFreshAndIntensePromo(
        freshRun,
        freshStats,
        bannerReadback,
        promoMetadata,
        promoInventorySnapshot,
      ),
    ],
    proposals: [
      buildMfnyProposal(todoText, promoMetadata, promoInventorySnapshot),
      buildVelocityThresholdProposal(velocityStats, bannerReadback, promoInventorySnapshot),
    ],
  }

  PromoOpsSnapshotSchema.parse(snapshot)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`)
  process.stdout.write(`Wrote ${outputPath}\n`)
}

main()
