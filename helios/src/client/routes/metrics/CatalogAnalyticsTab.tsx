import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import {
  CatalogAnalyticsFiltersResponseSchema,
  CatalogAnalyticsPointsResponseSchema,
  type CatalogAnalyticsFiltersResponse,
  type CatalogAnalyticsPoint,
  type CatalogAnalyticsPointsResponse,
  type CatalogFilterOption,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { HelpIcon } from './MetricChart.js'
import { computeCompactDomain } from './scatterAutoZoom.js'
import { useScatterZoom, type ZoomView } from './scatterZoom.js'

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

function cohortKey(p: CatalogAnalyticsPoint): string {
  return `${p.categoryName ?? '(no cat)'}|${p.subcategoryName ?? '(no sub)'}|${
    p.sizeLabel ?? '(no size)'
  }`
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
    label: 'Weeks of supply (on-hand / weekly velocity)',
    short: 'Wks supply',
    value: (p) => weeksOfSupplyOnHand(p),
    format: fmtNum,
  },
  {
    id: 'velocityIndex',
    label: 'Velocity index vs cohort (cat × sub × size)',
    short: 'Vel idx',
    value: velocityIndex,
    format: fmtX,
  },
  {
    id: 'effectivePriceIndex',
    label: 'Effective price index vs cohort',
    short: 'Price idx',
    value: effectivePriceIndex,
    format: fmtX,
  },
  {
    id: 'gmPercentIndex',
    label: 'GM% vs cohort median (percentage points)',
    short: 'GM% Δ',
    value: gmPercentIndex,
    format: fmtPctSigned,
  },
]

const POINT_AXES_BY_ID = new Map(POINT_AXES.map((a) => [a.id, a]))
function axis(id: string): PointAxisDef {
  return POINT_AXES_BY_ID.get(id) ?? POINT_AXES[0]!
}

// =========================== Colour-by (cohort) ============================

type ColourByKey =
  | 'none'
  | 'category'
  | 'subcategory'
  | 'brand'
  | 'sizeLabel'
  | 'priceBand'
  | 'thcBand'
  | 'discountBand'
  | 'gmBand'

interface ColourByDef {
  readonly id: ColourByKey
  readonly label: string
  readonly bucket: (p: CatalogAnalyticsPoint) => string
}

function priceBand(v: number | null): string {
  if (v == null) return '(no price)'
  if (v < 20) return '<$20'
  if (v < 40) return '$20-$40'
  if (v < 60) return '$40-$60'
  if (v < 100) return '$60-$100'
  return '$100+'
}
function thcBand(v: number | null): string {
  if (v == null) return '(no THC)'
  if (v < 10) return '<10%'
  if (v < 20) return '10-20%'
  if (v < 25) return '20-25%'
  if (v < 30) return '25-30%'
  return '30%+'
}
function discountBand(v: number | null): string {
  if (v == null) return '(no list)'
  if (v < 0.5) return 'at list (<0.5%)'
  if (v < 5) return '0.5–5%'
  if (v < 15) return '5–15%'
  if (v < 30) return '15–30%'
  if (v < 50) return '30–50%'
  return '50%+'
}
function gmBand(v: number | null): string {
  // Higher resolution around the operator's "decision zone" (40–65%).
  // The discount-cliff conversation usually sits inside this band, so a
  // 5-point grain there is much more useful than the coarse buckets we
  // started with.
  if (v == null) return '(no GM)'
  if (v < 0) return 'negative GM'
  if (v < 10) return '0–10%'
  if (v < 20) return '10–20%'
  if (v < 30) return '20–30%'
  if (v < 40) return '30–40%'
  if (v < 45) return '40–45%'
  if (v < 50) return '45–50%'
  if (v < 55) return '50–55%'
  if (v < 60) return '55–60%'
  if (v < 65) return '60–65%'
  if (v < 75) return '65–75%'
  return '75%+'
}

const COLOUR_BY: ReadonlyArray<ColourByDef> = [
  { id: 'none', label: 'single colour', bucket: () => 'all' },
  { id: 'category', label: 'category', bucket: (p) => p.categoryName ?? '(none)' },
  { id: 'subcategory', label: 'subcategory', bucket: (p) => p.subcategoryName ?? '(none)' },
  { id: 'brand', label: 'brand', bucket: (p) => p.brandName ?? '(none)' },
  { id: 'sizeLabel', label: 'size', bucket: (p) => p.sizeLabel ?? '(none)' },
  { id: 'priceBand', label: 'price band', bucket: (p) => priceBand(p.otdUnitPriceDollars) },
  { id: 'thcBand', label: 'THC band', bucket: (p) => thcBand(p.labThcPct) },
  {
    id: 'discountBand',
    label: 'discount depth band',
    bucket: (p) => discountBand(discountDepthPercent(p)),
  },
  { id: 'gmBand', label: 'effective GM band', bucket: (p) => gmBand(p.gmPercent) },
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
}

const SIZE_BY: ReadonlyArray<SizeByDef> = [
  { id: 'none', label: 'uniform', value: () => null },
  { id: 'unitsSold', label: 'units sold', value: (p) => p.unitsSold },
  { id: 'revenueDollars', label: 'revenue $', value: (p) => p.revenueDollars },
  { id: 'marginDollars', label: 'margin $', value: (p) => p.marginDollars },
  { id: 'invoiceCount', label: 'invoice count', value: (p) => p.invoiceCount },
  { id: 'currentQty', label: 'on-hand qty', value: (p) => p.currentQty },
  { id: 'daysWithSales', label: 'days with sales', value: (p) => p.daysWithSales },
  {
    id: 'marginVelocity',
    label: 'margin $/day',
    value: (p) => p.marginVelocityDollarsPerDay,
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
}

const OPACITY_BY: ReadonlyArray<OpacityByDef> = [
  { id: 'none', label: 'uniform', value: () => null },
  {
    id: 'salesDayCoverage',
    label: 'sales-day coverage %',
    value: salesDayCoveragePercent,
  },
  { id: 'invoiceCount', label: 'invoice count', value: (p) => p.invoiceCount },
  { id: 'unitsSold', label: 'units sold', value: (p) => p.unitsSold },
  { id: 'gmPercent', label: 'effective GM %', value: (p) => p.gmPercent },
  {
    id: 'discountDepth',
    label: 'discount depth %',
    value: (p) => discountDepthPercent(p),
  },
]

const OPACITY_BY_BY_ID = new Map(OPACITY_BY.map((o) => [o.id, o]))
function opacityBy(id: OpacityByKey): OpacityByDef {
  return OPACITY_BY_BY_ID.get(id) ?? OPACITY_BY[0]!
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
    defaultColourBy: 'discountBand',
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
    defaultColourBy: 'gmBand',
    section: SECTION_PROMO,
  },
  {
    id: 'discount-vs-velocity-index',
    title: 'Discount depth % vs velocity index (cohort)',
    description:
      'Promo responsiveness normalised against cat × sub × size peers. High-discount + high-index = promo-responsive winners. High-discount + low-index = bad promos / weak demand.',
    defaultX: 'discountDepthPercent',
    defaultY: 'velocityIndex',
    defaultColourBy: 'gmBand',
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
  // Use the in-cohort medians (computed on the loaded filter slice) to
  // give the operator a "vs peers" lens. The diagonals at 1× / 0pp
  // anchor the eye on "at-median" cleanly.
  {
    id: 'price-index-vs-velocity-index',
    title: 'Price index vs velocity index (cohort)',
    description:
      'World-class merchandising view. Quadrants: premium winners (top-right), value workhorses (top-left), overpriced laggards (bottom-right), cheap-but-slow (bottom-left).',
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
    defaultColourBy: 'gmBand',
    section: SECTION_BASKET,
  },
  {
    id: 'units-per-invoice-vs-margin-per-invoice',
    title: 'Units per invoice vs margin $/invoice',
    description:
      'Basket role view. SKUs with high units/invoice but low margin/invoice are multi-buy promo magnets that dilute basket economics.',
    defaultX: 'unitsPerInvoice',
    defaultY: 'marginPerInvoiceDollars',
    defaultColourBy: 'discountBand',
    section: SECTION_BASKET,
  },
  {
    id: 'weeks-of-supply-vs-contribution',
    title: 'Weeks of supply vs contribution $/day',
    description:
      'Replenishment + markdown radar. Top-right = high-profit, needs reorder. Bottom-right = dead inventory candidates for markdown.',
    defaultX: 'weeksOfSupplyOnHand',
    defaultY: 'marginVelocityDollarsPerDay',
    defaultColourBy: 'gmBand',
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
    defaultColourBy: 'gmBand',
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
    defaultColourBy: 'gmBand',
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
    defaultColourBy: 'priceBand',
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
    defaultColourBy: 'gmBand',
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
    defaultColourBy: 'priceBand',
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
    defaultColourBy: 'gmBand',
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
    defaultColourBy: 'discountBand',
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
    defaultColourBy: 'discountBand',
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
      'High basket multiplier + strong GM% = the holy grail; high basket multiplier + thin GM = promo lever pulled too hard.',
    defaultX: 'unitsPerInvoice',
    defaultY: 'gmPercent',
    defaultColourBy: 'discountBand',
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
    defaultColourBy: 'gmBand',
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
  return { fromMs: now - DEFAULT_WINDOW_DAYS * DAY_MS, toMs: now }
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

export function CatalogAnalyticsTab() {
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
  const [selectedSites, setSelectedSites] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [filters, setFilters] = useState<CatalogAnalyticsFiltersResponse | null>(null)
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  )
  const [selectedSubcategoryIds, setSelectedSubcategoryIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  )
  const [selectedBrandIds, setSelectedBrandIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  )
  const [selectedSizes, setSelectedSizes] = useState<ReadonlySet<string>>(() => new Set<string>())

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

  // -------- Page-wide chart controls --------
  const [pageColourBy, setPageColourBy] = useState<ColourByKey | 'per-chart'>('per-chart')
  const [pageSizeBy, setPageSizeBy] = useState<SizeByKey | 'per-chart'>('per-chart')
  const [pageOpacityBy, setPageOpacityBy] = useState<OpacityByKey | 'per-chart'>(
    'per-chart',
  )

  // -------- Active sub-tab inside the catalog analytics page --------
  const [activeSection, setActiveSection] = useState<string>(SECTION_CORE)

  // -------- Data --------
  const [pointsResp, setPointsResp] = useState<CatalogAnalyticsPointsResponse | null>(null)
  const [loadingFilters, setLoadingFilters] = useState<boolean>(true)
  const [loadingPoints, setLoadingPoints] = useState<boolean>(true)
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
      if (sizesParam) qs.set('sizes', sizesParam)
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
            setFilters({ categories: [], subcategories: [], brands: [], sizes: [] })
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
  }, [sitesParam, categoryIdsParam, subcategoryIdsParam, brandIdsParam, sizesParam])

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
        Array.from(selectedSizes).sort().join(','),
      ].join('|'),
    [
      range.fromMs,
      range.toMs,
      sitesParam,
      selectedCategoryIds,
      selectedSubcategoryIds,
      selectedBrandIds,
      selectedSizes,
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
      if (selectedSizes.size > 0) qs.set('sizes', Array.from(selectedSizes).join(','))
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

  const points = pointsResp?.points ?? []

  // Cohort medians for the index axes. Recomputed once per filter
  // result set so axis evaluators downstream are O(1). Cohort key is
  // (categoryName, subcategoryName, sizeLabel) per cohortKey().
  //
  // Only points that have ALL of (velocity, effective OTD price, GM%,
  // margin/unit) populated participate in their respective medians —
  // a points-without-sales row shouldn't drag the velocity median
  // toward zero. Cohorts smaller than MIN_COHORT contribute medians
  // but the SPA labels them ambiguous via the tooltip.
  const cohortMedians = useMemo(() => {
    const groups = new Map<
      string,
      { vel: number[]; price: number[]; gm: number[]; mpu: number[] }
    >()
    for (const p of points) {
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
  }, [points])

  const axisCtx: AxisCtx = useMemo(
    () => ({ windowDays, cohortMedians }),
    [windowDays, cohortMedians],
  )

  const sectionedCards = useMemo(() => groupCardsBySection(DEFAULT_CARDS), [])

  return (
    <section className="catalog-analytics-tab">
      <div className="metrics-controls catalog-analytics-controls">
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
          </details>
        </div>

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
                onClick={() => {
                  const next = new Set(selectedSites)
                  if (active) next.delete(s.id)
                  else next.add(s.id)
                  setSelectedSites(next)
                }}
                aria-pressed={active}
              >
                {s.label}
              </button>
            )
          })}
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

      <FilterBar
        filters={filters}
        loading={loadingFilters}
        selectedCategoryIds={selectedCategoryIds}
        onCategoryToggle={makeSetToggler(setSelectedCategoryIds)}
        selectedSubcategoryIds={selectedSubcategoryIds}
        onSubcategoryToggle={makeSetToggler(setSelectedSubcategoryIds)}
        selectedBrandIds={selectedBrandIds}
        onBrandToggle={makeSetToggler(setSelectedBrandIds)}
        selectedSizes={selectedSizes}
        onSizeToggle={makeSetToggler(setSelectedSizes)}
        onClearAll={() => {
          setSelectedCategoryIds(new Set())
          setSelectedSubcategoryIds(new Set())
          setSelectedBrandIds(new Set())
          setSelectedSizes(new Set())
        }}
      />

      {error ? (
        <p className="metric-chart-error">{error}</p>
      ) : (
        <p className="subtle-copy catalog-analytics-pointcount">
          {loadingPoints
            ? `Loading…`
            : `${points.length} variants in selection over the last ${windowDays} days.`}
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
                      loading={loadingPoints}
                      axisCtx={axisCtx}
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

interface FilterBarProps {
  filters: CatalogAnalyticsFiltersResponse | null
  loading: boolean
  selectedCategoryIds: ReadonlySet<string>
  onCategoryToggle: (id: string) => void
  selectedSubcategoryIds: ReadonlySet<string>
  onSubcategoryToggle: (id: string) => void
  selectedBrandIds: ReadonlySet<string>
  onBrandToggle: (id: string) => void
  selectedSizes: ReadonlySet<string>
  onSizeToggle: (id: string) => void
  onClearAll: () => void
}

function FilterBar(p: FilterBarProps) {
  if (p.loading && !p.filters) {
    return <p className="subtle-copy">Loading filter options…</p>
  }
  const f = p.filters
  if (!f) return null
  const anySelected =
    p.selectedCategoryIds.size +
      p.selectedSubcategoryIds.size +
      p.selectedBrandIds.size +
      p.selectedSizes.size >
    0
  return (
    <div className="catalog-analytics-filterbar">
      <FilterDropdown
        label="Category"
        options={f.categories}
        selected={p.selectedCategoryIds}
        onToggle={p.onCategoryToggle}
      />
      <FilterDropdown
        label="Subcategory"
        options={f.subcategories}
        selected={p.selectedSubcategoryIds}
        onToggle={p.onSubcategoryToggle}
      />
      <FilterDropdown
        label="Brand"
        options={f.brands}
        selected={p.selectedBrandIds}
        onToggle={p.onBrandToggle}
      />
      <FilterDropdown
        label="Size"
        options={f.sizes}
        selected={p.selectedSizes}
        onToggle={p.onSizeToggle}
      />
      {anySelected ? (
        <button type="button" className="ghost-button" onClick={p.onClearAll}>
          clear all filters
        </button>
      ) : null}
    </div>
  )
}

interface FilterDropdownProps {
  label: string
  options: ReadonlyArray<CatalogFilterOption>
  selected: ReadonlySet<string>
  onToggle: (id: string) => void
}

function FilterDropdown({ label, options, selected, onToggle }: FilterDropdownProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => o.label.toLowerCase().includes(q))
  }, [options, search])
  return (
    <div className="catalog-analytics-filterdrop" ref={ref}>
      <button
        type="button"
        className={
          selected.size > 0
            ? 'metrics-site-chip is-active'
            : 'metrics-site-chip'
        }
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {label}
        {selected.size > 0 ? ` (${selected.size})` : ''} ▾
      </button>
      {open ? (
        <div className="catalog-analytics-filterdrop-panel">
          <input
            type="text"
            placeholder={`Filter ${label.toLowerCase()}…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="catalog-analytics-filterdrop-search"
            autoFocus
          />
          <ul className="catalog-analytics-filterdrop-list">
            {filtered.length === 0 ? (
              <li className="subtle-copy" style={{ padding: '0.4em 0.6em' }}>
                no matches
              </li>
            ) : (
              filtered.slice(0, 200).map((o) => {
                const active = selected.has(o.id)
                return (
                  <li key={o.id}>
                    <label className="catalog-analytics-filterdrop-item">
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={() => onToggle(o.id)}
                      />{' '}
                      {o.label}{' '}
                      <span className="subtle-copy">(n={o.itemCount})</span>
                    </label>
                  </li>
                )
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  )
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
}

function ScatterCard({
  config,
  points,
  pageColourBy,
  pageSizeBy,
  pageOpacityBy,
  loading,
  axisCtx,
}: ScatterCardProps) {
  const [xId, setXId] = useState<string>(config.defaultX)
  const [yId, setYId] = useState<string>(config.defaultY)
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
      <p className="subtle-copy">{config.description}</p>
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
      />
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
}

interface PlottedPoint {
  readonly p: CatalogAnalyticsPoint
  readonly x: number
  readonly y: number
  readonly bucket: string
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
}: CatalogScatterSvgProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
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

  const computed = useMemo(() => {
    const plotted: PlottedPoint[] = []
    let xLo = Number.POSITIVE_INFINITY
    let xHi = Number.NEGATIVE_INFINITY
    let yLo = Number.POSITIVE_INFINITY
    let yHi = Number.NEGATIVE_INFINITY
    let sLo = Number.POSITIVE_INFINITY
    let sHi = Number.NEGATIVE_INFINITY
    let oLo = Number.POSITIVE_INFINITY
    let oHi = Number.NEGATIVE_INFINITY
    const bucketSet = new Set<string>()
    for (const p of points) {
      const x = xDef.value(p, axisCtx)
      const y = yDef.value(p, axisCtx)
      if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) continue
      const bucket = colourByDef.bucket(p)
      bucketSet.add(bucket)
      const sRaw = sizeByDef.value(p, axisCtx)
      const oRaw = opacityByDef.value(p, axisCtx)
      const sizeValue = sRaw != null && Number.isFinite(sRaw) ? sRaw : null
      const opacityValue = oRaw != null && Number.isFinite(oRaw) ? oRaw : null
      plotted.push({ p, x, y, bucket, sizeValue, opacityValue })
      if (x < xLo) xLo = x
      if (x > xHi) xHi = x
      if (y < yLo) yLo = y
      if (y > yHi) yHi = y
      if (sizeValue != null) {
        if (sizeValue < sLo) sLo = sizeValue
        if (sizeValue > sHi) sHi = sizeValue
      }
      if (opacityValue != null) {
        if (opacityValue < oLo) oLo = opacityValue
        if (opacityValue > oHi) oHi = opacityValue
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
        sMin: null as number | null,
        sMax: null as number | null,
        oMin: null as number | null,
        oMax: null as number | null,
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
    const sMin = Number.isFinite(sLo) ? sLo : null
    const sMax = Number.isFinite(sHi) ? sHi : null
    const oMin = Number.isFinite(oLo) ? oLo : null
    const oMax = Number.isFinite(oHi) ? oHi : null
    // Sort buckets by count desc so the legend reflects scale.
    const buckets = Array.from(bucketSet).sort()
    return {
      plotted,
      buckets,
      xMin: xLo,
      xMax: xHi,
      yMin: yLo,
      yMax: yHi,
      sMin,
      sMax,
      oMin,
      oMax,
    }
  }, [points, xDef, yDef, colourByDef, sizeByDef, opacityByDef, axisCtx])

  const { plotted, buckets, xMin, xMax, yMin, yMax, sMin, sMax, oMin, oMax } = computed

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
  const zoom = useScatterZoom({
    baseDomain,
    boundsDomain: autoZoom.full,
    svgRef,
    plot: { left: marginLeft, top: marginTop, width: plotW, height: plotH },
  })
  const view = zoom.view ?? baseDomain ?? fullDomain ?? { xMin, xMax, yMin, yMax }
  const clipId = useId()

  // Build a per-point radius/opacity resolver using the card-local
  // size/opacity domains. Square-root scaling for radius so visible
  // area (not radius) is proportional to magnitude. We clamp to a
  // healthy minimum so even tiny values stay visible.
  const dotRadius = useCallback(
    (sizeValue: number | null): number => {
      if (sizeByDef.id === 'none' || sMin == null || sMax == null || sMin === sMax) {
        return UNIFORM_R
      }
      if (sizeValue == null) return SIZE_MIN_R
      // Clamp negatives to the floor so we never sqrt(<0).
      const lo = Math.max(0, sMin)
      const hi = Math.max(lo + 1e-9, sMax)
      const v = Math.max(lo, Math.min(hi, sizeValue))
      const norm = Math.sqrt((v - lo) / (hi - lo))
      return SIZE_MIN_R + norm * (SIZE_MAX_R - SIZE_MIN_R)
    },
    [sizeByDef, sMin, sMax],
  )
  const dotOpacity = useCallback(
    (opacityValue: number | null): number => {
      if (opacityByDef.id === 'none' || oMin == null || oMax == null || oMin === oMax) {
        return UNIFORM_OPACITY
      }
      if (opacityValue == null) return OPACITY_MIN
      const v = Math.max(oMin, Math.min(oMax, opacityValue))
      const norm = (v - oMin) / (oMax - oMin)
      return OPACITY_MIN + norm * (OPACITY_MAX - OPACITY_MIN)
    },
    [opacityByDef, oMin, oMax],
  )

  const xScale = useCallback(
    (v: number) => marginLeft + ((v - view.xMin) / (view.xMax - view.xMin)) * plotW,
    [marginLeft, plotW, view.xMin, view.xMax],
  )
  const yScale = useCallback(
    (v: number) => marginTop + plotH - ((v - view.yMin) / (view.yMax - view.yMin)) * plotH,
    [marginTop, plotH, view.yMin, view.yMax],
  )

  const xTicks = useMemo(() => makeTicks(view.xMin, view.xMax, 5), [view.xMin, view.xMax])
  const yTicks = useMemo(() => makeTicks(view.yMin, view.yMax, 5), [view.yMin, view.yMax])

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
  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      // Forward to the zoom hook first so pinch/pan can run.
      zoom.handlers.onPointerMove(e)
      if (zoom.gestureActive) {
        if (hover) setHover(null)
        return
      }
      // On touch we only update hover on initial tap / drag; once the
      // finger lifts (pointerleave) we want the tooltip to stick.
      // The pointerup handler keeps hover; pointermove on touch still
      // updates which dot is targeted while the finger is down.
      const svg = svgRef.current
      if (!svg || plotted.length === 0) return
      const ctm = svg.getScreenCTM()
      if (!ctm) return
      const pt = svg.createSVGPoint()
      pt.x = e.clientX
      pt.y = e.clientY
      const local = pt.matrixTransform(ctm.inverse())
      let bestIdx = -1
      let bestDistSq = Infinity
      const hitRadius = e.pointerType === 'mouse' ? HOVER_PX : TOUCH_HOVER_PX
      const hitRadiusSq = hitRadius * hitRadius
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
        const dx = xScale(pp.x) - local.x
        const dy = yScale(pp.y) - local.y
        const d = dx * dx + dy * dy
        if (d < bestDistSq) {
          bestDistSq = d
          bestIdx = i
        }
      }
      if (bestIdx >= 0 && bestDistSq <= hitRadiusSq) {
        setHover({ idx: bestIdx, pointerType: e.pointerType })
      } else if (e.pointerType === 'mouse') {
        // Only clear on miss for mouse; touch keeps last selection
        // until the user taps empty space or dismisses.
        setHover(null)
      }
    },
    [plotted, xScale, yScale, zoom, hover, view.xMin, view.xMax, view.yMin, view.yMax],
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

  // On touch tap (pointerdown) on an empty region, dismiss any pinned
  // tooltip. We do this in pointerdown so a tap that hits a dot still
  // triggers the pointermove handler above (which sets a new hover).
  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      zoom.handlers.onPointerDown(e)
      if (e.pointerType === 'mouse') return
      // For a single-finger tap, immediately compute nearest dot so
      // the tooltip appears on tap rather than waiting for a move.
      if (plotted.length === 0) return
      const svg = svgRef.current
      if (!svg) return
      const ctm = svg.getScreenCTM()
      if (!ctm) return
      const pt = svg.createSVGPoint()
      pt.x = e.clientX
      pt.y = e.clientY
      const local = pt.matrixTransform(ctm.inverse())
      let bestIdx = -1
      let bestDistSq = Infinity
      const hitRadiusSq = TOUCH_HOVER_PX * TOUCH_HOVER_PX
      for (let i = 0; i < plotted.length; i++) {
        const pp = plotted[i]!
        if (
          pp.x < view.xMin ||
          pp.x > view.xMax ||
          pp.y < view.yMin ||
          pp.y > view.yMax
        ) {
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
      if (bestIdx >= 0 && bestDistSq <= hitRadiusSq) {
        setHover({ idx: bestIdx, pointerType: e.pointerType })
      } else {
        // tap on empty plot area — dismiss pinned tooltip
        setHover(null)
      }
    },
    [plotted, xScale, yScale, view.xMin, view.xMax, view.yMin, view.yMax, zoom],
  )

  const hovered = hover ? plotted[hover.idx] ?? null : null
  const hoveredDotPx = hovered ? { x: xScale(hovered.x), y: yScale(hovered.y) } : null

  return (
    <div className="metric-chart-svg-wrap catalog-analytics-svg-wrap" ref={wrapRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        className="metric-chart-svg"
        role="img"
        aria-label={`Scatter: ${yDef.label} (y) vs ${xDef.label} (x)`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={zoom.handlers.onPointerUp}
        onPointerCancel={zoom.handlers.onPointerCancel}
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
            const x = xScale(t)
            return (
              <line
                key={`xg-${t}`}
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
            const y = yScale(t)
            return (
              <line
                key={`yg-${t}`}
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
          <g key={`x-${t}`}>
            <line
              x1={xScale(t)}
              x2={xScale(t)}
              y1={marginTop + plotH}
              y2={marginTop + plotH + 4}
              stroke="#888"
            />
            <text
              x={xScale(t)}
              y={marginTop + plotH + 16}
              fontSize="10"
              textAnchor="middle"
              fill="#666"
            >
              {xDef.format(t)}
            </text>
          </g>
        ))}
        {yTicks.map((t) => (
          <g key={`y-${t}`}>
            <line x1={marginLeft - 4} x2={marginLeft} y1={yScale(t)} y2={yScale(t)} stroke="#888" />
            <text
              x={marginLeft - 6}
              y={yScale(t) + 3}
              fontSize="10"
              textAnchor="end"
              fill="#666"
            >
              {yDef.format(t)}
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
          {xDef.label}
        </text>
        <text
          transform={`rotate(-90 12 ${marginTop + plotH / 2})`}
          x={12}
          y={marginTop + plotH / 2}
          fontSize="11"
          textAnchor="middle"
          fill="#444"
        >
          {yDef.label}
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
              - unit-x:    vertical line at x = 1. */}
          {referenceLine === 'diagonal' && plotted.length > 0 ? (
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
              y1={yScale(1)}
              x2={xScale(view.xMax)}
              y2={yScale(1)}
              stroke="#999"
              strokeDasharray="4 4"
              strokeWidth={1}
            />
          ) : null}
          {referenceLine === 'unit-x' ? (
            <line
              x1={xScale(1)}
              y1={yScale(view.yMin)}
              x2={xScale(1)}
              y2={yScale(view.yMax)}
              stroke="#999"
              strokeDasharray="4 4"
              strokeWidth={1}
            />
          ) : null}
          {/* dots */}
          {plotted.map((pp, idx) => (
            <circle
              key={`${pp.p.inventoryItemId}-${idx}`}
              cx={xScale(pp.x)}
              cy={yScale(pp.y)}
              r={dotRadius(pp.sizeValue)}
              fill={colourFor(pp.bucket, buckets)}
              fillOpacity={dotOpacity(pp.opacityValue)}
              stroke="#fff"
              strokeWidth={0.5}
            />
          ))}
          {/* hovered dot highlight */}
          {hovered ? (
            <circle
              cx={xScale(hovered.x)}
              cy={yScale(hovered.y)}
              r={6}
              fill="none"
              stroke="#111"
              strokeWidth={1.5}
            />
          ) : null}
        </g>
      </svg>

      {autoZoom.hiddenCount > 0 ? (
        <button
          type="button"
          className={
            fitMode === 'full' ? 'metric-chart-fit-toggle is-active' : 'metric-chart-fit-toggle'
          }
          onClick={() => setFitMode((m) => (m === 'compact' ? 'full' : 'compact'))}
          aria-pressed={fitMode === 'full'}
          title={
            fitMode === 'compact'
              ? `Default view hides ${autoZoom.hiddenCount} outlier point${
                  autoZoom.hiddenCount === 1 ? '' : 's'
                } so the rest of the data is more legible. Click to show every point.`
              : 'Return to compact auto-zoom view (densest ~90% per axis).'
          }
        >
          {fitMode === 'compact'
            ? `Show all data (${autoZoom.hiddenCount})`
            : 'Compact view'}
        </button>
      ) : null}

      {zoom.isZoomed ? (
        <button
          type="button"
          className="metric-chart-zoom-reset"
          onClick={zoom.resetView}
          aria-label="Reset zoom"
          title="Reset zoom (double-click chart)"
        >
          Reset zoom
        </button>
      ) : null}

      {hovered && hoveredDotPx ? (
        <ScatterTooltip
          point={hovered.p}
          xDef={xDef}
          yDef={yDef}
          xValue={hovered.x}
          yValue={hovered.y}
          colourLabel={hovered.bucket}
          colourByDef={colourByDef}
          /* Absolute position in chart-wrapper local pixel space —
             follows the dot through page scroll, resize, pan/zoom. */
          dotPx={hoveredDotPx}
          wrapWidth={width}
          wrapHeight={height}
          dismissible={hover?.pointerType !== 'mouse'}
          onDismiss={() => setHover(null)}
        />
      ) : null}

      {colourByDef.id !== 'none' && buckets.length > 1 ? (
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

      {plotted.length === 0 && !loading ? (
        <p className="subtle-copy">
          No variants in the current filter slice have values for both axes over the last{' '}
          {axisCtx.windowDays} days.
        </p>
      ) : null}
    </div>
  )
}

interface ScatterTooltipProps {
  point: CatalogAnalyticsPoint
  xDef: PointAxisDef
  yDef: PointAxisDef
  xValue: number
  yValue: number
  colourLabel: string
  colourByDef: ColourByDef
  /** Hovered dot position, in chart-wrapper-local pixel space. */
  dotPx: { x: number; y: number }
  /** Chart wrapper width/height in pixels (== SVG viewBox dimensions). */
  wrapWidth: number
  wrapHeight: number
  /** True on touch — renders a close button so the operator can dismiss. */
  dismissible: boolean
  onDismiss: () => void
}

function ScatterTooltip(p: ScatterTooltipProps) {
  // Render width is responsive but we want a stable layout for clamp
  // calculations; treat 280px as the planning width and let CSS
  // shrink it on tiny viewports.
  const TOOLTIP_W = 280
  const TOOLTIP_H_EST = 220
  // Default: place to the right and below the dot. Flip sides if we'd
  // overflow the chart wrapper. Clamp to wrap bounds so a tooltip
  // near the top/left edge isn't pushed off-screen.
  const wantRight = p.dotPx.x + 14 + TOOLTIP_W <= p.wrapWidth
  const wantBelow = p.dotPx.y + 14 + TOOLTIP_H_EST <= p.wrapHeight
  let left = wantRight ? p.dotPx.x + 14 : p.dotPx.x - 14 - TOOLTIP_W
  let top = wantBelow ? p.dotPx.y + 14 : p.dotPx.y - 14 - TOOLTIP_H_EST
  left = Math.max(4, Math.min(p.wrapWidth - TOOLTIP_W - 4, left))
  top = Math.max(4, Math.min(p.wrapHeight - 40, top))
  // Position is in the wrap's local coords (the wrap is the
  // positioned containing block; the SVG fills it 100%). This means
  // the tooltip stays attached to the dot through page scroll,
  // window resize, pan, and zoom — no scroll listener required.
  const style: React.CSSProperties = {
    position: 'absolute',
    left,
    top,
    width: TOOLTIP_W,
    maxWidth: 'calc(100% - 8px)',
    pointerEvents: p.dismissible ? 'auto' : 'none',
  }
  return (
    <div className="catalog-analytics-tooltip" style={style} role="tooltip">
      <div className="catalog-analytics-tooltip-title">
        {p.point.productName}
        {p.point.sizeLabel ? ` — ${p.point.sizeLabel}` : ''}
        {p.dismissible ? (
          <button
            type="button"
            className="catalog-analytics-tooltip-close"
            onClick={(e) => {
              e.stopPropagation()
              p.onDismiss()
            }}
            aria-label="Dismiss tooltip"
          >
            ×
          </button>
        ) : null}
      </div>
      <div className="catalog-analytics-tooltip-sub subtle-copy">
        {[p.point.brandName, p.point.subcategoryName, p.point.categoryName]
          .filter((s) => s)
          .join(' • ') || '(no classification)'}
      </div>
      <table className="catalog-analytics-tooltip-table">
        <tbody>
          <tr>
            <th>{p.xDef.short}</th>
            <td>{p.xDef.format(p.xValue)}</td>
          </tr>
          <tr>
            <th>{p.yDef.short}</th>
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
    </div>
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

function makeTicks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    return []
  }
  const range = max - min
  const rough = range / count
  const pow = Math.pow(10, Math.floor(Math.log10(rough)))
  const norm = rough / pow
  let step: number
  if (norm < 1.5) step = pow
  else if (norm < 3) step = 2 * pow
  else if (norm < 7) step = 5 * pow
  else step = 10 * pow
  const start = Math.ceil(min / step) * step
  const out: number[] = []
  for (let v = start; v <= max; v += step) {
    out.push(v)
  }
  return out
}
