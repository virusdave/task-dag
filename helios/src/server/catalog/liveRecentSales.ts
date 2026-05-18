import { z } from 'zod'

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type GroupRecentSales,
  type GroupRecentSalesProductRow,
  type JsonValue,
  type RecentSalesSummary,
} from '../../shared/contracts/index.js'
import { callSweedRpc } from '../../worker/sweed/rpc.js'
import { withSweedSession } from '../../worker/sweed/session.js'

const REPORT_CACHE_TTL_MS = 60_000
const REPORT_PAGE_SIZE = 200

// `store.reports.reorder` echoes the request `page` / `pageSize`, but on the
// final (often empty) page Sweed sometimes returns `pageSize: 0`. The fields
// are not consumed by our pipeline, so accept any non-negative integer and
// don't reject the whole response on a benign echo value — the previous
// `.min(1)` constraint surfaced as a confusing "Recent sales velocity is
// unavailable right now" banner on /catalog/browser.
const ReorderReportResponseSchema = z.object({
  page: z.coerce.number().int().min(0).optional(),
  pageSize: z.coerce.number().int().min(0).optional(),
  reportDate: z.string().nullable().optional(),
  table: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      last30DaysGlossSales: z.coerce.number().nullable().optional(),
      lastWeekSellingPerDay: z.coerce.number().nullable().optional(),
      name: z.string().nullable().optional(),
      onHand: z.coerce.number().nullable().optional(),
    }).passthrough(),
  ).default([]),
  totalCount: z.coerce.number().int().min(0).optional(),
}).passthrough()

const CatalogGroupProductsSchema = z.object({
  products: z.array(
    z.object({
      name: z.string().nullable().optional(),
      productId: z.coerce.number().int().positive(),
      tab: z.string().nullable().optional(),
    }).passthrough(),
  ).default([]),
})

interface SiteReportRow {
  last30DaysGrossSales: number | null
  onHand: number | null
  productId: number
  reportDate: string | null
  unitsPerDay: number | null
}

interface CachedSiteReport {
  expiresAt: number
  reportDate: string | null
  rowsByProductId: Map<number, SiteReportRow>
}

interface GroupProduct {
  productId: number
  productName: string
  productTab: string
}

interface GroupRecentSalesInput {
  catalogGroupId: number
  liveState: JsonValue
}

const siteReportCache = new Map<number, CachedSiteReport>()

export function buildEmptyGroupRecentSales(liveState: JsonValue): GroupRecentSales {
  const products = extractGroupProducts(liveState)
  const productRows = HELIOS_PENDING_PURCHASE_SITE_DEALERS.flatMap((site) =>
    products.map((product) => buildProductRow(site, product, null, null)),
  )

  return {
    productRows,
    reportSource: 'store.reports.reorder',
    sites: HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) => ({
      siteDealerId: site.dealerId,
      siteKey: site.siteKey,
      siteLabel: site.siteLabel,
      summary: buildRecentSalesSummary(productRows.filter((row) => row.siteDealerId === site.dealerId)),
    })),
    summary: buildRecentSalesSummary(productRows),
  }
}

export async function loadRecentSalesForGroups(
  groups: GroupRecentSalesInput[],
): Promise<Map<number, GroupRecentSales>> {
  const parsedGroups = groups.map((group) => ({
    catalogGroupId: group.catalogGroupId,
    products: extractGroupProducts(group.liveState),
  }))

  const reports = await Promise.all(
    HELIOS_PENDING_PURCHASE_SITE_DEALERS.map(async (site) => [site.dealerId, await loadSiteReport(site.dealerId)] as const),
  )
  const reportsByDealerId = new Map(reports)

  return new Map(
    parsedGroups.map((group) => [group.catalogGroupId, buildGroupRecentSales(group.products, reportsByDealerId)]),
  )
}

function buildGroupRecentSales(
  products: GroupProduct[],
  reportsByDealerId: Map<number, CachedSiteReport>,
): GroupRecentSales {
  const productRows = HELIOS_PENDING_PURCHASE_SITE_DEALERS.flatMap((site) => {
    const report = reportsByDealerId.get(site.dealerId) ?? null
    return products.map((product) => buildProductRow(site, product, report?.rowsByProductId.get(product.productId) ?? null, report?.reportDate ?? null))
  })

  const sites = HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) => ({
    siteDealerId: site.dealerId,
    siteKey: site.siteKey,
    siteLabel: site.siteLabel,
    summary: buildRecentSalesSummary(productRows.filter((row) => row.siteDealerId === site.dealerId)),
  }))

  return {
    productRows,
    reportSource: 'store.reports.reorder',
    sites,
    summary: buildRecentSalesSummary(productRows),
  }
}

function buildProductRow(
  site: (typeof HELIOS_PENDING_PURCHASE_SITE_DEALERS)[number],
  product: GroupProduct,
  reportRow: SiteReportRow | null,
  fallbackReportDate: string | null,
): GroupRecentSalesProductRow {
  const unitsPerDay = reportRow?.unitsPerDay ?? null

  return {
    daysPerUnit: unitsPerDay !== null && unitsPerDay > 0 ? roundNumber(1 / unitsPerDay) : null,
    hasCoverage: reportRow !== null,
    last30DaysGrossSales: reportRow?.last30DaysGrossSales ?? null,
    onHand: reportRow?.onHand ?? null,
    productId: product.productId,
    productName: product.productName,
    productTab: product.productTab,
    reportDate: reportRow?.reportDate ?? fallbackReportDate,
    siteDealerId: site.dealerId,
    siteKey: site.siteKey,
    siteLabel: site.siteLabel,
    unitsPerDay,
  }
}

function buildRecentSalesSummary(rows: GroupRecentSalesProductRow[]): RecentSalesSummary {
  const coveredRows = rows.filter((row) => row.hasCoverage)
  const totalUnitsPerDay = sumNullable(coveredRows.map((row) => row.unitsPerDay))
  const totalOnHand = sumNullable(coveredRows.map((row) => row.onHand))
  const totalLast30DaysGrossSales = sumNullable(coveredRows.map((row) => row.last30DaysGrossSales))
  const reportDate = latestReportDate(coveredRows.map((row) => row.reportDate))

  return {
    combinationCount: rows.length,
    coverageCount: coveredRows.length,
    daysPerUnit:
      totalUnitsPerDay !== null && totalUnitsPerDay > 0 ? roundNumber(1 / totalUnitsPerDay) : null,
    last30DaysGrossSales: totalLast30DaysGrossSales,
    onHand: totalOnHand,
    reportDate,
    unitsPerDay: totalUnitsPerDay,
  }
}

function extractGroupProducts(liveState: JsonValue): GroupProduct[] {
  const parsed = CatalogGroupProductsSchema.safeParse(liveState)
  if (!parsed.success) {
    return []
  }

  const dedupedProducts = new Map<number, GroupProduct>()
  for (const product of parsed.data.products) {
    dedupedProducts.set(product.productId, {
      productId: product.productId,
      productName: normalizeText(product.name) || `Product #${product.productId}`,
      productTab: normalizeText(product.tab) || 'No tab',
    })
  }

  return [...dedupedProducts.values()].sort((left, right) => {
    if (left.productTab !== right.productTab) {
      return left.productTab.localeCompare(right.productTab)
    }
    if (left.productName !== right.productName) {
      return left.productName.localeCompare(right.productName)
    }
    return left.productId - right.productId
  })
}

async function loadSiteReport(dealerId: number): Promise<CachedSiteReport> {
  const cached = siteReportCache.get(dealerId)
  if (cached && cached.expiresAt > Date.now()) {
    return cached
  }

  return withSweedSession(async () => {
    const freshCache = siteReportCache.get(dealerId)
    if (freshCache && freshCache.expiresAt > Date.now()) {
      return freshCache
    }

    const rowsByProductId = new Map<number, SiteReportRow>()
    let page = 1
    let reportDate: string | null = null

    while (true) {
      const response = ReorderReportResponseSchema.parse(
        await callSweedRpc(dealerId, 'store.reports.reorder', {
          page,
          pageSize: REPORT_PAGE_SIZE,
        }),
      )

      reportDate = response.reportDate ?? reportDate

      for (const row of response.table) {
        const productId = parseProductId(row.id)
        if (productId === null) {
          continue
        }

        rowsByProductId.set(productId, {
          last30DaysGrossSales: row.last30DaysGlossSales ?? null,
          onHand: row.onHand ?? null,
          productId,
          reportDate: response.reportDate ?? reportDate,
          unitsPerDay: row.lastWeekSellingPerDay ?? null,
        })
      }

      const totalCount = response.totalCount ?? 0
      if (response.table.length < REPORT_PAGE_SIZE || page * REPORT_PAGE_SIZE >= totalCount) {
        break
      }

      page += 1
    }

    const nextCache: CachedSiteReport = {
      expiresAt: Date.now() + REPORT_CACHE_TTL_MS,
      reportDate,
      rowsByProductId,
    }
    siteReportCache.set(dealerId, nextCache)
    return nextCache
  })
}

function latestReportDate(reportDates: Array<string | null>): string | null {
  let latestValue: string | null = null
  let latestTimestamp = Number.NEGATIVE_INFINITY

  for (const reportDate of reportDates) {
    if (!reportDate) {
      continue
    }
    const timestamp = Date.parse(reportDate)
    if (!Number.isFinite(timestamp) || timestamp <= latestTimestamp) {
      continue
    }

    latestValue = reportDate
    latestTimestamp = timestamp
  }

  return latestValue
}

function sumNullable(values: Array<number | null>): number | null {
  const presentValues = values.filter((value): value is number => value !== null)
  if (presentValues.length === 0) {
    return null
  }

  return roundNumber(presentValues.reduce((sum, value) => sum + value, 0))
}

function parseProductId(value: string | number): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function roundNumber(value: number): number {
  return Math.round(value * 100) / 100
}

function normalizeText(value: string | null | undefined): string {
  return String(value ?? '')
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(' ')
    .trim()
}


