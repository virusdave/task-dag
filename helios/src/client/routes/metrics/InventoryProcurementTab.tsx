import { useEffect, useMemo, useState } from 'react'

import {
  InventoryProcurementResponseSchema,
  type InventoryAction,
  type InventoryDistributorStat,
  type InventoryProcurementResponse,
  type InventorySkuRow,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { nyIsoDate, nyMonthDaySlash } from '../../app/nyTime.js'

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
  const winNum = win ? Number(win) : NaN
  return {
    view: view && VALID_SUBTABS.has(view as SubTab) ? (view as SubTab) : defaults.view,
    sites: sites
      ? new Set(sites.split(',').filter((s) => s.length > 0))
      : defaults.sites,
    windowDays: VALID_WINDOWS.has(winNum) ? winNum : defaults.windowDays,
  }
}

function writeDeepLink(state: DeepLinkState): void {
  if (typeof window === 'undefined') return
  const p = new URLSearchParams()
  p.set('view', state.view)
  if (state.sites.size > 0) p.set('sites', Array.from(state.sites).sort().join(','))
  p.set('window', String(state.windowDays))
  const hash = `#${p.toString()}`
  if (hash !== window.location.hash) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`)
  }
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

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function InventoryProcurementTab() {
  const initial = useMemo(
    () => readDeepLink({ view: 'reorder', sites: new Set<string>(), windowDays: 28 }),
    [],
  )
  const [selectedSites, setSelectedSites] = useState<ReadonlySet<string>>(() => initial.sites)
  const [windowDays, setWindowDays] = useState(initial.windowDays)
  const [subTab, setSubTab] = useState<SubTab>(initial.view)
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
    writeDeepLink({ view: subTab, sites: selectedSites, windowDays })
  }, [subTab, selectedSites, windowDays])

  function toggleSite(id: string) {
    setSelectedSites((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
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
            onClick={() => setSubTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error ? <div className="inv-proc-error">Failed to load: {error}</div> : null}
      {loading && !data ? <div className="subtle-copy">Loading inventory…</div> : null}

      {data ? (
        <>
          {subTab === 'reorder' ? <ReorderQueueView data={data} /> : null}
          {subTab === 'distributors' ? <DistributorBasketsView data={data} /> : null}
          {subTab === 'exit' ? <ExitLiquidateView data={data} /> : null}
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

function ReorderQueueView({ data }: { data: InventoryProcurementResponse }) {
  const s = data.summary
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
                outRows.map((r) => <SkuRowCells key={rowKey(r)} r={r} />)
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
                  <tr key={rowKey(r)}>
                    <td className="num">
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
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </article>
    </div>
  )
}

function SkuRowCells({ r }: { r: InventorySkuRow }) {
  const last = daysAgo(r.lastSaleAt)
  return (
    <tr>
      <td>{r.siteLabel}</td>
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
    </tr>
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

function ExitLiquidateView({ data }: { data: InventoryProcurementResponse }) {
  const s = data.summary
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

      <article className="metric-chart-card">
        <h3 className="inv-proc-section-title">Liquidation queue</h3>
        <p className="subtle-copy inv-proc-section-sub">
          On-hand SKUs ranked by deadweight score (slow velocity, capital tied up, age, expiry
          proximity, weak margin). Breakeven discount = how far you can cut and still cover cost.
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
                <th className="num">Breakeven disc</th>
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
                rows.map((r) => {
                  const last = daysAgo(r.lastSaleAt)
                  const breakeven =
                    r.avgUnitPrice && r.avgUnitPrice > 0 && r.unitCostCurrent !== null
                      ? Math.max(0, 1 - r.unitCostCurrent / r.avgUnitPrice)
                      : null
                  return (
                    <tr key={rowKey(r)}>
                      <td className="num">
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
                      <td className="num">{fmtPct(breakeven)}</td>
                      <td className="num">{r.expiringUnits60 > 0 ? fmtNum(r.expiringUnits60) : '—'}</td>
                      <td>
                        <ActionPill action={r.action} />
                      </td>
                    </tr>
                  )
                })
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
