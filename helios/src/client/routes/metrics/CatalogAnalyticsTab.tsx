import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useRouteLoaderData, useSearchParams } from 'react-router-dom'

import {
  buildHeliosModulePath,
  CatalogAnalyticsFiltersResponseSchema,
  CatalogAnalyticsPointsResponseSchema,
  QueuePricingRunAcceptedResponseSchema,
  type CatalogAnalyticsFiltersResponse,
  type CatalogAnalyticsPoint,
  type CatalogAnalyticsPointsResponse,
  type SessionEnvelope,
} from '../../../shared/contracts/index.js'
import { buildCatalogCohortKey } from '../../../shared/domain/catalogCohort.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { buildAppPath } from '../../app/paths.js'
import { CatalogFilterBar, FilterDropdown } from './CatalogFilterBar.js'
import {
  ChartInteractionFrame,
  svgPointAnchor,
  TapGestureTracker,
  useChartInteraction,
} from './ChartInteractionFrame.js'
import { ControlsSection } from './ControlsSection.js'
import {
  buildStructuredHighlightMatcher,
  emptyHighlightSelection,
  HighlightControls,
  type HighlightDimensionSpec,
  type HighlightSelectionState,
} from './HighlightControls.js'
import {
  ratioForward,
  ratioTicks,
  ratioZeroFloor,
  type RatioTick,
} from './catalogRatioAxis.js'
import { niceXTicks, niceYTicks } from './gridlines.js'
import {
  buildContinuousScale,
  continuumColour,
  type BetterDirection,
  type ContinuousScale,
} from './continuousScale.js'
import { HelpIcon } from './MetricChart.js'
import { useMetricsDefaults } from './MetricsDefaultsContext.js'
import { defaultSiteSelection, normaliseSiteSelection, toggleSiteSelection } from './metricsSiteSelection.js'
import { RangeNudgeRow } from './RangeNudgeRow.js'
import { computeCompactDomain } from './scatterAutoZoom.js'
import { ScatterViewToolbar } from './ScatterViewToolbar.js'
import {
  useScatterZoom,
  type ScatterInteractionMode,
  type ScatterZoomTool,
  type ZoomView,
} from './scatterZoom.js'
import { useMetricSelection } from './useMetricSelection.js'

// v1.4 V4'4: per-card synthetic metricId prefix. Catalog scatters are
// served by /api/catalog-analytics/points (not the metric registry),
// but the URL `?selection=…` payload still keys off a stable
// metricId so share-links reproduce the drilled dot. metricId =
// `catalog.<scatter-card-config-id>`.
const CATALOG_SCATTER_METRIC_ID_PREFIX = 'catalog.'

// ---------------------------------------------------------------------------
// Catalog analytics tab — independent of the time-series metric registry.
//
// This is its own page-shaped UI under /metrics/catalog:
//   * Filter bar (date range, sites, category, subcategory, brand, size).
//   * A grid of preset scatter cards. Each card has its own (X, Y, colour-by)
//     axis pickers; the operator can swap to any of the per-variant metrics
//     defined below (`POINT_AXES`).
//   * Cohort overlay: any non-default colour-by mode (e.g. "brand" or
//     "subcategory") shades dots into peer groups so the operator can see
//     "this brand vs same-subcategory peers" at a glance.
//   * Hover-tooltip showing product / brand / size / sales / margin / etc.
//
// All charts share one point set, fetched once when the filters change.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000
const DEFAULT_WINDOW_DAYS = 90

// ============================ Axis definitions =============================

/**
 * Each entry describes a numeric field on `CatalogAnalyticsPoint` that
 * can serve as the X or Y axis of a scatter card. `format` controls the
 * tooltip / tick formatting.
 */
/**
 * Context passed to every axis evaluator. Carries window length so
 * "per day" metrics can normalise, and per-cohort medians so index
 * axes (velocity index vs cohort median, etc.) can compute on the
 * fly. Cohort key is `<category>|<subcategory>|<sizeLabel>` —
 * picked because operators reason about "this 1g flower vs other 1g
 * flower", not "this vape vs everything".
 *
 * The cohort medians are recomputed once per filter-result set in
 * the parent component (`useCohortMedians`) and cached, so axis
 * evaluators are cheap.
 */
export interface AxisCtx {
  readonly windowDays: number
  readonly cohortMedians: ReadonlyMap<
    string,
    {
      velocityUnitsPerDay: number | null
      effectiveOtdPriceDollars: number | null
      gmPercent: number | null
      marginPerUnitDollars: number | null
    }
  >
}

interface PointAxisDef {
  readonly id: string
  readonly label: string
  readonly short: string
  readonly value: (p: CatalogAnalyticsPoint, ctx: AxisCtx) => number | null
  readonly format: (v: number) => string
  /**
   * Marks a cohort-relative *ratio* axis whose neutral point is 1.0
   * (velocity index, price index, list ÷ market ratio). Only these
   * axes are eligible for the "balanced" reciprocal-fold scale (see
   * `catalogRatioAxis.ts`). Additive/pp-delta axes (baseline 0),
   * dollars, counts and percentages leave this unset.
   */
  readonly scaleKind?: 'ratioBaseline1'
}

// ============================ Derived metrics ==============================
//
// All "list vs effective" promo-erosion math lives here so it's
// expressed once and reused across the axis list, the per-card colour
// bands, and the tooltip. Each helper takes a raw `CatalogAnalyticsPoint`
// and returns `null` when the inputs aren't both present — the chart
// renderer drops null-axis points automatically.
// ---------------------------------------------------------------------------

function listOtdPriceDollars(p: CatalogAnalyticsPoint): number | null {
  if (p.listPriceDollars == null) return null
  const ratio = p.taxRatio ?? 1.0
  return p.listPriceDollars * ratio
}

function listGmPercent(p: CatalogAnalyticsPoint): number | null {
  if (p.listPriceDollars == null || p.wholesaleCostDollars == null) return null
  if (p.listPriceDollars <= 0) return null
  return ((p.listPriceDollars - p.wholesaleCostDollars) / p.listPriceDollars) * 100
}

function discountDollarsPerUnit(p: CatalogAnalyticsPoint): number | null {
  if (p.listPriceDollars == null || p.avgUnitPriceDollars == null) return null
  return p.listPriceDollars - p.avgUnitPriceDollars
}

function discountDepthPercent(p: CatalogAnalyticsPoint): number | null {
  if (p.listPriceDollars == null || p.avgUnitPriceDollars == null) return null
  if (p.listPriceDollars <= 0) return null
  return ((p.listPriceDollars - p.avgUnitPriceDollars) / p.listPriceDollars) * 100
}

function priceRealizationPercent(p: CatalogAnalyticsPoint): number | null {
  if (p.listPriceDollars == null || p.avgUnitPriceDollars == null) return null
  if (p.listPriceDollars <= 0) return null
  return (p.avgUnitPriceDollars / p.listPriceDollars) * 100
}

function salesDayCoveragePercent(p: CatalogAnalyticsPoint, ctx: AxisCtx): number | null {
  if (p.daysWithSales == null || ctx.windowDays <= 0) return null
  return Math.min(100, (p.daysWithSales / ctx.windowDays) * 100)
}

function unitsPerInvoice(p: CatalogAnalyticsPoint): number | null {
  if (p.unitsSold == null || !p.invoiceCount) return null
  return p.unitsSold / p.invoiceCount
}

function marginPerInvoiceDollars(p: CatalogAnalyticsPoint): number | null {
  if (p.marginDollars == null || !p.invoiceCount) return null
  return p.marginDollars / p.invoiceCount
}

function weeksOfSupplyOnHand(p: CatalogAnalyticsPoint): number | null {
  if (p.currentQty == null || p.salesVelocityUnitsPerDay == null) return null
  if (p.salesVelocityUnitsPerDay <= 0) return null
  return p.currentQty / (p.salesVelocityUnitsPerDay * 7)
}

// "Total size sold over the window" — grams sold of this variant.
// units_sold × unit_size_g. Edibles / tinctures use the mg variant.
function totalGramsSoldWindow(p: CatalogAnalyticsPoint): number | null {
  if (p.unitsSold == null || p.unitSizeGrams == null) return null
  return p.unitsSold * p.unitSizeGrams
}
function totalMgSoldWindow(p: CatalogAnalyticsPoint): number | null {
  if (p.unitsSold == null || p.unitSizeMg == null) return null
  return p.unitsSold * p.unitSizeMg
}

// Pack-aware total size — pack_count × unit_size_g (e.g. a 5-pack of
// 0.5g pre-rolls = 2.5g per package). Independent of sales — answers
// "how much of the active substance does a single package contain?".
function packTotalGrams(p: CatalogAnalyticsPoint): number | null {
  if (p.packCount == null || p.unitSizeGrams == null) return null
  return p.packCount * p.unitSizeGrams
}
function packTotalMg(p: CatalogAnalyticsPoint): number | null {
  if (p.packCount == null || p.unitSizeMg == null) return null
  return p.packCount * p.unitSizeMg
}

// "$ below market" — positive = we're cheaper than the median peer
// listing. Negative = we're more expensive. Compared pre-tax against
// our list (shelf) price, NOT our OTD price — `marketPricePretaxDollars`
// is itself pre-tax.
function dollarsBelowMarket(p: CatalogAnalyticsPoint): number | null {
  if (p.marketPricePretaxDollars == null || p.listPriceDollars == null) return null
  return p.marketPricePretaxDollars - p.listPriceDollars
}
function percentBelowMarket(p: CatalogAnalyticsPoint): number | null {
  if (p.marketPricePretaxDollars == null || p.listPriceDollars == null) return null
  if (p.marketPricePretaxDollars <= 0) return null
  return ((p.marketPricePretaxDollars - p.listPriceDollars) / p.marketPricePretaxDollars) * 100
}
function ourPriceOverMarket(p: CatalogAnalyticsPoint): number | null {
  if (p.marketPricePretaxDollars == null || p.listPriceDollars == null) return null
  if (p.marketPricePretaxDollars <= 0) return null
  return p.listPriceDollars / p.marketPricePretaxDollars
}

/**
 * Build a matcher predicate from a free-text highlight query. Returns
 * `null` when the query is empty / whitespace (caller should treat
 * highlight as inactive). The predicate is case-insensitive substring
 * match against:
 *   * brand / category / subcategory name
 *   * distributor name
 *   * size label, pack-count synthetic label ("1 per pkg" / "5-pack")
 *   * product name + short name, sku
 *
 * Multiple whitespace-separated terms are ALL-required (AND semantics)
 * so the operator can type "blue dream 1g" to narrow to a specific
 * strain × size.
 *
 * exempt: NOT consumed by CatalogAnalyticsTab itself anymore (issue
 * #38 / task A3 migrated the page to <HighlightControls> +
 * buildStructuredHighlightMatcher). Retained as an exported
 * symbol because highlightMatcher.test.ts exercises the
 * catalog-specific haystack composition. Safe to delete alongside
 * its test file in a future cleanup pass; intentionally not
 * removed here per A7's "don't refactor matched pages beyond
 * inserting the new primitives" non-goal.
 */
export function buildHighlightMatcher(
  query: string,
): ((p: CatalogAnalyticsPoint) => boolean) | null {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return null
  const terms = q.split(/\s+/).filter((t) => t.length > 0)
  if (terms.length === 0) return null
  return (p) => {
    const packLabel =
      p.packCount == null
        ? ''
        : p.packCount === 1
        ? '1 per pkg'
        : `${p.packCount}-pack`
    const haystack = [
      p.brandName,
      p.distributorName,
      p.categoryName,
      p.subcategoryName,
      p.sizeLabel,
      p.productName,
      p.productShortName,
      p.sku,
      packLabel,
    ]
      .filter((s) => s)
      .join(' ')
      .toLowerCase()
    return terms.every((t) => haystack.includes(t))
  }
}

// ---------------------------------------------------------------------------
// Structured-highlight dimensions for the catalog scatter (issue #38).
//
// One dim per page-level filter dimension. `getOptions` derives chip
// options from the FILTERED point set so the operator can only highlight
// values that actually appear on screen. `pointKey` returns the option-id
// the point belongs to (one per dim, except `pack` which is missing if
// `packCount` is null — getOptions silently skips nulls).
//
// We use the human-visible NAME as both id and label for category /
// subcategory / brand because the upstream `CatalogAnalyticsPoint`
// already carries names alongside ids and the chip UX reads more
// naturally when the chip's id is "Cresco Labs" rather than a UUID.
// (Two points with the same brand name and different brandIds — which
// shouldn't happen but does occur once in a while when sweed has a
// brand-merge backlog — get collapsed into one highlight chip, which
// is the right outcome.)
const CATALOG_HIGHLIGHT_DIMS: ReadonlyArray<HighlightDimensionSpec<CatalogAnalyticsPoint>> = [
  {
    id: 'category',
    label: 'Category',
    getOptions: (pts) => collectChipOptions(pts, (p) => p.categoryName),
    pointKey: (p) => (p.categoryName ? [p.categoryName] : []),
  },
  {
    id: 'subcategory',
    label: 'Subcategory',
    getOptions: (pts) => collectChipOptions(pts, (p) => p.subcategoryName),
    pointKey: (p) => (p.subcategoryName ? [p.subcategoryName] : []),
  },
  {
    id: 'brand',
    label: 'Brand',
    getOptions: (pts) => collectChipOptions(pts, (p) => p.brandName),
    pointKey: (p) => (p.brandName ? [p.brandName] : []),
  },
  {
    id: 'distributor',
    label: 'Distributor',
    getOptions: (pts) => collectChipOptions(pts, (p) => p.distributorName),
    pointKey: (p) => (p.distributorName ? [p.distributorName] : []),
  },
  {
    id: 'size',
    label: 'Size',
    getOptions: (pts) => collectChipOptions(pts, (p) => p.sizeLabel),
    pointKey: (p) => (p.sizeLabel ? [p.sizeLabel] : []),
  },
  {
    id: 'pack',
    label: 'Pack',
    getOptions: (pts) =>
      collectChipOptions(pts, (p) =>
        p.packCount == null ? null : p.packCount === 1 ? '1 per pkg' : `${p.packCount}-pack`,
      ),
    pointKey: (p) =>
      p.packCount == null
        ? []
        : p.packCount === 1
        ? ['1 per pkg']
        : [`${p.packCount}-pack`],
  },
  {
    // Variant dim — chip id is the catalog product id (the variant), so
    // structured highlighting (and any deep-link that seeds `highlight-
    // VariantIds`) pins the EXACT variant rather than fuzzy-matching a
    // product-name string. Each scatter dot is already one-per-variant
    // (rolled up from physical lots server-side), so this resolves to a
    // single dot per chip.
    id: 'variant',
    label: 'Variant',
    getOptions: (pts) => collectVariantChipOptions(pts),
    pointKey: (p) => (p.productId ? [p.productId] : []),
  },
  {
    // Hidden haystack-only dim (no chip dropdown): folds the product name
    // + short name + SKU into the free-text highlight haystack so typing
    // part of a product name still works. The structured matcher migration
    // (issue #38) had dropped product name/sku from the haystack, which is
    // why free-text product searches "never matched anything". getOptions
    // returns [] so HighlightControls renders no chip for it.
    id: 'product',
    label: 'Product',
    getOptions: () => [],
    pointKey: (p) =>
      [p.productName, p.productShortName, p.sku].filter(
        (s): s is string => typeof s === 'string' && s.length > 0,
      ),
  },
]

/**
 * Helper: bucket the filtered point set by `keyFn`, drop nulls, and
 * return `{id, label, itemCount}[]` sorted by label.
 */
function collectChipOptions<P>(
  points: ReadonlyArray<P>,
  keyFn: (p: P) => string | null | undefined,
): ReadonlyArray<{ id: string; label: string; itemCount: number }> {
  const counts = new Map<string, number>()
  for (const p of points) {
    const k = keyFn(p)
    if (!k) continue
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const out: Array<{ id: string; label: string; itemCount: number }> = []
  for (const [k, n] of counts) out.push({ id: k, label: k, itemCount: n })
  out.sort((a, b) => a.label.localeCompare(b.label))
  return out
}

/**
 * Variant chip options keyed on the catalog product id (the variant),
 * labelled with the human-readable product name (+ size) so the chip is
 * legible while the option *id* stays the stable numeric variant id. This
 * is what lets a deep-link (e.g. from the inventory page) highlight an
 * exact variant by id instead of fuzzy-matching a product-name string that
 * rarely lines up across data sources. Un-mapped lots (productId null) are
 * skipped — they have no variant id to pin.
 */
function collectVariantChipOptions(
  points: ReadonlyArray<CatalogAnalyticsPoint>,
): ReadonlyArray<{ id: string; label: string; itemCount: number }> {
  const byId = new Map<string, { label: string; count: number }>()
  for (const p of points) {
    if (!p.productId) continue
    const existing = byId.get(p.productId)
    if (existing) {
      existing.count += 1
      continue
    }
    const size = p.sizeLabel ? ` · ${p.sizeLabel}` : ''
    byId.set(p.productId, { label: `${p.productName}${size}`, count: 1 })
  }
  const out: Array<{ id: string; label: string; itemCount: number }> = []
  for (const [id, v] of byId) out.push({ id, label: v.label, itemCount: v.count })
  out.sort((a, b) => a.label.localeCompare(b.label))
  return out
}

export function cohortKey(p: CatalogAnalyticsPoint): string {
  // Delegates to the shared cohort-key builder so the scatter cohorts and the
  // CSV snapshot exports (/api/catalog/groups.csv, /api/catalog/inventory/
  // stock-snapshot.csv) always describe the exact same peer set.
  return buildCatalogCohortKey(p)
}

function velocityIndex(p: CatalogAnalyticsPoint, ctx: AxisCtx): number | null {
  if (p.salesVelocityUnitsPerDay == null) return null
  const m = ctx.cohortMedians.get(cohortKey(p))
  if (!m || !m.velocityUnitsPerDay || m.velocityUnitsPerDay === 0) return null
  return p.salesVelocityUnitsPerDay / m.velocityUnitsPerDay
}

function effectivePriceIndex(p: CatalogAnalyticsPoint, ctx: AxisCtx): number | null {
  if (p.otdUnitPriceDollars == null) return null
  const m = ctx.cohortMedians.get(cohortKey(p))
  if (!m || !m.effectiveOtdPriceDollars || m.effectiveOtdPriceDollars === 0) return null
  return p.otdUnitPriceDollars / m.effectiveOtdPriceDollars
}

function gmPercentIndex(p: CatalogAnalyticsPoint, ctx: AxisCtx): number | null {
  if (p.gmPercent == null) return null
  const m = ctx.cohortMedians.get(cohortKey(p))
  if (!m || m.gmPercent == null) return null
  return p.gmPercent - m.gmPercent
}

function fmtX(v: number): string {
  if (Math.abs(v) >= 10) return `${v.toFixed(1)}×`
  return `${v.toFixed(2)}×`
}
function fmtPctSigned(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}pp`
}

function fmtMoney(v: number): string {
  if (!Number.isFinite(v)) return '—'
  if (Math.abs(v) >= 1000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  return `$${v.toFixed(2)}`
}
function fmtMoneyShort(v: number): string {
  if (!Number.isFinite(v)) return '—'
  if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(1)}k`
  return `$${v.toFixed(2)}`
}
function fmtPct(v: number): string {
  return `${v.toFixed(1)}%`
}
function fmtNum(v: number): string {
  if (Math.abs(v) >= 100) return v.toLocaleString(undefined, { maximumFractionDigits: 0 })
  return v.toFixed(2)
}
// Weeks-of-supply is clamped to a 52-week ceiling for plotting; render
// the cap as "52+" so a capped runway (or a never-sold item with stock
// on hand) reads as "≥1 year of supply" rather than exactly 52.
function fmtWeeks(v: number): string {
  if (v >= WEEKS_OF_SUPPLY_CAP) return `${WEEKS_OF_SUPPLY_CAP}+`
  return v.toFixed(1)
}

const POINT_AXES: ReadonlyArray<PointAxisDef> = [
  {
    id: 'otdUnitPriceDollars',
    label: 'OTD price ($/unit)',
    short: 'OTD $/u',
    value: (p) => p.otdUnitPriceDollars,
    format: fmtMoney,
  },
  {
    id: 'avgUnitPriceDollars',
    label: 'Avg sold price ($/unit, pretax)',
    short: 'Avg $/u',
    value: (p) => p.avgUnitPriceDollars,
    format: fmtMoney,
  },
  {
    id: 'marginDollarsPerUnit',
    label: 'Margin ($/unit)',
    short: 'GM $/u',
    value: (p) => p.marginDollarsPerUnit,
    format: fmtMoney,
  },
  {
    id: 'marginDollars',
    label: 'Margin ($ total over window)',
    short: 'GM $',
    value: (p) => p.marginDollars,
    format: fmtMoneyShort,
  },
  {
    id: 'gmPercent',
    label: 'GM %',
    short: 'GM %',
    value: (p) => p.gmPercent,
    format: fmtPct,
  },
  {
    id: 'salesVelocityUnitsPerDay',
    label: 'Sales velocity (units/day)',
    short: 'Units/d',
    value: (p) => p.salesVelocityUnitsPerDay,
    format: fmtNum,
  },
  {
    id: 'marginVelocityDollarsPerDay',
    label: 'Margin velocity ($/day)',
    short: 'GM $/d',
    value: (p) => p.marginVelocityDollarsPerDay,
    format: fmtMoney,
  },
  {
    id: 'unitsSold',
    label: 'Units sold (window total)',
    short: 'Units',
    value: (p) => p.unitsSold,
    format: fmtNum,
  },
  {
    id: 'revenueDollars',
    label: 'Revenue ($ window total)',
    short: 'Rev $',
    value: (p) => p.revenueDollars,
    format: fmtMoneyShort,
  },
  {
    id: 'labThcPct',
    label: 'Lab THC %',
    short: 'THC %',
    value: (p) => p.labThcPct,
    format: fmtPct,
  },
  {
    id: 'labCbdPct',
    label: 'Lab CBD %',
    short: 'CBD %',
    value: (p) => p.labCbdPct,
    format: fmtPct,
  },
  {
    id: 'wholesaleCostDollars',
    label: 'Wholesale cost ($/unit)',
    short: 'Cost $',
    value: (p) => p.wholesaleCostDollars,
    format: fmtMoney,
  },
  {
    id: 'currentQty',
    label: 'On-hand qty',
    short: 'On hand',
    value: (p) => p.currentQty,
    format: fmtNum,
  },

  // --- list / shelf price + promo-aware (added 2026-05-26) ---
  {
    id: 'listPriceDollars',
    label: 'List price ($/unit, pretax)',
    short: 'List $',
    value: (p) => p.listPriceDollars,
    format: fmtMoney,
  },
  {
    id: 'listOtdPriceDollars',
    label: 'List OTD price ($/unit)',
    short: 'List OTD',
    value: (p) => listOtdPriceDollars(p),
    format: fmtMoney,
  },
  {
    id: 'listGmPercent',
    label: 'List GM % (if always sold at list)',
    short: 'List GM%',
    value: (p) => listGmPercent(p),
    format: fmtPct,
  },
  {
    id: 'discountDollarsPerUnit',
    label: 'Discount ($/unit, list − effective)',
    short: 'Disc $/u',
    value: (p) => discountDollarsPerUnit(p),
    format: fmtMoney,
  },
  {
    id: 'discountDepthPercent',
    label: 'Discount depth % (1 − effective/list)',
    short: 'Disc %',
    value: (p) => discountDepthPercent(p),
    format: fmtPct,
  },
  {
    id: 'priceRealizationPercent',
    label: 'Price realization % (effective/list)',
    short: 'Real %',
    value: (p) => priceRealizationPercent(p),
    format: fmtPct,
  },
  {
    id: 'salesDayCoveragePercent',
    label: 'Sales-day coverage % (days sold / window)',
    short: 'Cov %',
    value: salesDayCoveragePercent,
    format: fmtPct,
  },
  {
    id: 'unitsPerInvoice',
    label: 'Units per invoice (basket multiplier)',
    short: 'U/inv',
    value: (p) => unitsPerInvoice(p),
    format: fmtNum,
  },
  {
    id: 'marginPerInvoiceDollars',
    label: 'Margin $/invoice',
    short: 'GM $/inv',
    value: (p) => marginPerInvoiceDollars(p),
    format: fmtMoney,
  },
  {
    id: 'weeksOfSupplyOnHand',
    label: 'Weeks of supply (on-hand / weekly velocity, capped 52)',
    short: 'Wks supply',
    value: (p) => weeksOfSupplyOnHand(p),
    format: fmtWeeks,
  },
  {
    id: 'velocityIndex',
    label: 'Velocity index vs cohort (cat × sub × unit × pack)',
    short: 'Vel idx',
    value: velocityIndex,
    format: fmtX,
    scaleKind: 'ratioBaseline1',
  },
  {
    id: 'effectivePriceIndex',
    label: 'Effective price index vs cohort',
    short: 'Price idx',
    value: effectivePriceIndex,
    format: fmtX,
    scaleKind: 'ratioBaseline1',
  },
  {
    id: 'gmPercentIndex',
    label: 'GM% vs cohort median (percentage points)',
    short: 'GM% Δ',
    value: gmPercentIndex,
    format: fmtPctSigned,
  },

  // --- pack / unit-size axes (added 2026-05-27) ---
  // packCount, unitSizeGrams, unitSizeMg come straight off the point.
  // "Total size" variants are derived from sales × unit size; pack
  // variants are pack × unit size (independent of sales).
  {
    id: 'packCount',
    label: 'Pack size (units per package)',
    short: 'Pack',
    value: (p) => p.packCount,
    format: fmtNum,
  },
  {
    id: 'unitSizeGrams',
    label: 'Unit size (grams)',
    short: 'Unit g',
    value: (p) => p.unitSizeGrams,
    format: fmtNum,
  },
  {
    id: 'unitSizeMg',
    label: 'Unit size (mg, edibles / tinctures)',
    short: 'Unit mg',
    value: (p) => p.unitSizeMg,
    format: fmtNum,
  },
  {
    id: 'packTotalGrams',
    label: 'Total grams per package (pack × unit size)',
    short: 'Pkg g',
    value: packTotalGrams,
    format: fmtNum,
  },
  {
    id: 'packTotalMg',
    label: 'Total mg per package (pack × unit size, edibles)',
    short: 'Pkg mg',
    value: packTotalMg,
    format: fmtNum,
  },
  {
    id: 'totalGramsSoldWindow',
    label: 'Total grams sold (units × unit size, window)',
    short: 'g sold',
    value: totalGramsSoldWindow,
    format: fmtNum,
  },
  {
    id: 'totalMgSoldWindow',
    label: 'Total mg sold (units × unit size, window, edibles)',
    short: 'mg sold',
    value: totalMgSoldWindow,
    format: fmtNum,
  },

  // --- market-data axes (added 2026-05-27) ---
  // Driven by live catalog_market_matches × fuzzy_skus listings.
  // `marketPricePretaxDollars` is null when no live matches exist;
  // derived axes return null in that case (chart drops the dot).
  {
    id: 'marketPricePretaxDollars',
    label: 'Market price (median pretax, $/unit)',
    short: 'Mkt $',
    value: (p) => p.marketPricePretaxDollars,
    format: fmtMoney,
  },
  {
    id: 'dollarsBelowMarket',
    label: '$ below market (market − list, pretax; +cheaper / −expensive)',
    short: '$ <mkt',
    value: dollarsBelowMarket,
    format: fmtMoney,
  },
  {
    id: 'percentBelowMarket',
    label: '% below market (market − list / market; +cheaper / −expensive)',
    short: '% <mkt',
    value: percentBelowMarket,
    format: fmtPctSigned,
  },
  {
    id: 'ourPriceOverMarket',
    label: 'List ÷ market ratio (1.0 = parity, <1 cheaper)',
    short: 'List/Mkt',
    value: ourPriceOverMarket,
    format: fmtX,
    scaleKind: 'ratioBaseline1',
  },
]

const POINT_AXES_BY_ID = new Map(POINT_AXES.map((a) => [a.id, a]))
function axis(id: string): PointAxisDef {
  return POINT_AXES_BY_ID.get(id) ?? POINT_AXES[0]!
}

// =================== No-sales plot defaults + clamps =======================
//
// The server returns EVERY in-filter variant (never-sold included, via
// LEFT JOIN), with window/sales-driven fields null when the variant had
// no sales in [from, to]. The scatter renderer drops any dot whose X or
// Y axis value is null — so a never-sold variant silently disappears
// instead of landing at a sensible "no movement" spot.
//
// That's bad for the merchandiser's core workflow: e.g. "reprice a
// just-received order whose receive-time prices lacked market data" —
// they want to see where those still-unsold items would fall on an
// "effective GM%" cohort scatter using their LIST-price default.
//
// Fix (per oracle design, June 2026): when a variant has NO window sales
// AND the inputs for a sensible default exist, substitute a list-price /
// no-movement default *for plot position only*. The API stays factual
// (null = no sales), cohort medians stay computed over sales-present
// variants only, and the tooltip flags the substitution. We also clamp
// weeks-of-supply to a 52-week ceiling UNIVERSALLY (even for sold
// variants) since >52 ≈ 52 materially and uncapped values blow out the
// axis. Missing list / cost / market / lab / size inputs are NOT
// defaultable — those nulls are genuinely unknown, so the dot stays
// hidden on axes that need them.
// ---------------------------------------------------------------------------

export const WEEKS_OF_SUPPLY_CAP = 52

/** No window sales ⇒ every sales-driven field is null (LEFT JOIN). */
export function hasNoWindowSales(p: CatalogAnalyticsPoint): boolean {
  return p.unitsSold == null && p.revenueDollars == null
}

function finiteOrNull(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null
}

/** List-default unit margin $ — what a unit would earn if sold at list. */
function listMarginDollarsPerUnit(p: CatalogAnalyticsPoint): number | null {
  if (p.listPriceDollars == null || p.wholesaleCostDollars == null) return null
  return p.listPriceDollars - p.wholesaleCostDollars
}

/**
 * Colour / size / opacity channels key off their own id namespaces
 * (e.g. `price`, `salesVelocity`) which don't all match the POINT_AXES
 * ids. Map them to the canonical axis id so one resolver covers every
 * channel.
 */
function canonicalPlotMetricId(id: string): string {
  switch (id) {
    case 'price':
      return 'otdUnitPriceDollars'
    case 'salesVelocity':
      return 'salesVelocityUnitsPerDay'
    case 'marginVelocity':
      return 'marginVelocityDollarsPerDay'
    case 'discountDepth':
      return 'discountDepthPercent'
    case 'salesDayCoverage':
      return 'salesDayCoveragePercent'
    case 'thc':
      return 'labThcPct'
    case 'pctBelowMarket':
      return 'percentBelowMarket'
    default:
      return id
  }
}

/** Universal clamps applied to BOTH real and defaulted plot values. */
function clampPlotValue(metricId: string, v: number | null): number | null {
  if (v == null || !Number.isFinite(v)) return null
  if (metricId === 'weeksOfSupplyOnHand') {
    return Math.max(0, Math.min(WEEKS_OF_SUPPLY_CAP, v))
  }
  if (metricId === 'salesDayCoveragePercent') {
    return Math.max(0, Math.min(100, v))
  }
  return v
}

/**
 * The no-sales substitute for a metric, or null when no sensible
 * default exists (missing list/cost/market/etc., or a metric that has
 * no "no movement" meaning). Only consulted when `hasNoWindowSales`.
 */
function noSalesPlotDefault(
  metricId: string,
  p: CatalogAnalyticsPoint,
  ctx: AxisCtx,
): number | null {
  switch (metricId) {
    // True no-movement totals / rates → zero.
    case 'unitsSold':
    case 'revenueDollars':
    case 'cogsDollars':
    case 'marginDollars':
    case 'salesVelocityUnitsPerDay':
    case 'marginVelocityDollarsPerDay':
    case 'invoiceCount':
    case 'daysWithSales':
    case 'salesDayCoveragePercent':
    case 'unitsPerInvoice':
    case 'marginPerInvoiceDollars':
    case 'totalGramsSoldWindow':
    case 'totalMgSoldWindow':
      // grams/mg "sold" totals are zero only if the size unit applies.
      if (metricId === 'totalGramsSoldWindow') return p.unitSizeGrams == null ? null : 0
      if (metricId === 'totalMgSoldWindow') return p.unitSizeMg == null ? null : 0
      return 0

    // Effective price / margin economics → fall back to LIST defaults.
    case 'avgUnitPriceDollars':
      return finiteOrNull(p.listPriceDollars)
    case 'otdUnitPriceDollars':
      return listOtdPriceDollars(p)
    case 'marginDollarsPerUnit':
      return listMarginDollarsPerUnit(p)
    case 'gmPercent':
      return listGmPercent(p)

    // Discount vs list → none realized when never sold.
    case 'discountDollarsPerUnit':
      return p.listPriceDollars == null ? null : 0
    case 'discountDepthPercent':
      return p.listPriceDollars != null && p.listPriceDollars > 0 ? 0 : null
    case 'priceRealizationPercent':
      return p.listPriceDollars != null && p.listPriceDollars > 0 ? 100 : null

    // Weeks of supply: infinite runway with stock on hand → cap; no
    // stock → 0; unknown on-hand → can't place.
    case 'weeksOfSupplyOnHand':
      if (p.currentQty == null) return null
      return p.currentQty <= 0 ? 0 : WEEKS_OF_SUPPLY_CAP

    // Cohort-relative indexes use the LIST default as the numerator,
    // against the (sales-present) cohort median denominator.
    case 'velocityIndex': {
      const m = ctx.cohortMedians.get(cohortKey(p))
      return m?.velocityUnitsPerDay && m.velocityUnitsPerDay > 0 ? 0 : null
    }
    case 'effectivePriceIndex': {
      const listOtd = listOtdPriceDollars(p)
      const m = ctx.cohortMedians.get(cohortKey(p))
      if (listOtd == null || !m?.effectiveOtdPriceDollars) return null
      return listOtd / m.effectiveOtdPriceDollars
    }
    case 'gmPercentIndex': {
      const listGm = listGmPercent(p)
      const m = ctx.cohortMedians.get(cohortKey(p))
      if (listGm == null || m?.gmPercent == null) return null
      return listGm - m.gmPercent
    }

    default:
      // Sales-independent metrics (list price, lab, market, pack/size)
      // and anything unrecognized: no no-sales substitute.
      return null
  }
}

/**
 * Resolve the value used to PLOT a metric for one variant: the real
 * value when present (clamped), else a no-sales default (clamped) when
 * the variant had no window sales, else null (dot stays hidden).
 */
export function plotMetricValue(
  metricIdRaw: string,
  rawValue: number | null,
  p: CatalogAnalyticsPoint,
  ctx: AxisCtx,
): number | null {
  const metricId = canonicalPlotMetricId(metricIdRaw)
  const raw = finiteOrNull(rawValue)
  if (raw != null) return clampPlotValue(metricId, raw)
  if (!hasNoWindowSales(p)) return null
  return clampPlotValue(metricId, noSalesPlotDefault(metricId, p, ctx))
}

// =========================== Colour-by (cohort) ============================

// Categorical colour-by id list. Continuous colour-by ids are listed
// below in CONTINUOUS_COLOUR_BY. Kept as two distinct unions so the
// pickers and the renderer can branch on `kind` without runtime
// shenanigans.
type CategoricalColourByKey =
  | 'none'
  | 'category'
  | 'subcategory'
  | 'brand'
  | 'distributor'
  | 'sizeLabel'
  | 'packCount'

type ContinuousColourByKey =
  | 'price'
  | 'thc'
  | 'discountDepth'
  | 'gmPercent'
  | 'marginDollarsPerUnit'
  | 'salesVelocity'
  | 'pctBelowMarket'

type ColourByKey = CategoricalColourByKey | ContinuousColourByKey

interface CategoricalColourByDef {
  readonly kind: 'categorical'
  readonly id: CategoricalColourByKey
  readonly label: string
  readonly bucket: (p: CatalogAnalyticsPoint) => string
}

interface ContinuousColourByDef {
  readonly kind: 'continuous'
  readonly id: ContinuousColourByKey
  readonly label: string
  /** Pulled into the dot's colour AFTER the per-card distribution-aware stretch. */
  readonly value: (p: CatalogAnalyticsPoint, ctx: AxisCtx) => number | null
  /** Drives which end of the red→green ramp is "good". */
  readonly betterDirection: BetterDirection
  /** Used in the legend's min / max labels. */
  readonly format: (v: number) => string
}

type ColourByDef = CategoricalColourByDef | ContinuousColourByDef

const CATEGORICAL_COLOUR_BY: ReadonlyArray<CategoricalColourByDef> = [
  { kind: 'categorical', id: 'none', label: 'single colour', bucket: () => 'all' },
  {
    kind: 'categorical',
    id: 'category',
    label: 'category',
    bucket: (p) => p.categoryName ?? '(none)',
  },
  {
    kind: 'categorical',
    id: 'subcategory',
    label: 'subcategory',
    bucket: (p) => p.subcategoryName ?? '(none)',
  },
  {
    kind: 'categorical',
    id: 'brand',
    label: 'brand',
    bucket: (p) => p.brandName ?? '(none)',
  },
  {
    kind: 'categorical',
    id: 'distributor',
    label: 'distributor',
    bucket: (p) => p.distributorName ?? '(none)',
  },
  {
    kind: 'categorical',
    id: 'sizeLabel',
    label: 'size',
    bucket: (p) => p.sizeLabel ?? '(none)',
  },
  {
    kind: 'categorical',
    id: 'packCount',
    label: 'pack count',
    bucket: (p) =>
      p.packCount == null
        ? '(no pack)'
        : p.packCount === 1
        ? '1 per pkg'
        : `${p.packCount}-pack`,
  },
]

// Continuous colour-by axes drive a red→green diverging ramp where
// the colour intensity reflects the value's percentile within the
// current scatter slice — see continuousScale.ts for the per-card
// stretch logic and ramp definition. `betterDirection` decides which
// end of the ramp is "good"; mid-band is intentionally dull so
// outliers in either direction pop visually.
const CONTINUOUS_COLOUR_BY: ReadonlyArray<ContinuousColourByDef> = [
  {
    kind: 'continuous',
    id: 'gmPercent',
    label: 'effective GM % (red→green)',
    value: (p) => p.gmPercent,
    betterDirection: 'higher',
    format: fmtPct,
  },
  {
    kind: 'continuous',
    id: 'marginDollarsPerUnit',
    label: 'margin $ per unit (red→green)',
    value: (p) => p.marginDollarsPerUnit,
    betterDirection: 'higher',
    format: fmtMoney,
  },
  {
    kind: 'continuous',
    id: 'salesVelocity',
    label: 'sales velocity units/day (red→green)',
    value: (p) => p.salesVelocityUnitsPerDay,
    betterDirection: 'higher',
    format: fmtNum,
  },
  {
    kind: 'continuous',
    id: 'price',
    label: 'OTD price ($/unit, red→green, higher = pricier)',
    value: (p) => p.otdUnitPriceDollars,
    // Neither end is unambiguously "good"; we pick `higher` so dear
    // SKUs stand out (they're the ones the operator usually wants to
    // notice — a $200 cart is far more interesting than a $35 8th).
    betterDirection: 'higher',
    format: fmtMoney,
  },
  {
    kind: 'continuous',
    id: 'thc',
    label: 'lab THC % (red→green)',
    value: (p) => p.labThcPct,
    betterDirection: 'higher',
    format: fmtPct,
  },
  {
    kind: 'continuous',
    id: 'discountDepth',
    label: 'discount depth % (lower = greener; higher = redder)',
    value: (p) => discountDepthPercent(p),
    // Deeper promo discount = more margin given up. From a merchandising
    // / pricing-power perspective, lower is healthier. (The
    // shopper-eye perspective is the opposite, but the operator
    // looking at this scatter is the merchandiser.)
    betterDirection: 'lower',
    format: fmtPct,
  },
  {
    kind: 'continuous',
    id: 'pctBelowMarket',
    label: '% below market (higher = greener)',
    value: percentBelowMarket,
    betterDirection: 'higher',
    format: fmtPctSigned,
  },
]

const COLOUR_BY: ReadonlyArray<ColourByDef> = [
  ...CATEGORICAL_COLOUR_BY,
  ...CONTINUOUS_COLOUR_BY,
]

// ============================ Size-by (per-dot) ============================
//
// Operators kept asking us to "fit more information on the graph", so each
// scatter dot can be sized by an additional dimension. The renderer scales
// the radius between MIN_R and MAX_R using sqrt() of the value (since
// visual weight is area, not linear). 'none' means uniform 3.5px dots.

type SizeByKey =
  | 'none'
  | 'unitsSold'
  | 'revenueDollars'
  | 'marginDollars'
  | 'invoiceCount'
  | 'currentQty'
  | 'daysWithSales'
  | 'marginVelocity'

interface SizeByDef {
  readonly id: SizeByKey
  readonly label: string
  readonly value: (p: CatalogAnalyticsPoint, ctx: AxisCtx) => number | null
  /**
   * Drives the distribution-aware stretch. `higher` (the default)
   * means bigger dot = bigger raw value; `lower` would flip it
   * (smaller dot = bigger raw value). Currently every size-by has
   * `higher` semantics — kept on the def so future "weeks-of-supply
   * over-stock" / "days-out-of-stock" can flip the encoding without
   * touching the renderer.
   */
  readonly betterDirection?: BetterDirection
  /** Used by the size legend's min / max labels. */
  readonly format?: (v: number) => string
}

const SIZE_BY: ReadonlyArray<SizeByDef> = [
  { id: 'none', label: 'uniform', value: () => null },
  { id: 'unitsSold', label: 'units sold', value: (p) => p.unitsSold, format: fmtNum },
  {
    id: 'revenueDollars',
    label: 'revenue $',
    value: (p) => p.revenueDollars,
    format: fmtMoneyShort,
  },
  { id: 'marginDollars', label: 'margin $', value: (p) => p.marginDollars, format: fmtMoneyShort },
  { id: 'invoiceCount', label: 'invoice count', value: (p) => p.invoiceCount, format: fmtNum },
  { id: 'currentQty', label: 'on-hand qty', value: (p) => p.currentQty, format: fmtNum },
  {
    id: 'daysWithSales',
    label: 'days with sales',
    value: (p) => p.daysWithSales,
    format: fmtNum,
  },
  {
    id: 'marginVelocity',
    label: 'margin $/day',
    value: (p) => p.marginVelocityDollarsPerDay,
    format: fmtMoney,
  },
]

const SIZE_BY_BY_ID = new Map(SIZE_BY.map((s) => [s.id, s]))
function sizeBy(id: SizeByKey): SizeByDef {
  return SIZE_BY_BY_ID.get(id) ?? SIZE_BY[0]!
}

// ============================ Opacity-by (per-dot) =========================
//
// Pairs with size-by so the operator can cram a third (or fourth) data
// channel onto the scatter — e.g. "color by brand, size by margin $,
// fade by sales-day coverage" makes promo-driven blips visibly fainter
// than organic staples.

type OpacityByKey =
  | 'none'
  | 'salesDayCoverage'
  | 'invoiceCount'
  | 'unitsSold'
  | 'gmPercent'
  | 'discountDepth'

interface OpacityByDef {
  readonly id: OpacityByKey
  readonly label: string
  readonly value: (p: CatalogAnalyticsPoint, ctx: AxisCtx) => number | null
  /** Default: 'higher'. Used by the distribution-aware stretch. */
  readonly betterDirection?: BetterDirection
  readonly format?: (v: number) => string
}

const OPACITY_BY: ReadonlyArray<OpacityByDef> = [
  { id: 'none', label: 'uniform', value: () => null },
  {
    id: 'salesDayCoverage',
    label: 'sales-day coverage %',
    value: salesDayCoveragePercent,
    format: fmtPct,
  },
  { id: 'invoiceCount', label: 'invoice count', value: (p) => p.invoiceCount, format: fmtNum },
  { id: 'unitsSold', label: 'units sold', value: (p) => p.unitsSold, format: fmtNum },
  { id: 'gmPercent', label: 'effective GM %', value: (p) => p.gmPercent, format: fmtPct },
  {
    id: 'discountDepth',
    label: 'discount depth %',
    value: (p) => discountDepthPercent(p),
    format: fmtPct,
  },
]

const OPACITY_BY_BY_ID = new Map(OPACITY_BY.map((o) => [o.id, o]))
function opacityBy(id: OpacityByKey): OpacityByDef {
  return OPACITY_BY_BY_ID.get(id) ?? OPACITY_BY[0]!
}

// ============================================================================
// Page-wide scatter encoding defaults (persisted via /api/metrics-defaults)
//
// The Catalog analytics tab AND the embedded brand / distributor detail
// scatters share one set of page-wide encodings. These helpers let the
// "Update defaults" admin flow capture, hydrate, label, and diff them
// without the metrics layout needing to know the (large, client-only)
// colour/size/opacity unions.
// ============================================================================

/** A page-wide scatter encoding selection ('per-chart' = defer to each card). */
export type PageScatterValue<K extends string> = K | 'per-chart'
export interface PageScatterEncoding {
  readonly colourBy: PageScatterValue<ColourByKey>
  readonly sizeBy: PageScatterValue<SizeByKey>
  readonly opacityBy: PageScatterValue<OpacityByKey>
}

/** Part-1 code defaults: colour by brand, size by margin $/day. */
export const SCATTER_CODE_DEFAULTS: PageScatterEncoding = {
  colourBy: 'brand',
  sizeBy: 'marginVelocity',
  opacityBy: 'per-chart',
}

const COLOUR_BY_IDS = new Set<string>(COLOUR_BY.map((c) => c.id))
const SIZE_BY_IDS = new Set<string>(SIZE_BY.map((s) => s.id))
const OPACITY_BY_IDS = new Set<string>(OPACITY_BY.map((o) => o.id))

/**
 * Resolve a stored (untrusted) scatter slice against the known encoding
 * ids, falling back to the code defaults for any missing / unknown
 * value. Keeps junk in a stale DB blob from breaking the page.
 */
export function resolveScatterDefaults(stored?: {
  colourBy?: string
  sizeBy?: string
  opacityBy?: string
}): PageScatterEncoding {
  const pick = <K extends string>(
    raw: string | undefined,
    ids: Set<string>,
    fallback: PageScatterValue<K>,
  ): PageScatterValue<K> => {
    if (raw === 'per-chart') return 'per-chart'
    if (raw !== undefined && ids.has(raw)) return raw as K
    return fallback
  }
  return {
    colourBy: pick(stored?.colourBy, COLOUR_BY_IDS, SCATTER_CODE_DEFAULTS.colourBy),
    sizeBy: pick(stored?.sizeBy, SIZE_BY_IDS, SCATTER_CODE_DEFAULTS.sizeBy),
    opacityBy: pick(stored?.opacityBy, OPACITY_BY_IDS, SCATTER_CODE_DEFAULTS.opacityBy),
  }
}

/** Human label for a page-wide scatter encoding value. */
export function scatterEncodingLabel(
  channel: 'colourBy' | 'sizeBy' | 'opacityBy',
  value: string,
): string {
  if (value === 'per-chart') return 'per chart'
  const list =
    channel === 'colourBy' ? COLOUR_BY : channel === 'sizeBy' ? SIZE_BY : OPACITY_BY
  return (list as ReadonlyArray<{ id: string; label: string }>).find((d) => d.id === value)
    ?.label ?? value
}

/** Diff two scatter encodings into labelled change rows (empty = identical). */
export function scatterChangeRows(
  before: PageScatterEncoding,
  after: PageScatterEncoding,
): Array<{ label: string; before: string; after: string }> {
  const rows: Array<{ label: string; before: string; after: string }> = []
  const channels: Array<{ key: keyof PageScatterEncoding; label: string }> = [
    { key: 'colourBy', label: 'Scatter — colour by' },
    { key: 'sizeBy', label: 'Scatter — size by' },
    { key: 'opacityBy', label: 'Scatter — opacity by' },
  ]
  for (const { key, label } of channels) {
    if (before[key] !== after[key]) {
      rows.push({
        label,
        before: scatterEncodingLabel(key, before[key]),
        after: scatterEncodingLabel(key, after[key]),
      })
    }
  }
  return rows
}

// Same palette as the line chart so the look is consistent across the
// dashboard. (Picked for legibility on the light theme.)
const PALETTE = [
  '#1f77b4',
  '#d62728',
  '#2ca02c',
  '#9467bd',
  '#ff7f0e',
  '#8c564b',
  '#e377c2',
  '#17becf',
  '#bcbd22',
  '#7f7f7f',
]

function colourFor(bucket: string, allBuckets: ReadonlyArray<string>): string {
  if (bucket === 'all') return PALETTE[0]!
  const idx = allBuckets.indexOf(bucket)
  if (idx < 0) return PALETTE[0]!
  return PALETTE[idx % PALETTE.length]!
}

// ============================== Card defaults ==============================

interface ScatterCardConfig {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly defaultX: string
  readonly defaultY: string
  readonly defaultColourBy: ColourByKey
  /** Per-dot radius encoding (optional; defaults to uniform). */
  readonly defaultSizeBy?: SizeByKey
  /** Per-dot opacity encoding (optional; defaults to uniform). */
  readonly defaultOpacityBy?: OpacityByKey
  /**
   * Optional reference annotation rendered on the plot.
   *   - 'diagonal'  : y = x line in plot-space (sensible when X / Y
   *                   units match — e.g. List OTD vs Effective OTD,
   *                   List GM% vs Effective GM%).
   *   - 'unit'      : horizontal at y=1 (sensible for index axes
   *                   where 1.0× = cohort median).
   */
  readonly referenceLine?: 'diagonal' | 'unit-y' | 'unit-x'
  /**
   * Sub-tab this card lives under. Cards with the same `section`
   * are grouped onto the same sub-tab inside the catalog analytics
   * page. Defaults to "Core merchandising".
   */
  readonly section?: string
}

// Sub-tabs in display order. Each card carries its own `section`; cards
// without a section default to "Core merchandising".
const SECTION_CORE = 'Core merchandising'
const SECTION_PROMO = 'Promo erosion'
const SECTION_COHORT = 'Cohort-relative'
const SECTION_BASKET = 'Basket / inventory'
const SECTION_PROFIT = 'Profit engine'
const SECTION_POTENCY = 'Cannabinoid economics'
const SECTION_DEMAND = 'Demand quality'
const SECTION_TRAPS = 'Inventory traps'

const SECTIONS_IN_ORDER: ReadonlyArray<string> = [
  SECTION_CORE,
  SECTION_PROFIT,
  SECTION_PROMO,
  SECTION_COHORT,
  SECTION_POTENCY,
  SECTION_DEMAND,
  SECTION_BASKET,
  SECTION_TRAPS,
]

const DEFAULT_CARDS: ReadonlyArray<ScatterCardConfig> = [
  // ----- Core merchandising -----
  {
    id: 'otd-vs-margin-per-unit',
    title: 'OTD price vs margin $/unit',
    description:
      'Where on the shelf-price ladder does each variant land for per-unit margin? Points up and to the right are price-elastic winners.',
    defaultX: 'otdUnitPriceDollars',
    defaultY: 'marginDollarsPerUnit',
    defaultColourBy: 'subcategory',
    section: SECTION_CORE,
  },
  {
    id: 'otd-vs-velocity',
    title: 'OTD price vs sales velocity',
    description: 'Demand curve view — find the price points the market actually buys.',
    defaultX: 'otdUnitPriceDollars',
    defaultY: 'salesVelocityUnitsPerDay',
    defaultColourBy: 'subcategory',
    section: SECTION_CORE,
  },
  {
    id: 'otd-vs-gm-pct',
    title: 'OTD price vs GM %',
    description: 'High-margin variants at premium price points cluster in the upper-right.',
    defaultX: 'otdUnitPriceDollars',
    defaultY: 'gmPercent',
    defaultColourBy: 'brand',
    section: SECTION_CORE,
  },
  {
    id: 'gm-pct-vs-velocity',
    title: 'GM % vs sales velocity',
    description:
      'Star quadrant (top-right): high-margin AND fast-moving. Lower-left: kill candidates.',
    defaultX: 'gmPercent',
    defaultY: 'salesVelocityUnitsPerDay',
    defaultColourBy: 'subcategory',
    section: SECTION_CORE,
  },
  {
    id: 'velocity-vs-thc',
    title: 'Sales velocity vs THC %',
    description: 'Does potency drive throughput within this filter slice?',
    defaultX: 'labThcPct',
    defaultY: 'salesVelocityUnitsPerDay',
    defaultColourBy: 'brand',
    section: SECTION_CORE,
  },
  {
    id: 'margin-vs-thc',
    title: 'Margin $/unit vs THC %',
    description: 'Potency premium check — are we charging more per unit for high-THC SKUs?',
    defaultX: 'labThcPct',
    defaultY: 'marginDollarsPerUnit',
    defaultColourBy: 'brand',
    section: SECTION_CORE,
  },
  {
    id: 'cost-vs-margin',
    title: 'Wholesale cost vs margin $/unit',
    description: 'Margin lift over cost. A flat line = constant markup; spread = pricing leverage.',
    defaultX: 'wholesaleCostDollars',
    defaultY: 'marginDollarsPerUnit',
    defaultColourBy: 'brand',
    section: SECTION_CORE,
  },
  {
    id: 'thc-vs-otd',
    title: 'THC % vs OTD price',
    description: 'Are we capturing a potency premium on shelf price?',
    defaultX: 'labThcPct',
    defaultY: 'otdUnitPriceDollars',
    defaultColourBy: 'brand',
    section: SECTION_CORE,
  },

  // ----- List vs effective (promo erosion) -----
  //
  // These six expose where shelf price diverges from what the operator
  // actually receives at checkout — the operator's "are promos earning
  // their keep?" view. Reference diagonal added where X and Y share
  // units so eyeballing the spread vs the y=x line tells the story.
  {
    id: 'list-otd-vs-effective-otd',
    title: 'List OTD vs effective OTD price',
    description:
      'Diagonal = sell-at-list. Distance below the diagonal = how much per-unit revenue is being given up to promos. Big-volume points far below the line are where promo behaviour materially changes economics.',
    defaultX: 'listOtdPriceDollars',
    defaultY: 'otdUnitPriceDollars',
    defaultColourBy: 'discountDepth',
    referenceLine: 'diagonal',
    section: SECTION_PROMO,
  },
  {
    id: 'list-gm-vs-effective-gm',
    title: 'List GM% vs effective GM%',
    description:
      'Cleanest "promo margin erosion" view. Points on the diagonal sell at list margin; points below diagonal lose GM% to promos. Healthy-on-paper SKUs that have actually weak realized margin show up bottom-right.',
    defaultX: 'listGmPercent',
    defaultY: 'gmPercent',
    defaultColourBy: 'subcategory',
    referenceLine: 'diagonal',
    section: SECTION_PROMO,
  },
  {
    id: 'discount-vs-effective-gm',
    title: 'Discount depth % vs effective GM %',
    description:
      'The margin cliff. Where does the next 5 points of discount destroy 15 points of margin? Brands/SKUs at the bottom-right are most exposed.',
    defaultX: 'discountDepthPercent',
    defaultY: 'gmPercent',
    defaultColourBy: 'subcategory',
    section: SECTION_PROMO,
  },
  {
    id: 'discount-vs-contribution',
    title: 'Discount depth % vs contribution $/day',
    description:
      'Did the discount create profitable throughput or just cheap volume? Top-right = promo-responsive winners; bottom-right = burning money on volume.',
    defaultX: 'discountDepthPercent',
    defaultY: 'marginVelocityDollarsPerDay',
    defaultColourBy: 'gmPercent',
    section: SECTION_PROMO,
  },
  {
    id: 'discount-vs-velocity-index',
    title: 'Discount depth % vs velocity index (cohort)',
    description:
      'Promo responsiveness normalised against cat × sub × size peers. High-discount + high-index = promo-responsive winners. High-discount + low-index = bad promos / weak demand.',
    defaultX: 'discountDepthPercent',
    defaultY: 'velocityIndex',
    defaultColourBy: 'gmPercent',
    referenceLine: 'unit-y',
    section: SECTION_PROMO,
  },
  {
    id: 'realization-vs-margin-per-unit',
    title: 'Price realization % vs margin $/unit',
    description:
      'How much list-price leakage can the SKU tolerate before unit economics break? Premium brands may still deliver strong $/unit even with modest discounting.',
    defaultX: 'priceRealizationPercent',
    defaultY: 'marginDollarsPerUnit',
    defaultColourBy: 'brand',
    section: SECTION_PROMO,
  },

  // ----- Cohort-relative -----
  //
  // Use stable same-category/subcategory/unit-size/pack-size cohort medians
  // from the selected site/date universe. Brand/distributor/category/size
  // filters narrow the displayed dots, never the benchmark universe. The
  // diagonals at 1× / 0pp anchor the eye on "at-median" cleanly.
  {
    id: 'price-index-vs-velocity-index',
    title: 'Price index vs velocity index (cohort)',
    description:
      'Quadrants: premium winners (top-right), value workhorses (top-left), overpriced laggards (bottom-right), cheap-but-slow (bottom-left).',
    defaultX: 'effectivePriceIndex',
    defaultY: 'velocityIndex',
    defaultColourBy: 'subcategory',
    referenceLine: 'unit-y',
    section: SECTION_COHORT,
  },
  {
    id: 'gm-delta-vs-velocity-index',
    title: 'GM% vs cohort median vs velocity index',
    description:
      'Margin pricing power view. Top-right = SKUs out-performing peers on BOTH margin and velocity.',
    defaultX: 'gmPercentIndex',
    defaultY: 'velocityIndex',
    defaultColourBy: 'brand',
    referenceLine: 'unit-y',
    section: SECTION_COHORT,
  },

  // ----- Basket / inventory health -----
  {
    id: 'coverage-vs-discount',
    title: 'Sales-day coverage % vs discount depth %',
    description:
      'Distinguishes reliable demand from promo-driven spikes. Top-left = organic staple; top-right = promo-dependent staple; bottom-right = event/clearance behaviour; bottom-left = weak visibility.',
    defaultX: 'salesDayCoveragePercent',
    defaultY: 'discountDepthPercent',
    defaultColourBy: 'gmPercent',
    section: SECTION_BASKET,
  },
  {
    id: 'units-per-invoice-vs-margin-per-invoice',
    title: 'Units per invoice vs margin $/invoice',
    description:
      'Basket role view. SKUs with high units/invoice but low margin/invoice are multi-buy promo magnets that dilute basket economics.',
    defaultX: 'unitsPerInvoice',
    defaultY: 'marginPerInvoiceDollars',
    defaultColourBy: 'discountDepth',
    section: SECTION_BASKET,
  },
  {
    id: 'weeks-of-supply-vs-contribution',
    title: 'Weeks of supply vs contribution $/day',
    description:
      'Replenishment + markdown radar. Top-right = high-profit, needs reorder. Bottom-right = dead inventory candidates for markdown.',
    defaultX: 'weeksOfSupplyOnHand',
    defaultY: 'marginVelocityDollarsPerDay',
    defaultColourBy: 'gmPercent',
    section: SECTION_BASKET,
  },
  {
    id: 'onhand-vs-velocity',
    title: 'On-hand qty vs sales velocity',
    description:
      'Top-left: low stock fast movers (reorder!). Bottom-right: deep inventory of slow movers.',
    defaultX: 'currentQty',
    defaultY: 'salesVelocityUnitsPerDay',
    defaultColourBy: 'subcategory',
    section: SECTION_BASKET,
  },

  // ----- Profit engine -----
  //
  // These views answer "what is actually paying the rent right now?"
  // Most use revenue / margin totals or velocities so size-by/opacity-by
  // can encode an additional volume signal without burying the geometry.
  {
    id: 'margin-velocity-vs-revenue',
    title: 'Margin $/day vs revenue ($ window)',
    description:
      'Profit engine map. Top-right = both high-revenue AND high-profit. Bottom-right = high revenue but thin margin (volume burners).',
    defaultX: 'revenueDollars',
    defaultY: 'marginVelocityDollarsPerDay',
    defaultColourBy: 'subcategory',
    defaultSizeBy: 'unitsSold',
    defaultOpacityBy: 'salesDayCoverage',
    section: SECTION_PROFIT,
  },
  {
    id: 'margin-velocity-vs-units',
    title: 'Margin $/day vs units sold',
    description:
      'Throughput-to-profit translation. Slope shows realized margin per unit; outliers above the cloud earn outsized margin per unit.',
    defaultX: 'unitsSold',
    defaultY: 'marginVelocityDollarsPerDay',
    defaultColourBy: 'gmPercent',
    defaultSizeBy: 'revenueDollars',
    section: SECTION_PROFIT,
  },
  {
    id: 'margin-velocity-vs-invoice-count',
    title: 'Margin $/day vs invoice count',
    description:
      'How many baskets does it take to make a dollar? Tight cloud = consistent contribution per basket.',
    defaultX: 'invoiceCount',
    defaultY: 'marginVelocityDollarsPerDay',
    defaultColourBy: 'brand',
    defaultSizeBy: 'marginDollars',
    section: SECTION_PROFIT,
  },
  {
    id: 'revenue-vs-gm-pct',
    title: 'Revenue ($) vs effective GM %',
    description:
      'Where does the chain make money? Top-right = big-revenue, healthy-margin SKUs. Bottom-right = small but very high-margin niche items.',
    defaultX: 'revenueDollars',
    defaultY: 'gmPercent',
    defaultColourBy: 'subcategory',
    defaultSizeBy: 'marginDollars',
    defaultOpacityBy: 'salesDayCoverage',
    section: SECTION_PROFIT,
  },
  {
    id: 'revenue-vs-margin',
    title: 'Revenue ($) vs margin ($) — both window totals',
    description:
      'Slope = realized GM%. SKUs above the cloud convert disproportionately well; below = revenue without profit.',
    defaultX: 'revenueDollars',
    defaultY: 'marginDollars',
    defaultColourBy: 'gmPercent',
    defaultSizeBy: 'unitsSold',
    section: SECTION_PROFIT,
  },
  {
    id: 'revenue-vs-velocity',
    title: 'Revenue ($) vs sales velocity (units/day)',
    description:
      'Price-tier dependence of throughput. Cheap things rack up units; premium things rack up dollars without comparable unit pace.',
    defaultX: 'salesVelocityUnitsPerDay',
    defaultY: 'revenueDollars',
    defaultColourBy: 'price',
    defaultSizeBy: 'marginDollars',
    section: SECTION_PROFIT,
  },
  {
    id: 'margin-vs-invoice-count',
    title: 'Margin ($ window) vs invoice count',
    description:
      'A linear cloud means margin scales with reach; outliers above earn more per basket than peers.',
    defaultX: 'invoiceCount',
    defaultY: 'marginDollars',
    defaultColourBy: 'subcategory',
    defaultSizeBy: 'unitsSold',
    section: SECTION_PROFIT,
  },
  {
    id: 'margin-per-invoice-vs-invoice-count',
    title: 'Margin $/invoice vs invoice count',
    description:
      'Premium-basket vs frequency view. Top-right = wide-reach premium contributors; bottom-right = high reach, thin contribution.',
    defaultX: 'invoiceCount',
    defaultY: 'marginPerInvoiceDollars',
    defaultColourBy: 'gmPercent',
    defaultSizeBy: 'marginDollars',
    section: SECTION_PROFIT,
  },
  {
    id: 'units-vs-margin',
    title: 'Units sold vs margin ($ window)',
    description:
      'Slope shows margin per unit; the higher above the cloud, the more profit each unit contributes.',
    defaultX: 'unitsSold',
    defaultY: 'marginDollars',
    defaultColourBy: 'price',
    defaultOpacityBy: 'salesDayCoverage',
    section: SECTION_PROFIT,
  },

  // ----- Cannabinoid economics -----
  //
  // Potency vs price/margin views. Defaults all set so size-by/opacity-by
  // can carry volume signal without making low-volume noise dominate.
  {
    id: 'thc-vs-gm-pct',
    title: 'THC % vs effective GM %',
    description:
      'Are we capturing margin on potency or giving it back through promos? Top-right = potency premium realized.',
    defaultX: 'labThcPct',
    defaultY: 'gmPercent',
    defaultColourBy: 'subcategory',
    defaultSizeBy: 'marginDollars',
    defaultOpacityBy: 'salesDayCoverage',
    section: SECTION_POTENCY,
  },
  {
    id: 'thc-vs-price-realization',
    title: 'THC % vs price realization %',
    description:
      'High-potency SKUs that nonetheless need deep promos to move show up bottom-right and are pricing-power suspects.',
    defaultX: 'labThcPct',
    defaultY: 'priceRealizationPercent',
    defaultColourBy: 'brand',
    defaultSizeBy: 'unitsSold',
    section: SECTION_POTENCY,
  },
  {
    id: 'thc-vs-effective-price-index',
    title: 'THC % vs effective price index (cohort)',
    description:
      'Within cohort, do higher-potency SKUs realize a price premium? Top-right = yes; flat/negative slope = potency is not currently being paid for.',
    defaultX: 'labThcPct',
    defaultY: 'effectivePriceIndex',
    defaultColourBy: 'subcategory',
    referenceLine: 'unit-y',
    defaultSizeBy: 'unitsSold',
    section: SECTION_POTENCY,
  },
  {
    id: 'thc-vs-revenue',
    title: 'THC % vs revenue ($ window)',
    description:
      'How much revenue is concentrated at which potency? Useful for spotting whether assortment depth matches consumer interest.',
    defaultX: 'labThcPct',
    defaultY: 'revenueDollars',
    defaultColourBy: 'subcategory',
    defaultSizeBy: 'unitsSold',
    section: SECTION_POTENCY,
  },
  {
    id: 'thc-vs-discount-depth',
    title: 'THC % vs discount depth %',
    description:
      'Are we over-discounting strong-potency stock? Top-right = high potency AND deeply discounted — sometimes a leakage signal, sometimes a clearance signal.',
    defaultX: 'labThcPct',
    defaultY: 'discountDepthPercent',
    defaultColourBy: 'brand',
    defaultSizeBy: 'unitsSold',
    section: SECTION_POTENCY,
  },
  {
    id: 'cbd-vs-gm-pct',
    title: 'CBD % vs effective GM %',
    description:
      'CBD-leaning SKUs often serve a different customer; margin profile here helps see whether the segment is paying its way.',
    defaultX: 'labCbdPct',
    defaultY: 'gmPercent',
    defaultColourBy: 'subcategory',
    defaultSizeBy: 'marginDollars',
    section: SECTION_POTENCY,
  },
  {
    id: 'cbd-vs-velocity',
    title: 'CBD % vs sales velocity',
    description:
      'Throughput by CBD presence. Tells you whether the high-CBD shelf is doing real work or just sitting.',
    defaultX: 'labCbdPct',
    defaultY: 'salesVelocityUnitsPerDay',
    defaultColourBy: 'brand',
    defaultSizeBy: 'revenueDollars',
    section: SECTION_POTENCY,
  },
  {
    id: 'thc-vs-cost',
    title: 'THC % vs wholesale cost',
    description:
      'Where is potency embedded in cost? Steep slope = vendors are charging us for potency; flat = we have headroom.',
    defaultX: 'labThcPct',
    defaultY: 'wholesaleCostDollars',
    defaultColourBy: 'brand',
    defaultSizeBy: 'currentQty',
    section: SECTION_POTENCY,
  },
  {
    id: 'thc-vs-list-price',
    title: 'THC % vs list price',
    description:
      'Pricing-discipline view: are our shelf prices already structured to charge for potency?',
    defaultX: 'labThcPct',
    defaultY: 'listPriceDollars',
    defaultColourBy: 'subcategory',
    defaultSizeBy: 'unitsSold',
    section: SECTION_POTENCY,
  },

  // ----- Demand quality -----
  //
  // "Is this SKU's demand healthy?" — durability of sales across the
  // window, basket behaviour, invoice-count vs unit-pace shape.
  {
    id: 'coverage-vs-velocity',
    title: 'Sales-day coverage % vs sales velocity',
    description:
      'Steady earners pile up at the upper-right (sells most days, sells fast). Bottom-right is bursty / promo-driven; top-left is consistent low pace.',
    defaultX: 'salesDayCoveragePercent',
    defaultY: 'salesVelocityUnitsPerDay',
    defaultColourBy: 'subcategory',
    defaultSizeBy: 'marginDollars',
    section: SECTION_DEMAND,
  },
  {
    id: 'coverage-vs-invoices',
    title: 'Sales-day coverage % vs invoice count',
    description:
      'Distinguishes steady-but-shallow from bursty-but-broad demand patterns.',
    defaultX: 'salesDayCoveragePercent',
    defaultY: 'invoiceCount',
    defaultColourBy: 'gmPercent',
    defaultSizeBy: 'revenueDollars',
    section: SECTION_DEMAND,
  },
  {
    id: 'coverage-vs-units',
    title: 'Sales-day coverage % vs units sold',
    description:
      'Spot SKUs that sell a lot in a few days (clearance, drops) vs spread evenly across the window.',
    defaultX: 'salesDayCoveragePercent',
    defaultY: 'unitsSold',
    defaultColourBy: 'discountDepth',
    defaultSizeBy: 'marginDollars',
    section: SECTION_DEMAND,
  },
  {
    id: 'coverage-vs-gm-pct',
    title: 'Sales-day coverage % vs effective GM %',
    description:
      'Reliable demand at healthy margin is the most valuable shelf-space; that quadrant is top-right.',
    defaultX: 'salesDayCoveragePercent',
    defaultY: 'gmPercent',
    defaultColourBy: 'subcategory',
    defaultSizeBy: 'marginDollars',
    section: SECTION_DEMAND,
  },
  {
    id: 'invoices-vs-units-per-invoice',
    title: 'Invoice count vs units per invoice',
    description:
      'Distinguishes wide reach vs basket-multiplier behaviour. SKUs in the top-right move via multi-buy promos.',
    defaultX: 'invoiceCount',
    defaultY: 'unitsPerInvoice',
    defaultColourBy: 'discountDepth',
    defaultSizeBy: 'unitsSold',
    section: SECTION_DEMAND,
  },
  {
    id: 'invoices-vs-units',
    title: 'Invoice count vs units sold',
    description:
      'Above the diagonal = repeated multi-unit baskets; near the diagonal = single-unit baskets.',
    defaultX: 'invoiceCount',
    defaultY: 'unitsSold',
    defaultColourBy: 'subcategory',
    referenceLine: 'diagonal',
    defaultSizeBy: 'marginDollars',
    section: SECTION_DEMAND,
  },
  {
    id: 'units-per-invoice-vs-realization',
    title: 'Units per invoice vs price realization %',
    description:
      'Spot promo-bundled SKUs (high units/invoice + low realization) vs healthy multi-buys (high units/invoice + high realization).',
    defaultX: 'unitsPerInvoice',
    defaultY: 'priceRealizationPercent',
    defaultColourBy: 'brand',
    defaultSizeBy: 'marginDollars',
    section: SECTION_DEMAND,
  },
  {
    id: 'units-per-invoice-vs-gm',
    title: 'Units per invoice vs effective GM %',
    description:
      'High basket multiplier + strong GM% = ideal; high basket multiplier + thin GM = promo lever pulled too hard.',
    defaultX: 'unitsPerInvoice',
    defaultY: 'gmPercent',
    defaultColourBy: 'discountDepth',
    defaultSizeBy: 'marginDollars',
    section: SECTION_DEMAND,
  },

  // ----- Inventory traps -----
  //
  // Surface dead stock, over-stocked slow movers, and on-hand mismatches
  // with realized margin/velocity.
  {
    id: 'wos-vs-velocity',
    title: 'Weeks of supply vs sales velocity',
    description:
      'Bottom-right = enormous backstock for trivial pace (markdown candidates). Top-left = stockouts incoming.',
    defaultX: 'weeksOfSupplyOnHand',
    defaultY: 'salesVelocityUnitsPerDay',
    defaultColourBy: 'subcategory',
    defaultSizeBy: 'currentQty',
    section: SECTION_TRAPS,
  },
  {
    id: 'wos-vs-gm',
    title: 'Weeks of supply vs effective GM %',
    description:
      'Bottom-right = deep stock with no margin to protect — clear the deck. Top-right = deep stock at healthy margin (consider buy-cycle).',
    defaultX: 'weeksOfSupplyOnHand',
    defaultY: 'gmPercent',
    defaultColourBy: 'brand',
    defaultSizeBy: 'currentQty',
    section: SECTION_TRAPS,
  },
  {
    id: 'wos-vs-realization',
    title: 'Weeks of supply vs price realization %',
    description:
      'Identify SKUs that are deeply stocked AND already being discounted hard — the markdown is not yet working.',
    defaultX: 'weeksOfSupplyOnHand',
    defaultY: 'priceRealizationPercent',
    defaultColourBy: 'subcategory',
    defaultSizeBy: 'currentQty',
    section: SECTION_TRAPS,
  },
  {
    id: 'onhand-vs-margin-velocity',
    title: 'On-hand qty vs margin $/day',
    description:
      'Quadrant view: low stock + high margin/day = reorder; high stock + low margin/day = freeze / markdown.',
    defaultX: 'currentQty',
    defaultY: 'marginVelocityDollarsPerDay',
    defaultColourBy: 'gmPercent',
    defaultSizeBy: 'marginDollars',
    section: SECTION_TRAPS,
  },
  {
    id: 'onhand-vs-invoices',
    title: 'On-hand qty vs invoice count',
    description:
      'How many actual customers does the current inventory pile serve? Bottom-right = a lot of stock, very few customers.',
    defaultX: 'currentQty',
    defaultY: 'invoiceCount',
    defaultColourBy: 'subcategory',
    defaultSizeBy: 'marginDollars',
    section: SECTION_TRAPS,
  },
  {
    id: 'onhand-vs-coverage',
    title: 'On-hand qty vs sales-day coverage %',
    description:
      'Bottom-right = a lot of stock that almost never sells a day in the window. Top-left = scarce SKU but moves every day.',
    defaultX: 'currentQty',
    defaultY: 'salesDayCoveragePercent',
    defaultColourBy: 'brand',
    defaultSizeBy: 'marginDollars',
    section: SECTION_TRAPS,
  },

  // ----- Cohort outliers (extending existing section) -----
  {
    id: 'gm-delta-vs-price-index',
    title: 'GM% Δ vs price index (cohort)',
    description:
      'Top-right = premium-priced AND higher-margin than peers (pricing power realized). Bottom-right = priced premium but margin worse than peers (deal-driven leakage).',
    defaultX: 'effectivePriceIndex',
    defaultY: 'gmPercentIndex',
    defaultColourBy: 'subcategory',
    referenceLine: 'unit-x',
    defaultSizeBy: 'marginDollars',
    section: SECTION_COHORT,
  },
  {
    id: 'gm-delta-vs-effective-price',
    title: 'GM% Δ vs effective OTD price',
    description:
      'Where in the absolute price ladder do we beat / underperform peers on margin?',
    defaultX: 'otdUnitPriceDollars',
    defaultY: 'gmPercentIndex',
    defaultColourBy: 'subcategory',
    defaultSizeBy: 'marginDollars',
    section: SECTION_COHORT,
  },
  {
    id: 'velocity-index-vs-coverage',
    title: 'Velocity index vs sales-day coverage %',
    description:
      'Reliable out-performers (top-right) vs bursty out-performers (top-left). Bottom-left = drop the SKU.',
    defaultX: 'salesDayCoveragePercent',
    defaultY: 'velocityIndex',
    defaultColourBy: 'subcategory',
    referenceLine: 'unit-y',
    defaultSizeBy: 'marginDollars',
    section: SECTION_COHORT,
  },
  {
    id: 'price-index-vs-effective-gm',
    title: 'Price index vs effective GM %',
    description:
      'Are we getting paid for premium positioning? Top-right = yes. Bottom-right = we are priced premium and still bleeding margin.',
    defaultX: 'effectivePriceIndex',
    defaultY: 'gmPercent',
    defaultColourBy: 'subcategory',
    defaultSizeBy: 'marginDollars',
    section: SECTION_COHORT,
  },
]

function sectionOf(c: ScatterCardConfig): string {
  return c.section ?? SECTION_CORE
}

function groupCardsBySection(
  cards: ReadonlyArray<ScatterCardConfig>,
): ReadonlyArray<{ section: string; cards: ReadonlyArray<ScatterCardConfig> }> {
  const byName = new Map<string, ScatterCardConfig[]>()
  for (const c of cards) {
    const name = sectionOf(c)
    const arr = byName.get(name) ?? []
    arr.push(c)
    byName.set(name, arr)
  }
  // Render sections in the order declared in SECTIONS_IN_ORDER, then
  // any extras alphabetically. (Defensive — current data has no
  // extras, but keeps drift from breaking the page.)
  const knownOrder = new Map<string, number>(
    SECTIONS_IN_ORDER.map((s, i) => [s, i]),
  )
  return Array.from(byName.entries())
    .sort(([a], [b]) => {
      const oa = knownOrder.get(a)
      const ob = knownOrder.get(b)
      if (oa != null && ob != null) return oa - ob
      if (oa != null) return -1
      if (ob != null) return 1
      return a.localeCompare(b)
    })
    .map(([section, cs]) => ({ section, cards: cs }))
}

// =============================== Tab component =============================

const KNOWN_SITES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'bronx', label: 'Bronx' },
  { id: 'midtown', label: 'Midtown' },
]

// Initial range mirrors DEFAULT_WINDOW_DAYS so existing snapshots and
// "over the last N days" copy keep matching what the user sees.
function initialRange(): { fromMs: number; toMs: number } {
  const now = Date.now()
  // Honour a `?windowDays=` deep-link param (e.g. from the inventory
  // page's "cohort analysis" links) so the cohort comparison uses the
  // same window the buyer was looking at. Falls back to the default.
  let days = DEFAULT_WINDOW_DAYS
  if (typeof window !== 'undefined') {
    const raw = new URLSearchParams(window.location.search).get('windowDays')
    const parsed = raw ? Number.parseInt(raw, 10) : NaN
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 365) days = parsed
  }
  return { fromMs: now - days * DAY_MS, toMs: now }
}

// Resolve a `?section=` deep-link param to one of the known sub-tab
// section names. Accepts the exact section name (case-insensitive) or a
// short slug (e.g. "cohort", "traps", "promo") so external links don't
// have to URL-encode the display strings. Returns null when unrecognised
// so the caller can fall back to the default section.
function resolveSectionParam(raw: string | null): string | null {
  if (!raw) return null
  const norm = raw.trim().toLowerCase()
  const exact = SECTIONS_IN_ORDER.find((s) => s.toLowerCase() === norm)
  if (exact) return exact
  const slug: Record<string, string> = {
    core: SECTION_CORE,
    profit: SECTION_PROFIT,
    promo: SECTION_PROMO,
    erosion: SECTION_PROMO,
    cohort: SECTION_COHORT,
    potency: SECTION_POTENCY,
    cannabinoid: SECTION_POTENCY,
    demand: SECTION_DEMAND,
    basket: SECTION_BASKET,
    inventory: SECTION_BASKET,
    traps: SECTION_TRAPS,
  }
  return slug[norm] ?? null
}

// Format a millisecond timestamp as the `value` expected by an
// `<input type="datetime-local">`. Local-time on purpose: the input
// itself is local-time, so we deliberately don't toggle to UTC here
// (the scatter / sales dashboards do the same in MetricsLayoutPage).
function toLocalDtInput(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`
}

/**
 * Optional embedded-mode props. When provided, the catalog scatter
 * page renders without its filter chrome (no filter bar, no
 * highlight input, no clear-all) and pre-seeds its filter state
 * from the override values instead of from URL search params.
 *
 * Used by the Brand / Distributor detail pages
 * (`/metrics/brands/:brandId`, `/metrics/distributors/:slug`) to
 * embed one scatter section per category, scoped to the entity.
 */
export interface CatalogAnalyticsTabEmbeddedProps {
  /** Pre-select these category ids (chip selection). */
  readonly categoryIds?: ReadonlyArray<string>
  /** Pre-select these brand ids. */
  readonly brandIds?: ReadonlyArray<string>
  /** Pre-select these distributor names (legacy multi-select). */
  readonly distributorNames?: ReadonlyArray<string>
  /**
   * Pre-seed the free-text highlight input. Deprecated for
   * brand / distributor detail pages — prefer the structured
   * `highlightBrandNames` / `highlightDistributorNames` below since
   * substring matching against e.g. "Cresco" also catches strain
   * names that happen to contain "Cresco". Free-text seed remains
   * supported for any caller that genuinely wants substring match
   * (e.g. an arbitrary URL share).
   */
  readonly highlight?: string
  /**
   * Pre-seed the structured Highlight section's Brand chip.
   * Values are brand NAMES (matching CATALOG_HIGHLIGHT_DIMS pointKey,
   * which uses the human-visible name as both id and label). Used by
   * /metrics/brands/:brandId — the detail page resolves the brand id
   * to its label and seeds that here.
   */
  readonly highlightBrandNames?: ReadonlyArray<string>
  /**
   * Pre-seed the structured Highlight section's Distributor chip.
   * Values are distributor NAMES. Used by
   * /metrics/distributors/:distributorName.
   */
  readonly highlightDistributorNames?: ReadonlyArray<string>
  /** Hide the page-wide filter bar so the user can't change the scope. */
  readonly hideFilterBar?: boolean
  /** Hide the page-wide control row (range / sites / colour-by / etc). */
  readonly hideTopControls?: boolean
}

export interface CatalogAnalyticsTabProps {
  readonly embedded?: CatalogAnalyticsTabEmbeddedProps
}

export function CatalogAnalyticsTab({ embedded }: CatalogAnalyticsTabProps = {}) {
  // -------- URL hydration --------
  // Brand / distributor index pages link here with `?highlight=…`
  // (and optionally `?sites=…&categoryIds=…&brandIds=…&
  //  distributorNames=…&subcategoryIds=…&sizes=…&packCounts=…`)
  // so the operator lands on the catalog scatter pre-focused on
  // that entity. We hydrate state ONCE at mount; we deliberately
  // do NOT keep the URL in sync afterwards (the existing UI uses
  // dropdown chips, not URL state, as its source of truth, and a
  // bidirectional sync would force two-way state plumbing that
  // isn't in scope for the IA refactor).
  //
  // In embedded mode (Brand / Distributor detail pages) the
  // override props take precedence over URL params, since the
  // canonical route's own params already drive the override values
  // and the embedded scatter shouldn't reach up to the page's URL.
  const [searchParams] = useSearchParams()
  const initialQueryRef = useRef(searchParams)
  const embeddedRef = useRef(embedded)
  const initialSet = useCallback(
    (key: string, override?: ReadonlyArray<string>): Set<string> => {
      if (override !== undefined) {
        return new Set(override)
      }
      const raw = initialQueryRef.current.get(key)
      if (!raw) return new Set<string>()
      return new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))
    },
    [],
  )
  const initialMulti = useCallback(
    (key: string, override?: ReadonlyArray<string>): Set<string> => {
      if (override !== undefined) {
        return new Set(override)
      }
      // Distributor names can legitimately contain commas, so the
      // distributorNames param accepts repeated entries (matching the
      // server contract) in addition to a single CSV string.
      const all = initialQueryRef.current.getAll(key)
      if (all.length === 0) return new Set<string>()
      const out = new Set<string>()
      for (const raw of all) {
        for (const part of raw.split(',')) {
          const trimmed = part.trim()
          if (trimmed.length > 0) out.add(trimmed)
        }
      }
      return out
    },
    [],
  )

  // -------- Filters --------
  // Range is stored as concrete from/to milliseconds so the "custom"
  // datetime pickers and the preset day buttons share one source of
  // truth. windowDays is derived for any code that wants "how wide
  // was the window?" (cohort medians, query-string `from`/`to`,
  // display copy). Presets set both ends to (now - Nd ... now);
  // custom inputs set either end independently.
  const [range, setRange] = useState<{ fromMs: number; toMs: number }>(() => initialRange())
  const windowDays = useMemo(() => {
    const d = (range.toMs - range.fromMs) / DAY_MS
    return d > 0 ? Math.round(d) : 0
  }, [range.fromMs, range.toMs])
  const setWindowDays = useCallback((d: number) => {
    if (!Number.isFinite(d) || d <= 0) return
    const now = Date.now()
    setRange({ fromMs: now - d * DAY_MS, toMs: now })
  }, [])
  const [selectedSites, setSelectedSites] = useState<ReadonlySet<string>>(() => {
    const fromUrl = initialSet('sites')
    return normaliseSiteSelection(
      fromUrl.size > 0 ? fromUrl : defaultSiteSelection(KNOWN_SITES.map((s) => s.id)),
      KNOWN_SITES.length,
    )
  })
  const [filters, setFilters] = useState<CatalogAnalyticsFiltersResponse | null>(null)
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<ReadonlySet<string>>(
    () => initialSet('categoryIds', embeddedRef.current?.categoryIds),
  )
  const [selectedSubcategoryIds, setSelectedSubcategoryIds] = useState<ReadonlySet<string>>(
    () => initialSet('subcategoryIds'),
  )
  const [selectedBrandIds, setSelectedBrandIds] = useState<ReadonlySet<string>>(
    () => initialSet('brandIds', embeddedRef.current?.brandIds),
  )
  const [selectedDistributorNames, setSelectedDistributorNames] = useState<ReadonlySet<string>>(
    () => initialMulti('distributorNames', embeddedRef.current?.distributorNames),
  )
  const [selectedSizes, setSelectedSizes] = useState<ReadonlySet<string>>(() => initialSet('sizes'))
  const [selectedPackCounts, setSelectedPackCounts] = useState<ReadonlySet<string>>(
    () => initialSet('packCounts'),
  )

  const sitesParam = useMemo(() => Array.from(selectedSites).join(','), [selectedSites])
  const categoryIdsParam = useMemo(
    () => Array.from(selectedCategoryIds).sort().join(','),
    [selectedCategoryIds],
  )
  const subcategoryIdsParam = useMemo(
    () => Array.from(selectedSubcategoryIds).sort().join(','),
    [selectedSubcategoryIds],
  )
  const brandIdsParam = useMemo(
    () => Array.from(selectedBrandIds).sort().join(','),
    [selectedBrandIds],
  )
  const sizesParam = useMemo(
    () => Array.from(selectedSizes).sort().join(','),
    [selectedSizes],
  )
  const packCountsParam = useMemo(
    () => Array.from(selectedPackCounts).sort().join(','),
    [selectedPackCounts],
  )

  // -------- Page-wide chart controls --------
  // Hydrate the page-wide scatter encodings from the persisted global
  // defaults (falling back to the code defaults: colour by brand, size by
  // margin $/day). `useState(() => …)` so first paint already reflects the
  // saved defaults — no flash from code default → saved default.
  const metricsDefaults = useMetricsDefaults()
  const [scatterInit] = useState<PageScatterEncoding>(() =>
    resolveScatterDefaults(metricsDefaults?.stored?.scatter),
  )
  const [pageColourBy, setPageColourBy] = useState<ColourByKey | 'per-chart'>(
    scatterInit.colourBy,
  )
  const [pageSizeBy, setPageSizeBy] = useState<SizeByKey | 'per-chart'>(scatterInit.sizeBy)
  const [pageOpacityBy, setPageOpacityBy] = useState<OpacityByKey | 'per-chart'>(
    scatterInit.opacityBy,
  )
  // Publish the live encodings so the admin "Update defaults" flow can
  // capture them even though the button lives outside this component.
  const registerScatterSnapshot = metricsDefaults?.registerScatterSnapshot
  useEffect(() => {
    if (!registerScatterSnapshot) return
    registerScatterSnapshot({
      colourBy: pageColourBy,
      sizeBy: pageSizeBy,
      opacityBy: pageOpacityBy,
    })
    return () => registerScatterSnapshot(null)
  }, [registerScatterSnapshot, pageColourBy, pageSizeBy, pageOpacityBy])
  // Free-text "highlight subset" query. Lower-cased substring match
  // against the point's text-y fields (brand / category / subcategory
  // / size / product name / sku / pack count). When non-empty:
  //   * matching dots: full opacity, thicker stroke ring
  //   * non-matching dots: heavily dimmed so the highlighted subset
  //     pops out of the rest of the cloud.
  // Stored on the page so it applies to every card in the grid.
  // Hydrated from `?highlight=…` so Brand / Distributor index links
  // can land the operator on the catalog scatter with that entity
  // pre-highlighted across every card.
  const [highlightQuery, setHighlightQuery] = useState<string>(
    () =>
      embeddedRef.current?.highlight !== undefined
        ? embeddedRef.current.highlight
        : initialQueryRef.current.get('highlight') ?? '',
  )
  // Structured highlight chips — one set per dim id in
  // CATALOG_HIGHLIGHT_DIMS. Combines with the free-text input above
  // via buildStructuredHighlightMatcher (AND across dims, OR within).
  // Brand- / distributor-detail pages pre-seed this via
  // embedded.highlightBrandNames / highlightDistributorNames so the
  // detail page lands with that entity already chip-highlighted.
  const [highlightState, setHighlightState] = useState<HighlightSelectionState>(() => {
    const seed = emptyHighlightSelection()
    const brandNames = embeddedRef.current?.highlightBrandNames ?? []
    const distNames = embeddedRef.current?.highlightDistributorNames ?? []
    // Exact-variant highlight via ?highlightVariantIds=<productId>[,…].
    // Deep-links (e.g. the inventory cohort links) use the variant id so
    // the highlight reliably hits the right dot instead of fuzzy-matching
    // a product name. Ignored in embedded mode (the host owns highlight).
    const variantIds = embeddedRef.current
      ? []
      : (initialQueryRef.current.get('highlightVariantIds') ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
    if (brandNames.length === 0 && distNames.length === 0 && variantIds.length === 0) return seed
    const next = new Map<string, ReadonlySet<string>>()
    if (brandNames.length > 0) next.set('brand', new Set(brandNames))
    if (distNames.length > 0) next.set('distributor', new Set(distNames))
    if (variantIds.length > 0) next.set('variant', new Set(variantIds))
    return next
  })

  // -------- Active sub-tab inside the catalog analytics page --------
  // Hydrated once from `?section=` (inventory "cohort analysis" links and
  // other deep links land directly on Cohort-relative / Inventory traps /
  // Promo erosion). Ignored in embedded mode, where the host page owns
  // which section is shown. Falls back to Core merchandising.
  const [activeSection, setActiveSection] = useState<string>(
    () =>
      (embeddedRef.current ? null : resolveSectionParam(initialQueryRef.current.get('section'))) ??
      SECTION_CORE,
  )

  // -------- Data --------
  const [pointsResp, setPointsResp] = useState<CatalogAnalyticsPointsResponse | null>(null)
  const [cohortPointsResp, setCohortPointsResp] = useState<CatalogAnalyticsPointsResponse | null>(null)
  const [loadingFilters, setLoadingFilters] = useState<boolean>(true)
  const [loadingPoints, setLoadingPoints] = useState<boolean>(true)
  const [loadingCohorts, setLoadingCohorts] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  // Fetch filter options whenever sites OR any selected filter changes.
  // The server applies the OTHER dimensions' selections (cumulative
  // narrowing) so the n=… counts and dropdown contents always reflect
  // what would actually be in scope if the operator added one more
  // pick. The current dimension's own selection is intentionally not
  // applied to itself (so the user can still see/deselect their picks).
  //
  // Debounced so rapid-fire chip-clicks don't fire N requests.
  useEffect(() => {
    let cancelled = false
    setLoadingFilters(true)
    const handle = setTimeout(() => {
      const qs = new URLSearchParams()
      if (sitesParam) qs.set('sites', sitesParam)
      if (categoryIdsParam) qs.set('categoryIds', categoryIdsParam)
      if (subcategoryIdsParam) qs.set('subcategoryIds', subcategoryIdsParam)
      if (brandIdsParam) qs.set('brandIds', brandIdsParam)
      for (const name of Array.from(selectedDistributorNames).sort()) {
        qs.append('distributorNames', name)
      }
      if (sizesParam) qs.set('sizes', sizesParam)
      if (packCountsParam) qs.set('packCounts', packCountsParam)
      const url = qs.toString()
        ? `/api/catalog-analytics/filters?${qs.toString()}`
        : '/api/catalog-analytics/filters'
      loadJson(url, CatalogAnalyticsFiltersResponseSchema)
        .then((r) => {
          if (!cancelled) setFilters(r)
        })
        .catch((e) => {
          if (!cancelled) {
            setError(`Failed to load filter options: ${(e as Error).message}`)
            setFilters({
              categories: [],
              subcategories: [],
              brands: [],
              distributors: [],
              sizes: [],
              packCounts: [],
            })
          }
        })
        .finally(() => {
          if (!cancelled) setLoadingFilters(false)
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [
    sitesParam,
    categoryIdsParam,
    subcategoryIdsParam,
    brandIdsParam,
    selectedDistributorNames,
    sizesParam,
    packCountsParam,
  ])

  // Fetch points whenever ANY filter changes. We debounce filter changes
  // by 250ms so multi-select chip-clicks don't trigger N queries.
  const pointsKey = useMemo(
    () =>
      [
        range.fromMs,
        range.toMs,
        sitesParam,
        Array.from(selectedCategoryIds).sort().join(','),
        Array.from(selectedSubcategoryIds).sort().join(','),
        Array.from(selectedBrandIds).sort().join(','),
        Array.from(selectedDistributorNames).sort().join(','),
        Array.from(selectedSizes).sort().join(','),
        Array.from(selectedPackCounts).sort().join(','),
      ].join('|'),
    [
      range.fromMs,
      range.toMs,
      sitesParam,
      selectedCategoryIds,
      selectedSubcategoryIds,
      selectedBrandIds,
      selectedDistributorNames,
      selectedSizes,
      selectedPackCounts,
    ],
  )
  useEffect(() => {
    let cancelled = false
    setLoadingPoints(true)
    setError(null)
    const handle = setTimeout(() => {
      const from = new Date(range.fromMs).toISOString()
      const to = new Date(range.toMs).toISOString()
      const qs = new URLSearchParams()
      qs.set('from', from)
      qs.set('to', to)
      if (sitesParam) qs.set('sites', sitesParam)
      if (selectedCategoryIds.size > 0) qs.set('categoryIds', Array.from(selectedCategoryIds).join(','))
      if (selectedSubcategoryIds.size > 0)
        qs.set('subcategoryIds', Array.from(selectedSubcategoryIds).join(','))
      if (selectedBrandIds.size > 0) qs.set('brandIds', Array.from(selectedBrandIds).join(','))
      if (selectedDistributorNames.size > 0) {
        for (const name of Array.from(selectedDistributorNames).sort()) {
          qs.append('distributorNames', name)
        }
      }
      if (selectedSizes.size > 0) qs.set('sizes', Array.from(selectedSizes).join(','))
      if (selectedPackCounts.size > 0)
        qs.set('packCounts', Array.from(selectedPackCounts).join(','))
      loadJson(
        `/api/catalog-analytics/points?${qs.toString()}`,
        CatalogAnalyticsPointsResponseSchema,
      )
        .then((r) => {
          if (!cancelled) setPointsResp(r)
        })
        .catch((e) => {
          if (!cancelled) setError(`Failed to load catalog points: ${(e as Error).message}`)
        })
        .finally(() => {
          if (!cancelled) setLoadingPoints(false)
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
    // pointsKey rolls up everything we depend on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointsKey])

  // Cohort benchmarks are intentionally fetched from the full selected
  // site/date universe, with NO product-subset filters applied. The displayed
  // points can be narrowed to Curaleaf / Select / Flower / 1g, but every
  // cohort-relative axis still benchmarks against all same
  // category×subcategory×unit-size×pack-size peers for the selected sites and
  // window.
  const cohortPointsKey = useMemo(
    () => [range.fromMs, range.toMs, sitesParam].join('|'),
    [range.fromMs, range.toMs, sitesParam],
  )
  useEffect(() => {
    let cancelled = false
    setLoadingCohorts(true)
    const handle = setTimeout(() => {
      const qs = new URLSearchParams()
      qs.set('from', new Date(range.fromMs).toISOString())
      qs.set('to', new Date(range.toMs).toISOString())
      if (sitesParam) qs.set('sites', sitesParam)
      loadJson(
        `/api/catalog-analytics/points?${qs.toString()}`,
        CatalogAnalyticsPointsResponseSchema,
      )
        .then((r) => {
          if (!cancelled) setCohortPointsResp(r)
        })
        .catch((e) => {
          if (!cancelled) setError(`Failed to load cohort benchmark universe: ${(e as Error).message}`)
        })
        .finally(() => {
          if (!cancelled) setLoadingCohorts(false)
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
    // cohortPointsKey rolls up everything we depend on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cohortPointsKey])

  const points = pointsResp?.points ?? []
  const cohortPoints = cohortPointsResp?.points ?? []

  // Cohort medians for the index axes. Recomputed from the stable
  // site/date benchmark universe so axis evaluators downstream are O(1).
  // Cohort key is (categoryName, subcategoryName, unit size, pack count)
  // per cohortKey(); brand / distributor / category / size filters on the
  // visible dot set never narrow these medians.
  //
  // Only points that have ALL of (velocity, effective OTD price, GM%,
  // margin/unit) populated participate in their respective medians —
  // a points-without-sales row shouldn't drag the velocity median
  // toward zero.
  const cohortMedians = useMemo(() => {
    const groups = new Map<
      string,
      { vel: number[]; price: number[]; gm: number[]; mpu: number[] }
    >()
    for (const p of cohortPoints) {
      const k = cohortKey(p)
      let g = groups.get(k)
      if (!g) {
        g = { vel: [], price: [], gm: [], mpu: [] }
        groups.set(k, g)
      }
      if (p.salesVelocityUnitsPerDay != null) g.vel.push(p.salesVelocityUnitsPerDay)
      if (p.otdUnitPriceDollars != null) g.price.push(p.otdUnitPriceDollars)
      if (p.gmPercent != null) g.gm.push(p.gmPercent)
      if (p.marginDollarsPerUnit != null) g.mpu.push(p.marginDollarsPerUnit)
    }
    const out = new Map<
      string,
      {
        velocityUnitsPerDay: number | null
        effectiveOtdPriceDollars: number | null
        gmPercent: number | null
        marginPerUnitDollars: number | null
      }
    >()
    for (const [k, g] of groups) {
      out.set(k, {
        velocityUnitsPerDay: median(g.vel),
        effectiveOtdPriceDollars: median(g.price),
        gmPercent: median(g.gm),
        marginPerUnitDollars: median(g.mpu),
      })
    }
    return out
  }, [cohortPoints])

  const axisCtx: AxisCtx = useMemo(
    () => ({ windowDays, cohortMedians }),
    [windowDays, cohortMedians],
  )

  // Combined highlight matcher: structured chips (AND across dims,
  // OR within) AND free-text. Returns null when neither is engaged,
  // matching the legacy "no dimming" UX. The structured matcher
  // already folds the free-text query in, so we don't need to
  // separately build buildHighlightMatcher() here.
  const highlightMatcher = useMemo(
    () =>
      buildStructuredHighlightMatcher(
        CATALOG_HIGHLIGHT_DIMS,
        highlightState,
        highlightQuery,
      ),
    [highlightState, highlightQuery],
  )
  const highlightCount = useMemo(() => {
    if (!highlightMatcher) return 0
    let n = 0
    for (const p of points) if (highlightMatcher(p)) n += 1
    return n
  }, [highlightMatcher, points])

  // Distinct product ids in the highlighted subset, used to seed the
  // "Reprice highlighted" action. `productId` on a scatter point is
  // the catalog product id as a string (null for inventory rows that
  // never linked to a mirrored product); we coerce and dedupe so the
  // server-side allowlist is well-formed. Multiple inventory rows can
  // share one productId (e.g. same product mirrored at both sites);
  // the Set collapses them.
  const highlightedProductIds = useMemo<readonly number[]>(() => {
    if (!highlightMatcher) return []
    const ids = new Set<number>()
    for (const p of points) {
      if (!highlightMatcher(p)) continue
      if (p.productId == null) continue
      const n = Number(p.productId)
      if (Number.isInteger(n) && n > 0) ids.add(n)
    }
    return [...ids].sort((left, right) => left - right)
  }, [highlightMatcher, points])

  const session = useRouteLoaderData('root') as SessionEnvelope | undefined
  const canReprice = session?.permissions.canEditProposals === true
  const [repriceState, setRepriceState] = useState<{
    status: 'idle' | 'queueing' | 'error'
    message?: string
  }>({ status: 'idle' })

  const handleRepriceHighlighted = useCallback(async () => {
    if (highlightedProductIds.length === 0) return
    // Open the destination tab synchronously so popup blockers don't
    // mistake the post-await `window.open` for an unsolicited popup.
    // We park it on about:blank until the queue mutation resolves.
    const placeholder = window.open('about:blank', '_blank')
    setRepriceState({ status: 'queueing' })
    try {
      const idsForRequest = [...highlightedProductIds]
      const response = await mutateJson(
        '/api/pricing/runs',
        QueuePricingRunAcceptedResponseSchema,
        {
          body: JSON.stringify({
            brands: [],
            categories: [],
            distributorNames: [],
            explicitProductIds: idsForRequest,
            includePending: false,
            packSizes: [],
            reason: `Reprice highlighted (${idsForRequest.length} product${
              idsForRequest.length === 1 ? '' : 's'
            }) from metrics scatter.`,
            scopeKind: 'explicit_selection',
            scopeLabel: `Highlighted ${idsForRequest.length} product${
              idsForRequest.length === 1 ? '' : 's'
            } from metrics scatter`,
            sites: ['bronx', 'midtown'],
            stockOnly: false,
            strict: false,
            subcategories: [],
            unitSizes: [],
          }),
          method: 'POST',
        },
      )
      const dest = buildAppPath(
        buildHeliosModulePath('pricing', `runs/${response.proposalBatchId}`),
      )
      if (placeholder && !placeholder.closed) {
        placeholder.location.href = dest
      } else {
        // Popup was blocked or already closed — fall back to opening
        // a fresh tab. Some browsers block this too; if so the user
        // can still navigate via the link in the error message.
        window.open(dest, '_blank')
      }
      setRepriceState({ status: 'idle' })
    } catch (error) {
      if (placeholder && !placeholder.closed) placeholder.close()
      setRepriceState({
        status: 'error',
        message:
          error instanceof Error ? error.message : 'Could not queue the pricing run.',
      })
    }
  }, [highlightedProductIds])

  const sectionedCards = useMemo(() => groupCardsBySection(DEFAULT_CARDS), [])

  const hideTopControls = embedded?.hideTopControls === true
  const hideFilterBar = embedded?.hideFilterBar === true
  return (
    <section className="catalog-analytics-tab">
      {hideTopControls ? null : (
      <div className="metrics-controls catalog-analytics-controls">
        <div className="metrics-control-group">
          <span className="subtle-copy">sites</span>
          <button
            type="button"
            className={
              selectedSites.size === 0 ? 'metrics-site-chip is-active' : 'metrics-site-chip'
            }
            onClick={() => setSelectedSites(new Set())}
          >
            All
          </button>
          {KNOWN_SITES.map((s) => {
            const active = selectedSites.has(s.id)
            return (
              <button
                key={s.id}
                type="button"
                className={active ? 'metrics-site-chip is-active' : 'metrics-site-chip'}
                onClick={() => setSelectedSites(toggleSiteSelection(selectedSites, s.id, KNOWN_SITES.length))}
                aria-pressed={active}
              >
                {s.label}
              </button>
            )
          })}
        </div>

        <div className="metrics-control-group">
          <span className="subtle-copy">range</span>
          {[7, 30, 90, 180, 365].map((d) => {
            // A preset matches "currently active" only if the range is
            // exactly (now-Nd ... now); after the user picks custom
            // dates no preset is highlighted.
            const isExactPreset =
              windowDays === d && Math.abs(range.toMs - Date.now()) < DAY_MS
            return (
              <button
                key={d}
                type="button"
                className={isExactPreset ? 'metrics-site-chip is-active' : 'metrics-site-chip'}
                onClick={() => setWindowDays(d)}
                aria-pressed={isExactPreset}
              >
                {d}d
              </button>
            )
          })}
          <details className="metrics-range-custom">
            <summary>custom</summary>
            <div className="metrics-range-custom-inputs">
              <label className="subtle-copy">
                from{' '}
                <input
                  type="datetime-local"
                  value={toLocalDtInput(range.fromMs)}
                  onChange={(e) => {
                    const ms = Date.parse(e.target.value)
                    if (!Number.isNaN(ms)) setRange((r) => ({ fromMs: ms, toMs: r.toMs }))
                  }}
                />
              </label>
              <label className="subtle-copy">
                to{' '}
                <input
                  type="datetime-local"
                  value={toLocalDtInput(range.toMs)}
                  onChange={(e) => {
                    const ms = Date.parse(e.target.value)
                    if (!Number.isNaN(ms)) setRange((r) => ({ fromMs: r.fromMs, toMs: ms }))
                  }}
                />
              </label>
            </div>
            <RangeNudgeRow range={range} setRange={(next) => setRange(next)} />
          </details>
        </div>

        <div className="metrics-control-group">
          <label>
            colour by{' '}
            <select
              value={pageColourBy}
              onChange={(e) => setPageColourBy(e.target.value as ColourByKey | 'per-chart')}
            >
              <option value="per-chart">per chart</option>
              {COLOUR_BY.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            size by{' '}
            <select
              value={pageSizeBy}
              onChange={(e) => setPageSizeBy(e.target.value as SizeByKey | 'per-chart')}
            >
              <option value="per-chart">per chart</option>
              {SIZE_BY.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label>
           opacity by{' '}
           <select
             value={pageOpacityBy}
             onChange={(e) =>
               setPageOpacityBy(e.target.value as OpacityByKey | 'per-chart')
             }
           >
             <option value="per-chart">per chart</option>
             {OPACITY_BY.map((o) => (
               <option key={o.id} value={o.id}>
                 {o.label}
               </option>
             ))}
           </select>
          </label>
          </div>
          </div>
      )}

      {hideFilterBar ? null : (
      <ControlsSection title="Filters" defaultOpen="always">
      <div className="catalog-analytics-filterbar-row">
        <CatalogFilterBar
          filters={filters}
          loading={loadingFilters}
          selection={{
            categoryIds: selectedCategoryIds,
            subcategoryIds: selectedSubcategoryIds,
            brandIds: selectedBrandIds,
            sizes: selectedSizes,
          }}
          callbacks={{
            onCategoryToggle: makeSetToggler(setSelectedCategoryIds),
            onSubcategoryToggle: makeSetToggler(setSelectedSubcategoryIds),
            onBrandToggle: makeSetToggler(setSelectedBrandIds),
            onSizeToggle: makeSetToggler(setSelectedSizes),
            onClearAll: () => {
              setSelectedCategoryIds(new Set())
              setSelectedSubcategoryIds(new Set())
              setSelectedBrandIds(new Set())
              setSelectedDistributorNames(new Set())
              setSelectedSizes(new Set())
              setSelectedPackCounts(new Set())
            },
          }}
        />
        {filters?.distributors && filters.distributors.length > 0 ? (
          <FilterDropdown
            label="Distributor"
            options={filters.distributors}
            selected={selectedDistributorNames}
            onToggle={makeSetToggler(setSelectedDistributorNames)}
          />
        ) : null}
        {/* Pack-count filter lives outside the shared CatalogFilterBar
            so the sales / inventory pages (which don't carry packOfSize
            on their metric defs) don't have to widen their dimension
            enum. Uses the same FilterDropdown chip so it visually
            joins the row. */}
        {filters?.packCounts && filters.packCounts.length > 0 ? (
          <FilterDropdown
            label="Pack"
            options={filters.packCounts}
            selected={selectedPackCounts}
            onToggle={makeSetToggler(setSelectedPackCounts)}
          />
        ) : null}
        {(selectedDistributorNames.size > 0 || selectedPackCounts.size > 0) &&
        selectedCategoryIds.size === 0 &&
        selectedSubcategoryIds.size === 0 &&
        selectedBrandIds.size === 0 &&
        selectedSizes.size === 0 ? (
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              setSelectedCategoryIds(new Set())
              setSelectedSubcategoryIds(new Set())
              setSelectedBrandIds(new Set())
              setSelectedDistributorNames(new Set())
              setSelectedSizes(new Set())
              setSelectedPackCounts(new Set())
            }}
          >
            clear all filters
          </button>
        ) : null}
      </div>
      </ControlsSection>
      )}

      {/* Highlight controls — see issue #38 / task A3. Open by default
          on desktop, collapsed on mobile so the dense chip row doesn't
          push the scatter cards off-screen. Structured chips combine
          with the free-text input via AND across dims, OR within. */}
      <ControlsSection title="Highlight" defaultOpen="desktop-only">
        <HighlightControls
          dims={CATALOG_HIGHLIGHT_DIMS}
          state={highlightState}
          setState={setHighlightState}
          filteredPoints={points}
          freeText={highlightQuery}
          setFreeText={setHighlightQuery}
          freeTextPlaceholder="brand / strain / size…"
        />
        {canReprice ? (
          <div
            className="catalog-analytics-highlight-actions"
            style={{
              alignItems: 'center',
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.5rem',
              marginTop: '0.5rem',
            }}
          >
            <button
              type="button"
              className="ghost-button"
              disabled={highlightedProductIds.length === 0 || repriceState.status === 'queueing'}
              onClick={handleRepriceHighlighted}
              title={
                highlightedProductIds.length === 0
                  ? 'Highlight a non-empty subset to enable a focused pricing run.'
                  : `Queue a new pricing run for the ${highlightedProductIds.length} highlighted product${
                      highlightedProductIds.length === 1 ? '' : 's'
                    } (opens in a new tab).`
              }
            >
              {repriceState.status === 'queueing'
                ? 'Queueing…'
                : highlightedProductIds.length > 0
                  ? `Reprice highlighted (${highlightedProductIds.length})`
                  : 'Reprice highlighted'}
            </button>
            {repriceState.status === 'error' && repriceState.message ? (
              <span className="error-text" role="alert">
                {repriceState.message}
              </span>
            ) : null}
          </div>
        ) : null}
      </ControlsSection>

      {error ? (
        <p className="metric-chart-error">{error}</p>
      ) : (
        <p className="subtle-copy catalog-analytics-pointcount">
          {loadingPoints || loadingCohorts
            ? `Loading…`
            : `${points.length} variants in selection over the last ${windowDays} days; cohort benchmarks use ${cohortPoints.length} site/date peers.`}
        </p>
      )}

      {(() => {
        const validSection =
          sectionedCards.find((s) => s.section === activeSection) ?? sectionedCards[0]
        const activeName = validSection?.section ?? activeSection
        return (
          <>
            <nav
              className="catalog-analytics-subtabs"
              role="tablist"
              aria-label="Catalog analytics sub-tabs"
            >
              {sectionedCards.map(({ section, cards }) => {
                const isActive = section === activeName
                return (
                  <button
                    key={section}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className={
                      isActive
                        ? 'metrics-site-chip is-active'
                        : 'metrics-site-chip'
                    }
                    onClick={() => setActiveSection(section)}
                  >
                    {section}{' '}
                    <span className="subtle-copy">({cards.length})</span>
                  </button>
                )
              })}
            </nav>

            {validSection ? (
              <div className="catalog-analytics-section">
                <div className="catalog-analytics-grid">
                  {validSection.cards.map((cfg) => (
                   <ScatterCard
                     key={cfg.id}
                     config={cfg}
                     points={points}
                     pageColourBy={pageColourBy}
                     pageSizeBy={pageSizeBy}
                     pageOpacityBy={pageOpacityBy}
                     loading={loadingPoints || loadingCohorts}
                     axisCtx={axisCtx}
                     highlightMatcher={highlightMatcher}
                   />
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )
      })()}
    </section>
  )
}

// ================================ Filter bar ===============================

function makeSetToggler(
  setter: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>,
): (id: string) => void {
  return (id: string) => {
    setter((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
}

// ============================== Scatter card ===============================

interface ScatterCardProps {
  config: ScatterCardConfig
  points: ReadonlyArray<CatalogAnalyticsPoint>
  pageColourBy: ColourByKey | 'per-chart'
  pageSizeBy: SizeByKey | 'per-chart'
  pageOpacityBy: OpacityByKey | 'per-chart'
  loading: boolean
  axisCtx: AxisCtx
  /** When non-null, points matching the predicate are rendered at
   *  full strength and non-matching points are heavily dimmed. */
  highlightMatcher: ((p: CatalogAnalyticsPoint) => boolean) | null
}

function ScatterCard({
  config,
  points,
  pageColourBy,
  pageSizeBy,
  pageOpacityBy,
  loading,
  axisCtx,
  highlightMatcher,
}: ScatterCardProps) {
  const [xId, setXId] = useState<string>(config.defaultX)
  const [yId, setYId] = useState<string>(config.defaultY)

  // v1.4 V4'4: URL-backed scatter-dot drill selection. metricId is
  // synthetic but stable per card-config — share-links reproduce the
  // drilled dot. Escape clears at the window level (handled here so
  // every scatter card has the same behaviour without a tab-level
  // listener).
  const metricId = `${CATALOG_SCATTER_METRIC_ID_PREFIX}${config.id}`
  const [selection, setSelection] = useMetricSelection()
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && selection != null) setSelection(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selection, setSelection])
  const selectedDotId =
    selection != null &&
    selection.kind === 'scatterDot' &&
    selection.metricId === metricId
      ? selection.dotId
      : null
  const onSelectDot = (dotId: string | null): void => {
    setSelection(
      dotId == null
        ? null
        : { kind: 'scatterDot', metricId, dotId },
    )
  }

  const [localColourBy, setLocalColourBy] = useState<ColourByKey>(config.defaultColourBy)
  const [localSizeBy, setLocalSizeBy] = useState<SizeByKey>(
    config.defaultSizeBy ?? 'none',
  )
  const [localOpacityBy, setLocalOpacityBy] = useState<OpacityByKey>(
    config.defaultOpacityBy ?? 'none',
  )
  const effectiveColourBy: ColourByKey =
    pageColourBy === 'per-chart' ? localColourBy : pageColourBy
  const effectiveSizeBy: SizeByKey =
    pageSizeBy === 'per-chart' ? localSizeBy : pageSizeBy
  const effectiveOpacityBy: OpacityByKey =
    pageOpacityBy === 'per-chart' ? localOpacityBy : pageOpacityBy
  const colourByDef = COLOUR_BY.find((c) => c.id === effectiveColourBy) ?? COLOUR_BY[0]!
  const sizeByDef = sizeBy(effectiveSizeBy)
  const opacityByDef = opacityBy(effectiveOpacityBy)
  const xDef = axis(xId)
  const yDef = axis(yId)

  return (
    <article className="metric-chart-card catalog-analytics-card">
      <header className="metric-chart-header">
        <div className="metric-chart-titlewrap">
          <h3 className="metric-chart-title">
            {config.title}
            {config.description ? <HelpIcon text={config.description} /> : null}
          </h3>
        </div>
        <div className="metric-chart-controls catalog-card-controls">
          {/* Per-card axis / encoding selectors. We deliberately render
              the *short* axis labels in each <option> rather than the
              long `label`; the long form is exposed on hover via the
              `title` attribute and is also visible at the top of the
              card as the axis description. Without this, each <select>
              auto-sizes to the longest option ("Sales-day coverage %
              (days sold / window)") which blew the controls onto 3-4
              rows on mobile. */}
          {/* Y comes BEFORE X so the control order matches reading order:
              the Y label sits to the LEFT of the X label on the plot. */}
          <label title={yDef.label}>
            Y:{' '}
            <select value={yId} onChange={(e) => setYId(e.target.value)} title={yDef.label}>
              {POINT_AXES.map((a) => (
                <option key={a.id} value={a.id} title={a.label}>
                  {a.short}
                </option>
              ))}
            </select>
          </label>
          <label title={xDef.label}>
            X:{' '}
            <select value={xId} onChange={(e) => setXId(e.target.value)} title={xDef.label}>
              {POINT_AXES.map((a) => (
                <option key={a.id} value={a.id} title={a.label}>
                  {a.short}
                </option>
              ))}
            </select>
          </label>
          <label
            title={
              pageColourBy === 'per-chart'
                ? colourByDef.label
                : 'Page-wide colour-by override is active; this control is disabled.'
            }
          >
            col:{' '}
            <select
              value={effectiveColourBy}
              onChange={(e) => setLocalColourBy(e.target.value as ColourByKey)}
              disabled={pageColourBy !== 'per-chart'}
            >
              {COLOUR_BY.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label
            title={
              pageSizeBy === 'per-chart'
                ? sizeByDef.label
                : 'Page-wide size-by override is active; this control is disabled.'
            }
          >
            sz:{' '}
            <select
              value={effectiveSizeBy}
              onChange={(e) => setLocalSizeBy(e.target.value as SizeByKey)}
              disabled={pageSizeBy !== 'per-chart'}
            >
              {SIZE_BY.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label
            title={
              pageOpacityBy === 'per-chart'
                ? opacityByDef.label
                : 'Page-wide opacity-by override is active; this control is disabled.'
            }
          >
            op:{' '}
            <select
              value={effectiveOpacityBy}
              onChange={(e) => setLocalOpacityBy(e.target.value as OpacityByKey)}
              disabled={pageOpacityBy !== 'per-chart'}
            >
              {OPACITY_BY.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>
      {/* config.description used to render inline here; it's now
          surfaced via the title's `!` HelpIcon popover so the card's
          visible chrome stays compact. */}
      <ChartInteractionFrame label={`${config.title} chart`} showFullscreenControl={false}>
        <CatalogScatterSvg
       points={points}
       xDef={xDef}
       yDef={yDef}
       colourByDef={colourByDef}
       sizeByDef={sizeByDef}
       opacityByDef={opacityByDef}
       loading={loading}
       axisCtx={axisCtx}
       referenceLine={config.referenceLine}
       highlightMatcher={highlightMatcher}
       selectedDotId={selectedDotId}
       onSelectDot={onSelectDot}
        />
      </ChartInteractionFrame>
    </article>
  )
}

// =============================== SVG renderer ==============================

interface CatalogScatterSvgProps {
  points: ReadonlyArray<CatalogAnalyticsPoint>
  xDef: PointAxisDef
  yDef: PointAxisDef
  colourByDef: ColourByDef
  sizeByDef: SizeByDef
  opacityByDef: OpacityByDef
  loading: boolean
  axisCtx: AxisCtx
  /** Reference line annotation, see ScatterCardConfig. */
  referenceLine?: 'diagonal' | 'unit-y' | 'unit-x'
  /** Optional highlight predicate. When supplied, matching points
   *  render at full opacity with a thicker stroke ring; non-matching
   *  points are heavily dimmed so the subset visually pops. */
  highlightMatcher?: ((p: CatalogAnalyticsPoint) => boolean) | null
  /** v1.4 V4'4: currently-selected dot's inventoryItemId (or null). */
  selectedDotId?: string | null
  /** v1.4 V4'4: click/keyboard activation handler. */
  onSelectDot?: (dotId: string | null) => void
}

interface PlottedPoint {
  readonly p: CatalogAnalyticsPoint
  /** Screen-space plot coordinate (may be axis-transformed). Mutable so
   *  the zero-floor fixup pass can place no-movement dots. */
  x: number
  y: number
  /** Raw metric value for tooltips (never axis-transformed). Equals
   *  x / y when the axis is a plain linear scale. */
  readonly xRaw: number
  readonly yRaw: number
  /** Categorical-colour bucket label. Empty string when the active colour-by is continuous. */
  readonly bucket: string
  /** Continuous-colour raw value (null for categorical mode). */
  readonly colourValue: number | null
  readonly sizeValue: number | null
  readonly opacityValue: number | null
}

// Per-dot radius bounds when a size-by encoding is active. Linear sqrt
// scaling between MIN_R and MAX_R so visual weight (area) is the
// quantity carried.
const SIZE_MIN_R = 2
const SIZE_MAX_R = 11
// Opacity bounds when an opacity-by encoding is active. We bottom-out
// well above 0 so faint dots remain visible against the white plot
// area.
const OPACITY_MIN = 0.18
const OPACITY_MAX = 0.92
const UNIFORM_R = 3.5
const UNIFORM_OPACITY = 0.65

function CatalogScatterSvg({
  points,
  xDef,
  yDef,
  colourByDef,
  sizeByDef,
  opacityByDef,
  loading,
  axisCtx,
  referenceLine,
  highlightMatcher,
  selectedDotId,
  onSelectDot,
}: CatalogScatterSvgProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const touchGestureRef = useRef(new TapGestureTracker())
  const { showTooltip, dismissTooltip } = useChartInteraction()
  const [renderedWidthPx, setRenderedWidthPx] = useState<number>(440)
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const w = Math.max(220, Math.floor(entries[0]?.contentRect.width ?? 440))
      setRenderedWidthPx(w)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const width = renderedWidthPx
  const height = 320
  const marginLeft = 64
  const marginRight = 14
  const marginTop = 14
  const marginBottom = 40
  const plotW = Math.max(50, width - marginLeft - marginRight)
  const plotH = Math.max(50, height - marginTop - marginBottom)

  // "Balanced" ratio scale (reciprocal-fold around 1.0). Only ratio
  // axes (scaleKind 'ratioBaseline1') are eligible; the toggle is
  // hidden entirely when neither axis qualifies. Default ON — it's the
  // intended view (equal precision above AND below the cohort baseline);
  // the operator can drop to Linear per-card. See catalogRatioAxis.ts.
  const xRatio = xDef.scaleKind === 'ratioBaseline1'
  const yRatio = yDef.scaleKind === 'ratioBaseline1'
  const ratioEligible = xRatio || yRatio
  const [balanced, setBalanced] = useState(true)
  const xActive = balanced && xRatio
  const yActive = balanced && yRatio

  const computed = useMemo(() => {
    const plotted: PlottedPoint[] = []
    let xLo = Number.POSITIVE_INFINITY
    let xHi = Number.NEGATIVE_INFINITY
    let yLo = Number.POSITIVE_INFINITY
    let yHi = Number.NEGATIVE_INFINITY
    const bucketSet = new Set<string>()
    const colourValues: Array<number | null> = []
    const sizeValuesAll: Array<number | null> = []
    const opacityValuesAll: Array<number | null> = []
    const isContinuousColour = colourByDef.kind === 'continuous'
    // Balanced ratio axes fold r<1 into the negative via reciprocal
    // (see catalogRatioAxis.ts). A ratio of exactly 0 (never-sold →
    // velocity index 0) has no finite fold value, so we stash NaN and
    // resolve it to a data-dependent floor AFTER the extents are known,
    // keeping the no-movement dots visible and correctly ordered below
    // every positive point. Track per-axis whether any zeros exist and
    // the smallest finite transformed value to place that floor.
    let xMinFinite = Number.POSITIVE_INFINITY
    let yMinFinite = Number.POSITIVE_INFINITY
    let xHasZero = false
    let yHasZero = false
    const txX = (v: number): number => (xActive ? (v > 0 ? ratioForward(v) : NaN) : v)
    const txY = (v: number): number => (yActive ? (v > 0 ? ratioForward(v) : NaN) : v)
    for (const p of points) {
      // Plot-position resolution: real value when present, else a
      // list-price / no-movement default for never-sold variants, so
      // they land at a sensible spot instead of vanishing. See
      // `plotMetricValue` above.
      const xr = plotMetricValue(xDef.id, xDef.value(p, axisCtx), p, axisCtx)
      const yr = plotMetricValue(yDef.id, yDef.value(p, axisCtx), p, axisCtx)
      if (xr === null || yr === null || !Number.isFinite(xr) || !Number.isFinite(yr)) continue
      const x = txX(xr)
      const y = txY(yr)
      const bucket = isContinuousColour ? '' : colourByDef.bucket(p)
      if (!isContinuousColour) bucketSet.add(bucket)
      const colourRaw = isContinuousColour
        ? plotMetricValue(colourByDef.id, colourByDef.value(p, axisCtx), p, axisCtx)
        : null
      const colourValue = colourRaw != null && Number.isFinite(colourRaw) ? colourRaw : null
      colourValues.push(colourValue)
      const sRaw = plotMetricValue(sizeByDef.id, sizeByDef.value(p, axisCtx), p, axisCtx)
      const oRaw = plotMetricValue(opacityByDef.id, opacityByDef.value(p, axisCtx), p, axisCtx)
      const sizeValue = sRaw != null && Number.isFinite(sRaw) ? sRaw : null
      const opacityValue = oRaw != null && Number.isFinite(oRaw) ? oRaw : null
      sizeValuesAll.push(sizeValue)
      opacityValuesAll.push(opacityValue)
      plotted.push({ p, x, y, xRaw: xr, yRaw: yr, bucket, colourValue, sizeValue, opacityValue })
      if (Number.isNaN(x)) {
        xHasZero = true
      } else {
        if (x < xLo) xLo = x
        if (x > xHi) xHi = x
        if (x < xMinFinite) xMinFinite = x
      }
      if (Number.isNaN(y)) {
        yHasZero = true
      } else {
        if (y < yLo) yLo = y
        if (y > yHi) yHi = y
        if (y < yMinFinite) yMinFinite = y
      }
    }
    if (plotted.length === 0) {
      return {
        plotted,
        buckets: [] as string[],
        xMin: 0,
        xMax: 1,
        yMin: 0,
        yMax: 1,
        xFloor: null as number | null,
        yFloor: null as number | null,
        colourScale: null as ContinuousScale | null,
        sizeScale: null as ContinuousScale | null,
        opacityScale: null as ContinuousScale | null,
      }
    }
    // Resolve zero-floor positions and drop the no-movement dots there.
    // Fold each floor into the extents so the padded domain frames them.
    const xFloor =
      xActive && xHasZero
        ? ratioZeroFloor(Number.isFinite(xMinFinite) ? xMinFinite : null)
        : null
    const yFloor =
      yActive && yHasZero
        ? ratioZeroFloor(Number.isFinite(yMinFinite) ? yMinFinite : null)
        : null
    if (xFloor != null || yFloor != null) {
      for (const pp of plotted) {
        if (xFloor != null && Number.isNaN(pp.x)) pp.x = xFloor
        if (yFloor != null && Number.isNaN(pp.y)) pp.y = yFloor
      }
      if (xFloor != null) {
        if (xFloor < xLo) xLo = xFloor
        if (xFloor > xHi) xHi = xFloor
      }
      if (yFloor != null) {
        if (yFloor < yLo) yLo = yFloor
        if (yFloor > yHi) yHi = yFloor
      }
    }
    if (xLo === xHi) {
      xLo -= 1
      xHi += 1
    } else {
      const span = xHi - xLo
      xLo -= span * 0.05
      xHi += span * 0.05
    }
    if (yLo === yHi) {
      yLo -= 1
      yHi += 1
    } else {
      const span = yHi - yLo
      yLo -= span * 0.05
      yHi += span * 0.05
    }
    // Build per-card distribution-aware scales. The scales decide
    // their own linear-vs-rank mode based on whether the sample looks
    // uniform; betterDirection picks which end of the [0,1] output
    // is "good". See continuousScale.ts.
    const colourScale = isContinuousColour
      ? buildContinuousScale(colourValues, colourByDef.betterDirection)
      : null
    const sizeScale =
      sizeByDef.id === 'none'
        ? null
        : buildContinuousScale(sizeValuesAll, sizeByDef.betterDirection ?? 'higher')
    const opacityScale =
      opacityByDef.id === 'none'
        ? null
        : buildContinuousScale(opacityValuesAll, opacityByDef.betterDirection ?? 'higher')

    // Sort buckets alphabetically for stable legend ordering.
    const buckets = Array.from(bucketSet).sort()
    return {
      plotted,
      buckets,
      xMin: xLo,
      xMax: xHi,
      yMin: yLo,
      yMax: yHi,
      xFloor,
      yFloor,
      colourScale,
      sizeScale,
      opacityScale,
    }
  }, [points, xDef, yDef, colourByDef, sizeByDef, opacityByDef, axisCtx, xActive, yActive])

  const { plotted, buckets, xMin, xMax, yMin, yMax, xFloor, yFloor, colourScale, sizeScale, opacityScale } =
    computed

  // Zoom / pan hook. Base domain is the outlier-resistant compact
  // window over the just-computed data extent (densest ~90% per axis),
  // not the full extent — so a couple of outlier variants don't
  // squish the rest of the cloud into a corner. Outliers stay
  // reachable: Ctrl/⌘-wheel or pinch zoom out, or click "Show all
  // data (N)" to swap base to the full extent. We snap to `null`
  // while loading / empty so the hook can no-op without crashing.
  const fullDomain: ZoomView | null = useMemo(() => {
    if (plotted.length === 0) return null
    return { xMin, xMax, yMin, yMax }
  }, [plotted.length, xMin, xMax, yMin, yMax])
  const autoZoom = useMemo(
    () => computeCompactDomain(plotted, { fullDomain }),
    [plotted, fullDomain],
  )
  const [fitMode, setFitMode] = useState<'compact' | 'full'>('compact')
  const baseDomain = fitMode === 'full' ? autoZoom.full : autoZoom.compact
  // Local pan/zoom UI state (June 2026 redesign). Default is
  // `inspect` so the chart behaves exactly as before until the
  // operator opts in via the toolbar. `tool` is only meaningful in
  // zoom mode but we keep it as separate state so the toolbar can
  // show the current/previous tool when toggling modes back and
  // forth without losing the selection.
  const [zoomMode, setZoomMode] = useState<ScatterInteractionMode>('inspect')
  const [zoomTool, setZoomTool] = useState<ScatterZoomTool>('box')
  const zoom = useScatterZoom({
    baseDomain,
    boundsDomain: autoZoom.full,
    svgRef,
    plot: { left: marginLeft, top: marginTop, width: plotW, height: plotH },
    mode: zoomMode,
    tool: zoomTool,
  })
  const view = zoom.view ?? baseDomain ?? fullDomain ?? { xMin, xMax, yMin, yMax }
  const clipId = useId()

  // Build per-point radius / opacity / colour resolvers using the
  // card-local distribution-aware scales. The scale itself does any
  // rank-stretching (resolution where the data lives); we just map
  // its [0,1] output to the visual range.
  //
  // For size we map the stretched fraction LINEARLY to dot AREA (then
  // sqrt to radius), so visual weight is proportional to the
  // stretched value rather than to the raw input. With rank mode this
  // gives equal-area increments per data percentile — i.e. half the
  // dots are smaller than the median dot's area.
  const dotRadius = useCallback(
    (sizeValue: number | null): number => {
      if (sizeScale == null) return UNIFORM_R
      const frac = sizeScale.toFraction(sizeValue)
      if (frac == null) return SIZE_MIN_R
      const minArea = SIZE_MIN_R * SIZE_MIN_R
      const maxArea = SIZE_MAX_R * SIZE_MAX_R
      const area = minArea + frac * (maxArea - minArea)
      return Math.sqrt(area)
    },
    [sizeScale],
  )
  const dotOpacity = useCallback(
    (opacityValue: number | null): number => {
      if (opacityScale == null) return UNIFORM_OPACITY
      const frac = opacityScale.toFraction(opacityValue)
      if (frac == null) return OPACITY_MIN
      return OPACITY_MIN + frac * (OPACITY_MAX - OPACITY_MIN)
    },
    [opacityScale],
  )

  // Resolve the colour fill for one dot. Branches once on the
  // colour-by `kind` (cheap; the def reference is stable across the
  // card render).
  const dotColour = useCallback(
    (pp: PlottedPoint): string => {
      if (colourByDef.kind === 'categorical') {
        return colourFor(pp.bucket, buckets)
      }
      // Continuous mode: rank-stretched / linear fraction → red→green
      // ramp. Null inputs render in the neutral fallback grey.
      if (colourScale == null) return '#bdbdbd'
      const frac = colourScale.toFraction(pp.colourValue)
      return continuumColour(frac)
    },
    [colourByDef, buckets, colourScale],
  )

  const xScale = useCallback(
    (v: number) => marginLeft + ((v - view.xMin) / (view.xMax - view.xMin)) * plotW,
    [marginLeft, plotW, view.xMin, view.xMax],
  )
  const yScale = useCallback(
    (v: number) => marginTop + plotH - ((v - view.yMin) / (view.yMax - view.yMin)) * plotH,
    [marginTop, plotH, view.yMin, view.yMax],
  )

  // v1.4 V4'1: shared niceXTicks / niceYTicks helpers from
  // gridlines.ts so scatter axes use the same `{1, 2, 2.5, 5, 10} × 10^k`
  // ladder as the time-series MetricChart (operator wishlist #1 —
  // "scatter feels different from the rest of the dashboard"). The CI
  // guardrail in `gridlines.test.ts` covers the 2.5 / 0.25 / 0.025
  // regression cases on both axes.
  // Ticks carry an explicit label so a transformed (balanced) axis can
  // show raw-ratio labels ("0.50×", "1.00×", "2.00×") at folded
  // positions while a plain linear axis keeps the shared nice-tick
  // ladder. `pos` is always in plot (post-transform) coordinates.
  const xTicks: RatioTick[] = useMemo(
    () =>
      xActive
        ? ratioTicks(view.xMin, view.xMax, { format: xDef.format, zeroFloor: xFloor })
        : niceXTicks(view.xMin, view.xMax, 5).ticks.map((t) => ({
            pos: t,
            label: xDef.format(t),
          })),
    [xActive, view.xMin, view.xMax, xDef, xFloor],
  )
  const yTicks: RatioTick[] = useMemo(
    () =>
      yActive
        ? ratioTicks(view.yMin, view.yMax, { format: yDef.format, zeroFloor: yFloor })
        : niceYTicks(view.yMin, view.yMax, 5).ticks.map((t) => ({
            pos: t,
            label: yDef.format(t),
          })),
    [yActive, view.yMin, view.yMax, yDef, yFloor],
  )

  // Hover. Stored as just the index — we recompute the dot's screen
  // position from `xScale`/`yScale` each render, so the tooltip
  // automatically tracks the dot through scrolling, resizing, and
  // pan/zoom rather than freezing at the touch coordinate.
  //
  // On touch, the browser fires `pointerleave` the moment the finger
  // lifts. We track the originating pointer type so we can keep the
  // tooltip pinned after a tap on touch (operator must tap elsewhere
  // or tap the X to dismiss). Mouse retains the old "leave clears
  // tooltip" behaviour because hover semantics work fine there.
  const [hover, setHover] = useState<{ idx: number; pointerType: string } | null>(
    null,
  )
  const HOVER_PX = 12
  const TOUCH_HOVER_PX = 28 // chubbier hit-radius for fingers
  // Two-pass hit-test that prefers highlighted (matching) dots over
  // dimmed (non-matching) dots when a highlight matcher is active.
  // Without this the nearest-dot scan can land on a heavily-dimmed
  // point that visually sits underneath a popped highlight point —
  // and the resulting tooltip shows the wrong product (see brand /
  // distributor detail page bug, June 2026: hovering near a Quality
  // Control edibles dot snapped to a nearby dimmed Revert dot and
  // surfaced "Revert" as if that was the brand's highlighted point).
  const findNearestIdx = useCallback(
    (local: { x: number; y: number }, hitRadiusSq: number): number => {
      const scan = (matchersOnly: boolean): { idx: number; distSq: number } => {
        let bestIdx = -1
        let bestDistSq = Infinity
        for (let i = 0; i < plotted.length; i++) {
          const pp = plotted[i]!
          // skip points outside the visible view — they're clipped
          if (
            pp.x < view.xMin ||
            pp.x > view.xMax ||
            pp.y < view.yMin ||
            pp.y > view.yMax
          ) {
            continue
          }
          if (matchersOnly && highlightMatcher && !highlightMatcher(pp.p)) {
            continue
          }
          const dx = xScale(pp.x) - local.x
          const dy = yScale(pp.y) - local.y
          const d = dx * dx + dy * dy
          if (d < bestDistSq) {
            bestDistSq = d
            bestIdx = i
          }
        }
        return { idx: bestIdx, distSq: bestDistSq }
      }
      if (highlightMatcher) {
        const m = scan(true)
        if (m.idx >= 0 && m.distSq <= hitRadiusSq) return m.idx
      }
      const any = scan(false)
      return any.idx >= 0 && any.distSq <= hitRadiusSq ? any.idx : -1
    },
    [plotted, xScale, yScale, view.xMin, view.xMax, view.yMin, view.yMax, highlightMatcher],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      // Forward to the zoom hook first so pinch/pan can run.
      zoom.handlers.onPointerMove(e)
      if (e.pointerType !== 'mouse') return
      if (zoom.gestureActive) {
        if (hover) setHover(null)
        return
      }
      const svg = svgRef.current
      if (!svg || plotted.length === 0) return
      const ctm = svg.getScreenCTM()
      if (!ctm) return
      const pt = svg.createSVGPoint()
      pt.x = e.clientX
      pt.y = e.clientY
      const local = pt.matrixTransform(ctm.inverse())
      const bestIdx = findNearestIdx(local, HOVER_PX * HOVER_PX)
      if (bestIdx >= 0) {
        setHover({ idx: bestIdx, pointerType: e.pointerType })
      } else {
        setHover(null)
      }
    },
    [plotted, zoom, hover, findNearestIdx],
  )

  // Mouse: pointerleave clears the tooltip. Touch: do NOT clear on
  // pointerleave — the operator just lifted their finger; they
  // expect the tooltip to remain so they can read it.
  const onPointerLeave = useCallback(
    (_e: React.PointerEvent<SVGSVGElement>) => {
      setHover((h) => (h && h.pointerType !== 'mouse' ? h : null))
    },
    [],
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      zoom.handlers.onPointerDown(e)
      if (e.pointerType !== 'mouse') {
        touchGestureRef.current.pointerDown(e.pointerId, {
          x: e.clientX,
          y: e.clientY,
        })
      }
    },
    [zoom],
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      zoom.handlers.onPointerUp(e)
      if (
        e.pointerType === 'mouse' ||
        !touchGestureRef.current.pointerUp(e.pointerId, { x: e.clientX, y: e.clientY }) ||
        plotted.length === 0
      ) return
      const svg = svgRef.current
      if (!svg) return
      const ctm = svg.getScreenCTM()
      if (!ctm) return
      const pt = svg.createSVGPoint()
      pt.x = e.clientX
      pt.y = e.clientY
      const local = pt.matrixTransform(ctm.inverse())
      const renderedWidth = svg.getBoundingClientRect().width
      const touchRadius = renderedWidth > 0 ? 44 * (width / renderedWidth) : TOUCH_HOVER_PX
      const bestIdx = findNearestIdx(local, touchRadius * touchRadius)
      if (bestIdx >= 0) {
        setHover({ idx: bestIdx, pointerType: e.pointerType })
      } else {
        setHover(null)
      }
    },
    [plotted, width, zoom, findNearestIdx],
  )

  const onPointerCancel = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      touchGestureRef.current.pointerCancel(e.pointerId)
      zoom.handlers.onPointerCancel(e)
    },
    [zoom],
  )

  const hovered = hover ? plotted[hover.idx] ?? null : null
  const hoveredDotX = hovered ? xScale(hovered.x) : null
  const hoveredDotY = hovered ? yScale(hovered.y) : null

  useEffect(() => {
    const svg = svgRef.current
    if (hovered === null || hoveredDotX === null || hoveredDotY === null || svg === null) {
      dismissTooltip(false)
      return
    }
    const trigger = svg.querySelector<SVGCircleElement>(
      `[data-chart-point-index="${hover?.idx ?? -1}"]`,
    ) ?? svg
    showTooltip({
      anchor: svgPointAnchor(svg, { x: hoveredDotX, y: hoveredDotY }, trigger),
      sticky: hover?.pointerType !== 'mouse',
      label: `Product details for ${hovered.p.productName}`,
      onDismiss: () => setHover(null),
      content: (
        <ScatterTooltipContent
          point={hovered.p}
          xDef={xDef}
          yDef={yDef}
          xValue={hovered.xRaw}
          yValue={hovered.yRaw}
          noWindowSales={hasNoWindowSales(hovered.p)}
          colourLabel={
            colourByDef.kind === 'categorical'
              ? hovered.bucket
              : hovered.colourValue != null
                ? colourByDef.format(hovered.colourValue)
                : '—'
          }
          colourByDef={colourByDef}
        />
      ),
    })
  }, [
    colourByDef,
    dismissTooltip,
    hover?.idx,
    hover?.pointerType,
    hovered,
    hoveredDotX,
    hoveredDotY,
    showTooltip,
    xDef,
    yDef,
  ])

  return (
    <div className="metric-chart-svg-wrap catalog-analytics-svg-wrap" ref={wrapRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        className="metric-chart-svg"
        role="group"
        aria-label={`Scatter: ${yDef.label} (y) vs ${xDef.label} (x)`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerLeave}
        onDoubleClick={zoom.handlers.onDoubleClick}
        style={zoom.svgStyle}
      >
        {/* Clip dots / reference lines so panned content can't leak
            over the axes, tick labels, or the chart frame. */}
        <defs>
          <clipPath id={clipId}>
            <rect
              x={marginLeft}
              y={marginTop}
              width={plotW}
              height={plotH}
            />
          </clipPath>
        </defs>
        {/* Light dashed gridlines at the same "nice" intervals the
            axis labels use. Drawn before axes/data so they sit
            beneath everything else. */}
        <g pointerEvents="none">
          {xTicks.map((t) => {
            const x = xScale(t.pos)
            return (
              <line
                key={`xg-${t.pos}`}
                x1={x}
                x2={x}
                y1={marginTop}
                y2={marginTop + plotH}
                stroke="#d8d8d8"
                strokeWidth={0.8}
                strokeDasharray="3 3"
              />
            )
          })}
          {yTicks.map((t) => {
            const y = yScale(t.pos)
            return (
              <line
                key={`yg-${t.pos}`}
                x1={marginLeft}
                x2={marginLeft + plotW}
                y1={y}
                y2={y}
                stroke="#d8d8d8"
                strokeWidth={0.8}
                strokeDasharray="3 3"
              />
            )
          })}
        </g>
        {/* axes */}
        <line
          x1={marginLeft}
          x2={marginLeft + plotW}
          y1={marginTop + plotH}
          y2={marginTop + plotH}
          stroke="#888"
        />
        <line
          x1={marginLeft}
          x2={marginLeft}
          y1={marginTop}
          y2={marginTop + plotH}
          stroke="#888"
        />
        {xTicks.map((t) => (
          <g key={`x-${t.pos}`}>
            <line
              x1={xScale(t.pos)}
              x2={xScale(t.pos)}
              y1={marginTop + plotH}
              y2={marginTop + plotH + 4}
              stroke="#888"
            />
            <text
              x={xScale(t.pos)}
              y={marginTop + plotH + 16}
              fontSize="10"
              textAnchor="middle"
              fill="#666"
            >
              {t.label}
            </text>
          </g>
        ))}
        {yTicks.map((t) => (
          <g key={`y-${t.pos}`}>
            <line x1={marginLeft - 4} x2={marginLeft} y1={yScale(t.pos)} y2={yScale(t.pos)} stroke="#888" />
            <text
              x={marginLeft - 6}
              y={yScale(t.pos) + 3}
              fontSize="10"
              textAnchor="end"
              fill="#666"
            >
              {t.label}
            </text>
          </g>
        ))}
        <text
          x={marginLeft + plotW / 2}
          y={height - 6}
          fontSize="11"
          textAnchor="middle"
          fill="#444"
        >
          {xActive ? `${xDef.label} (balanced at 1×)` : xDef.label}
        </text>
        <text
          transform={`rotate(-90 12 ${marginTop + plotH / 2})`}
          x={12}
          y={marginTop + plotH / 2}
          fontSize="11"
          textAnchor="middle"
          fill="#444"
        >
          {yActive ? `${yDef.label} (balanced at 1×)` : yDef.label}
        </text>
        {/* Everything that lives inside the plot rectangle — reference
            lines, dots, hover highlight — is clipped so zoom/pan can't
            paint over the axis, ticks, or chart frame. */}
        <g clipPath={`url(#${clipId})`}>
          {/* Reference line annotations.
              - diagonal:  y = x in axis space (clipped naturally by the
                           plot rect — we no longer need to manually
                           intersect with the visible range, since the
                           clipPath does it for us regardless of zoom).
              - unit-y:    horizontal line at y = 1 (index axes).
              - unit-x:    vertical line at x = 1.
              Ratio 1.0 sits at transformed 0 on a balanced axis, so the
              unit lines use the axis-transformed baseline position. The
              diagonal is only meaningful when both axes share the same
              scale (both linear or both balanced). */}
          {referenceLine === 'diagonal' && plotted.length > 0 && xActive === yActive ? (
            <line
              x1={xScale(Math.min(view.xMin, view.yMin) - 1)}
              y1={yScale(Math.min(view.xMin, view.yMin) - 1)}
              x2={xScale(Math.max(view.xMax, view.yMax) + 1)}
              y2={yScale(Math.max(view.xMax, view.yMax) + 1)}
              stroke="#999"
              strokeDasharray="4 4"
              strokeWidth={1}
            />
          ) : null}
          {referenceLine === 'unit-y' ? (
            <line
              x1={xScale(view.xMin)}
              y1={yScale(yActive ? 0 : 1)}
              x2={xScale(view.xMax)}
              y2={yScale(yActive ? 0 : 1)}
              stroke="#999"
              strokeDasharray="4 4"
              strokeWidth={1}
            />
          ) : null}
          {referenceLine === 'unit-x' ? (
            <line
              x1={xScale(xActive ? 0 : 1)}
              y1={yScale(view.yMin)}
              x2={xScale(xActive ? 0 : 1)}
              y2={yScale(view.yMax)}
              stroke="#999"
              strokeDasharray="4 4"
              strokeWidth={1}
            />
          ) : null}
          {/* dots — when a highlight predicate is active we render
              non-matching points first (heavily dimmed, slightly
              shrunk) and matching points last so they paint on top
              with a stronger ring. Without the explicit z-order
              split, the highlighted subset can be buried under the
              dimmed cloud and the visual effect is lost. */}
          {(() => {
            const matched: Array<[PlottedPoint, number]> = []
            const dimmed: Array<[PlottedPoint, number]> = []
            const hasHighlight = !!highlightMatcher
            plotted.forEach((pp, idx) => {
              if (hasHighlight && highlightMatcher!(pp.p)) matched.push([pp, idx])
              else if (hasHighlight) dimmed.push([pp, idx])
              else matched.push([pp, idx])
            })
            const renderDot = (pp: PlottedPoint, idx: number, isMatch: boolean): JSX.Element => {
              const r = dotRadius(pp.sizeValue)
              // v1.4 V4'4: selected dots get a 2px black stroke that
              // overrides every other stroke. Drill is wired only
              // when onSelectDot is provided.
              const drillable = onSelectDot != null
              const isSelected =
                drillable && selectedDotId != null && selectedDotId === pp.p.inventoryItemId
              const onActivate = (): void => {
                if (!drillable) return
                onSelectDot!(isSelected ? null : pp.p.inventoryItemId)
              }
              const drillAttrs = drillable
                ? {
                    role: 'button' as const,
                    'aria-pressed': isSelected,
                    'aria-label': `Drill into ${pp.p.productName ?? pp.p.inventoryItemId}`,
                    style: { cursor: 'pointer' },
                    onClick: onActivate,
                    onKeyDown: (e: React.KeyboardEvent<SVGCircleElement>) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onActivate()
                      }
                    },
                  }
                : {}
              const interactionAttrs = {
                'data-chart-point-index': idx,
                tabIndex: drillable ? 0 : -1,
                onFocus: () => setHover({ idx, pointerType: 'keyboard' }),
              }
              if (hasHighlight && !isMatch) {
                return (
                  <circle
                    key={`dim-${pp.p.inventoryItemId}-${idx}`}
                    cx={xScale(pp.x)}
                    cy={yScale(pp.y)}
                    r={Math.max(1.5, r - 0.5)}
                    fill={dotColour(pp)}
                    fillOpacity={Math.min(0.18, dotOpacity(pp.opacityValue))}
                    stroke={isSelected ? '#000' : 'none'}
                    strokeWidth={isSelected ? 2 : 0}
                    {...interactionAttrs}
                    {...drillAttrs}
                  />
                )
              }
              if (hasHighlight && isMatch) {
                return (
                  <circle
                    key={`hl-${pp.p.inventoryItemId}-${idx}`}
                    cx={xScale(pp.x)}
                    cy={yScale(pp.y)}
                    r={r + 0.5}
                    fill={dotColour(pp)}
                    fillOpacity={Math.max(0.9, dotOpacity(pp.opacityValue))}
                    stroke={isSelected ? '#000' : '#111'}
                    strokeWidth={isSelected ? 2 : 1.25}
                    {...interactionAttrs}
                    {...drillAttrs}
                  />
                )
              }
              return (
                <circle
                  key={`${pp.p.inventoryItemId}-${idx}`}
                  cx={xScale(pp.x)}
                  cy={yScale(pp.y)}
                  r={r}
                  fill={dotColour(pp)}
                  fillOpacity={dotOpacity(pp.opacityValue)}
                  stroke={isSelected ? '#000' : '#fff'}
                  strokeWidth={isSelected ? 2 : 0.5}
                  {...interactionAttrs}
                  {...drillAttrs}
                />
              )
            }
            return (
              <>
                {dimmed.map(([pp, idx]) => renderDot(pp, idx, false))}
                {matched.map(([pp, idx]) => renderDot(pp, idx, true))}
              </>
            )
          })()}
          {/* hovered dot highlight — when a brand/distributor highlight
              matcher is active, a hovered NON-matching dot uses a
              muted dashed ring so it can never be visually confused
              with the page-level highlight emphasis. Without this,
              hovering near a dimmed competitor dot on a brand /
              distributor detail page can look identical to the
              brand-highlight ring (June 2026 bug). */}
          {hovered ? (() => {
            const hoveredIsMatch =
              highlightMatcher == null ? true : highlightMatcher(hovered.p)
            return (
              <circle
                cx={xScale(hovered.x)}
                cy={yScale(hovered.y)}
                r={6}
                fill="none"
                stroke={hoveredIsMatch ? '#111' : '#888'}
                strokeOpacity={hoveredIsMatch ? 1 : 0.55}
                strokeWidth={hoveredIsMatch ? 1.5 : 1}
                strokeDasharray={hoveredIsMatch ? undefined : '3 2'}
              />
            )
          })() : null}
          {/* Box-zoom drag preview overlay. Rendered AFTER the dots /
              hover ring so it always paints on top, and outside the
              clip path so a corner-of-plot drag still shows the full
              rectangle frame at the edges. */}
          {zoom.dragBox ? (
            <rect
              className="scatter-zoom-dragbox"
              x={zoom.dragBox.x}
              y={zoom.dragBox.y}
              width={zoom.dragBox.width}
              height={zoom.dragBox.height}
            />
          ) : null}
        </g>
      </svg>

      {ratioEligible ? (
        <div className="scatter-ratio-toolbar" role="group" aria-label="Ratio axis scale">
          <span className="scatter-ratio-label">Ratio scale:</span>
          <div className="scatter-view-tool-group" role="group" aria-label="Ratio scale mode">
            <button
              type="button"
              className={
                balanced ? 'scatter-view-tool-chip' : 'scatter-view-tool-chip is-active'
              }
              aria-pressed={!balanced}
              onClick={() => setBalanced(false)}
            >
              Linear
            </button>
            <button
              type="button"
              className={
                balanced ? 'scatter-view-tool-chip is-active' : 'scatter-view-tool-chip'
              }
              aria-pressed={balanced}
              onClick={() => setBalanced(true)}
            >
              Balanced
            </button>
          </div>
          <HelpIcon
            text={
              'Balanced ratio scale: 1× is the cohort baseline. A value ' +
              'below 1× plots as far below the baseline as its reciprocal ' +
              'plots above — 0.5× sits opposite 2×, 0.33× opposite 3× — so ' +
              'low and high performers get equal vertical precision. Never-' +
              'sold items (0×) sit at the bottom floor tick. Applies to ' +
              (xRatio && yRatio
                ? 'both axes'
                : xRatio
                ? `the X axis (${xDef.short})`
                : `the Y axis (${yDef.short})`) +
              '. Switch to Linear for the raw ratio axis.'
            }
          />
        </div>
      ) : null}

      <ScatterViewToolbar
        mode={zoomMode}
        setMode={setZoomMode}
        tool={zoomTool}
        setTool={setZoomTool}
        isZoomed={zoom.isZoomed}
        resetView={zoom.resetView}
        fitMode={autoZoom.hiddenCount > 0 ? fitMode : undefined}
        setFitMode={autoZoom.hiddenCount > 0 ? setFitMode : undefined}
        hiddenOutlierCount={autoZoom.hiddenCount}
      />

      {colourByDef.kind === 'categorical' && colourByDef.id !== 'none' && buckets.length > 1 ? (
        <div className="catalog-analytics-legend">
          {buckets.slice(0, 16).map((b) => (
            <span key={b} className="catalog-analytics-legend-item">
              <span
                className="catalog-analytics-legend-swatch"
                style={{ background: colourFor(b, buckets) }}
              />
              {b}
            </span>
          ))}
          {buckets.length > 16 ? (
            <span className="subtle-copy">+{buckets.length - 16} more</span>
          ) : null}
        </div>
      ) : null}

      {colourByDef.kind === 'continuous' && colourScale ? (
        <ContinuousLegend
          label={colourByDef.label}
          format={colourByDef.format}
          scale={colourScale}
        />
      ) : null}

      {plotted.length === 0 && !loading ? (
        <p className="subtle-copy">
          No variants in the current filter slice have values for both axes over the last{' '}
          {axisCtx.windowDays} days.
        </p>
      ) : null}
    </div>
  )
}

// ============================ Continuous legend ============================

interface ContinuousLegendProps {
  readonly label: string
  readonly format: (v: number) => string
  readonly scale: ContinuousScale
}

/**
 * Gradient strip with min / max value labels for continuous colour-by
 * mode. The strip itself is just a CSS gradient through the same
 * red→green ramp the dots use; we sample a handful of ramp stops so
 * the gradient visually matches `continuumColour` (no separate
 * tuning to drift out of sync).
 *
 * If the per-card scale ran in rank-stretched mode we also note that
 * — "rank-stretched" is operator shorthand for "resolution lives
 * where the data lives, not at fixed band edges".
 */
function ContinuousLegend({ label, format, scale }: ContinuousLegendProps) {
  if (scale.min == null || scale.max == null) return null
  // Sample the ramp at 11 stops (every 10%) and turn it into a CSS
  // gradient. The stops use the metric's `betterDirection`-aware
  // [0,1] mapping so "good" always ends up green regardless of which
  // direction the metric runs.
  const stops: string[] = []
  for (let i = 0; i <= 10; i++) {
    const p = i / 10
    stops.push(`${continuumColour(p)} ${(p * 100).toFixed(0)}%`)
  }
  const gradient = `linear-gradient(to right, ${stops.join(', ')})`
  const lowEnd = scale.betterDirection === 'higher' ? scale.min : scale.max
  const highEnd = scale.betterDirection === 'higher' ? scale.max : scale.min
  return (
    <div className="catalog-analytics-legend continuous">
      <span className="catalog-analytics-legend-label">{label}</span>
      <span className="continuous-legend-min">{format(lowEnd)}</span>
      <span
        className="continuous-legend-strip"
        style={{ background: gradient }}
        aria-hidden
      />
      <span className="continuous-legend-max">{format(highEnd)}</span>
      <span className="subtle-copy continuous-legend-mode">
        {scale.mode === 'rank'
          ? `rank-stretched (n=${scale.sampleSize})`
          : `linear (n=${scale.sampleSize})`}
      </span>
    </div>
  )
}

interface ScatterTooltipContentProps {
  point: CatalogAnalyticsPoint
  xDef: PointAxisDef
  yDef: PointAxisDef
  xValue: number
  yValue: number
  /** True when this variant had no window sales — its axis positions
   *  are list-price / no-movement defaults, not realized sales. */
  noWindowSales: boolean
  colourLabel: string
  colourByDef: ColourByDef
}

function ScatterTooltipContent(p: ScatterTooltipContentProps) {
  return (
    <>
            <div className="catalog-analytics-tooltip-title">
              {p.point.productName}
              {p.point.sizeLabel ? ` · ${p.point.sizeLabel}` : ''}
            </div>
            <div className="catalog-analytics-tooltip-sub subtle-copy">
              {[p.point.brandName, p.point.distributorName, p.point.subcategoryName, p.point.categoryName]
                .filter((s) => s)
                .join(' • ') || '(no classification)'}
            </div>
            <table className="catalog-analytics-tooltip-table">
              <tbody>
          <tr>
            <th>{p.xDef.short}{p.noWindowSales ? '*' : ''}</th>
            <td>{p.xDef.format(p.xValue)}</td>
          </tr>
          <tr>
            <th>{p.yDef.short}{p.noWindowSales ? '*' : ''}</th>
            <td>{p.yDef.format(p.yValue)}</td>
          </tr>
          {p.point.unitsSold != null ? (
            <tr>
              <th>units sold</th>
              <td>{fmtNum(p.point.unitsSold)}</td>
            </tr>
          ) : null}
          {p.point.revenueDollars != null ? (
            <tr>
              <th>revenue</th>
              <td>{fmtMoney(p.point.revenueDollars)}</td>
            </tr>
          ) : null}
          {p.point.marginDollars != null ? (
            <tr>
              <th>margin $</th>
              <td>{fmtMoney(p.point.marginDollars)}</td>
            </tr>
          ) : null}
          {p.point.gmPercent != null ? (
            <tr>
              <th>eff. GM %</th>
              <td>{fmtPct(p.point.gmPercent)}</td>
            </tr>
          ) : null}
          {p.point.listPriceDollars != null ? (
            <tr>
              <th>list $/u</th>
              <td>{fmtMoney(p.point.listPriceDollars)}</td>
            </tr>
          ) : null}
          {(() => {
            const d = discountDepthPercent(p.point)
            if (d == null) return null
            return (
              <tr>
                <th>discount</th>
                <td>{fmtPct(d)}</td>
              </tr>
            )
          })()}
          {p.point.labThcPct != null ? (
            <tr>
              <th>THC %</th>
              <td>{fmtPct(p.point.labThcPct)}</td>
            </tr>
          ) : null}
          {p.point.currentQty != null ? (
            <tr>
              <th>on hand</th>
              <td>{fmtNum(p.point.currentQty)}</td>
            </tr>
          ) : null}
          {p.colourByDef.id !== 'none' ? (
            <tr>
              <th>{p.colourByDef.label}</th>
              <td>{p.colourLabel}</td>
            </tr>
          ) : null}
              </tbody>
            </table>
            {p.noWindowSales ? (
              <div className="catalog-analytics-tooltip-note subtle-copy">
                * no sales in window; axes show list-price / no-movement defaults
              </div>
            ) : null}
    </>
  )
}

// =============================== Math helpers ==============================

/** Population median. Returns null on an empty / all-NaN input. */
function median(values: ReadonlyArray<number>): number | null {
  const xs = values.filter((v) => Number.isFinite(v))
  if (xs.length === 0) return null
  const sorted = xs.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

// =============================== Tick helpers ==============================
//
// v1.4 V4'1: scatter tick computation has been unified across the
// dashboard. The local `makeTicks` (linear interpolation) was removed
// in favour of the shared `niceXTicks` / `niceYTicks` helpers from
// `gridlines.ts`, which use the same `{1, 2, 2.5, 5, 10} × 10^k`
// ladder as the time-series `MetricChart`. The CI guardrail in
// `gridlines.test.ts` covers the 2.5 / 0.25 / 0.025 regression cases
// on both axes.
