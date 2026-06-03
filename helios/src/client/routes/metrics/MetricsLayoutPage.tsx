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
  type SessionEnvelope,
} from '../../../shared/contracts/index.js'
import { userHasMetricGrant } from '../../../shared/domain/metricGrants.js'
import { loadJson } from '../../app/fetchJson.js'

import { BudtenderPerformanceTab } from './BudtenderPerformanceTab.js'
import { CatalogAnalyticsTab } from './CatalogAnalyticsTab.js'
import { CustomerValueTab } from './CustomerValueTab.js'
import { EssentialsDailySummaryBanner } from './EssentialsDailySummaryBanner.js'
import {
  CatalogFilterBar,
  emptyCatalogFilterSelection,
  type CatalogFilterSelection,
} from './CatalogFilterBar.js'
import { MetricsAccessGate } from './MetricsAccessGate.js'
import {
  MetricChart,
  METRIC_STACK_MODES,
  type MetricStackMode,
} from './MetricChart.js'
import { RangeNudgeRow } from './RangeNudgeRow.js'
import { TimeAxisProvider, useTimeAxis, type TimeWindow } from './TimeAxisContext.js'

const DAY_MS = 24 * 60 * 60 * 1000

function toggleInSet(prev: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(prev)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}
const PRESETS: ReadonlyArray<{ label: string; days: number }> = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '6mo', days: 180 },
  { label: '1y', days: 365 },
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
  | 'geography'
  | 'inventory'
  | 'scatter'
  | 'catalog'
  | 'budtenders'
  | 'customer-value'

const DEFAULT_TAB_ID: MetricsTabId = 'essentials'

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
  'margins.stack_new_vs_returning',
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
    id: 'geography',
    label: 'Customer geography',
    description: 'Where orders come from (borough mix) and how they fulfill (delivery vs pickup).',
    defaultAgg: 'week',
    defaultStackMode: 'percent',
    showAggControl: true,
    showStackControl: true,
    include: (m) => m.chartType !== 'scatter' && GEOGRAPHY_GROUPS.has(m.group),
    grant: 'explore',
  },
  {
    id: 'inventory',
    label: 'Inventory',
    description: 'Current on-hand state — slow movers, running low, days-of-stock.',
    defaultAgg: 'date',
    defaultStackMode: 'none',
    showAggControl: true,
    showStackControl: true,
    include: (m) => m.chartType !== 'scatter' && INVENTORY_GROUPS.has(m.group),
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

function resolveTab(raw: string | undefined): MetricsTab {
  if (!raw) return METRICS_TABS_BY_ID.get(DEFAULT_TAB_ID)!
  const aliased = METRICS_TAB_ALIASES[raw] ?? (raw as MetricsTabId)
  return METRICS_TABS_BY_ID.get(aliased) ?? METRICS_TABS_BY_ID.get(DEFAULT_TAB_ID)!
}

export async function metricsLoader(): Promise<MetricListResponse> {
  return loadJson('/api/metrics', MetricListResponseSchema)
}

export function MetricsLayoutPage() {
  const { metrics } = useLoaderData() as MetricListResponse
  const { tabId } = useParams<{ tabId?: string }>()
  // The root loader provides session — used to filter tabs by per-user
  // metric grant. Admins implicitly hold every grant.
  const session = useRouteLoaderData('root') as SessionEnvelope | undefined
  const user = session?.user ?? null

  // Tabs the user can see. The full set of tab definitions is static;
  // accessibility is dynamic. We compute `visibleTabs` once per render
  // and use it both for the nav strip and for "default tab" fallback
  // when the URL didn't pick one (or picked one the user lacks).
  const visibleTabs = useMemo(
    () => METRICS_TABS.filter((t) => userHasMetricGrant(user, t.grant)),
    [user],
  )

  const requestedTab = useMemo(() => resolveTab(tabId), [tabId])
  const activeTab = useMemo(() => {
    // If the URL points at a tab the user can see, keep it.
    if (visibleTabs.some((t) => t.id === requestedTab.id)) return requestedTab
    // Otherwise fall back to the first accessible tab (or the
    // requested one if NONE are accessible — the access-denied
    // page below will be rendered in that case).
    return visibleTabs[0] ?? requestedTab
  }, [requestedTab, visibleTabs])

  // Site filter: empty Set = all sites. Multi-select against KNOWN_SITES.
  const [selectedSites, setSelectedSites] = useState<ReadonlySet<string>>(() => new Set<string>())
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
  const [aggByTab, setAggByTab] = useState<Record<MetricsTabId, MetricAggregation>>(() =>
    Object.fromEntries(METRICS_TABS.map((t) => [t.id, t.defaultAgg])) as Record<
      MetricsTabId,
      MetricAggregation
    >,
  )
  const [stackByTab, setStackByTab] = useState<Record<MetricsTabId, MetricStackMode>>(() =>
    Object.fromEntries(METRICS_TABS.map((t) => [t.id, t.defaultStackMode])) as Record<
      MetricsTabId,
      MetricStackMode
    >,
  )
  const pageAgg = aggByTab[activeTab.id]
  const pageStackMode = stackByTab[activeTab.id]
  const setPageAgg = useCallback(
    (next: MetricAggregation) => setAggByTab((prev) => ({ ...prev, [activeTab.id]: next })),
    [activeTab.id],
  )
  const setPageStackMode = useCallback(
    (next: MetricStackMode) => setStackByTab((prev) => ({ ...prev, [activeTab.id]: next })),
    [activeTab.id],
  )
  // 90d default window matching the parent epic spec.
  const [initialWindow] = useState<TimeWindow>(() => ({
    fromMs: Date.now() - 90 * DAY_MS,
    toMs: Date.now(),
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
  return (
    <MetricsAccessGate anyOf={[pageGrant]} surfaceLabel={activeTab.label}>
      <TimeAxisProvider initial={initialWindow}>
        <section className="metrics-dashboard">
          <header className="page-header metrics-dashboard-header">
            <div>
              <p className="eyebrow">Business &amp; Performance Metrics</p>
              <h2>Dashboard</h2>
            </div>
            <DataCoverageBadge
              realCount={partitioned.real.length}
              missingCount={partitioned.missing.length}
              showMissing={showMissing}
              onToggleShowMissing={setShowMissing}
            />
          </header>

          <MetricsTabsNav activeTabId={activeTab.id} visibleTabs={visibleTabs} />

        {/* Essentials top-of-tab "today" summary banner — sticky on
            desktop, collapsable on mobile. Polls every ~90s. Render
            only on the essentials tab (the metric registry on the
            other tabs has no equivalent same-day-summary contract). */}
        {activeTab.id === 'essentials' ? <EssentialsDailySummaryBanner /> : null}

        {activeTab.id === 'catalog' ? (
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
        ) : (
          <RegistryDashboard
            activeTab={activeTab}
            selectedSites={selectedSites}
            setSelectedSites={setSelectedSites}
            pageAgg={pageAgg}
            setPageAgg={setPageAgg}
            pageStackMode={pageStackMode}
            setPageStackMode={setPageStackMode}
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
  showAggControl,
  showStackControl,
  catalogFilters,
  loadingCatalogFilters,
  catalogFilterSelection,
  catalogFilterCallbacks,
  catalogFilterDimensions,
}: DashboardControlsProps) {
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
              onClick={() => {
                const next = new Set(selectedSites)
                if (active) next.delete(s.id)
                else next.add(s.id)
                onSitesChange(next)
              }}
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
        </div>
      ) : null}

      <div className="metrics-control-group">
        <span className="subtle-copy">range</span>
        {PRESETS.map((p) => (
          <PresetButton key={p.label} label={p.label} days={p.days} />
        ))}
        <details className="metrics-range-custom">
          <summary>custom</summary>
          <ManualRangeInputs />
        </details>
      </div>
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
          to={`/metrics/${t.id}`}
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

function PresetButton({ label, days }: { label: string; days: number }) {
  const axis = useTimeAxis()
  // A preset chip is "active" when the current window is exactly
  // (now-Nd … now). After the user types in a custom range, no
  // preset stays highlighted (matching the catalog tab's behaviour).
  const isExactPreset =
    Math.abs(axis.window.toMs - Date.now()) < DAY_MS &&
    Math.round((axis.window.toMs - axis.window.fromMs) / DAY_MS) === days
  return (
    <button
      type="button"
      className={isExactPreset ? 'metrics-site-chip is-active' : 'metrics-site-chip'}
      onClick={() => axis.setWindow({ fromMs: Date.now() - days * DAY_MS, toMs: Date.now() })}
      aria-pressed={isExactPreset}
    >
      {label}
    </button>
  )
}

function ManualRangeInputs() {
  const axis = useTimeAxis()
  return (
    <>
      <div className="metrics-range-custom-inputs">
        <label className="subtle-copy">
          from{' '}
          <input
            type="datetime-local"
            value={toLocalDtInput(axis.window.fromMs)}
            onChange={(e) => {
              const ms = Date.parse(e.target.value)
              if (!Number.isNaN(ms)) axis.setWindow({ fromMs: ms, toMs: axis.window.toMs })
            }}
          />
        </label>
        <label className="subtle-copy">
          to{' '}
          <input
            type="datetime-local"
            value={toLocalDtInput(axis.window.toMs)}
            onChange={(e) => {
              const ms = Date.parse(e.target.value)
              if (!Number.isNaN(ms)) axis.setWindow({ fromMs: axis.window.fromMs, toMs: ms })
            }}
          />
        </label>
      </div>
      <RangeNudgeRow
        range={{ fromMs: axis.window.fromMs, toMs: axis.window.toMs }}
        setRange={(next) => axis.setWindow({ fromMs: next.fromMs, toMs: next.toMs })}
      />
    </>
  )
}

function toLocalDtInput(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`
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
