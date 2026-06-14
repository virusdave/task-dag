import { useEffect, useState } from 'react'

import {
  EssentialsDailySummaryResponseSchema,
  type EssentialsDailySummaryResponse,
  type EssentialsDailySummaryRow,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'

// ============================================================================
// "Today" summary banner pinned to the top of the Essentials tab.
//
// One row per site (Bronx, Midtown) plus a Totals row, refreshing
// every ~90 seconds. Sticky on desktop so it stays in view while the
// operator scrolls the per-card charts beneath. On mobile it
// collapses to a <details> with a one-line summary, so the dense
// table doesn't eat the whole viewport.
//
// "Today" is whatever the server says it is — the server computes the
// NY-calendar-day boundary (per canon). The header echoes the NY
// date string + the asOf timestamp so the operator can spot a stale
// snapshot at a glance.
// ============================================================================

const REFRESH_MS = 90_000

// Bias the layout the same way the rest of the dashboard does: a
// reviewer on mobile is reading a phone-width column, so we cut the
// table to a one-line header until they expand it.
const MOBILE_BREAKPOINT_PX = 720

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window === 'undefined'
      ? false
      : window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`)
    const handler = (ev: MediaQueryListEvent) => setIsMobile(ev.matches)
    // Older Safari uses addListener; modern uses addEventListener.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handler)
      return () => mql.removeEventListener('change', handler)
    }
    mql.addListener(handler)
    return () => mql.removeListener(handler)
  }, [])
  return isMobile
}

function formatDollars(n: number): string {
  // Same formatting the metric tooltips use: 2-decimal with grouping
  // for >= $1k. Negative values shown with a leading minus so a
  // returns-only day doesn't render misleadingly.
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })
}

function formatGmPct(pct: number | null): string {
  if (pct === null) return '—'
  return `${(pct * 100).toFixed(1)}%`
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

function formatAsOf(asOfIso: string): string {
  return new Date(asOfIso).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  })
}

interface SummaryCellProps {
  readonly label: string
  readonly value: string
  /** When true, render with stronger weight (totals row). */
  readonly emphasis?: boolean
}

function SummaryCell({ label, value, emphasis }: SummaryCellProps) {
  return (
    <div className="essentials-daily-summary__cell">
      <span className="essentials-daily-summary__cell-label">{label}</span>
      <span
        className={
          emphasis
            ? 'essentials-daily-summary__cell-value essentials-daily-summary__cell-value--emphasis'
            : 'essentials-daily-summary__cell-value'
        }
      >
        {value}
      </span>
    </div>
  )
}

interface RowProps {
  readonly row: EssentialsDailySummaryRow
  readonly emphasis?: boolean
}

function SummaryRow({ row, emphasis }: RowProps) {
  return (
    <div
      className={
        emphasis
          ? 'essentials-daily-summary__row essentials-daily-summary__row--totals'
          : 'essentials-daily-summary__row'
      }
    >
      <div
        className={
          emphasis
            ? 'essentials-daily-summary__row-label essentials-daily-summary__row-label--totals'
            : 'essentials-daily-summary__row-label'
        }
      >
        {row.siteLabel}
      </div>
      <SummaryCell label="new scan" value={formatCount(row.newScans)} emphasis={emphasis} />
      <SummaryCell label="ret. scan" value={formatCount(row.returningScans)} emphasis={emphasis} />
      <SummaryCell label="new buy" value={formatCount(row.newPurchases)} emphasis={emphasis} />
      <SummaryCell label="ret. buy" value={formatCount(row.returningPurchases)} emphasis={emphasis} />
      <SummaryCell
        label="gross receipts"
        value={formatDollars(row.grossReceiptsDollars)}
        emphasis={emphasis}
      />
      <SummaryCell
        label="gross sales"
        value={formatDollars(row.grossSalesDollars)}
        emphasis={emphasis}
      />
      <SummaryCell
        label="net receipts"
        value={formatDollars(row.netReceiptsDollars)}
        emphasis={emphasis}
      />
      <SummaryCell
        label="net sales"
        value={formatDollars(row.netSalesDollars)}
        emphasis={emphasis}
      />
      <SummaryCell
        label="margin $"
        value={formatDollars(row.marginDollars)}
        emphasis={emphasis}
      />
      <SummaryCell label="GM%" value={formatGmPct(row.gmPct)} emphasis={emphasis} />
    </div>
  )
}

// One-liner that hits the operator's highest-priority numbers without
// needing to expand the section. Shared by the mobile <details> and the
// collapsed desktop banner.
function summaryLine(data: EssentialsDailySummaryResponse): string {
  const t = data.totals
  return `Today · GS ${formatDollars(t.grossSalesDollars)} · Mgn ${formatDollars(
    t.marginDollars,
  )} (${formatGmPct(t.gmPct)}) · Scans ${formatCount(t.newScans + t.returningScans)}`
}

function MobileSummary({ data }: { readonly data: EssentialsDailySummaryResponse }) {
  const summary = summaryLine(data)
  return (
    <details className="essentials-daily-summary essentials-daily-summary--mobile">
      <summary className="essentials-daily-summary__summary-line">
        <span className="essentials-daily-summary__summary-line-text">{summary}</span>
        <span className="essentials-daily-summary__asof subtle-copy">
          {data.today.nyDate} · {formatAsOf(data.asOf)}
        </span>
      </summary>
      <div className="essentials-daily-summary__body">
        {data.sites.map((row) => (
          <SummaryRow key={row.siteKey} row={row} />
        ))}
        <SummaryRow row={data.totals} emphasis />
      </div>
    </details>
  )
}

const DESKTOP_COLLAPSED_KEY = 'helios.metrics.essentialsBanner.collapsed'

function useDesktopCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(DESKTOP_COLLAPSED_KEY) === '1'
  })
  const toggle = () =>
    setCollapsed((prev) => {
      const next = !prev
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(DESKTOP_COLLAPSED_KEY, next ? '1' : '0')
      }
      return next
    })
  return [collapsed, toggle]
}

function DesktopSummary({ data }: { readonly data: EssentialsDailySummaryResponse }) {
  // Collapsible on desktop: the full per-site table is dense and the
  // banner is sticky, so an operator who has internalised today's
  // numbers can fold it down to a one-line summary and reclaim the
  // vertical space. The choice persists across reloads.
  const [collapsed, toggleCollapsed] = useDesktopCollapsed()
  return (
    <section
      className={`essentials-daily-summary essentials-daily-summary--desktop${
        collapsed ? ' essentials-daily-summary--collapsed' : ''
      }`}
      aria-label="Today's per-site summary"
    >
      <div className="essentials-daily-summary__header">
        <button
          type="button"
          className="essentials-daily-summary__collapse-toggle"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand today’s summary' : 'Collapse today’s summary'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="essentials-daily-summary__title">Today ({data.today.nyDate})</span>
        {collapsed ? (
          <span className="essentials-daily-summary__summary-line-text">{summaryLine(data)}</span>
        ) : null}
        <span className="essentials-daily-summary__asof subtle-copy">
          as of {formatAsOf(data.asOf)} ET
        </span>
      </div>
      {collapsed ? null : (
        <div className="essentials-daily-summary__body">
          {data.sites.map((row) => (
            <SummaryRow key={row.siteKey} row={row} />
          ))}
          <SummaryRow row={data.totals} emphasis />
        </div>
      )}
    </section>
  )
}

export function EssentialsDailySummaryBanner() {
  const isMobile = useIsMobile()
  const [data, setData] = useState<EssentialsDailySummaryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: number | null = null

    async function fetchNow() {
      try {
        const fresh = await loadJson(
          '/api/metrics/essentials/today',
          EssentialsDailySummaryResponseSchema,
        )
        if (!cancelled) {
          setData(fresh)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load today’s summary.')
        }
      }
    }

    void fetchNow()
    // Modest polling cadence — the banner isn't a real-time tape; the
    // user spec calls for "no less than every minute or two". 90 s is
    // a comfortable midpoint that doesn't pile load on slow days.
    timer = window.setInterval(() => {
      void fetchNow()
    }, REFRESH_MS)
    // Refresh immediately when the operator brings the tab back into
    // focus after being away for a while.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void fetchNow()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      if (timer !== null) window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  if (!data && error) {
    return (
      <div className="essentials-daily-summary essentials-daily-summary--error" role="status">
        Today’s summary unavailable: {error}
      </div>
    )
  }
  if (!data) {
    return (
      <div
        className="essentials-daily-summary essentials-daily-summary--loading"
        role="status"
        aria-live="polite"
      >
        Loading today’s summary…
      </div>
    )
  }

  return isMobile ? <MobileSummary data={data} /> : <DesktopSummary data={data} />
}
