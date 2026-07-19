import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, useLoaderData, useParams, useRouteLoaderData } from 'react-router-dom'

import {
  CatalogAnalyticsFiltersResponseSchema,
  MetricAnnotationsListResponseSchema,
  MetricListResponseSchema,
  type CatalogAnalyticsFiltersResponse,
  type MetricAggregation,
  type MetricAnnotationRecord,
  type MetricCatalogFilterDimension,
  type MetricDataStatus,
  type MetricDefSummary,
  type MetricGrantKey,
  type MetricListResponse,
  type MetricsTabDefaults,
  type MetricsViewDefaults,
  type SessionEnvelope,
} from '../../../shared/contracts/index.js'
import { userHasAnyMetricGrant, userHasMetricGrant } from '../../../shared/domain/metricGrants.js'
import {
  GADS_DEFAULT_SUBPAGE,
  GADS_IMPLEMENTED_SUBPAGES,
  GADS_METRIC_SCOPE_BY_TAB_ID,
  GADS_RESERVED_SUBPAGES,
  gadsSubPageLabel,
  type GadsMetricScope,
  type GadsMetricTabId,
  type GadsScope,
  type GadsSubPage,
} from '../../../shared/domain/gadsSites.js'
import { loadJson } from '../../app/fetchJson.js'
import {
  NY_HOUR_MS,
  nyAddBusinessMonths,
  nyAddDays,
  nyFloorToBusinessDay,
  nyFloorToBusinessMonth,
  nyFloorToBusinessWeek,
  nyFloorToHour,
} from '../../app/nyTime.js'

import { BudtenderPerformanceTab } from './BudtenderPerformanceTab.js'
import { GAdsEvolutionTab } from './GAdsEvolutionTab.js'
import { GAdsLandingPagesTab } from './GAdsLandingPagesTab.js'
import {
  CatalogAnalyticsTab,
  resolveScatterDefaults,
  scatterChangeRows,
  SCATTER_CODE_DEFAULTS,
} from './CatalogAnalyticsTab.js'
import {
  MetricsDefaultsProvider,
  loadMetricsDefaults,
  useMetricsDefaults,
} from './MetricsDefaultsContext.js'
import {
  MetricsDefaultsModal,
  type MetricsDefaultsChange,
} from './MetricsDefaultsModal.js'
import { CrmSegmentAnalysisTab } from './CrmSegmentAnalysisTab.js'
import { CrmSegmentsTab } from './CrmSegmentsTab.js'
import { CustomerValueTab } from './CustomerValueTab.js'
import { InventoryProcurementTab } from './InventoryProcurementTab.js'
import { TargetTrackingTab } from './TargetTrackingTab.js'
import { TimeOfDayTab } from './TimeOfDayTab.js'
import { EssentialsDailySummaryBanner } from './EssentialsDailySummaryBanner.js'
import {
  CatalogFilterBar,
  emptyCatalogFilterSelection,
  type CatalogFilterSelection,
} from './CatalogFilterBar.js'
import { MetricsAccessGate } from './MetricsAccessGate.js'
import { defaultSiteSelection, toggleSiteSelection } from './metricsSiteSelection.js'
import {
  MetricChart,
  METRIC_STACK_MODES,
  type MetricStackMode,
} from './MetricChart.js'
import {
  Y_AXIS_BASELINE_PAGE_DEFAULTS,
  Y_AXIS_BASELINE_PAGE_DEFAULT_LABEL,
  type YAxisBaselinePageDefault,
} from './yAxisBaseline.js'
import { MetricRangeControls, type MetricRangePresetOption } from './MetricRangeControls.js'
import { TimeAxisProvider, useTimeAxis, type TimeWindow } from './TimeAxisContext.js'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Right edge for the default / preset window: the END of the
 * in-progress bucket for the active aggregation, NOT bare `now`.
 *
 * The server pace-extrapolates the rightmost in-progress bucket and
 * draws that projected knot at the bucket END (= next bucket start —
 * see `partialBuckets.ts`, `partialProjectedT = lastEnd`). With the
 * old `toMs = Date.now()` right edge, that projected knot sat up to
 * one whole bucket-width past the visible window, so the extrapolated
 * datapoint the operator cares about started off-screen to the right.
 *
 * Mirror the server's `advanceBucketStart` over the NY-business-day
 * grid (08:00 ET rollover) so the window's right edge lands exactly on
 * the projected knot. Categorical aggregations (total / dow / dom /
 * dofortnight) have no time edge, so fall back to `now`.
 */
function defaultWindowRightEdge(agg: MetricAggregation, nowMs: number = Date.now()): number {
  switch (agg) {
    case 'hour':
      return nyFloorToHour(nowMs) + NY_HOUR_MS
    case 'date':
      return nyAddDays(nyFloorToBusinessDay(nowMs), 1)
    case 'week':
      return nyAddDays(nyFloorToBusinessWeek(nowMs), 7)
    case 'month':
      return nyAddBusinessMonths(nyFloorToBusinessMonth(nowMs), 1)
    default:
      return nowMs
  }
}

function toggleInSet(prev: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(prev)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}
interface RangePreset {
  readonly label: string
  /**
   * Grouping to switch to when this preset is clicked. Omitted ⇒ leave
   * the current page aggregation untouched (only the window changes).
   */
  readonly agg?: MetricAggregation
  /**
   * Window builder. `agg` is the effective aggregation
   * (`preset.agg ?? current page agg`) so the right edge lands on the
   * projected in-progress-bucket knot (see `defaultWindowRightEdge`).
   */
  readonly range: (nowMs: number, agg: MetricAggregation) => TimeWindow
}

// A trailing-N-days window anchored on the left at `now - Nd` and on the
// right at the end of the current bucket for the effective aggregation.
const lastNDaysRange =
  (days: number) =>
  (nowMs: number, agg: MetricAggregation): TimeWindow => ({
    fromMs: nowMs - days * DAY_MS,
    toMs: defaultWindowRightEdge(agg, nowMs),
  })

const PRESETS: ReadonlyArray<RangePreset> = [
  // Single-business-day views default to hourly grouping — that's the
  // only granularity that makes an intra-day window legible.
  {
    label: 'today',
    agg: 'hour',
    range: (nowMs) => ({
      fromMs: nyFloorToBusinessDay(nowMs),
      toMs: defaultWindowRightEdge('hour', nowMs),
    }),
  },
  {
    label: '-1d',
    agg: 'hour',
    range: (nowMs) => ({
      // Yesterday's full business day: [start of yesterday, start of today).
      fromMs: nyAddDays(nyFloorToBusinessDay(nowMs), -1),
      toMs: nyFloorToBusinessDay(nowMs),
    }),
  },
  // A week reads best bucketed by day.
  { label: '7d', agg: 'date', range: lastNDaysRange(7) },
  // Longer ranges keep whatever grouping the operator has chosen.
  { label: '30d', range: lastNDaysRange(30) },
  { label: '90d', range: lastNDaysRange(90) },
  { label: '6mo', range: lastNDaysRange(180) },
  { label: '1y', range: lastNDaysRange(365) },
]

const PRIMARY_AGGREGATIONS: ReadonlyArray<MetricAggregation> = ['hour', 'date', 'week', 'month', 'total']
const ADVANCED_AGGREGATIONS: ReadonlyArray<MetricAggregation> = ['dow', 'dom', 'dofortnight']

// Known store dealer ids. Surface a chip-style multi-select instead of the
// free-form input that v1 shipped — operators know "Bronx" / "Midtown", not
// the underlying numeric dealer ids. The values are what the API expects in
// the `?sites=` query string.
//
// If a new store comes online, add it here and the chip strip picks it up.
const KNOWN_SITES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'bronx', label: 'Bronx' },
  { id: 'midtown', label: 'Midtown' },
]

// ---------------------------------------------------------------------------
// Tabs
//
// The dashboard is split into URL-addressable tabs (`/metrics/:tabId`) so that
// each tab can carry its own toolbar config — page-wide aggregation, page-wide
// stack mode — and so that controls that are meaningless for a tab (e.g.
// "aggregation" on a scatter tab) can be hidden rather than no-op. Tabs are
// declared client-side; each one filters the loaded metric list with its
// `include` predicate.
//
// Adding a tab is a one-liner here plus matching predicate.
// ---------------------------------------------------------------------------

export type MetricsTabId =
  | 'essentials'
  | 'sales'
  | 'inventory'
  | 'scatter'
  | 'catalog'
  | 'budtenders'
  | 'customer-value'
  | 'crm-segments'
  | 'crm-segment-analysis'
  | 'target'
  | 'time-of-day'
  | 'gads-bronx'
  | 'gads-midtown'
  | 'gads-all'

const DEFAULT_TAB_ID: MetricsTabId = 'essentials'

// GAds tabs are per-site. The typed registry maps each tab id to the route
// scope and ANY-of grant set so `gads-all` stays a true superset everywhere.
function gadsMetricScopeForTab(tabId: MetricsTabId): GadsMetricScope | null {
  return (
    (GADS_METRIC_SCOPE_BY_TAB_ID as Partial<Record<GadsMetricTabId | MetricsTabId, GadsMetricScope>>)[tabId] ?? null
  )
}

interface MetricsTab {
  readonly id: MetricsTabId
  readonly label: string
  readonly description: string
  readonly defaultAgg: MetricAggregation
  readonly defaultStackMode: MetricStackMode
  readonly showAggControl: boolean
  readonly showStackControl: boolean
  /** Predicate run against each loaded MetricDefSummary. */
  readonly include: (m: MetricDefSummary) => boolean
  /**
   * Per-user grant key required to see this tab. Mirrors the
   * server-side gate so a user without the relevant grant never
   * gets the tab in their navigation strip. Admins implicitly
   * hold every grant.
   */
  readonly grant: MetricGrantKey
  /**
   * Optional ANY-of grant set. When present, the tab is visible if the
   * user holds ANY of these grants (used by the GAds per-site tabs,
   * where `gads-all` is a superset that must also reveal the per-site
   * tabs). Defaults to `[grant]`.
   */
  readonly grantAnyOf?: ReadonlyArray<MetricGrantKey>
  /**
   * Admin-only tab: visible only to users with the `admin` role,
   * regardless of metric grants. Mirrors the server-side
   * `requireSessionUser(..., 'admin')` gate on the tab's endpoint.
   */
  readonly adminOnly?: boolean
}

/** Grant visibility for a tab: ANY-of when grantAnyOf is set, else the
 *  single `grant`. Mirrors the server endpoint gate so nav and API
 *  never drift. */
function userCanSeeMetricsTab(
  user: Parameters<typeof userHasMetricGrant>[0],
  tab: MetricsTab,
): boolean {
  if (tab.adminOnly && user?.role !== 'admin') return false
  return userHasAnyMetricGrant(user, tab.grantAnyOf ?? [tab.grant])
}

/** In-tab nav between the GAds sub-pages that actually render today.
 *  Reserved-but-unbuilt slugs still resolve to a coming-soon panel by
 *  direct URL, but they stay out of the primary nav until useful. */
function GAdsSubPageNav({
  tabId,
  activeSlug,
}: {
  tabId: MetricsTabId
  activeSlug: GadsSubPage
}): JSX.Element {
  return (
    <nav className="gads-subnav" aria-label="GAds sub-pages">
      {GADS_IMPLEMENTED_SUBPAGES.map((slug) => (
        <NavLink
          key={slug}
          to={`/metrics/${tabId}/${slug}`}
          className={slug === activeSlug ? 'gads-subnav-link is-active' : 'gads-subnav-link'}
          aria-current={slug === activeSlug ? 'page' : undefined}
        >
          {gadsSubPageLabel(slug)}
        </NavLink>
      ))}
    </nav>
  )
}

/**
 * Resolves the GAds `:subpage` URL segment to a rendered sub-page. Today
 * "landing-pages" and "evolution" render; a reserved-but-unbuilt slug
 * renders a coming-soon panel, and an unknown slug a not-found note
 * (never silently defaults to a different confidential page).
 */
function GAdsTabRouter({
  tabId,
  scope,
  subpage,
}: {
  tabId: MetricsTabId
  scope: GadsScope
  subpage: string | undefined
}): JSX.Element {
  const slug = (subpage ?? GADS_DEFAULT_SUBPAGE) as GadsSubPage
  if (GADS_IMPLEMENTED_SUBPAGES.includes(slug)) {
    return (
      <>
        <GAdsSubPageNav tabId={tabId} activeSlug={slug} />
        {slug === 'evolution' ? (
          <GAdsEvolutionTab scope={scope} />
        ) : (
          <GAdsLandingPagesTab scope={scope} />
        )}
      </>
    )
  }
  if (GADS_RESERVED_SUBPAGES.includes(slug)) {
    return (
      <>
        <GAdsSubPageNav tabId={tabId} activeSlug={slug} />
        <section className="gads-lp-tab">
          <p className="subtle-copy">
            The GAds &ldquo;{gadsSubPageLabel(slug)}&rdquo; sub-page is coming soon.
          </p>
        </section>
      </>
    )
  }
  return (
    <section className="gads-lp-tab">
      <p className="gads-lp-error">Unknown GAds sub-page: {subpage}.</p>
    </section>
  )
}

// Group-membership sets, scoped per tab. Anything outside these falls into
// the "sales" catch-all so a new metric doesn't go missing just because no
// tab claimed it yet — the operator will see it on the default tab and we
// can re-home it later by editing this map.
const GEOGRAPHY_GROUPS = new Set(['Customer origin', 'Delivery'])
const INVENTORY_GROUPS = new Set(['Inventory', 'Running low', 'Slow movers'])
// "Essentials" is a curated, top-of-house view of revenue / margin /
// customer-acquisition fundamentals. Membership is by metric id (not
// group) so we can pull select cards from across the registry. The
// Essentials cards ALSO render on the Sales & ops tab — they're meant
// to be the first thing the operator sees, but they're not removed
// from the deeper tab.
const ESSENTIALS_METRIC_IDS = new Set<string>([
  'essentials.gross_receipts',
  'essentials.gross_sales',
  'essentials.net_sales',
  'margins.gross_margin_dollars',
  'margins.effective_gm_pct',
  'acquisition.first_vs_returning',
  'basket.size_by_customer_type',
  // Gross margin $ split by new vs returning customer (local + far
  // combined), plus the region-segmented companion (new/return local
  // vs far) right alongside it.
  'margins.stack_new_vs_returning',
  'margins.stack_new_vs_returning_region',
])

const METRICS_TABS: ReadonlyArray<MetricsTab> = [
  {
    id: 'essentials',
    label: 'Essentials',
    description:
      'Top-of-house: gross sales / gross receipts / net sales / margin $ / effective GM%, plus new-vs-returning customer mix. Same cards also live in Sales & ops.',
    defaultAgg: 'week',
    defaultStackMode: 'none',
    showAggControl: true,
    showStackControl: true,
    include: (m) => ESSENTIALS_METRIC_IDS.has(m.id),
    grant: 'explore',
  },
  {
    id: 'sales',
    label: 'Sales & ops',
    description: 'Time-series of orders, margin, basket, payment mix, category distribution, cashier throughput.',
    defaultAgg: 'week',
    defaultStackMode: 'none',
    showAggControl: true,
    showStackControl: true,
    include: (m) =>
      m.chartType !== 'scatter' &&
      !GEOGRAPHY_GROUPS.has(m.group) &&
      !INVENTORY_GROUPS.has(m.group),
    grant: 'explore',
  },
  {
    id: 'inventory',
    label: 'Inventory',
    description:
      'Procurement workspace: reorder queue (out-now + runout-soon with recommended order qty), vendor baskets with distributor fulfillment context, exit / liquidate (deadweight capital), and mix drift (inventory $/unit vs sales/margin mix).',
    defaultAgg: 'date',
    defaultStackMode: 'none',
    // The inventory tab renders its OWN UI (see InventoryProcurementTab) —
    // one consolidated /api/inventory-procurement fetch drives all four
    // views, so the shared toolbar agg / stack / range controls don't
    // apply and the registry metric list is empty for this tab.
    showAggControl: false,
    showStackControl: false,
    include: () => false,
    grant: 'reordering',
  },
  {
    id: 'customer-value',
    label: 'Customer value',
    description:
      'Short- and long-term value of customers. Top grid shows the four mandatory LTV histograms (customer count by purchase number, basket-size escalation, lifetime $ by total purchases, revenue mix by purchase ordinal). Configurable metric basis (gross sales / margin $). Drives CAC / spend-to-convert / repeat-vs-tourist decisions.',
    defaultAgg: 'week',
    defaultStackMode: 'none',
    showAggControl: false,
    showStackControl: false,
    include: () => false,
    grant: 'explore',
  },
  {
    id: 'crm-segments',
    label: 'CRM Segments',
    description:
      'About a customer segment: cached membership, growth (entries/week), and how active / valuable / recent its members are, plus fulfillment mix. Pick a segment, site scope, and window. Companion to CRM Segment Analysis (segment-vs-rest comparison).',
    defaultAgg: 'week',
    defaultStackMode: 'none',
    // Owns its full UI (segment picker + sites/range + cards). No shared
    // toolbar or registry metrics.
    showAggControl: false,
    showStackControl: false,
    include: () => false,
    grant: 'explore',
  },
  {
    id: 'crm-segment-analysis',
    label: 'CRM Segment Analysis',
    description:
      'How a segment differs from the rest (everyone − segment): customer / sales share + value index, basket size, value-per-customer, repeat & discount rates, and fulfillment-channel affinity — each with lift/index and a significance badge (two-proportion z / Welch / BH-FDR). Margin & category affinity arrive with the fact rollups.',
    defaultAgg: 'week',
    defaultStackMode: 'none',
    showAggControl: false,
    showStackControl: false,
    include: () => false,
    grant: 'explore',
  },
  {
    id: 'budtenders',
    label: 'Budtender performance',
    description:
      'Per-cashier sales / discount / customer-mix / shift-productivity dashboard. Core sub-tab has KPIs + leaderboard + dollar-basket upsell lift + customer / fulfillment mix; Advanced sub-tab is a one-dot-per-cashier scatter with switchable axes, peer-percentile colour, and a highlight subset query. MISSING DATA cards mark per-product subset comparison, returns, drawer cash +/-, and cashier-attributed reviews until those sources are ingested.',
    defaultAgg: 'date',
    defaultStackMode: 'none',
    // Like the catalog tab, this tab owns its full UI (sites / range /
    // sub-tabs / cards) so the shared toolbar's agg / stack controls
    // don't apply.
    showAggControl: false,
    showStackControl: false,
    include: () => false,
    grant: 'staff',
  },
  {
    id: 'catalog',
    label: 'Catalog analytics',
    description:
      'Per-variant scatter suite over the catalog. Filter by category / subcategory / brand / size, then compare any pair of price / margin / GM% / velocity / THC% / cost / inventory metrics. Hover any dot for the underlying product.',
    defaultAgg: 'date',
    defaultStackMode: 'none',
    // The catalog tab renders its OWN UI (see CatalogAnalyticsTab) — the
    // shared toolbar agg / stack / range / site controls don't apply to
    // it. Tab-internal controls drive everything.
    showAggControl: false,
    showStackControl: false,
    // Catalog analytics doesn't pull from the time-series metric registry
    // at all. Returning `false` for every registry metric means the tab
    // renders an empty metric list and we short-circuit to the dedicated
    // CatalogAnalyticsTab below.
    include: () => false,
    grant: 'explore',
  },
  {
    id: 'target',
    label: 'Target tracking',
    description:
      'Break-even progress per period. Admins enter the business cost basis (fixed monthly costs + blended labour rate × weekly staffing); the page prorates that to each period and charts actual gross margin $ earned against the break-even target, with a pace projection for the current period.',
    defaultAgg: 'week',
    defaultStackMode: 'none',
    showAggControl: false,
    showStackControl: false,
    // Owns its full UI (see TargetTrackingTab); no registry metrics.
    include: () => false,
    grant: 'explore',
  },
  {
    id: 'time-of-day',
    label: 'Time of day',
    description:
      'Weekday × hour heatmap of order economics, for staffing / hours-of-operation decisions. Pick a money basis (default margin $) and an optional fulfillment slice; turn on the labor break-even model to enter a marginal staff-hour cost and see which weekday/hour blocks clear it. Admin-only; uses a manual labor cost (Helios scheduling/payroll data is not yet trusted).',
    defaultAgg: 'date',
    defaultStackMode: 'none',
    showAggControl: false,
    showStackControl: false,
    // Owns its full UI (see TimeOfDayTab); no registry metrics.
    include: () => false,
    grant: 'explore',
    adminOnly: true,
  },
  {
    id: 'scatter',
    label: 'Scatter analytics',
    description: 'Point-per-observation scatter plots (currently weather correlation; product-analytics scatter to follow).',
    // Scatter metrics don't bucket meaningfully across days; the dot grain
    // belongs to the metric (per-site, per-day). Default to `date` so the
    // server query picks one-dot-per-(site, day).
    defaultAgg: 'date',
    defaultStackMode: 'none',
    // The agg/stack controls have no useful effect on a scatter tab — what
    // would "weekly high temperature" mean for a scatter? — so we hide
    // both globally and per-chart.
    showAggControl: false,
    showStackControl: false,
    include: (m) => m.chartType === 'scatter',
    grant: 'explore',
  },
  // GAds (Google Ads) per-site analytics. Each tab owns its full UI
  // (GAdsLandingPagesTab) fed by one consolidated /api/gads/landing-pages
  // fetch — the shared toolbar (sites / agg / stack / range) does not
  // apply. Access is per-site: gads-bronx / gads-midtown reveal their
  // own tab, and the gads-all superset reveals all three (grantAnyOf,
  // sourced from requiredGadsGrants so nav matches the server gate).
  // First sub-page is "Landing pages"; future sub-pages (campaigns,
  // creative, keywords, policy-health, experiments, evolution,
  // iteration) are reserved in shared/domain/gadsSites.ts.
  {
    id: 'gads-bronx',
    label: GADS_METRIC_SCOPE_BY_TAB_ID['gads-bronx'].label,
    description:
      'Google Ads landing-page analytics for Bronx: assignment-cohort funnel (assigned → impressed → redirected → converted) and per-variant observed performance over the unified landing engine. Confidential.',
    defaultAgg: 'date',
    defaultStackMode: 'none',
    showAggControl: false,
    showStackControl: false,
    include: () => false,
    grant: 'gads-bronx',
    grantAnyOf: GADS_METRIC_SCOPE_BY_TAB_ID['gads-bronx'].grants,
  },
  {
    id: 'gads-midtown',
    label: GADS_METRIC_SCOPE_BY_TAB_ID['gads-midtown'].label,
    description:
      'Google Ads landing-page analytics for Midtown: assignment-cohort funnel (assigned → impressed → redirected → converted) and per-variant observed performance over the unified landing engine. Confidential.',
    defaultAgg: 'date',
    defaultStackMode: 'none',
    showAggControl: false,
    showStackControl: false,
    include: () => false,
    grant: 'gads-midtown',
    grantAnyOf: GADS_METRIC_SCOPE_BY_TAB_ID['gads-midtown'].grants,
  },
  {
    id: 'gads-all',
    label: GADS_METRIC_SCOPE_BY_TAB_ID['gads-all'].label,
    description:
      'Google Ads landing-page analytics across all sites: assignment-cohort funnel and per-variant observed performance over the unified landing engine. Confidential.',
    defaultAgg: 'date',
    defaultStackMode: 'none',
    showAggControl: false,
    showStackControl: false,
    include: () => false,
    grant: 'gads-all',
    grantAnyOf: GADS_METRIC_SCOPE_BY_TAB_ID['gads-all'].grants,
  },
]

const METRICS_TABS_BY_ID = new Map<MetricsTabId, MetricsTab>(METRICS_TABS.map((t) => [t.id, t]))

// IA-level aliases. The sidebar navigates to clean, intention-revealing
// URLs (`/metrics/staff`, `/metrics/reordering`) that map to existing
// tab content. Adding an alias here is the only thing required to
// surface a tab under a new URL — no router changes, no duplicated
// component wiring.
//
// Brand-index gets its own dedicated route in router.tsx and never
// resolves to a tab here.
const METRICS_TAB_ALIASES: Record<string, MetricsTabId> = {
  staff: 'budtenders',
  reordering: 'inventory',
}

function resolveExplicitTab(raw: string | undefined): MetricsTab | null {
  if (!raw) return null
  const aliased = METRICS_TAB_ALIASES[raw] ?? (raw as MetricsTabId)
  return METRICS_TABS_BY_ID.get(aliased) ?? null
}

function resolveTab(raw: string | undefined): MetricsTab {
  return resolveExplicitTab(raw) ?? METRICS_TABS_BY_ID.get(DEFAULT_TAB_ID)!
}

// ---------------------------------------------------------------------------
// Page-wide line-chart defaults (persisted via /api/metrics-defaults)
//
// The persisted blob stores, per tab id, the toolbar aggregation / stack
// mode / y-axis baseline. These helpers resolve an (untrusted) stored
// slice against the known enums — falling back to the code defaults for
// any missing / unknown value — so a stale DB blob can never break the
// page, and let the admin "Update defaults" flow capture + diff the
// current state.
// ---------------------------------------------------------------------------

/**
 * Code default Y-axis baseline. Operator direction (2026-06): every
 * line chart should pin its axis to include zero unless an admin saves
 * a different page-wide default. (Was 'per-chart' = float-to-data.)
 */
const CODE_DEFAULT_Y_BASELINE: YAxisBaselinePageDefault = 'zero'

const AGG_VALUE_SET = new Set<string>([...PRIMARY_AGGREGATIONS, ...ADVANCED_AGGREGATIONS])
const STACK_VALUE_SET = new Set<string>(METRIC_STACK_MODES)
const Y_BASELINE_VALUE_SET = new Set<string>(Y_AXIS_BASELINE_PAGE_DEFAULTS)

// Tabs whose toolbar exposes the agg / stack / y-axis line controls.
// These are the only tabs whose line defaults we capture / diff.
const LINE_CONTROL_TABS: ReadonlyArray<MetricsTab> = METRICS_TABS.filter(
  (t) => t.showAggControl || t.showStackControl,
)

interface ResolvedLineTabDefaults {
  readonly agg: MetricAggregation
  readonly stackMode: MetricStackMode
  readonly yBaseline: YAxisBaselinePageDefault
}

/** The code-baseline line defaults for a tab (used on reset + as fallback). */
function lineTabCodeDefaults(tab: MetricsTab): ResolvedLineTabDefaults {
  return {
    agg: tab.defaultAgg,
    stackMode: tab.defaultStackMode,
    yBaseline: CODE_DEFAULT_Y_BASELINE,
  }
}

/**
 * Resolve a tab's effective line defaults from the persisted blob,
 * falling back to the code defaults for any missing / unknown value.
 */
function resolveLineTabDefaults(
  stored: MetricsViewDefaults | null,
  tab: MetricsTab,
): ResolvedLineTabDefaults {
  const s = stored?.tabs?.[tab.id]
  const code = lineTabCodeDefaults(tab)
  return {
    agg: s?.agg && AGG_VALUE_SET.has(s.agg) ? (s.agg as MetricAggregation) : code.agg,
    stackMode:
      s?.stackMode && STACK_VALUE_SET.has(s.stackMode)
        ? (s.stackMode as MetricStackMode)
        : code.stackMode,
    yBaseline:
      s?.yBaseline && Y_BASELINE_VALUE_SET.has(s.yBaseline)
        ? (s.yBaseline as YAxisBaselinePageDefault)
        : code.yBaseline,
  }
}

/** Diff two resolved line-tab configs into labelled change rows. */
function lineTabChangeRows(
  tabLabel: string,
  before: ResolvedLineTabDefaults,
  after: ResolvedLineTabDefaults,
): MetricsDefaultsChange[] {
  const rows: MetricsDefaultsChange[] = []
  if (before.agg !== after.agg) {
    rows.push({ label: `${tabLabel} — aggregation`, before: before.agg, after: after.agg })
  }
  if (before.stackMode !== after.stackMode) {
    rows.push({
      label: `${tabLabel} — stack`,
      before: STACK_MODE_PAGE_LABEL[before.stackMode],
      after: STACK_MODE_PAGE_LABEL[after.stackMode],
    })
  }
  if (before.yBaseline !== after.yBaseline) {
    rows.push({
      label: `${tabLabel} — y-axis`,
      before: Y_AXIS_BASELINE_PAGE_DEFAULT_LABEL[before.yBaseline],
      after: Y_AXIS_BASELINE_PAGE_DEFAULT_LABEL[after.yBaseline],
    })
  }
  return rows
}

export interface MetricsLoaderData extends MetricListResponse {
  readonly metricsDefaults: {
    defaults: MetricsViewDefaults | null
    updatedBy: string | null
    updatedAt: string | null
  }
}

export async function metricsLoader(): Promise<MetricsLoaderData> {
  // Load the metric registry and the persisted page-wide defaults in
  // parallel. The defaults fetch tolerates failure (returns nulls) so a
  // missing migration / transient blip never blocks the metrics page.
  const [metrics, metricsDefaults] = await Promise.all([
    loadJson('/api/metrics', MetricListResponseSchema),
    loadMetricsDefaults(),
  ])
  return { ...metrics, metricsDefaults }
}

export function MetricsLayoutPage() {
  const { metrics, metricsDefaults: loadedDefaults } = useLoaderData() as MetricsLoaderData
  const { tabId, subpage } = useParams<{ tabId?: string; subpage?: string }>()
  // The root loader provides session — used to filter tabs by per-user
  // metric grant. Admins implicitly hold every grant.
  const session = useRouteLoaderData('root') as SessionEnvelope | undefined
  const user = session?.user ?? null

  // Tabs the user can see. The full set of tab definitions is static;
  // accessibility is dynamic. We compute `visibleTabs` once per render
  // and use it both for the nav strip and for "default tab" fallback
  // when the URL didn't pick one (or picked one the user lacks).
  const visibleTabs = useMemo(
    () => METRICS_TABS.filter((t) => userCanSeeMetricsTab(user, t)),
    [user],
  )

  const explicitTab = useMemo(() => resolveExplicitTab(tabId), [tabId])
  const requestedTab = useMemo(() => resolveTab(tabId), [tabId])
  const activeTab = useMemo(() => {
    // If the URL points at a tab the user can see, keep it.
    if (visibleTabs.some((t) => t.id === requestedTab.id)) return requestedTab
    // If the URL points at a known tab the user cannot see, keep that
    // tab active so the grant gate denies the requested confidential
    // surface instead of silently showing some other tab under this URL.
    if (explicitTab) return requestedTab
    // Otherwise fall back to the first accessible tab (or the
    // requested one if NONE are accessible — the access-denied
    // page below will be rendered in that case).
    return visibleTabs[0] ?? requestedTab
  }, [explicitTab, requestedTab, visibleTabs])

  // Site filter: empty Set = all sites. Multi-select against KNOWN_SITES.
  const [selectedSites, setSelectedSites] = useState<ReadonlySet<string>>(() => defaultSiteSelection())
  const sitesParam = useMemo(() => Array.from(selectedSites).join(','), [selectedSites])

  // Shared catalog-scope filter selection (category / subcategory /
  // brand / size). Lifted here so the same compact dropdown-chip UX
  // can drive the catalog, sales, and inventory tabs — the chip bar
  // is rendered by DashboardControls on tabs that have at least one
  // metric declaring supportedCatalogFilters, and by CatalogAnalyticsTab
  // on its own. The selection persists across tab switches.
  const [catalogFilterSelection, setCatalogFilterSelection] = useState<CatalogFilterSelection>(
    emptyCatalogFilterSelection,
  )
  const catalogFilterCallbacks = useMemo(
    () => ({
      onCategoryToggle: (id: string) =>
        setCatalogFilterSelection((prev) => ({ ...prev, categoryIds: toggleInSet(prev.categoryIds, id) })),
      onSubcategoryToggle: (id: string) =>
        setCatalogFilterSelection((prev) => ({ ...prev, subcategoryIds: toggleInSet(prev.subcategoryIds, id) })),
      onBrandToggle: (id: string) =>
        setCatalogFilterSelection((prev) => ({ ...prev, brandIds: toggleInSet(prev.brandIds, id) })),
      onSizeToggle: (id: string) =>
        setCatalogFilterSelection((prev) => ({ ...prev, sizes: toggleInSet(prev.sizes, id) })),
      onClearAll: () => setCatalogFilterSelection(emptyCatalogFilterSelection()),
    }),
    [],
  )

  // Fetch /api/catalog-analytics/filters whenever sites or the
  // selection itself changes (the endpoint narrows option lists
  // cumulatively against the OTHER dimensions). Used by both the
  // catalog tab and the shared filter bar in DashboardControls.
  const [catalogFilters, setCatalogFilters] = useState<CatalogAnalyticsFiltersResponse | null>(null)
  const [loadingCatalogFilters, setLoadingCatalogFilters] = useState(false)
  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams()
    if (sitesParam) params.set('sites', sitesParam)
    if (catalogFilterSelection.categoryIds.size > 0)
      params.set('categoryIds', Array.from(catalogFilterSelection.categoryIds).join(','))
    if (catalogFilterSelection.subcategoryIds.size > 0)
      params.set('subcategoryIds', Array.from(catalogFilterSelection.subcategoryIds).join(','))
    if (catalogFilterSelection.brandIds.size > 0)
      params.set('brandIds', Array.from(catalogFilterSelection.brandIds).join(','))
    if (catalogFilterSelection.sizes.size > 0)
      params.set('sizes', Array.from(catalogFilterSelection.sizes).join(','))
    const qs = params.toString()
    const url = `/api/catalog-analytics/filters${qs ? `?${qs}` : ''}`
    setLoadingCatalogFilters(true)
    loadJson(url, CatalogAnalyticsFiltersResponseSchema)
      .then((r) => {
        if (!cancelled) setCatalogFilters(r)
      })
      .catch(() => {
        if (!cancelled) setCatalogFilters(null)
      })
      .finally(() => {
        if (!cancelled) setLoadingCatalogFilters(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    sitesParam,
    catalogFilterSelection.categoryIds,
    catalogFilterSelection.subcategoryIds,
    catalogFilterSelection.brandIds,
    catalogFilterSelection.sizes,
  ])

  // Tab-scoped toolbar config. Each tab remembers its own aggregation +
  // stack-mode independently so switching tabs doesn't trample the operator's
  // preferences on the previous one. Defaults come from the tab definition.
  // Hydrate each tab's toolbar config from the persisted page-wide
  // defaults (loaded synchronously by the route loader, so no flash),
  // falling back to the tab's code defaults for anything unset. The
  // y-axis code default is now 'include zero' (CODE_DEFAULT_Y_BASELINE).
  const storedDefaults = loadedDefaults.defaults
  const [aggByTab, setAggByTab] = useState<Record<MetricsTabId, MetricAggregation>>(() =>
    Object.fromEntries(
      METRICS_TABS.map((t) => [t.id, resolveLineTabDefaults(storedDefaults, t).agg]),
    ) as Record<MetricsTabId, MetricAggregation>,
  )
  const [stackByTab, setStackByTab] = useState<Record<MetricsTabId, MetricStackMode>>(() =>
    Object.fromEntries(
      METRICS_TABS.map((t) => [t.id, resolveLineTabDefaults(storedDefaults, t).stackMode]),
    ) as Record<MetricsTabId, MetricStackMode>,
  )
  // Page-wide Y-axis baseline default, tab-scoped like agg / stack.
  const [yBaselineByTab, setYBaselineByTab] = useState<
    Record<MetricsTabId, YAxisBaselinePageDefault>
  >(() =>
    Object.fromEntries(
      METRICS_TABS.map((t) => [t.id, resolveLineTabDefaults(storedDefaults, t).yBaseline]),
    ) as Record<MetricsTabId, YAxisBaselinePageDefault>,
  )
  const pageAgg = aggByTab[activeTab.id]
  const pageStackMode = stackByTab[activeTab.id]
  const pageYBaseline = yBaselineByTab[activeTab.id]
  const setPageAgg = useCallback(
    (next: MetricAggregation) => setAggByTab((prev) => ({ ...prev, [activeTab.id]: next })),
    [activeTab.id],
  )
  const setPageStackMode = useCallback(
    (next: MetricStackMode) => setStackByTab((prev) => ({ ...prev, [activeTab.id]: next })),
    [activeTab.id],
  )
  const setPageYBaseline = useCallback(
    (next: YAxisBaselinePageDefault) =>
      setYBaselineByTab((prev) => ({ ...prev, [activeTab.id]: next })),
    [activeTab.id],
  )
  // 90d default window matching the parent epic spec. The right edge
  // extends to the END of the current bucket (for the landing tab's
  // default aggregation) so the rightmost pace-extrapolated knot is
  // visible on first paint instead of one bucket-width off-screen.
  const [initialWindow] = useState<TimeWindow>(() => ({
    fromMs: Date.now() - 90 * DAY_MS,
    toMs: defaultWindowRightEdge(pageAgg),
  }))

  // Missing-data metrics (spec'd but not yet wired to real data) are hidden
  // by default so the dashboard reads as "what we actually know". Operator
  // can opt in via the coverage badge toggle to see what's still pending
  // ingest plumbing.
  const [showMissing, setShowMissing] = useState(false)

  // Annotations are fetched ONCE at the dashboard level and handed to every
  // card. A global annotation creates an event indicator on every chart at
  // its timestamp.
  const [annotations, setAnnotations] = useState<MetricAnnotationRecord[]>([])
  const [annotationsSeq, setAnnotationsSeq] = useState(0)
  useEffect(() => {
    let cancelled = false
    loadJson('/api/metric-annotations', MetricAnnotationsListResponseSchema)
      .then((r) => {
        if (!cancelled) setAnnotations(r.annotations)
      })
      .catch(() => {
        if (!cancelled) setAnnotations([])
      })
    return () => {
      cancelled = true
    }
  }, [annotationsSeq])
  const onAnnotationsChanged = useCallback(() => setAnnotationsSeq((n) => n + 1), [])

  // Click-to-expand focus panel: at most one expanded metric at a time.
  const [expandedMetricId, setExpandedMetricId] = useState<string | null>(null)
  const focusPanelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!expandedMetricId) return
    // Scroll the focus panel into view on expand. requestAnimationFrame
    // lets the layout settle first so getBoundingClientRect is correct.
    const raf = requestAnimationFrame(() => {
      focusPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    return () => cancelAnimationFrame(raf)
  }, [expandedMetricId])
  // Escape closes the focus panel.
  useEffect(() => {
    if (!expandedMetricId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpandedMetricId(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [expandedMetricId])
  // Close any focused metric when the operator switches tabs — the focused
  // metric usually belongs to the previous tab, and re-opening on the new
  // tab takes one click.
  useEffect(() => {
    setExpandedMetricId(null)
  }, [activeTab.id])

  // Filter the loaded metric list down to what THIS tab claims, BEFORE
  // partitioning into real/missing and grouping. That way the coverage
  // badge ("2 live, 1 missing") and the group list both reflect just this
  // tab's slice.
  const tabMetrics = useMemo(() => metrics.filter(activeTab.include), [metrics, activeTab])
  const hasRegistryMetrics = tabMetrics.length > 0

  const expandedMetric = useMemo(
    () => tabMetrics.find((m) => m.id === expandedMetricId) ?? null,
    [tabMetrics, expandedMetricId],
  )

  // Partition metrics by data status and group.
  const partitioned = useMemo(() => partitionMetrics(tabMetrics), [tabMetrics])
  const realGroups = useMemo(() => groupByMetricGroup(partitioned.real), [partitioned.real])
  const missingGroups = useMemo(() => groupByMetricGroup(partitioned.missing), [partitioned.missing])

  // The page-level gate: at least one of the SUPPORTED grant keys
  // (any tab's grant) must be held. If not, render the standard
  // access-denied component instead of the dashboard chrome. The
  // gate ALSO trips on a per-tab basis below — even with `explore`
  // a user landing on /metrics/staff sees the staff-restricted
  // page until they're granted 'staff' too.
  const pageGrant = activeTab.grant
  const pageGrants = activeTab.grantAnyOf ?? [pageGrant]
  const activeGadsScope = gadsMetricScopeForTab(activeTab.id)
  const isAdmin = user?.role === 'admin'
  return (
    <MetricsDefaultsProvider
      initialStored={loadedDefaults.defaults}
      initialUpdatedBy={loadedDefaults.updatedBy}
      initialUpdatedAt={loadedDefaults.updatedAt}
      isAdmin={isAdmin}
    >
    <MetricsAccessGate
      anyOf={pageGrants}
      requiredRole={activeTab.adminOnly ? 'admin' : undefined}
      surfaceLabel={activeTab.label}
      showGrantHint={!activeGadsScope && !activeTab.adminOnly}
    >
      <TimeAxisProvider initial={initialWindow}>
        <section className="metrics-dashboard">
          <header className="page-header metrics-dashboard-header">
            <div>
              <p className="eyebrow">Business &amp; Performance Metrics</p>
              <h2>Dashboard</h2>
            </div>
            <div className="metrics-dashboard-header-actions">
              <MetricsDefaultsAdminControls
                lineState={{ aggByTab, stackByTab, yBaselineByTab }}
              />
              {hasRegistryMetrics && (
                <DataCoverageBadge
                  realCount={partitioned.real.length}
                  missingCount={partitioned.missing.length}
                  showMissing={showMissing}
                  onToggleShowMissing={setShowMissing}
                />
              )}
            </div>
          </header>

          <MetricsTabsNav activeTabId={activeTab.id} visibleTabs={visibleTabs} />

        {/* Essentials top-of-tab "today" summary banner — sticky on
            desktop, collapsable on mobile. Polls every ~90s. Render
            only on the essentials tab (the metric registry on the
            other tabs has no equivalent same-day-summary contract). */}
        {activeTab.id === 'essentials' ? <EssentialsDailySummaryBanner /> : null}

        {activeGadsScope ? (
          // GAds per-site landing-page analytics. Owns its full UI, fed
          // by one /api/gads/landing-pages fetch. The tab id encodes the
          // site scope; the :subpage segment selects the sub-page (V1
          // implements only "landing-pages"; reserved slugs render a
          // coming-soon panel, unknown slugs a not-found note).
          <GAdsTabRouter tabId={activeTab.id} scope={activeGadsScope.scope} subpage={subpage} />
        ) : activeTab.id === 'catalog' ? (
          // Catalog analytics has its own filter bar + scatter grid and does
          // not share the time-series toolbar (sites / agg / stack / range).
          // Short-circuit the rest of the dashboard render here.
          <CatalogAnalyticsTab />
        ) : activeTab.id === 'budtenders' ? (
          // Budtender performance has its own sites/range/sub-tabs UI
          // and a single consolidated /api/budtender-analytics fetch.
          // Same short-circuit pattern as catalog.
          <BudtenderPerformanceTab />
        ) : activeTab.id === 'customer-value' ? (
          <CustomerValueTab />
        ) : activeTab.id === 'crm-segments' ? (
          // CRM Segments owns its full UI (segment picker + sites/range +
          // about-the-segment cards). Single consolidated fetch; no shared
          // toolbar. Same short-circuit pattern as the other bespoke tabs.
          <CrmSegmentsTab />
        ) : activeTab.id === 'crm-segment-analysis' ? (
          // CRM Segment Analysis owns its full UI (picker + sites/range +
          // comparison cards/tables). Single consolidated fetch.
          <CrmSegmentAnalysisTab />
        ) : activeTab.id === 'target' ? (
          // Target tracking owns its full UI (cost config + break-even
          // gauge + per-period bar chart). No shared toolbar.
          <TargetTrackingTab isAdmin={isAdmin} />
        ) : activeTab.id === 'time-of-day' ? (
          // Time of day owns its full UI (weekday × hour heatmap +
          // basis/slice/labor controls). Admin-only; single consolidated
          // /api/time-of-day-analytics fetch. Same short-circuit pattern.
          <TimeOfDayTab />
        ) : activeTab.id === 'inventory' ? (
          // Inventory / Reordering: a bespoke procurement workspace
          // (reorder queue / vendor baskets / exit-liquidate / mix
          // drift) backed by one consolidated /api/inventory-procurement
          // fetch. Owns its full UI; the shared toolbar doesn't apply.
          <InventoryProcurementTab />
        ) : (
          <RegistryDashboard
            activeTab={activeTab}
            selectedSites={selectedSites}
            setSelectedSites={setSelectedSites}
            pageAgg={pageAgg}
            setPageAgg={setPageAgg}
            pageStackMode={pageStackMode}
            setPageStackMode={setPageStackMode}
            pageYBaseline={pageYBaseline}
            setPageYBaseline={setPageYBaseline}
            partitioned={partitioned}
            realGroups={realGroups}
            missingGroups={missingGroups}
            sitesParam={sitesParam}
            annotations={annotations}
            onAnnotationsChanged={onAnnotationsChanged}
            expandedMetric={expandedMetric}
            expandedMetricId={expandedMetricId}
            setExpandedMetricId={setExpandedMetricId}
            focusPanelRef={focusPanelRef}
            showMissing={showMissing}
            catalogFilters={catalogFilters}
            loadingCatalogFilters={loadingCatalogFilters}
            catalogFilterSelection={catalogFilterSelection}
            catalogFilterCallbacks={catalogFilterCallbacks}
          />
        )}

        <details className="page-collapsible metrics-help-collapsible">
          <summary>How this dashboard works</summary>
          <ul className="subtle-copy">
            <li>All cards share one time axis (the range picker above). Click any card to open a focus panel with pan / zoom / annotate.</li>
            <li>In the focus panel, use the 🔒/🔓 button to unlock that chart from the shared axis, then pan/zoom independently.</li>
            <li>Hover any chart for a per-timestamp readout; other charts dim a crosshair at the same moment so you can compare.</li>
            <li>Annotations created with scope <em>global</em> appear as event indicators on every chart at their timestamp.</li>
            <li>Site filter: leave all chips off for an all-sites view, or pick one or more stores.</li>
            <li>The <strong>Catalog analytics</strong> tab is its own filterable scatter suite with per-variant performance metrics — independent of the time-series tabs.</li>
          </ul>
          </details>
        </section>
      </TimeAxisProvider>
    </MetricsAccessGate>
    </MetricsDefaultsProvider>
  )
}

// ---------------------------------------------------------------------------
// Admin "Update defaults" / "Reset defaults" controls
//
// Rendered inside MetricsDefaultsProvider. Visible only to admins. Captures
// the CURRENT page-wide toolbar config (line-chart tab agg / stack / y-axis
// where the page owns it, plus the shared scatter colour / size / opacity)
// and persists it as the new global default, or drops the override to fall
// back to code defaults. Both flows confirm via a diff modal.
//
// `lineState` is present on the main /metrics dashboard (which owns the
// line-chart tab state). On pages that only embed the scatter (brand /
// distributor detail) it is omitted: an Update there captures the current
// scatter encodings while PRESERVING the stored line-tab defaults, and a
// Reset still clears everything (the diff is computed from the stored blob).
// ---------------------------------------------------------------------------

interface MetricsDefaultsAdminControlsProps {
  readonly lineState?: {
    readonly aggByTab: Record<MetricsTabId, MetricAggregation>
    readonly stackByTab: Record<MetricsTabId, MetricStackMode>
    readonly yBaselineByTab: Record<MetricsTabId, YAxisBaselinePageDefault>
  }
}

export function MetricsDefaultsAdminControls({ lineState }: MetricsDefaultsAdminControlsProps) {
  const ctx = useMetricsDefaults()
  const [mode, setMode] = useState<'update' | 'reset' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!ctx || !ctx.isAdmin) return null

  const stored = ctx.stored

  // Capture the current view into a full defaults blob (used by Update).
  const buildCaptured = (): MetricsViewDefaults => {
    // Line tabs: capture from live state where the page owns it,
    // otherwise preserve whatever is already stored so a scatter-only
    // page doesn't wipe the line defaults.
    const tabs: Record<string, MetricsTabDefaults> = {}
    if (lineState) {
      for (const t of LINE_CONTROL_TABS) {
        tabs[t.id] = {
          agg: lineState.aggByTab[t.id],
          stackMode: lineState.stackByTab[t.id],
          yBaseline: lineState.yBaselineByTab[t.id],
        }
      }
    } else if (stored?.tabs) {
      for (const [k, v] of Object.entries(stored.tabs)) tabs[k] = v
    }
    // Scatter: prefer the live snapshot (set when a scatter is mounted),
    // else preserve the resolved stored encodings.
    const snap = ctx.getScatterSnapshot()
    const scatter = snap ?? resolveScatterDefaults(stored?.scatter)
    return {
      version: 1,
      tabs,
      scatter: {
        colourBy: scatter.colourBy,
        sizeBy: scatter.sizeBy,
        opacityBy: scatter.opacityBy,
      },
    }
  }

  // Diff rows for the modal, depending on the active flow.
  const computeChanges = (): MetricsDefaultsChange[] => {
    const rows: MetricsDefaultsChange[] = []
    if (mode === 'update') {
      const captured = buildCaptured()
      if (lineState) {
        for (const t of LINE_CONTROL_TABS) {
          rows.push(
            ...lineTabChangeRows(
              t.label,
              resolveLineTabDefaults(stored, t),
              resolveLineTabDefaults(captured, t),
            ),
          )
        }
      }
      rows.push(
        ...scatterChangeRows(
          resolveScatterDefaults(stored?.scatter),
          resolveScatterDefaults(captured.scatter),
        ),
      )
    } else if (mode === 'reset') {
      // Reset drops the whole override → everything reverts to code
      // defaults. Diff the resolved stored config against code defaults.
      for (const t of LINE_CONTROL_TABS) {
        rows.push(
          ...lineTabChangeRows(
            t.label,
            resolveLineTabDefaults(stored, t),
            lineTabCodeDefaults(t),
          ),
        )
      }
      rows.push(
        ...scatterChangeRows(resolveScatterDefaults(stored?.scatter), SCATTER_CODE_DEFAULTS),
      )
    }
    return rows
  }

  const onConfirm = async () => {
    setBusy(true)
    setError(null)
    try {
      if (mode === 'update') await ctx.saveDefaults(buildCaptured())
      else if (mode === 'reset') await ctx.resetDefaults()
      setMode(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const onCancel = () => {
    if (busy) return
    setMode(null)
    setError(null)
  }

  return (
    <div className="metrics-defaults-admin">
      <button
        type="button"
        className="ghost-button metrics-defaults-admin-btn"
        onClick={() => {
          setError(null)
          setMode('update')
        }}
        title="Save the current page-wide chart configuration as the default for everyone."
      >
        Update defaults
      </button>
      <button
        type="button"
        className="ghost-button metrics-defaults-admin-btn"
        onClick={() => {
          setError(null)
          setMode('reset')
        }}
        title="Clear the saved page-wide defaults and revert to the built-in code defaults."
      >
        Reset defaults
      </button>
      {ctx.updatedBy ? (
        <span className="subtle-copy metrics-defaults-admin-meta">
          defaults set by {ctx.updatedBy}
          {ctx.updatedAt ? ` · ${new Date(ctx.updatedAt).toLocaleDateString()}` : ''}
        </span>
      ) : null}
      {mode ? (
        <MetricsDefaultsModal
          title={mode === 'update' ? 'Update page-wide defaults' : 'Reset page-wide defaults'}
          intro={
            mode === 'update'
              ? 'Save the current chart configuration as the page-wide default for every metrics viewer. This replaces the previously-saved defaults.'
              : 'Clear the saved page-wide defaults so every metrics page falls back to the built-in code defaults.'
          }
          changes={computeChanges()}
          confirmLabel={mode === 'update' ? 'Save defaults' : 'Reset to code defaults'}
          busy={busy}
          error={error}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      ) : null}
    </div>
  )
}

interface RegistryDashboardProps {
  activeTab: MetricsTab
  selectedSites: ReadonlySet<string>
  setSelectedSites: (next: ReadonlySet<string>) => void
  pageAgg: MetricAggregation
  setPageAgg: (next: MetricAggregation) => void
  pageStackMode: MetricStackMode
  setPageStackMode: (next: MetricStackMode) => void
  pageYBaseline: YAxisBaselinePageDefault
  setPageYBaseline: (next: YAxisBaselinePageDefault) => void
  partitioned: PartitionedMetrics
  realGroups: Array<{ group: string; metrics: MetricDefSummary[] }>
  missingGroups: Array<{ group: string; metrics: MetricDefSummary[] }>
  sitesParam: string
  annotations: ReadonlyArray<MetricAnnotationRecord>
  onAnnotationsChanged: () => void
  expandedMetric: MetricDefSummary | null
  expandedMetricId: string | null
  setExpandedMetricId: (id: string | null) => void
  focusPanelRef: React.MutableRefObject<HTMLDivElement | null>
  showMissing: boolean
  catalogFilters: CatalogAnalyticsFiltersResponse | null
  loadingCatalogFilters: boolean
  catalogFilterSelection: CatalogFilterSelection
  catalogFilterCallbacks: {
    readonly onCategoryToggle: (id: string) => void
    readonly onSubcategoryToggle: (id: string) => void
    readonly onBrandToggle: (id: string) => void
    readonly onSizeToggle: (id: string) => void
    readonly onClearAll: () => void
  }
}

function RegistryDashboard({
  activeTab,
  selectedSites,
  setSelectedSites,
  pageAgg,
  setPageAgg,
  pageStackMode,
  setPageStackMode,
  pageYBaseline,
  setPageYBaseline,
  partitioned,
  realGroups,
  missingGroups,
  sitesParam,
  annotations,
  onAnnotationsChanged,
  expandedMetric,
  expandedMetricId,
  setExpandedMetricId,
  focusPanelRef,
  showMissing,
  catalogFilters,
  loadingCatalogFilters,
  catalogFilterSelection,
  catalogFilterCallbacks,
}: RegistryDashboardProps) {
  // The union of dimensions supported by any visible live metric. If
  // empty (e.g. weather scatter tab today), we omit the filter bar
  // entirely rather than showing chips no card can honor.
  const supportedDimensions = useMemo<ReadonlyArray<MetricCatalogFilterDimension>>(() => {
    const set = new Set<MetricCatalogFilterDimension>()
    for (const m of partitioned.real) {
      for (const d of m.supportedCatalogFilters) set.add(d)
    }
    return ['category', 'subcategory', 'brand', 'size'].filter((d) =>
      set.has(d as MetricCatalogFilterDimension),
    ) as MetricCatalogFilterDimension[]
  }, [partitioned.real])
  return (
    <>
      <DashboardControls
        selectedSites={selectedSites}
        onSitesChange={setSelectedSites}
        pageAgg={pageAgg}
        onAggChange={setPageAgg}
        pageStackMode={pageStackMode}
        onStackModeChange={setPageStackMode}
        pageYBaseline={pageYBaseline}
        onYBaselineChange={setPageYBaseline}
        showAggControl={activeTab.showAggControl}
        showStackControl={activeTab.showStackControl}
        catalogFilters={catalogFilters}
        loadingCatalogFilters={loadingCatalogFilters}
        catalogFilterSelection={catalogFilterSelection}
        catalogFilterCallbacks={catalogFilterCallbacks}
        catalogFilterDimensions={supportedDimensions}
      />

      {expandedMetric ? (
        <div className="metrics-focus-panel" ref={focusPanelRef}>
          <div className="metrics-focus-panel-toolbar">
            <span className="subtle-copy">Focus:</span>
            <strong>
              {expandedMetric.group} — {expandedMetric.title}
            </strong>
            <button
              type="button"
              className="ghost-button"
              onClick={() => setExpandedMetricId(null)}
              aria-label="Close focus panel"
            >
              ✕ close
            </button>
          </div>
          <MetricChart
            key={`focus-${expandedMetric.id}`}
            metric={expandedMetric}
            sitesParam={sitesParam}
            defaultAgg={pageAgg}
            defaultStackMode={pageStackMode}
            yBaselineDefault={pageYBaseline}
            annotations={annotations}
            onAnnotationsChanged={onAnnotationsChanged}
            variant="expanded"
            catalogFilterSelection={catalogFilterSelection}
          />
        </div>
      ) : null}

      {realGroups.length === 0 ? (
        <p className="subtle-copy">
          No live metrics on this tab yet. {activeTab.description}
        </p>
      ) : (
        realGroups.map((g) => (
          <MetricGroupSection
            key={`live-${g.group}`}
            group={g.group}
            metrics={g.metrics}
            sitesParam={sitesParam}
            pageAgg={pageAgg}
            pageStackMode={pageStackMode}
            pageYBaseline={pageYBaseline}
            annotations={annotations}
            onAnnotationsChanged={onAnnotationsChanged}
            expandedMetricId={expandedMetricId}
            onExpand={setExpandedMetricId}
            catalogFilterSelection={catalogFilterSelection}
          />
        ))
      )}

      {missingGroups.length > 0 ? (
        <details className="metrics-pending-section" open={showMissing}>
          <summary>
            <span className="metrics-section-title">Missing data</span>{' '}
            <span className="subtle-copy">
              ({partitioned.missing.length} metric{partitioned.missing.length === 1 ? '' : 's'} awaiting ingest)
            </span>
          </summary>
          <p className="subtle-copy metrics-pending-explainer">
            These metrics are part of the spec but their data sources aren't wired up yet — we deliberately do{' '}
            <strong>not</strong> render synthetic values for them. Each card shows the metric's real definition
            and a link to the ingest issue tracking the unblock work.
          </p>
          {missingGroups.map((g) => (
            <MissingGroupSection key={`missing-${g.group}`} group={g.group} metrics={g.metrics} />
          ))}
        </details>
      ) : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// Dashboard chrome
// ---------------------------------------------------------------------------

interface DataCoverageBadgeProps {
  readonly realCount: number
  readonly missingCount: number
  readonly showMissing: boolean
  readonly onToggleShowMissing: (v: boolean) => void
}

function DataCoverageBadge({ realCount, missingCount, showMissing, onToggleShowMissing }: DataCoverageBadgeProps) {
  return (
    <div className="metrics-coverage-badge">
      <span className="metrics-coverage-chip metrics-coverage-chip--real">{realCount} live</span>
      <span
        className="metrics-coverage-chip metrics-coverage-chip--pending"
        title={missingCount === 0 ? 'No metrics are missing data' : 'Toggle below to show missing-data metrics'}
      >
        {missingCount} missing
      </span>
      {missingCount > 0 ? (
        <label className="metrics-coverage-toggle subtle-copy">
          <input type="checkbox" checked={showMissing} onChange={(e) => onToggleShowMissing(e.target.checked)} />{' '}
          show missing
        </label>
      ) : null}
    </div>
  )
}

interface DashboardControlsProps {
  readonly selectedSites: ReadonlySet<string>
  readonly onSitesChange: (next: ReadonlySet<string>) => void
  readonly pageAgg: MetricAggregation
  readonly onAggChange: (next: MetricAggregation) => void
  readonly pageStackMode: MetricStackMode
  readonly onStackModeChange: (next: MetricStackMode) => void
  readonly pageYBaseline: YAxisBaselinePageDefault
  readonly onYBaselineChange: (next: YAxisBaselinePageDefault) => void
  /** When false the aggregation dropdown is hidden (scatter tabs etc.). */
  readonly showAggControl: boolean
  /** When false the stack-mode dropdown is hidden (scatter tabs etc.). */
  readonly showStackControl: boolean
  readonly catalogFilters: CatalogAnalyticsFiltersResponse | null
  readonly loadingCatalogFilters: boolean
  readonly catalogFilterSelection: CatalogFilterSelection
  readonly catalogFilterCallbacks: {
    readonly onCategoryToggle: (id: string) => void
    readonly onSubcategoryToggle: (id: string) => void
    readonly onBrandToggle: (id: string) => void
    readonly onSizeToggle: (id: string) => void
    readonly onClearAll: () => void
  }
  /**
   * Empty = hide the catalog filter chip bar entirely (no visible
   * metric on this tab declares any supportedCatalogFilters).
   */
  readonly catalogFilterDimensions: ReadonlyArray<MetricCatalogFilterDimension>
}

const STACK_MODE_PAGE_LABEL: Record<MetricStackMode, string> = {
  none: 'off (lines)',
  stacked: 'stacked',
  percent: '100% (share)',
}

function DashboardControls({
  selectedSites,
  onSitesChange,
  pageAgg,
  onAggChange,
  pageStackMode,
  onStackModeChange,
  pageYBaseline,
  onYBaselineChange,
  showAggControl,
  showStackControl,
  catalogFilters,
  loadingCatalogFilters,
  catalogFilterSelection,
  catalogFilterCallbacks,
  catalogFilterDimensions,
}: DashboardControlsProps) {
  const axis = useTimeAxis()
  const rangePresets = useMemo<ReadonlyArray<MetricRangePresetOption>>(
    () =>
      PRESETS.map((p) => {
        const effectiveAgg = p.agg ?? pageAgg
        const target = p.range(Date.now(), effectiveAgg)
        const active =
          Math.abs(axis.window.toMs - target.toMs) < DAY_MS &&
          Math.abs(axis.window.fromMs - target.fromMs) < DAY_MS &&
          (p.agg === undefined || pageAgg === p.agg)
        return {
          label: p.label,
          active,
          onSelect: () => {
            if (p.agg !== undefined && p.agg !== pageAgg) onAggChange(p.agg)
            axis.setWindow(p.range(Date.now(), p.agg ?? pageAgg))
          },
        }
      }),
    [axis, pageAgg, onAggChange],
  )
  return (
    <div className="metrics-controls">
      <div className="metrics-control-group">
        <span className="subtle-copy">sites</span>
        <button
          type="button"
          className={selectedSites.size === 0 ? 'metrics-site-chip is-active' : 'metrics-site-chip'}
          onClick={() => onSitesChange(new Set())}
          aria-pressed={selectedSites.size === 0}
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
              onClick={() => onSitesChange(toggleSiteSelection(selectedSites, s.id, KNOWN_SITES.length))}
              aria-pressed={active}
            >
              {s.label}
            </button>
          )
        })}
      </div>

      {catalogFilterDimensions.length > 0 ? (
        <div className="metrics-control-group">
          <span
            className="subtle-copy"
            title="Narrow time-series cards by catalog category / subcategory / brand / size. Cards whose query supports these filters re-fetch with the narrowed scope; cards that don't show a 'filters not applied' badge."
          >
            catalog
          </span>
          <CatalogFilterBar
            filters={catalogFilters}
            loading={loadingCatalogFilters}
            selection={catalogFilterSelection}
            callbacks={catalogFilterCallbacks}
            dimensions={catalogFilterDimensions}
          />
        </div>
      ) : null}

      {showAggControl || showStackControl ? (
        <div className="metrics-control-group">
          {showAggControl ? (
            <label>
              aggregation{' '}
              <select
                value={pageAgg}
                onChange={(e) => onAggChange(e.target.value as MetricAggregation)}
              >
                {PRIMARY_AGGREGATIONS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
                <optgroup label="advanced">
                  {ADVANCED_AGGREGATIONS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
          ) : null}
          {showStackControl ? (
            <label
              title="Stack multi-series line charts as cumulative bands, or normalise each bucket to 100% so series read as a share-of-whole."
            >
              stack{' '}
              <select
                value={pageStackMode}
                onChange={(e) => onStackModeChange(e.target.value as MetricStackMode)}
              >
                {METRIC_STACK_MODES.map((m) => (
                  <option key={m} value={m}>
                    {STACK_MODE_PAGE_LABEL[m]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label
            title="Default Y-axis baseline for the line charts on this tab. 'include zero' pins every chart's axis to the zero line; 'data range' floats to the observed values; 'per-chart' imposes no page-wide policy (each chart's own setting decides, floating by default). Individual charts can override this in their focus panel."
          >
            y-axis{' '}
            <select
              value={pageYBaseline}
              onChange={(e) =>
                onYBaselineChange(e.target.value as YAxisBaselinePageDefault)
              }
            >
              {Y_AXIS_BASELINE_PAGE_DEFAULTS.map((b) => (
                <option key={b} value={b}>
                  {Y_AXIS_BASELINE_PAGE_DEFAULT_LABEL[b]}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      <MetricRangeControls
        presets={rangePresets}
        range={{ fromMs: axis.window.fromMs, toMs: axis.window.toMs }}
        setRange={(next) => axis.setWindow({ fromMs: next.fromMs, toMs: next.toMs })}
      />
    </div>
  )
}

// Tab nav strip rendered between the dashboard header and the toolbar.
// Each tab is a real <NavLink> so the URL drives the active tab and the
// browser back/forward buttons work as expected. The "All" / catch-all
// idea was rejected: tabs are meant to be intentional dashboards, not a
// generic everything-page.
function MetricsTabsNav({
  activeTabId,
  visibleTabs,
}: {
  activeTabId: MetricsTabId
  visibleTabs: ReadonlyArray<MetricsTab>
}) {
  return (
    <nav
      className="metrics-tabs-nav"
      role="tablist"
      aria-label="Metrics dashboard tabs"
    >
      {visibleTabs.map((t) => (
        <NavLink
          key={t.id}
          // GAds tabs carry a sub-page segment (V1: landing-pages) so
          // the canonical confidential URL is /metrics/gads-<site>/
          // landing-pages. Other tabs use the bare /metrics/:tabId form.
          to={gadsMetricScopeForTab(t.id)?.path ?? `/metrics/${t.id}`}
          // Inactive tabs get the ghost-button look; the active tab gets
          // an emphasized class. We can't trust NavLink's own active
          // state because the bare `/metrics` URL doesn't carry a tabId
          // (it resolves to the default tab via resolveTab()).
          className={({ isActive }) =>
            isActive || t.id === activeTabId
              ? 'metrics-tab metrics-tab--active'
              : 'metrics-tab'
          }
          role="tab"
          aria-selected={t.id === activeTabId}
          title={t.description}
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  )
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

interface MetricGroupSectionProps {
  readonly group: string
  readonly metrics: ReadonlyArray<MetricDefSummary>
  readonly sitesParam: string
  readonly pageAgg: MetricAggregation
  readonly pageStackMode: MetricStackMode
  readonly pageYBaseline: YAxisBaselinePageDefault
  readonly annotations: ReadonlyArray<MetricAnnotationRecord>
  readonly onAnnotationsChanged: () => void
  readonly expandedMetricId: string | null
  readonly onExpand: (id: string) => void
  readonly catalogFilterSelection: CatalogFilterSelection
}

function MetricGroupSection({
  group,
  metrics,
  sitesParam,
  pageAgg,
  pageStackMode,
  pageYBaseline,
  annotations,
  onAnnotationsChanged,
  expandedMetricId,
  onExpand,
  catalogFilterSelection,
}: MetricGroupSectionProps) {
  return (
    <section className="metrics-group">
      <h3 className="metrics-section-title">{group}</h3>
      <div className="metrics-grid">
        {metrics.map((m) => (
          <MetricChart
            key={m.id}
            metric={m}
            sitesParam={sitesParam}
            defaultAgg={pageAgg}
            defaultStackMode={pageStackMode}
            yBaselineDefault={pageYBaseline}
            annotations={annotations}
            onAnnotationsChanged={onAnnotationsChanged}
            variant="card"
            onExpand={() => onExpand(m.id === expandedMetricId ? '' : m.id)}
            catalogFilterSelection={catalogFilterSelection}
          />
        ))}
      </div>
    </section>
  )
}

interface MissingGroupSectionProps {
  readonly group: string
  readonly metrics: ReadonlyArray<MetricDefSummary>
}

function MissingGroupSection({ group, metrics }: MissingGroupSectionProps) {
  return (
    <section className="metrics-group">
      <h4 className="metrics-section-subtitle">{group}</h4>
      <div className="metrics-grid">
        {metrics.map((m) => (
          <MissingMetricCard key={m.id} metric={m} />
        ))}
      </div>
    </section>
  )
}

function MissingMetricCard({ metric }: { metric: MetricDefSummary }) {
  return (
    <article className="metric-chart-card metric-chart-card--pending">
      <header className="metric-chart-header">
        <div className="metric-chart-titlewrap">
          <h3 className="metric-chart-title">{metric.title}</h3>
          <span className="metric-chart-pending-badge">MISSING DATA</span>
        </div>
      </header>
      <div className="metric-chart-pending-body">
        <p className="subtle-copy">
          {metric.description || 'Data source for this metric is not yet wired up.'}
        </p>
        {metric.blockedByUrl ? (
          <p className="subtle-copy">
            Tracked in{' '}
            <a href={metric.blockedByUrl} target="_blank" rel="noreferrer noopener">
              {metric.blockedByUrl.replace(/^https?:\/\//, '')}
            </a>
          </p>
        ) : null}
      </div>
    </article>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PartitionedMetrics {
  readonly real: ReadonlyArray<MetricDefSummary>
  readonly missing: ReadonlyArray<MetricDefSummary>
}

function partitionMetrics(metrics: ReadonlyArray<MetricDefSummary>): PartitionedMetrics {
  const real: MetricDefSummary[] = []
  const missing: MetricDefSummary[] = []
  for (const m of metrics) {
    const status: MetricDataStatus = m.dataStatus ?? 'real'
    if (status === 'real') real.push(m)
    else missing.push(m)
  }
  return { real, missing }
}

function groupByMetricGroup(
  metrics: ReadonlyArray<MetricDefSummary>,
): Array<{ group: string; metrics: MetricDefSummary[] }> {
  const byGroup = new Map<string, MetricDefSummary[]>()
  for (const m of metrics) {
    const list = byGroup.get(m.group) ?? []
    list.push(m)
    byGroup.set(m.group, list)
  }
  return Array.from(byGroup.entries())
    .map(([group, metrics]) => ({ group, metrics: metrics.slice().sort((a, b) => a.title.localeCompare(b.title)) }))
    .sort((a, b) => a.group.localeCompare(b.group))
}
