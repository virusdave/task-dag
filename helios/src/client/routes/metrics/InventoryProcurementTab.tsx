import { Fragment, useEffect, useMemo, useState } from 'react'

import {
  InventoryProcurementResponseSchema,
  InventorySkuHistoryResponseSchema,
  type InventoryAction,
  type InventoryCategoryOverhang,
  type InventoryDistributorStat,
  type InventoryProcurementResponse,
  type InventoryScoreFactor,
  type InventorySkuHistoryResponse,
  type InventorySkuRow,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { nyIsoDate, nyMonthDaySlash } from '../../app/nyTime.js'
import { normaliseSiteSelection, toggleSiteSelection } from './metricsSiteSelection.js'

// ---------------------------------------------------------------------------
// Inventory / Procurement workspace (the /metrics → "Inventory" /
// "Reordering" tab). One consolidated /api/inventory-procurement fetch
// returns a per-SKU fact table + per-distributor cadence stats; all four
// procurement views (Reorder Queue / Distributor Baskets / Exit &
// Liquidate / Mix Drift) are derived client-side from that payload.
//
// Design: oracle thread T-019e6edf (2026-06-04). Procurement-grade —
// the buyer must know exactly what to order, from whom, how much, when.
// Reviewer-efficiency: answer-first tables on top, methodology collapsed.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000
const CARRY_ANNUAL_RATE = 0.2 // 20%/yr capital carrying cost for order-now value
const ORDER_NOW_VALUE_THRESHOLD = 50
const MIN_BASKET_COST = 250

const KNOWN_SITES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'bronx', label: 'Bronx' },
  { id: 'midtown', label: 'Midtown' },
]

const WINDOW_PRESETS: ReadonlyArray<{ days: number; label: string }> = [
  { days: 14, label: '14d' },
  { days: 28, label: '28d' },
  { days: 56, label: '56d' },
  { days: 90, label: '90d' },
]

type SubTab = 'reorder' | 'distributors' | 'exit' | 'mix'
const SUBTABS: ReadonlyArray<{ id: SubTab; label: string }> = [
  { id: 'reorder', label: 'Reorder queue' },
  { id: 'distributors', label: 'Distributor baskets' },
  { id: 'exit', label: 'Exit / liquidate' },
  { id: 'mix', label: 'Mix drift' },
]

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtMoney(n: number | null | undefined, dp = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`
}
function fmtNum(n: number | null | undefined, dp = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
}
function fmtPct(n: number | null | undefined, dp = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(dp)}%`
}
function fmtDays(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (n >= 999) return '∞'
  return `${n.toFixed(n < 10 ? 1 : 0)}d`
}
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  return nyMonthDaySlash(t)
}
function daysAgo(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.floor((Date.now() - t) / DAY_MS)
}

// Approximate breakeven discount: the deepest markdown off the CURRENT
// shelf price at which liquidating the *remaining* on-hand units still
// breaks the SKU even — netting out the margin already banked from prior
// sales. So a SKU whose past sales have already recovered its on-hand cost
// can be blown out at ~100% off and still come out whole, whereas one
// that's barely sold can only be cut by its raw cost margin.
//
//   recoveredMargin = max(0, lifetimeSoldRevenue - lifetimeUnitsSold * unitCost)
//   floorPrice      = max(0, onHandCost - recoveredMargin) / onHandUnits
//   breakevenDisc   = clamp(1 - floorPrice / shelfPrice, 0..1)
//
// APPROXIMATE (surfaced as "appx" in the UI): COGS is the current unit cost
// (no per-sale cost-as-of), lifetime sales apply no canceled-status
// filter, and the horizon is bounded by however much order history has been
// ingested. With no sales on record it degrades to 1 - cost/shelfPrice.
function breakevenDisc(r: InventorySkuRow): number | null {
  const base = r.listPrice && r.listPrice > 0 ? r.listPrice : r.avgUnitPrice
  if (!base || base <= 0 || r.unitCostCurrent === null) return null
  let floorPrice: number
  if (r.physicalUnits > 0) {
    const recoveredMargin = Math.max(0, r.lifetimeSoldRevenue - r.lifetimeUnitsSold * r.unitCostCurrent)
    floorPrice = Math.max(0, r.onHandCost - recoveredMargin) / r.physicalUnits
  } else {
    floorPrice = r.unitCostCurrent
  }
  return Math.max(0, Math.min(1, 1 - floorPrice / base))
}

// ---------------------------------------------------------------------------
// Deep-link state — persist the active sub-tab + filters in the URL hash so a
// buyer can bookmark/share a specific view (e.g. ".../metrics/inventory
// #view=distributors&sites=bronx&window=56"). The route path itself is owned
// by react-router (the :tabId segment), so we keep our view state in the hash
// to avoid fighting the router.
// ---------------------------------------------------------------------------

interface DeepLinkState {
  view: SubTab
  sites: ReadonlySet<string>
  windowDays: number
  /** Expanded SKU insight panel (`dealerId:productId`), or null. */
  expandedSku: string | null
}

const VALID_SUBTABS = new Set<SubTab>(SUBTABS.map((t) => t.id))
const VALID_WINDOWS = new Set<number>(WINDOW_PRESETS.map((w) => w.days))

function readDeepLink(defaults: DeepLinkState): DeepLinkState {
  if (typeof window === 'undefined') return defaults
  const raw = window.location.hash.replace(/^#/, '')
  if (!raw) return defaults
  const p = new URLSearchParams(raw)
  const view = p.get('view')
  const sites = p.get('sites')
  const win = p.get('window')
  const sku = p.get('sku')
  const winNum = win ? Number(win) : NaN
  return {
    view: view && VALID_SUBTABS.has(view as SubTab) ? (view as SubTab) : defaults.view,
    sites: sites
      ? new Set(sites.split(',').filter((s) => s.length > 0))
      : defaults.sites,
    windowDays: VALID_WINDOWS.has(winNum) ? winNum : defaults.windowDays,
    expandedSku: sku && /^\d+:\d+$/.test(sku) ? sku : defaults.expandedSku,
  }
}

function writeDeepLink(state: DeepLinkState): void {
  if (typeof window === 'undefined') return
  const p = new URLSearchParams()
  p.set('view', state.view)
  if (state.sites.size > 0) p.set('sites', Array.from(state.sites).sort().join(','))
  p.set('window', String(state.windowDays))
  if (state.expandedSku) p.set('sku', state.expandedSku)
  const hash = `#${p.toString()}`
  if (hash !== window.location.hash) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`)
  }
}

/** Stable per-SKU key for expand state / deep-links. */
function skuKey(r: InventorySkuRow): string {
  return `${r.dealerId}:${r.productId}`
}

/** Build a deep-link href to this page with one SKU pre-expanded (new tab). */
function skuDetailHref(
  subTab: SubTab,
  sites: ReadonlySet<string>,
  windowDays: number,
  key: string,
): string {
  if (typeof window === 'undefined') return '#'
  const p = new URLSearchParams()
  p.set('view', subTab)
  if (sites.size > 0) p.set('sites', Array.from(sites).sort().join(','))
  p.set('window', String(windowDays))
  p.set('sku', key)
  return `${window.location.pathname}${window.location.search}#${p.toString()}`
}

// Deep-link into the Catalog Analytics scatter suite, pre-filtered to this
// SKU's category and with the product highlighted, landing on a specific
// sub-section (Cohort-relative / Inventory traps / Promo erosion). This is
// how the buyer goes from "the model says X" to "show me how this item sits
// against its category cohort" — reusing the exact charts Catalog Analytics
// already provides instead of duplicating the cohort math here. Opens in a
// new tab. `categoryIds` / `brandIds` on the catalog page are matched by
// NAME (not numeric id), so the row's own fields are sufficient. The
// product is highlighted by VARIANT ID (productId) via
// `highlightVariantIds` — a product-name free-text highlight rarely lines
// up across data sources, so the id is the only reliable handle.
const COHORT_LINKS: ReadonlyArray<{ section: string; label: string; hint: string }> = [
  {
    section: 'Cohort-relative',
    label: 'Cohort-relative',
    hint: 'Price index, velocity index and GM% vs the category-cohort median — is this SKU priced/selling/margining above or below its peers?',
  },
  {
    section: 'Inventory traps',
    label: 'Inventory traps',
    hint: 'Weeks-of-supply vs velocity and on-hand qty vs margin $/day — spot capital traps and overstock.',
  },
  {
    section: 'Promo erosion',
    label: 'Promo erosion',
    hint: 'List vs effective OTD price and list vs effective GM% — how much discounting is eroding this SKU’s margin.',
  },
]

function catalogCohortHref(r: InventorySkuRow, section: string, windowDays: number): string {
  const p = new URLSearchParams()
  if (r.siteKey) p.set('sites', r.siteKey)
  if (r.categoryName) p.set('categoryIds', r.categoryName)
  // Highlight the exact variant by id. Fall back to a product-name
  // free-text highlight only for un-mapped rows with no productId.
  if (r.productId != null) p.set('highlightVariantIds', String(r.productId))
  else if (r.productName) p.set('highlight', r.productName)
  p.set('section', section)
  p.set('windowDays', String(windowDays))
  return `/metrics/catalog?${p.toString()}`
}

// ---------------------------------------------------------------------------
// CSV export — hand the buyer a spreadsheet they can act on / hand to a
// distributor. NY-local date in the filename per repo canon.
// ---------------------------------------------------------------------------

function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : v
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function downloadCsv(filename: string, header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): void {
  if (typeof document === 'undefined') return
  const lines = [header, ...rows].map((cols) => cols.map(csvCell).join(','))
  // Prepend a UTF-8 BOM so Excel opens it with the right encoding.
  const blob = new Blob(['\ufeff' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

const ACTION_META: Record<InventoryAction, { label: string; cls: string }> = {
  order_now: { label: 'ORDER NOW', cls: 'inv-pill--danger' },
  order_now_supplier_unknown: { label: 'ORDER — SUPPLIER?', cls: 'inv-pill--warn' },
  check_hidden_stock: { label: 'CHECK HIDDEN STOCK', cls: 'inv-pill--warn' },
  reorder_soon: { label: 'REORDER SOON', cls: 'inv-pill--info' },
  liquidate_now: { label: 'LIQUIDATE NOW', cls: 'inv-pill--danger' },
  burn_down_stop_carry: { label: 'BURN DOWN', cls: 'inv-pill--warn' },
  reprice_before_expiry: { label: 'REPRICE — EXPIRY', cls: 'inv-pill--warn' },
  reduce_future_orders: { label: 'REDUCE ORDERS', cls: 'inv-pill--info' },
  accept_stockout: { label: 'ACCEPT STOCKOUT', cls: 'inv-pill--muted' },
  hold: { label: 'HOLD', cls: 'inv-pill--muted' },
  do_not_reorder: { label: 'DO NOT REORDER', cls: 'inv-pill--muted' },
  skip_min_order_overshoots: { label: 'SKIP — CASE TOO LARGE', cls: 'inv-pill--muted' },
}

function ActionPill({ action }: { action: InventoryAction }) {
  const m = ACTION_META[action]
  return <span className={`inv-pill ${m.cls}`}>{m.label}</span>
}

function ConfidencePill({ score }: { score: number }) {
  const cls = score >= 0.7 ? 'inv-pill--ok' : score >= 0.4 ? 'inv-pill--warn' : 'inv-pill--muted'
  const label = score >= 0.7 ? 'High' : score >= 0.4 ? 'Med' : 'Low'
  return <span className={`inv-pill ${cls}`} title={`Confidence ${(score * 100).toFixed(0)}%`}>{label}</span>
}

function Kpi({ value, label, warn }: { value: string; label: string; warn?: boolean }) {
  return (
    <div className={`budtender-kpi${warn ? ' is-warn' : ''}`}>
      <div className="budtender-kpi-value">{value}</div>
      <div className="budtender-kpi-label subtle-copy">{label}</div>
    </div>
  )
}

// ===========================================================================
// Per-SKU insight / justification panel
//
// Turns each "black art" recommendation row into a defensible decision:
//   1. a plain-language sentence stating the action + the business reason,
//   2. the supporting facts behind it,
//   3. the score broken into its weighted terms (so the 0–100 number isn't
//      a black box), and
//   4. an on-demand daily-sales sparkline answering "was this actually
//      selling, or is the model inventing demand?".
// Shared by the Reorder queue and Exit/liquidate tables.
// ===========================================================================

type InsightMode = 'reorder' | 'exit'

// Module-level cache so re-expanding a row (or deep-linking) is instant and
// we never refetch the same series within a session.
const skuHistoryCache = new Map<string, InventorySkuHistoryResponse>()

function useSkuHistory(
  r: InventorySkuRow,
  days: number,
): { data: InventorySkuHistoryResponse | null; loading: boolean; error: string | null } {
  const key = `${r.dealerId}|${r.productId}|${days}`
  const [state, setState] = useState<{
    data: InventorySkuHistoryResponse | null
    loading: boolean
    error: string | null
  }>(() =>
    skuHistoryCache.has(key)
      ? { data: skuHistoryCache.get(key)!, loading: false, error: null }
      : { data: null, loading: false, error: null },
  )
  useEffect(() => {
    if (r.productId === null) {
      setState({ data: null, loading: false, error: 'No product id for this row.' })
      return
    }
    const cached = skuHistoryCache.get(key)
    if (cached) {
      setState({ data: cached, loading: false, error: null })
      return
    }
    let cancelled = false
    setState({ data: null, loading: true, error: null })
    loadJson(
      `/api/inventory-procurement/sku-history?dealerId=${r.dealerId}&productId=${r.productId}&days=${days}`,
      InventorySkuHistoryResponseSchema,
    )
      .then((d) => {
        skuHistoryCache.set(key, d)
        if (!cancelled) setState({ data: d, loading: false, error: null })
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setState({ data: null, loading: false, error: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      cancelled = true
    }
  }, [key, r.productId, r.dealerId, days])
  return state
}

// Plain-language decision sentence, action-rule-aware (the action is NOT
// always "because the score is high" — overshoot / hidden-stock / expiry
// are rule-driven), plus a low-confidence caveat.
function buildSkuJustification(r: InventorySkuRow, mode: InsightMode): {
  sentence: string
  caveat: string | null
} {
  const dist = r.distributorName ? ` from ${r.distributorName}` : ''
  const ds = fmtDays(r.daysSupply ?? undefined)
  const fcst = fmtNum(r.forecastDailyUnits, 1)
  let sentence: string

  switch (r.action) {
    case 'order_now':
    case 'order_now_supplier_unknown':
      sentence =
        `Order ${fmtNum(r.recommendedQty)} units${dist} (~${fmtMoney(r.recommendedCost)}). ` +
        `Only ${fmtNum(r.sellableUnits)} sellable (~${ds} at ${fcst}/day) and restock needs ` +
        `~${fmtDays(r.reorderPointDays)}; waiting risks ${fmtMoney(r.expectedMarginLossBeforeReplenishment)} ` +
        `of margin before stock lands.` +
        (r.action === 'order_now_supplier_unknown' ? ' Supplier unknown — confirm who to buy from.' : '')
      break
    case 'reorder_soon':
      sentence =
        `Reorder ~${fmtNum(r.recommendedQty)} units${dist} soon — ${ds} of supply at ${fcst}/day ` +
        `vs a ${fmtDays(r.reorderPointDays)} reorder point. Not urgent yet.`
      break
    case 'check_hidden_stock':
      sentence =
        `${fmtNum(r.physicalUnits)} units on hand but 0 sellable — likely stuck on hold / quarantine. ` +
        `Check the floor before reordering (was selling at ${fcst}/day).`
      break
    case 'skip_min_order_overshoots':
      sentence =
        `Real demand (${fcst}/day), but the ${fmtNum(r.suppressedRecommendedQty)}-unit minimum case would ` +
        `cover ~${fmtDays(r.coverageAfterSnappedOrderDays ?? undefined)} vs a ${fmtDays(r.targetCoverDays)} ` +
        `target — too much to sell through, so it's not recommended.`
      break
    case 'accept_stockout':
      sentence =
        `Out of stock and was recently selling, but there's no economical reorder right now ` +
        `(no supplier or qty). Accept the stockout unless you can source it.`
      break
    case 'liquidate_now':
      sentence =
        `Liquidate now — ${fmtMoney(r.onHandCost)} of capital tied up in ${fmtNum(r.physicalUnits)} units, ` +
        `${fmtNum(r.units90)} sold in 90d, avg age ~${fmtDays(r.avgInventoryAgeDays ?? undefined)}. ` +
        `The capital is stranded; clear it.`
      break
    case 'burn_down_stop_carry':
      sentence =
        `Burn down / stop carrying — deadweight ${r.deadweightScore}/100: ${fmtMoney(r.onHandCost)} capital, ` +
        `${fmtNum(r.units90)} sold in 90d` +
        (r.expiringUnits60 > 0 ? `, ${fmtNum(r.expiringUnits60)} units expiring ≤60d` : '') +
        `. Don't replenish; let it draw down or discount.`
      break
    case 'reprice_before_expiry':
      sentence =
        `Reprice before expiry — ${fmtNum(r.expiringUnits60 > 0 ? r.expiringUnits60 : r.physicalUnits)} units ` +
        `near expiry (${fmtDays(r.daysToNearestExpiration ?? undefined)} out). Discount to clear while it ` +
        `still has value.`
      break
    case 'reduce_future_orders':
      sentence =
        `Overstocked — ${ds} of supply at ${fcst}/day. Stop or thin future orders and let it draw down.`
      break
    case 'do_not_reorder':
      sentence =
        `Not selling enough to justify reordering` +
        (r.deadweightScore >= 70 ? ` (flagged deadweight ${r.deadweightScore}/100)` : '') +
        `. ${fmtNum(r.units90)} sold in 90d.`
      break
    default:
      sentence =
        mode === 'reorder'
          ? `Adequately stocked — ${ds} of supply, above the ${fmtDays(r.reorderPointDays)} reorder point.`
          : `${fmtMoney(r.onHandCost)} on hand, ${fmtNum(r.units90)} sold in 90d.`
  }

  const caveat =
    r.confidenceScore < 0.6
      ? `Low confidence (${fmtPct(r.confidenceScore)}) — sparse sales history and/or default supplier timing; treat as directional.`
      : null
  return { sentence, caveat }
}

// Plain-English explanation per score-factor key, so the (often
// truncated) factor label has a meaningful hover/title instead of a
// dangling "Margin loss b…". Keyed by the stable factor `key` the server
// emits; falls back to just the label + weight when a key is unmapped.
const FACTOR_EXPLANATIONS: Record<string, string> = {
  // reorder-priority terms
  expected_loss:
    'Estimated margin $ lost to stockouts before a reorder could land, given current velocity and lead time. The biggest driver of reorder urgency.',
  reorder_gap:
    'How far current days-of-supply has fallen below the reorder point (lead time + safety stock). Larger gap = more overdue.',
  lost_margin:
    'Margin $/day currently being forfeited because the item is out of stock or running short.',
  confidence:
    'How trustworthy the forecast is, based on sales-history density and how certain the supplier lead time is.',
  deadweight_penalty:
    'Penalty subtracted when the item is also flagged deadweight (≥70/100) — we don’t want to reorder something we’re simultaneously trying to exit.',
  // deadweight terms
  slow: 'How slowly the item sells relative to the units on hand. Low velocity = more deadweight.',
  capital: 'How much cash is tied up in on-hand units (log-scaled vs the catalog’s 95th-percentile SKU).',
  age: 'How long the on-hand units have been sitting in inventory.',
  expiry: 'How close the on-hand units are to expiration.',
  margin_weakness:
    'How weak this item’s gross margin is — weak-margin slow movers are the worst capital to keep holding.',
}

function factorTitle(f: InventoryScoreFactor): string {
  const expl = FACTOR_EXPLANATIONS[f.key]
  const meta = `(weight ${(f.weight * 100).toFixed(0)}% · magnitude ${fmtPct(f.norm)} · ${
    f.contribution >= 0 ? '+' : '−'
  }${Math.abs(f.contribution).toFixed(1)} pts)`
  return expl ? `${f.label}: ${expl} ${meta}` : `${f.label} ${meta}`
}

// Weighted-factor score breakdown. Bar width = |points|/100 so the bars are
// proportional to the 0–100 score and visibly sum to the headline number.
function ScoreBreakdown({
  title,
  score,
  factors,
}: {
  title: string
  score: number
  factors: ReadonlyArray<InventoryScoreFactor>
}) {
  return (
    <div className="inv-score">
      <div className="inv-score-head">
        <strong>{score}</strong>
        <span className="subtle-copy">/100 · {title}</span>
      </div>
      {factors.map((f) => {
        const neg = f.contribution < 0
        const widthPct = Math.min(100, Math.abs(f.contribution))
        const tip = factorTitle(f)
        return (
          <div className="inv-score-row" key={f.key}>
            <span className="inv-score-label" title={tip} aria-label={tip}>
              {f.label}
            </span>
            <span className="inv-score-track">
              <span
                className={`inv-score-fill${neg ? ' is-neg' : ''}`}
                style={{ width: `${widthPct}%` }}
              />
            </span>
            <span className="inv-score-val">
              {f.contribution >= 0 ? '+' : '−'}
              {Math.abs(f.contribution).toFixed(1)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// Honest daily-sales bar chart (sparse spiky data → bars, not a smoothed
// line). Zero-filled by the server. A 7-day trailing average line gives the
// trend the forecast is built on.
function DailySalesBars({ history }: { history: InventorySkuHistoryResponse }) {
  const series = history.series
  const n = series.length
  if (n === 0) return <p className="subtle-copy">No sales in the last {history.days} days.</p>
  const W = 760
  const H = 130
  const PADL = 6
  const PADR = 6
  const PADT = 8
  const PADB = 18
  const plotW = W - PADL - PADR
  const plotH = H - PADT - PADB
  const maxU = Math.max(1, ...series.map((s) => s.units))
  const bw = plotW / n
  const yOf = (u: number) => PADT + plotH - (u / maxU) * plotH

  // 7-day trailing average path.
  const avg: number[] = series.map((_, i) => {
    const lo = Math.max(0, i - 6)
    let t = 0
    for (let j = lo; j <= i; j++) t += series[j]!.units
    return t / (i - lo + 1)
  })
  let avgPath = ''
  for (let i = 0; i < n; i++) {
    const x = PADL + i * bw + bw / 2
    const y = yOf(avg[i]!)
    avgPath += `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)} `
  }

  const firstDate = series[0]!.date
  const lastDate = series[n - 1]!.date
  const avgPerDay = history.totalUnits / n

  return (
    <div className="inv-spark">
      <div className="inv-spark-caption subtle-copy">
        {fmtNum(history.totalUnits)} units over {history.days}d · {avgPerDay.toFixed(2)}/day avg ·{' '}
        {fmtMoney(history.totalRevenue)} revenue
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="inv-spark-svg" role="img" aria-label="Daily units sold">
        <line x1={PADL} x2={W - PADR} y1={PADT + plotH} y2={PADT + plotH} stroke="#d8d8d8" strokeWidth={1} />
        {series.map((s, i) => {
          const h = (s.units / maxU) * plotH
          return (
            <rect
              key={s.date}
              x={PADL + i * bw + 0.4}
              y={PADT + plotH - h}
              width={Math.max(0.6, bw - 0.8)}
              height={h}
              className="inv-spark-bar"
            >
              <title>{`${s.date}: ${s.units} units · ${fmtMoney(s.revenue)}`}</title>
            </rect>
          )
        })}
        {n > 1 ? <path d={avgPath} className="inv-spark-avg" fill="none" /> : null}
        <text x={PADL} y={H - 5} fontSize={9} fill="#666">
          {firstDate}
        </text>
        <text x={W - PADR} y={H - 5} fontSize={9} fill="#666" textAnchor="end">
          {lastDate}
        </text>
      </svg>
    </div>
  )
}

function Fact({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`inv-fact${warn ? ' is-warn' : ''}`}>
      <div className="inv-fact-label subtle-copy">{label}</div>
      <div className="inv-fact-value">{value}</div>
    </div>
  )
}

function reorderFacts(r: InventorySkuRow): Array<{ label: string; value: string; warn?: boolean }> {
  return [
    { label: 'Sellable', value: fmtNum(r.sellableUnits), warn: r.sellableUnits === 0 },
    { label: 'Days supply', value: fmtDays(r.daysSupply ?? undefined) },
    { label: 'Forecast/day', value: fmtNum(r.forecastDailyUnits, 1) },
    { label: 'Velocity 7d / win', value: `${fmtNum(r.units7 / 7, 1)} / ${fmtNum(r.velocity, 1)}` },
    { label: 'Lead + safety', value: fmtDays(r.reorderPointDays) },
    { label: 'Cadence', value: fmtDays(r.cadenceDays) },
    { label: 'Target cover', value: fmtDays(r.targetCoverDays) },
    { label: 'Rec qty', value: fmtNum(r.recommendedQty) },
    { label: 'Est cost', value: fmtMoney(r.recommendedCost) },
    { label: 'Unit margin', value: fmtMoney(r.unitMargin, 2) },
    { label: 'Lost $/day', value: fmtMoney(r.lostMarginPerDay, 2), warn: r.lostMarginPerDay > 0 },
    { label: 'Confidence', value: fmtPct(r.confidenceScore), warn: r.confidenceScore < 0.6 },
  ]
}

function exitFacts(r: InventorySkuRow): Array<{ label: string; value: string; warn?: boolean }> {
  const last = daysAgo(r.lastSaleAt)
  const breakeven = breakevenDisc(r)
  const recoveredMargin =
    r.unitCostCurrent !== null
      ? Math.max(0, r.lifetimeSoldRevenue - r.lifetimeUnitsSold * r.unitCostCurrent)
      : null
  return [
    { label: 'On-hand units', value: fmtNum(r.physicalUnits) },
    { label: 'On-hand cost', value: fmtMoney(r.onHandCost), warn: r.onHandCost > 0 },
    { label: 'Avg age', value: fmtDays(r.avgInventoryAgeDays ?? undefined) },
    { label: 'Last sale', value: last === null ? 'never' : `${last}d ago` },
    { label: 'Sold 90d', value: fmtNum(r.units90), warn: r.units90 === 0 },
    { label: 'Sold lifetime', value: `${fmtNum(r.lifetimeUnitsSold)} / ${fmtMoney(r.lifetimeSoldRevenue)}` },
    { label: 'Recovered margin (appx)', value: recoveredMargin === null ? '—' : fmtMoney(recoveredMargin) },
    { label: 'GM%', value: fmtPct(r.gmPct) },
    { label: 'Breakeven disc (appx)', value: breakeven === null ? '—' : `≈${fmtPct(breakeven)}` },
    { label: 'Expiring ≤60d', value: r.expiringUnits60 > 0 ? fmtNum(r.expiringUnits60) : '—', warn: r.expiringUnits60 > 0 },
    { label: 'Confidence', value: fmtPct(r.confidenceScore), warn: r.confidenceScore < 0.6 },
  ]
}

function SkuInsightPanel({
  r,
  mode,
  windowDays,
}: {
  r: InventorySkuRow
  mode: InsightMode
  windowDays: number
}) {
  const histDays = 90
  const { data: history, loading, error } = useSkuHistory(r, histDays)
  const { sentence, caveat } = buildSkuJustification(r, mode)
  const facts = mode === 'reorder' ? reorderFacts(r) : exitFacts(r)

  return (
    <div className="inv-insight">
      <p className="inv-insight-sentence">{sentence}</p>
      {caveat ? <p className="inv-insight-caveat">⚠ {caveat}</p> : null}

      <div className="inv-fact-grid">
        {facts.map((f) => (
          <Fact key={f.label} label={f.label} value={f.value} warn={f.warn} />
        ))}
      </div>

      <div className="inv-insight-chart">
        <div className="inv-insight-chart-title subtle-copy">Daily units sold — last {histDays}d</div>
        {loading ? (
          <p className="subtle-copy">Loading sales history…</p>
        ) : error ? (
          <p className="subtle-copy">Couldn't load sales history: {error}</p>
        ) : history ? (
          <DailySalesBars history={history} />
        ) : null}
      </div>

      <div className="inv-insight-scores">
        {mode === 'reorder' ? (
          <ScoreBreakdown title="reorder priority" score={r.reorderPriorityScore} factors={r.reorderFactors} />
        ) : null}
        <ScoreBreakdown title="deadweight" score={r.deadweightScore} factors={r.deadweightFactors} />
      </div>

      <div className="inv-cohort-links">
        <div className="inv-cohort-links-title subtle-copy">
          See this SKU vs its category cohort{r.categoryName ? ` (${r.categoryName})` : ''} — opens
          Catalog Analytics in a new tab
        </div>
        {r.categoryName ? (
          <div className="inv-cohort-links-row">
            {COHORT_LINKS.map((l) => (
              <a
                key={l.section}
                className="inv-cohort-link"
                href={catalogCohortHref(r, l.section, windowDays)}
                target="_blank"
                rel="noreferrer noopener"
                title={l.hint}
                onClick={(e) => e.stopPropagation()}
              >
                {l.label} ↗
              </a>
            ))}
          </div>
        ) : (
          <p className="subtle-copy">No category resolved for this SKU, so cohort comparison isn’t available.</p>
        )}
      </div>
    </div>
  )
}

// Wraps a table row so clicking it expands an inline insight panel. The
// `cells` are the row's <td>s; `detailColSpan` must equal the table's column
// count. A small "open ↗" link in the panel header deep-links the row in a
// new tab (no dedicated SKU route needed).
function ExpandableSkuRow({
  r,
  mode,
  cells,
  detailColSpan,
  expandedSku,
  onToggleExpand,
  detailHref,
  windowDays,
}: {
  r: InventorySkuRow
  mode: InsightMode
  cells: React.ReactNode
  detailColSpan: number
  expandedSku: string | null
  onToggleExpand: (key: string) => void
  detailHref: string
  windowDays: number
}) {
  const key = skuKey(r)
  const canExpand = r.productId !== null
  const isOpen = canExpand && expandedSku === key
  return (
    <>
      <tr
        className={`${canExpand ? 'inv-proc-clickable' : ''}${isOpen ? ' is-expanded' : ''}`}
        onClick={canExpand ? () => onToggleExpand(key) : undefined}
      >
        {cells}
      </tr>
      {isOpen ? (
        <tr className="inv-proc-sku-detail">
          <td colSpan={detailColSpan}>
            <div className="inv-insight-head">
              <span className="subtle-copy">Why this recommendation</span>
              <a
                href={detailHref}
                target="_blank"
                rel="noreferrer noopener"
                className="inv-insight-openlink"
                onClick={(e) => e.stopPropagation()}
              >
                open ↗
              </a>
            </div>
            <SkuInsightPanel r={r} mode={mode} windowDays={windowDays} />
          </td>
        </tr>
      ) : null}
    </>
  )
}

// A leading caret cell content marking a row as expandable.
function caret(isOpen: boolean): string {
  return isOpen ? '▾ ' : '▸ '
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function InventoryProcurementTab() {
  const initial = useMemo(
    () =>
      readDeepLink({
        view: 'reorder',
        sites: new Set<string>(),
        windowDays: 28,
        expandedSku: null,
      }),
    [],
  )
  const [selectedSites, setSelectedSites] = useState<ReadonlySet<string>>(() =>
    normaliseSiteSelection(initial.sites, KNOWN_SITES.length),
  )
  const [windowDays, setWindowDays] = useState(initial.windowDays)
  const [subTab, setSubTab] = useState<SubTab>(initial.view)
  const [expandedSku, setExpandedSku] = useState<string | null>(initial.expandedSku)
  const [data, setData] = useState<InventoryProcurementResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sitesParam = useMemo(() => Array.from(selectedSites).join(','), [selectedSites])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const qs = new URLSearchParams()
    qs.set('windowDays', String(windowDays))
    if (sitesParam) qs.set('sites', sitesParam)
    loadJson(`/api/inventory-procurement?${qs.toString()}`, InventoryProcurementResponseSchema)
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sitesParam, windowDays])

  // Keep the URL hash in sync so the current view is bookmarkable/shareable.
  useEffect(() => {
    writeDeepLink({ view: subTab, sites: selectedSites, windowDays, expandedSku })
  }, [subTab, selectedSites, windowDays, expandedSku])

  const toggleExpand = (key: string) =>
    setExpandedSku((cur) => (cur === key ? null : key))

  // Switching to a view without per-SKU rows clears the expanded panel so
  // the hash doesn't carry a stale sku= on the distributor / mix tabs.
  function changeSubTab(next: SubTab) {
    setSubTab(next)
    if (next !== 'reorder' && next !== 'exit') setExpandedSku(null)
  }

  function toggleSite(id: string) {
    setSelectedSites((prev) => toggleSiteSelection(prev, id, KNOWN_SITES.length))
  }

  return (
    <div className="inv-proc-tab">
      <div className="inv-proc-controls">
        <div className="inv-proc-site-chips">
          <button
            type="button"
            className={`metrics-site-chip${selectedSites.size === 0 ? ' is-active' : ''}`}
            onClick={() => setSelectedSites(new Set())}
          >
            All sites
          </button>
          {KNOWN_SITES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`metrics-site-chip${selectedSites.has(s.id) ? ' is-active' : ''}`}
              onClick={() => toggleSite(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="inv-proc-window-chips">
          <span className="subtle-copy">Demand window:</span>
          {WINDOW_PRESETS.map((w) => (
            <button
              key={w.days}
              type="button"
              className={`metrics-site-chip${windowDays === w.days ? ' is-active' : ''}`}
              onClick={() => setWindowDays(w.days)}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <div className="budtender-perf-subtabs">
        {SUBTABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`metrics-site-chip${subTab === t.id ? ' is-active' : ''}`}
            onClick={() => changeSubTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error ? <div className="inv-proc-error">Failed to load: {error}</div> : null}
      {loading && !data ? <div className="subtle-copy">Loading inventory…</div> : null}

      {data ? (
        <>
          {subTab === 'reorder' ? (
            <ReorderQueueView
              data={data}
              expandedSku={expandedSku}
              onToggleExpand={toggleExpand}
              sites={selectedSites}
            />
          ) : null}
          {subTab === 'distributors' ? <DistributorBasketsView data={data} /> : null}
          {subTab === 'exit' ? (
            <ExitLiquidateView
              data={data}
              expandedSku={expandedSku}
              onToggleExpand={toggleExpand}
              sites={selectedSites}
            />
          ) : null}
          {subTab === 'mix' ? <MixDriftView data={data} /> : null}

          <details className="inv-proc-methodology">
            <summary>About this page / methodology</summary>
            <ul>
              {data.methodology.map((m, i) => (
                <li key={i} className="subtle-copy">
                  {m}
                </li>
              ))}
              <li className="subtle-copy">
                Generated {fmtDate(data.generatedAt)} · {data.summary.skuCount} SKUs ·{' '}
                window {data.params.windowDays}d · default lead {data.params.defaultLeadDays}d.
              </li>
            </ul>
          </details>
        </>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab 1 — Reorder Queue
// ---------------------------------------------------------------------------

interface SkuViewProps {
  data: InventoryProcurementResponse
  expandedSku: string | null
  onToggleExpand: (key: string) => void
  sites: ReadonlySet<string>
}

function ReorderQueueView({ data, expandedSku, onToggleExpand, sites }: SkuViewProps) {
  const s = data.summary
  const win = data.params.windowDays
  const hrefFor = (r: InventorySkuRow) => skuDetailHref('reorder', sites, win, skuKey(r))
  const outRows = useMemo(
    () =>
      data.skus
        .filter((r) => r.outRegretted)
        .sort((a, b) => b.lostMarginPerDay - a.lostMarginPerDay)
        .slice(0, 100),
    [data.skus],
  )
  const queueRows = useMemo(
    () =>
      data.skus
        .filter(
          (r) =>
            !r.outRegretted &&
            (r.recommendedQty > 0 ||
              r.minOrderOvershootsTarget ||
              (r.daysSupply !== null && r.forecastDailyUnits > 0 && r.daysSupply <= r.reorderPointDays)),
        )
        .sort((a, b) => b.reorderPriorityScore - a.reorderPriorityScore)
        .slice(0, 200),
    [data.skus],
  )

  return (
    <div className="inv-proc-view">
      <div className="budtender-totals-strip">
        <Kpi value={String(s.outRegrettedCount)} label="Out & regretting" warn={s.outRegrettedCount > 0} />
        <Kpi value={fmtMoney(s.outRegrettedLostMarginPerDay)} label="Lost margin / day (out)" warn={s.outRegrettedLostMarginPerDay > 0} />
        <Kpi value={String(s.soonOutCount)} label="Runout before reorder lands" />
        <Kpi value={fmtMoney(s.recommendedOrderCostTotal)} label="Recommended order cost" />
        <Kpi value={String(s.lowConfidenceCount)} label="Low-confidence rows" />
      </div>

      <article className="metric-chart-card">
        <h3 className="inv-proc-section-title">Out right now &amp; regretting it</h3>
        <p className="subtle-copy inv-proc-section-sub">
          Zero sellable units on a SKU that was recently selling. Ranked by lost margin per day.
        </p>
        <div className="inv-proc-table-scroll">
          <table className="budtender-leaderboard inv-proc-table">
            <thead>
              <tr>
                <th>Site</th>
                <th>Product</th>
                <th>Category</th>
                <th>Distributor</th>
                <th className="num">Last sale</th>
                <th className="num">Sold {data.params.windowDays}d</th>
                <th className="num">Fcst/day</th>
                <th className="num">Unit margin</th>
                <th className="num">Lost $/day</th>
                <th className="num">Rec qty</th>
                <th className="num">Est cost</th>
                <th>Conf</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {outRows.length === 0 ? (
                <tr>
                  <td colSpan={13} className="subtle-copy">
                    Nothing out that was recently selling. 🎉
                  </td>
                </tr>
              ) : (
                outRows.map((r) => (
                  <ExpandableSkuRow
                    key={rowKey(r)}
                    r={r}
                    mode="reorder"
                    detailColSpan={13}
                    expandedSku={expandedSku}
                    onToggleExpand={onToggleExpand}
                    detailHref={hrefFor(r)}
                    windowDays={win}
                    cells={<SkuRowCells r={r} isOpen={expandedSku === skuKey(r)} />}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </article>

      <article className="metric-chart-card">
        <h3 className="inv-proc-section-title">Runout soon — reorder queue</h3>
        <p className="subtle-copy inv-proc-section-sub">
          Below the reorder point or with a recommended quantity. Ranked by reorder priority
          (expected margin loss before replenishment, reorder gap, lost margin/day, confidence).
        </p>
        <div className="inv-proc-table-scroll">
          <table className="budtender-leaderboard inv-proc-table">
            <thead>
              <tr>
                <th className="num">Pri</th>
                <th>Site</th>
                <th>Product</th>
                <th>Distributor</th>
                <th className="num">Sellable</th>
                <th className="num">Days supply</th>
                <th className="num">Stockout</th>
                <th className="num">Lead</th>
                <th className="num">Fcst/day</th>
                <th className="num">Lost $/day</th>
                <th className="num">Rec qty</th>
                <th className="num">Est cost</th>
                <th>Conf</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {queueRows.length === 0 ? (
                <tr>
                  <td colSpan={14} className="subtle-copy">
                    No SKUs below their reorder point right now.
                  </td>
                </tr>
              ) : (
                queueRows.map((r) => (
                  <ExpandableSkuRow
                    key={rowKey(r)}
                    r={r}
                    mode="reorder"
                    detailColSpan={14}
                    expandedSku={expandedSku}
                    onToggleExpand={onToggleExpand}
                    detailHref={hrefFor(r)}
                    windowDays={win}
                    cells={<QueueRowCells r={r} isOpen={expandedSku === skuKey(r)} />}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </article>
    </div>
  )
}

// Cells for the "out & regretting" table (13 columns). Returns <td>s only —
// the surrounding <tr> + click/expand is owned by ExpandableSkuRow.
function SkuRowCells({ r, isOpen }: { r: InventorySkuRow; isOpen: boolean }) {
  const last = daysAgo(r.lastSaleAt)
  return (
    <>
      <td>
        {r.productId !== null ? <span className="inv-caret">{caret(isOpen)}</span> : null}
        {r.siteLabel}
      </td>
      <td>
        <div className="inv-proc-prod">{r.productName}</div>
        <div className="subtle-copy inv-proc-prod-sub">{r.brandName ?? ''}</div>
      </td>
      <td>{[r.categoryName, r.subcategoryName].filter(Boolean).join(' · ') || '—'}</td>
      <td>{r.distributorName ?? <span className="subtle-copy">unknown</span>}</td>
      <td className="num">{last === null ? '—' : `${last}d ago`}</td>
      <td className="num">{fmtNum(r.units28)}</td>
      <td className="num">{fmtNum(r.forecastDailyUnits, 1)}</td>
      <td className="num">{fmtMoney(r.unitMargin, 2)}</td>
      <td className="num">{fmtMoney(r.lostMarginPerDay, 2)}</td>
      <td className="num">
        <strong>{fmtNum(r.recommendedQty)}</strong>
      </td>
      <td className="num">{fmtMoney(r.recommendedCost)}</td>
      <td>
        <ConfidencePill score={r.confidenceScore} />
      </td>
      <td>
        <ActionPill action={r.action} />
      </td>
    </>
  )
}

// Cells for the "runout soon — reorder queue" table (14 columns).
function QueueRowCells({ r, isOpen }: { r: InventorySkuRow; isOpen: boolean }) {
  return (
    <>
      <td className="num">
        {r.productId !== null ? <span className="inv-caret">{caret(isOpen)}</span> : null}
        <strong>{r.reorderPriorityScore}</strong>
      </td>
      <td>{r.siteLabel}</td>
      <td>
        <div className="inv-proc-prod">{r.productName}</div>
        <div className="subtle-copy inv-proc-prod-sub">
          {[r.brandName, r.categoryName].filter(Boolean).join(' · ')}
        </div>
      </td>
      <td>{r.distributorName ?? <span className="subtle-copy">unknown</span>}</td>
      <td className="num">{fmtNum(r.sellableUnits)}</td>
      <td className="num">{fmtDays(r.daysSupply ?? undefined)}</td>
      <td className="num">{fmtDate(r.projectedStockoutAt)}</td>
      <td className="num">{fmtDays(r.leadTimeDays)}</td>
      <td className="num">{fmtNum(r.forecastDailyUnits, 1)}</td>
      <td className="num">{fmtMoney(r.lostMarginPerDay, 2)}</td>
      <td className="num">
        <strong>{fmtNum(r.recommendedQty)}</strong>
        {r.minOrderOvershootsTarget && r.suppressedRecommendedQty !== null && (
          <div
            className="subtle-copy"
            title={`Minimum case of ${fmtNum(r.suppressedRecommendedQty)} would create ~${fmtDays(
              r.coverageAfterSnappedOrderDays ?? undefined,
            )} of supply vs a ${fmtDays(r.targetCoverDays)} target — too much to sell through, so not recommended.`}
          >
            (min {fmtNum(r.suppressedRecommendedQty)} = {fmtDays(r.coverageAfterSnappedOrderDays ?? undefined)})
          </div>
        )}
      </td>
      <td className="num">{fmtMoney(r.recommendedCost)}</td>
      <td>
        <ConfidencePill score={r.confidenceScore} />
      </td>
      <td>
        <ActionPill action={r.action} />
      </td>
    </>
  )
}

// Cells for the liquidation/exit table (13 columns). Returns <td>s only —
// the surrounding <tr> + click/expand is owned by ExpandableSkuRow.
function ExitRowCells({ r, isOpen }: { r: InventorySkuRow; isOpen: boolean }) {
  const last = daysAgo(r.lastSaleAt)
  const breakeven = breakevenDisc(r)
  return (
    <>
      <td className="num">
        {r.productId !== null ? <span className="inv-caret">{caret(isOpen)}</span> : null}
        <strong>{r.deadweightScore}</strong>
      </td>
      <td>{r.siteLabel}</td>
      <td>
        <div className="inv-proc-prod">{r.productName}</div>
        <div className="subtle-copy inv-proc-prod-sub">{r.brandName ?? ''}</div>
      </td>
      <td>{[r.categoryName, r.subcategoryName].filter(Boolean).join(' · ') || '—'}</td>
      <td className="num">{fmtNum(r.physicalUnits)}</td>
      <td className="num">{fmtMoney(r.onHandCost)}</td>
      <td className="num">{fmtDays(r.avgInventoryAgeDays ?? undefined)}</td>
      <td className="num">{last === null ? 'never' : `${last}d`}</td>
      <td className="num">{fmtNum(r.units90)}</td>
      <td className="num">{fmtPct(r.gmPct)}</td>
      <td className="num">{breakeven === null ? '—' : `≈${fmtPct(breakeven)}`}</td>
      <td className="num">{r.expiringUnits60 > 0 ? fmtNum(r.expiringUnits60) : '—'}</td>
      <td>
        <ActionPill action={r.action} />
      </td>
    </>
  )
}

// ---------------------------------------------------------------------------
// Tab 2 — Distributor Baskets
// ---------------------------------------------------------------------------

interface BasketLine {
  r: InventorySkuRow
  lossIfOrderNow: number
  lossIfWait: number
  earlyCarry: number
  orderNowValue: number
  include: boolean
}
interface DistBasket {
  key: string
  siteLabel: string
  distributorName: string
  leadTimeDays: number
  cadenceDays: number
  lastDeliveryDate: string | null
  waitDays: number
  lines: BasketLine[]
  basketCost: number
  basketUnits: number
  urgentCount: number
  outRegrettedCount: number
  lossIfOrderNow: number
  lossIfWait: number
  orderNowValue: number
  guidance: 'order_now' | 'short_order' | 'wait' | 'no_action'
}

function buildBaskets(data: InventoryProcurementResponse): DistBasket[] {
  const distByKey = new Map<string, InventoryDistributorStat>()
  for (const d of data.distributors) distByKey.set(`${d.dealerId}|${d.distributorName}`, d)

  const groups = new Map<string, InventorySkuRow[]>()
  for (const r of data.skus) {
    if (!r.distributorName) continue
    const k = `${r.dealerId}|${r.distributorName}`
    const arr = groups.get(k)
    if (arr) arr.push(r)
    else groups.set(k, [r])
  }

  const baskets: DistBasket[] = []
  for (const [k, rows] of groups) {
    const first = rows[0]
    const dist = distByKey.get(k)
    const leadTimeDays = first.leadTimeDays
    const cadenceDays = dist?.cadenceDays ?? first.cadenceDays
    const lastDeliveryDate = dist?.lastDeliveryDate ?? null
    const nextOrderMs = lastDeliveryDate
      ? new Date(lastDeliveryDate).getTime() + cadenceDays * DAY_MS
      : Date.now()
    const waitDays = Math.max(0, Math.round((nextOrderMs - Date.now()) / DAY_MS))
    const dailyCarry = CARRY_ANNUAL_RATE / 365

    const lines: BasketLine[] = rows.map((r) => {
      const ds = r.daysSupply ?? Infinity
      const lossIfOrderNow = r.lostMarginPerDay * Math.max(0, leadTimeDays - ds)
      const lossIfWait = r.lostMarginPerDay * Math.max(0, leadTimeDays + waitDays - ds)
      const earlyCarry = r.recommendedCost * dailyCarry * waitDays
      const orderNowValue = lossIfWait - lossIfOrderNow - earlyCarry
      const include =
        r.recommendedQty > 0 &&
        !r.doNotReorder &&
        (r.reorderPriorityScore >= 50 || orderNowValue > 0 || r.outRegretted)
      return { r, lossIfOrderNow, lossIfWait, earlyCarry, orderNowValue, include }
    })

    const included = lines.filter((l) => l.include)
    const basketCost = included.reduce((t, l) => t + l.r.recommendedCost, 0)
    const basketUnits = included.reduce((t, l) => t + l.r.recommendedQty, 0)
    // Only count rows we'd actually order toward basket urgency — a slow
    // mover whose minimum case overshoots target (recommendedQty === 0) must
    // not flip a distributor to "ORDER NOW" for something we won't buy.
    const urgentCount = rows.filter(
      (r) =>
        r.recommendedQty > 0 &&
        r.daysSupply !== null &&
        r.forecastDailyUnits > 0 &&
        r.daysSupply <= r.reorderPointDays,
    ).length
    const outRegrettedCount = rows.filter((r) => r.outRegretted && r.recommendedQty > 0).length
    const orderNowValue = included.reduce((t, l) => t + l.orderNowValue, 0)
    const lossIfOrderNow = included.reduce((t, l) => t + l.lossIfOrderNow, 0)
    const lossIfWait = included.reduce((t, l) => t + l.lossIfWait, 0)

    let guidance: DistBasket['guidance']
    if (basketCost <= 0) guidance = 'no_action'
    else if (orderNowValue >= ORDER_NOW_VALUE_THRESHOLD || outRegrettedCount > 0 || urgentCount >= 3)
      guidance = 'order_now'
    else if (orderNowValue > 0 && basketCost >= MIN_BASKET_COST) guidance = 'short_order'
    else guidance = 'wait'

    baskets.push({
      key: k,
      siteLabel: first.siteLabel,
      distributorName: first.distributorName ?? '(unknown)',
      leadTimeDays,
      cadenceDays,
      lastDeliveryDate,
      waitDays,
      lines: included.sort((a, b) => b.orderNowValue - a.orderNowValue),
      basketCost,
      basketUnits,
      urgentCount,
      outRegrettedCount,
      lossIfOrderNow,
      lossIfWait,
      orderNowValue,
      guidance,
    })
  }

  const rank: Record<DistBasket['guidance'], number> = { order_now: 0, short_order: 1, wait: 2, no_action: 3 }
  return baskets
    .filter((b) => b.basketCost > 0)
    .sort((a, b) => rank[a.guidance] - rank[b.guidance] || b.orderNowValue - a.orderNowValue)
}

const BASKET_CSV_HEADER: ReadonlyArray<string> = [
  'Site',
  'Distributor',
  'Guidance',
  'Product',
  'Brand',
  'Category',
  'SKU',
  'Sellable units',
  'Days supply',
  'Projected stockout',
  'Forecast/day',
  'Unit cost',
  'Recommended qty',
  'Extended cost',
  'Order-now value',
]

function round2(n: number | null | undefined): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null
  return Math.round(n * 100) / 100
}

function basketCsvRows(
  baskets: ReadonlyArray<DistBasket>,
): Array<Array<string | number | null>> {
  const rows: Array<Array<string | number | null>> = []
  for (const b of baskets) {
    for (const l of b.lines) {
      const r = l.r
      rows.push([
        b.siteLabel,
        b.distributorName,
        GUIDANCE_META[b.guidance].label,
        r.productName,
        r.brandName ?? '',
        r.categoryName ?? '',
        r.productSku ?? '',
        r.sellableUnits,
        r.daysSupply === null ? '' : round2(r.daysSupply),
        r.projectedStockoutAt ? nyIsoDate(new Date(r.projectedStockoutAt).getTime()) : '',
        round2(r.forecastDailyUnits),
        round2(r.unitCostCurrent),
        r.recommendedQty,
        round2(r.recommendedCost),
        round2(l.orderNowValue),
      ])
    }
  }
  return rows
}

const GUIDANCE_META: Record<DistBasket['guidance'], { label: string; cls: string }> = {
  order_now: { label: 'ORDER NOW', cls: 'inv-pill--danger' },
  short_order: { label: 'SHORT ORDER', cls: 'inv-pill--warn' },
  wait: { label: 'WAIT', cls: 'inv-pill--info' },
  no_action: { label: 'NO ACTION', cls: 'inv-pill--muted' },
}

function DistributorBasketsView({ data }: { data: InventoryProcurementResponse }) {
  const baskets = useMemo(() => buildBaskets(data), [data])
  const [expanded, setExpanded] = useState<string | null>(null)

  const orderNowCount = baskets.filter((b) => b.guidance === 'order_now').length
  const totalBasketCost = baskets
    .filter((b) => b.guidance === 'order_now' || b.guidance === 'short_order')
    .reduce((t, b) => t + b.basketCost, 0)
  const marginSaved = baskets.reduce((t, b) => t + Math.max(0, b.lossIfWait - b.lossIfOrderNow), 0)

  const actionableBaskets = baskets.filter(
    (b) => b.guidance === 'order_now' || b.guidance === 'short_order',
  )

  function exportBaskets(toExport: ReadonlyArray<DistBasket>, label: string) {
    const rows = basketCsvRows(toExport)
    if (rows.length === 0) return
    downloadCsv(`procurement-baskets-${label}-${nyIsoDate(Date.now())}.csv`, BASKET_CSV_HEADER, rows)
  }

  return (
    <div className="inv-proc-view">
      <div className="budtender-totals-strip">
        <Kpi value={String(orderNowCount)} label="Distributors to order now" warn={orderNowCount > 0} />
        <Kpi value={fmtMoney(totalBasketCost)} label="Recommended basket cost" />
        <Kpi value={fmtMoney(marginSaved)} label="Margin saved vs waiting" />
        <Kpi value={String(baskets.length)} label="Distributors with a basket" />
      </div>

      <article className="metric-chart-card">
        <div className="inv-proc-section-head">
          <h3 className="inv-proc-section-title">Distributor order board</h3>
          <button
            type="button"
            className="metrics-site-chip inv-proc-export-btn"
            disabled={actionableBaskets.length === 0}
            title="Download the order-now + short-order baskets as a CSV"
            onClick={() => exportBaskets(actionableBaskets, 'order-now')}
          >
            ⬇ Export order baskets (CSV)
          </button>
        </div>
        <p className="subtle-copy inv-proc-section-sub">
          Batched per-distributor guidance. "Order-now value" = margin lost by waiting minus early
          carrying cost. Click a row to see the recommended basket.
        </p>
        <div className="inv-proc-table-scroll">
          <table className="budtender-leaderboard inv-proc-table">
            <thead>
              <tr>
                <th>Site</th>
                <th>Distributor</th>
                <th>Guidance</th>
                <th className="num">Lines</th>
                <th className="num">Units</th>
                <th className="num">Basket cost</th>
                <th className="num">Urgent</th>
                <th className="num">Out</th>
                <th className="num">Cadence</th>
                <th className="num">Next order</th>
                <th className="num">Order-now value</th>
              </tr>
            </thead>
            <tbody>
              {baskets.length === 0 ? (
                <tr>
                  <td colSpan={11} className="subtle-copy">
                    No distributor baskets to recommend right now.
                  </td>
                </tr>
              ) : (
                baskets.map((b) => (
                  <>
                    <tr
                      key={b.key}
                      className="inv-proc-clickable"
                      onClick={() => setExpanded((e) => (e === b.key ? null : b.key))}
                    >
                      <td>{b.siteLabel}</td>
                      <td>
                        {expanded === b.key ? '▾ ' : '▸ '}
                        {b.distributorName}
                      </td>
                      <td>
                        <span className={`inv-pill ${GUIDANCE_META[b.guidance].cls}`}>
                          {GUIDANCE_META[b.guidance].label}
                        </span>
                      </td>
                      <td className="num">{b.lines.length}</td>
                      <td className="num">{fmtNum(b.basketUnits)}</td>
                      <td className="num">
                        <strong>{fmtMoney(b.basketCost)}</strong>
                      </td>
                      <td className="num">{b.urgentCount}</td>
                      <td className="num">{b.outRegrettedCount}</td>
                      <td className="num">{fmtDays(b.cadenceDays)}</td>
                      <td className="num">{b.waitDays === 0 ? 'now' : `${b.waitDays}d`}</td>
                      <td className="num">{fmtMoney(b.orderNowValue)}</td>
                    </tr>
                    {expanded === b.key ? (
                      <tr key={`${b.key}-detail`} className="inv-proc-basket-detail">
                        <td colSpan={11}>
                          <div className="inv-proc-basket-detail-head">
                            <span className="subtle-copy">
                              {b.distributorName} · {b.siteLabel} · {b.lines.length} line
                              {b.lines.length === 1 ? '' : 's'} · {fmtMoney(b.basketCost)}
                            </span>
                            <button
                              type="button"
                              className="metrics-site-chip inv-proc-export-btn"
                              title="Download this distributor's basket as a CSV"
                              onClick={(e) => {
                                e.stopPropagation()
                                exportBaskets(
                                  [b],
                                  `${b.distributorName}-${b.siteLabel}`
                                    .toLowerCase()
                                    .replace(/[^a-z0-9]+/g, '-')
                                    .replace(/^-+|-+$/g, ''),
                                )
                              }}
                            >
                              ⬇ Export this basket (CSV)
                            </button>
                          </div>
                          <table className="budtender-leaderboard inv-proc-table inv-proc-subtable">
                            <thead>
                              <tr>
                                <th>Product</th>
                                <th className="num">Sellable</th>
                                <th className="num">Days supply</th>
                                <th className="num">Stockout</th>
                                <th className="num">Fcst/day</th>
                                <th className="num">Unit cost</th>
                                <th className="num">Rec qty</th>
                                <th className="num">Ext cost</th>
                                <th className="num">Order-now value</th>
                              </tr>
                            </thead>
                            <tbody>
                              {b.lines.map((l) => (
                                <tr key={rowKey(l.r)}>
                                  <td>
                                    <div className="inv-proc-prod">{l.r.productName}</div>
                                    <div className="subtle-copy inv-proc-prod-sub">
                                      {[l.r.brandName, l.r.categoryName].filter(Boolean).join(' · ')}
                                    </div>
                                  </td>
                                  <td className="num">{fmtNum(l.r.sellableUnits)}</td>
                                  <td className="num">{fmtDays(l.r.daysSupply ?? undefined)}</td>
                                  <td className="num">{fmtDate(l.r.projectedStockoutAt)}</td>
                                  <td className="num">{fmtNum(l.r.forecastDailyUnits, 1)}</td>
                                  <td className="num">{fmtMoney(l.r.unitCostCurrent, 2)}</td>
                                  <td className="num">
                                    <strong>{fmtNum(l.r.recommendedQty)}</strong>
                                  </td>
                                  <td className="num">{fmtMoney(l.r.recommendedCost)}</td>
                                  <td className="num">{fmtMoney(l.orderNowValue, 2)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    ) : null}
                  </>
                ))
              )}
            </tbody>
          </table>
        </div>
      </article>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab 3 — Exit / Liquidate
// ---------------------------------------------------------------------------

// Category-level capital-vs-demand overhang. Surfaces structural
// overstacking ("Flower carries 35% of capital but earns 18% of margin")
// that no single SKU row reveals, so the buyer can target whole-category
// drawdowns. Only categories carrying capital with meaningful overhang
// (ratio ≥ 1.25 or no demand at all) are shown; healthy categories are
// omitted to keep the panel actionable.
function CategoryOverhangPanel({ rows }: { rows: readonly InventoryCategoryOverhang[] }) {
  const flagged = useMemo(
    () =>
      rows
        .filter((r) => r.onHandCost > 0 && (r.overhangRatio >= 1.25 || r.marginShare === 0))
        .slice(0, 8),
    [rows],
  )
  if (flagged.length === 0) return null
  const freeable = flagged.reduce((t, r) => t + r.excessCapital, 0)

  return (
    <article className="metric-chart-card">
      <h3 className="inv-proc-section-title">Category overhang</h3>
      <p className="subtle-copy inv-proc-section-sub">
        Categories carrying more capital than their recent demand earns. Overhang = capital
        share ÷ margin share (&gt;1 means overstacked); excess capital is the dollars freeable by
        drawing the category down to a demand-proportional level. Up to{' '}
        <strong>{fmtMoney(freeable)}</strong> is tied up above demand here.
      </p>
      <div className="inv-proc-table-scroll">
        <table className="budtender-leaderboard inv-proc-table">
          <thead>
            <tr>
              <th>Category</th>
              <th className="num">SKUs</th>
              <th className="num">On-hand cost</th>
              <th className="num">Capital share</th>
              <th className="num">Margin share</th>
              <th className="num">Overhang</th>
              <th className="num">Excess capital</th>
              <th className="num">Deadweight $</th>
            </tr>
          </thead>
          <tbody>
            {flagged.map((r) => (
              <tr key={r.categoryName}>
                <td>{r.categoryName}</td>
                <td className="num">{fmtNum(r.skuCount)}</td>
                <td className="num">{fmtMoney(r.onHandCost)}</td>
                <td className="num">{fmtPct(r.onHandCostShare)}</td>
                <td className="num">{fmtPct(r.marginShare)}</td>
                <td className="num">
                  <span
                    className={`inv-pill ${r.overhangRatio >= 2 || r.marginShare === 0 ? 'inv-pill--danger' : 'inv-pill--warn'}`}
                    title="On-hand capital share ÷ realized margin share. >1 = carrying more capital than demand earns."
                  >
                    {r.marginShare === 0 ? 'no demand' : `${r.overhangRatio.toFixed(1)}×`}
                  </span>
                </td>
                <td className="num">
                  <strong>{fmtMoney(r.excessCapital)}</strong>
                </td>
                <td className="num">{fmtMoney(r.deadweightCapital)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  )
}

function ExitLiquidateView({ data, expandedSku, onToggleExpand, sites }: SkuViewProps) {
  const s = data.summary
  const win = data.params.windowDays
  const hrefFor = (r: InventorySkuRow) => skuDetailHref('exit', sites, win, skuKey(r))
  const rows = useMemo(
    () =>
      data.skus
        .filter((r) => r.physicalUnits > 0 && r.onHandCost >= 25)
        .sort((a, b) => b.deadweightScore - a.deadweightScore || b.onHandCost - a.onHandCost)
        .slice(0, 200),
    [data.skus],
  )
  const stopCarry = data.skus.filter((r) => r.action === 'burn_down_stop_carry' || r.action === 'liquidate_now').length

  return (
    <div className="inv-proc-view">
      <div className="budtender-totals-strip">
        <Kpi value={fmtMoney(s.deadweightCapital)} label="Deadweight capital" warn={s.deadweightCapital > 0} />
        <Kpi value={fmtMoney(s.zeroVelocityCapital)} label="Zero-velocity capital" />
        <Kpi value={fmtMoney(s.expiringSoonCost)} label="Expiring ≤60d (cost)" warn={s.expiringSoonCost > 0} />
        <Kpi value={String(stopCarry)} label="Stop-carry candidates" />
      </div>

      <CategoryOverhangPanel rows={data.categoryOverhang} />

      <article className="metric-chart-card">
        <h3 className="inv-proc-section-title">Liquidation queue</h3>
        <p className="subtle-copy inv-proc-section-sub">
          On-hand SKUs ranked by deadweight score (slow velocity, capital tied up, age, expiry
          proximity, weak margin). GM% is margin on recent sales. Breakeven disc (appx ≈) is the
          deepest cut off the current shelf price at which liquidating the remaining units still
          breaks even, after crediting margin already recovered from prior sales — so SKUs you've
          already paid off can be cut further. Approximate: COGS uses current unit cost and the
          sales horizon is bounded by ingested order history. Expand a row to see the inputs.
        </p>
        <div className="inv-proc-table-scroll">
          <table className="budtender-leaderboard inv-proc-table">
            <thead>
              <tr>
                <th className="num">DW</th>
                <th>Site</th>
                <th>Product</th>
                <th>Category</th>
                <th className="num">On-hand</th>
                <th className="num">On-hand cost</th>
                <th className="num">Avg age</th>
                <th className="num">Last sale</th>
                <th className="num">Sold 90d</th>
                <th className="num">GM%</th>
                <th className="num">Breakeven disc (appx)</th>
                <th className="num">Expiring 60d</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={13} className="subtle-copy">
                    No deadweight inventory above the cost threshold.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <ExpandableSkuRow
                    key={rowKey(r)}
                    r={r}
                    mode="exit"
                    detailColSpan={13}
                    expandedSku={expandedSku}
                    onToggleExpand={onToggleExpand}
                    detailHref={hrefFor(r)}
                    windowDays={win}
                    cells={<ExitRowCells r={r} isOpen={expandedSku === skuKey(r)} />}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </article>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab 4 — Mix Drift
// ---------------------------------------------------------------------------

type Grain = 'category' | 'subcategory' | 'brand' | 'distributor'
type DemandBasis = 'margin' | 'revenue' | 'units' | 'forecast'

const GRAINS: ReadonlyArray<{ id: Grain; label: string }> = [
  { id: 'category', label: 'Category' },
  { id: 'subcategory', label: 'Subcategory' },
  { id: 'brand', label: 'Brand' },
  { id: 'distributor', label: 'Distributor' },
]
const BASES: ReadonlyArray<{ id: DemandBasis; label: string }> = [
  { id: 'margin', label: 'Margin' },
  { id: 'revenue', label: 'Revenue' },
  { id: 'units', label: 'Units sold' },
  { id: 'forecast', label: 'Forecast units' },
]

interface MixSeg {
  segment: string
  onHandUnits: number
  onHandCost: number
  unitsSold: number
  revenue: number
  margin: number
  forecastUnits28: number
  sellableUnits: number
  forecastDaily: number
}

function segmentKey(r: InventorySkuRow, grain: Grain): string {
  switch (grain) {
    case 'category':
      return r.categoryName ?? '(uncategorized)'
    case 'subcategory':
      return r.subcategoryName ?? '(no subcategory)'
    case 'brand':
      return r.brandName ?? '(no brand)'
    case 'distributor':
      return r.distributorName ?? '(no distributor)'
  }
}

function MixDriftView({ data }: { data: InventoryProcurementResponse }) {
  const [grain, setGrain] = useState<Grain>('category')
  const [basis, setBasis] = useState<DemandBasis>('margin')

  const { segs, totals } = useMemo(() => {
    const map = new Map<string, MixSeg>()
    for (const r of data.skus) {
      const key = segmentKey(r, grain)
      let seg = map.get(key)
      if (!seg) {
        seg = {
          segment: key,
          onHandUnits: 0,
          onHandCost: 0,
          unitsSold: 0,
          revenue: 0,
          margin: 0,
          forecastUnits28: 0,
          sellableUnits: 0,
          forecastDaily: 0,
        }
        map.set(key, seg)
      }
      seg.onHandUnits += r.physicalUnits
      seg.onHandCost += r.onHandCost
      seg.unitsSold += r.units28
      seg.revenue += r.revenueWindow
      seg.margin += r.marginWindow
      seg.forecastUnits28 += r.forecastDailyUnits * 28
      seg.sellableUnits += r.sellableUnits
      seg.forecastDaily += r.forecastDailyUnits
    }
    const segs = Array.from(map.values())
    const totals = {
      onHandUnits: segs.reduce((t, x) => t + x.onHandUnits, 0),
      onHandCost: segs.reduce((t, x) => t + x.onHandCost, 0),
      unitsSold: segs.reduce((t, x) => t + x.unitsSold, 0),
      revenue: segs.reduce((t, x) => t + x.revenue, 0),
      margin: segs.reduce((t, x) => t + x.margin, 0),
      forecastUnits28: segs.reduce((t, x) => t + x.forecastUnits28, 0),
    }
    return { segs, totals }
  }, [data.skus, grain])

  function demandShare(seg: MixSeg): number {
    switch (basis) {
      case 'margin':
        return totals.margin > 0 ? seg.margin / totals.margin : 0
      case 'revenue':
        return totals.revenue > 0 ? seg.revenue / totals.revenue : 0
      case 'units':
        return totals.unitsSold > 0 ? seg.unitsSold / totals.unitsSold : 0
      case 'forecast':
        return totals.forecastUnits28 > 0 ? seg.forecastUnits28 / totals.forecastUnits28 : 0
    }
  }

  const rows = useMemo(() => {
    return segs
      .map((seg) => {
        const costShare = totals.onHandCost > 0 ? seg.onHandCost / totals.onHandCost : 0
        const dShare = demandShare(seg)
        const gapPp = (costShare - dShare) * 100
        const excessCapital = totals.onHandCost * Math.max(0, costShare - dShare)
        const deficitCapital = totals.onHandCost * Math.max(0, dShare - costShare)
        const weightedDaysSupply = seg.forecastDaily > 0 ? seg.sellableUnits / seg.forecastDaily : null
        let action: 'overweight' | 'underweight' | 'low_cost_units' | 'balanced'
        if (gapPp >= 5 && (weightedDaysSupply ?? 0) >= 45) action = 'overweight'
        else if (gapPp <= -5 && weightedDaysSupply !== null && weightedDaysSupply <= 14) action = 'underweight'
        else action = 'balanced'
        return { seg, costShare, dShare, gapPp, excessCapital, deficitCapital, weightedDaysSupply, action }
      })
      .sort((a, b) => Math.abs(b.gapPp) - Math.abs(a.gapPp))
  }, [segs, totals, basis])

  const driftIndex =
    rows.reduce((t, r) => t + Math.abs(r.costShare - r.dShare), 0) / 2
  const overCapital = rows.reduce((t, r) => t + r.excessCapital, 0)
  const topUnder = rows.slice().sort((a, b) => b.deficitCapital - a.deficitCapital)[0]

  const ACTION_LABEL: Record<string, { label: string; cls: string }> = {
    overweight: { label: 'OVERWEIGHT', cls: 'inv-pill--warn' },
    underweight: { label: 'UNDERWEIGHT', cls: 'inv-pill--danger' },
    low_cost_units: { label: 'LOW-COST MIX', cls: 'inv-pill--info' },
    balanced: { label: 'BALANCED', cls: 'inv-pill--muted' },
  }

  return (
    <div className="inv-proc-view">
      <div className="budtender-totals-strip">
        <Kpi value={fmtPct(driftIndex)} label="Capital mix drift index" warn={driftIndex > 0.15} />
        <Kpi value={fmtMoney(overCapital)} label="Overallocated capital" />
        <Kpi
          value={topUnder ? topUnder.seg.segment : '—'}
          label="Largest underallocated segment"
        />
      </div>

      <div className="inv-proc-controls inv-proc-controls--secondary">
        <div className="inv-proc-window-chips">
          <span className="subtle-copy">Grain:</span>
          {GRAINS.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`metrics-site-chip${grain === g.id ? ' is-active' : ''}`}
              onClick={() => setGrain(g.id)}
            >
              {g.label}
            </button>
          ))}
        </div>
        <div className="inv-proc-window-chips">
          <span className="subtle-copy">Demand basis:</span>
          {BASES.map((b) => (
            <button
              key={b.id}
              type="button"
              className={`metrics-site-chip${basis === b.id ? ' is-active' : ''}`}
              onClick={() => setBasis(b.id)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>

      <article className="metric-chart-card">
        <h3 className="inv-proc-section-title">Inventory mix vs demand mix</h3>
        <p className="subtle-copy inv-proc-section-sub">
          Where capital share diverges from {basis} share. Positive gap = overinvested; negative =
          underinvested relative to demand.
        </p>
        <div className="inv-proc-table-scroll">
          <table className="budtender-leaderboard inv-proc-table">
            <thead>
              <tr>
                <th>Segment</th>
                <th className="num">On-hand cost</th>
                <th className="num">Cost share</th>
                <th className="num">{BASES.find((b) => b.id === basis)?.label} share</th>
                <th className="num bar">Gap</th>
                <th className="num">Gap pp</th>
                <th className="num">Excess $</th>
                <th className="num">Deficit $</th>
                <th className="num">Wtd days supply</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const maxAbs = Math.max(...rows.map((x) => Math.abs(x.gapPp)), 1)
                const widthPct = (Math.abs(r.gapPp) / maxAbs) * 100
                const over = r.gapPp >= 0
                return (
                  <tr key={r.seg.segment}>
                    <td>{r.seg.segment}</td>
                    <td className="num">{fmtMoney(r.seg.onHandCost)}</td>
                    <td className="num">{fmtPct(r.costShare, 1)}</td>
                    <td className="num">{fmtPct(r.dShare, 1)}</td>
                    <td className="bar">
                      <div className="inv-proc-gapbar">
                        <div
                          className={`inv-proc-gapbar-fill ${over ? 'is-over' : 'is-under'}`}
                          style={{ width: `${widthPct}%` }}
                        />
                      </div>
                    </td>
                    <td className="num">{(r.gapPp >= 0 ? '+' : '') + r.gapPp.toFixed(1)}</td>
                    <td className="num">{r.excessCapital > 0 ? fmtMoney(r.excessCapital) : '—'}</td>
                    <td className="num">{r.deficitCapital > 0 ? fmtMoney(r.deficitCapital) : '—'}</td>
                    <td className="num">{fmtDays(r.weightedDaysSupply ?? undefined)}</td>
                    <td>
                      <span className={`inv-pill ${ACTION_LABEL[r.action].cls}`}>
                        {ACTION_LABEL[r.action].label}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </article>
    </div>
  )
}

function rowKey(r: InventorySkuRow): string {
  return `${r.dealerId}-${r.productId ?? r.productName}`
}
