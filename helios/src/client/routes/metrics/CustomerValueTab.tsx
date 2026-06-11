import * as React from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import {
  CustomerValueAnalyticsResponseSchema,
  type BasketByPurchaseNumberPoint,
  type CohortRetentionRow,
  type ContributionByPurchaseNumberPoint,
  type CustomerValueAnalyticsResponse,
  type CustomerValueCohortGranularity,
  type CustomerValueMissingDataCard,
  type FirstSecondConversionRow,
  type LifetimeByTotalPurchasesPoint,
  type MetricSelection,
  type PurchaseCountBucket,
  type PurchaseCountPercentiles,
  type TrailingSpendPercentiles,
  DEFAULT_PURCHASE_COUNT_PERCENTILES,
  normalizePurchaseCountPercentile,
} from '../../../shared/contracts/index.js'
import { loadJson } from '../../app/fetchJson.js'
import { nyIsoDate, nyMonthDaySlash } from '../../app/nyTime.js'

import { ControlsSection } from './ControlsSection.js'
import { formatYTick, niceYTicks } from './gridlines.js'
import {
  buildStructuredHighlightMatcher,
  emptyHighlightSelection,
  HighlightControls,
  type HighlightDimensionSpec,
  type HighlightSelectionState,
} from './HighlightControls.js'
import { HelpIcon } from './MetricChart.js'
import { toggleSiteSelection } from './metricsSiteSelection.js'
import { RangeNudgeRow } from './RangeNudgeRow.js'
import { useMetricSelection } from './useMetricSelection.js'

// ---------------------------------------------------------------------------
// Customer Value dashboard tab.
//
// Top grid (2×2 desktop / single-column mobile) of the four mandatory
// LTV histograms. Each card has its own metric-basis selector (gross
// sales vs net sales vs gross receipts) so the operator can hot-swap
// the dollar dimension without leaving the page.
//
// All cards eat from a SINGLE /api/customer-value-analytics fetch
// (see customerValueAnalyticsQueries.ts) — the response is small (a
// dozen rows per chart at default max-N=20) so further pivoting
// happens client-side without another round-trip.
//
// Per oracle's design — see virusdave/top-level#7 — we NEVER
// fabricate. Margin-basis histograms render as MISSING DATA cards
// until per-invoice margin is materialized (see backend
// MISSING_CARDS).
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

const RANGE_PRESETS: ReadonlyArray<{ label: string; days: number }> = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '6mo', days: 180 },
  { label: '1y', days: 365 },
]

const KNOWN_SITES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'bronx', label: 'Bronx' },
  { id: 'midtown', label: 'Midtown' },
]

type CohortScope = 'all_as_of_end' | 'active_in_range' | 'acquired_in_range'
const COHORT_SCOPES: ReadonlyArray<{ id: CohortScope; label: string; help: string }> = [
  {
    id: 'all_as_of_end',
    label: 'All known customers',
    help: 'Every customer who has ever made a purchase up to the end of the selected range. Use this for true lifetime-value questions.',
  },
  {
    id: 'active_in_range',
    label: 'Active in range',
    help: 'Only customers who made at least one purchase inside the selected range. Filters out lapsed long-tail customers.',
  },
  {
    id: 'acquired_in_range',
    label: 'Acquired in range',
    help: 'Only customers whose FIRST EVER purchase fell inside the selected range. Useful for evaluating recent acquisition cohorts, but right-censored — recent cohorts haven\'t had time to mature.',
  },
]

type MoneyBasis = 'gross_sales' | 'net_sales' | 'gross_receipts'
const MONEY_BASES: ReadonlyArray<{ id: MoneyBasis; label: string; help: string }> = [
  {
    id: 'gross_sales',
    label: 'Gross sales (ex-tax)',
    help: 'Pre-discount, pre-tax line total. The "what the store would have rung if nothing was discounted" number.',
  },
  {
    id: 'net_sales',
    label: 'Net sales (ex-tax, net of discounts)',
    help: 'After-discount, pre-tax line total. The "revenue booked" number.',
  },
  {
    id: 'gross_receipts',
    label: 'Gross receipts (incl. tax)',
    help: 'After-discount, including sales tax — money actually collected.',
  },
]

type MaxNChoice = 'auto' | 10 | 20 | 30 | 50
const MAX_N_OPTIONS: ReadonlyArray<MaxNChoice> = ['auto', 10, 20, 30, 50]

// v1.4 V4'5: operator-set threshold (top-level#7) for promoting
// VeriScan-keyed views from MISSING DATA to real. Below this, the
// "Show only VeriScan-linked customers" toggle is disabled; at or
// above, the toggle is enabled but is a no-op in v1.4 (full filtering
// behaviour ships in the v1.4.1 follow-on dispatched once coverage
// crosses the threshold).
const VERISCAN_COVERAGE_THRESHOLD_PCT = 0.25
// v1.4 V4'5: operator-approved tooltip text (see virusdave/top-level#7
// approval comment from 2026-05-31). The `{linked}` / `{total}` /
// `{thresholdPct}` placeholders are filled in at render time. Any
// non-trivial wording change requires re-paging Dave at p4 for
// re-approval before merging.
const VERISCAN_BADGE_TOOLTIP_TEMPLATE =
  '{linked} of {total} purchases in this window are attributed to a ' +
  'VeriScan-known identity. Cohort retention, basket size at purchase ' +
  'N, and lifetime $ histograms key off `customer_id` from ' +
  '`sweed_orders` and are unaffected. VeriScan-keyed views are MISSING ' +
  'DATA until coverage crosses the operator-set threshold (today: ' +
  '{thresholdPct}%).'

export function CustomerValueTab(): JSX.Element {
  const [windowDays, setWindowDays] = useState<number>(90)
  const [useCustomRange, setUseCustomRange] = useState<boolean>(false)
  const [customFromMs, setCustomFromMs] = useState<number>(Date.now() - 90 * DAY_MS)
  const [customToMs, setCustomToMs] = useState<number>(Date.now())
  const [selectedSites, setSelectedSites] = useState<ReadonlySet<string>>(() => new Set())
  const [cohortScope, setCohortScope] = useState<CohortScope>('all_as_of_end')
  const [maxN, setMaxN] = useState<MaxNChoice>('auto')
  // v1.4 V4'3: cohort retention granularity (week / month). Default
  // 'week' matches the parent epic spec — gives ~12 useful weekly
  // cohorts in a default 90-day window.
  const [cohortGranularity, setCohortGranularity] =
    useState<CustomerValueCohortGranularity>('week')
  // Which five purchase-count percentiles to report (each 50..99).
  // Operator-adjustable; defaults to the original fixed set.
  const [percentiles, setPercentiles] = useState<number[]>(() => [
    ...DEFAULT_PURCHASE_COUNT_PERCENTILES,
  ])

  const [data, setData] = useState<CustomerValueAnalyticsResponse | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  const { fromMs, toMs } = useMemo(() => {
    if (useCustomRange) return { fromMs: customFromMs, toMs: customToMs }
    const to = Date.now()
    return { fromMs: to - windowDays * DAY_MS, toMs: to }
  }, [useCustomRange, customFromMs, customToMs, windowDays])

  const sitesParam = useMemo(() => Array.from(selectedSites).join(','), [selectedSites])
  const percentilesParam = useMemo(() => percentiles.join(','), [percentiles])

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams()
    params.set('from', new Date(fromMs).toISOString())
    params.set('to', new Date(toMs).toISOString())
    if (sitesParam) params.set('sites', sitesParam)
    params.set('cohortScope', cohortScope)
    // 'auto' passes through to the server, which probes for the
    // long-tail cliff and returns the resolved value as
    // `maxPurchaseNumber` in the response.
    params.set('maxPurchaseNumber', String(maxN))
    // v1.4 V4'3: opt in to retention sections on the consolidated
    // endpoint. Granularity also forwarded; server defaults to 'week'.
    params.set('include', 'retention')
    params.set('cohortGranularity', cohortGranularity)
    params.set('percentiles', percentilesParam)
    setLoading(true)
    setError(null)
    loadJson(
      `/api/customer-value-analytics?${params.toString()}`,
      CustomerValueAnalyticsResponseSchema,
    )
      .then((r) => {
        if (!cancelled) setData(r)
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setData(null)
          setError(e instanceof Error ? e.message : String(e))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [fromMs, toMs, sitesParam, cohortScope, maxN, cohortGranularity, percentilesParam])

  return (
    <section className="customer-value-tab">
      {/* Issue #38 / task A6: wrap the page-level filter chrome in
          the shared Filters ControlsSection so the surface matches
          Catalog Analytics / Budtender Performance. defaultOpen
          "always" keeps the chrome visible at every breakpoint —
          this page has no scatter that benefits from hiding the
          filters on mobile. The Highlight ControlsSection lives
          inside <CustomerValueBody> below since its dimension
          options come from the loaded response. */}
      <ControlsSection title="Filters" defaultOpen="always">
      <div className="customer-value-controls metrics-controls">
        <div className="metrics-control-group">
          <span className="subtle-copy">sites</span>
          <button
            type="button"
            className={selectedSites.size === 0 ? 'metrics-site-chip is-active' : 'metrics-site-chip'}
            onClick={() => setSelectedSites(new Set())}
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
          {RANGE_PRESETS.map((p) => {
            const active = !useCustomRange && windowDays === p.days
            return (
              <button
                key={p.label}
                type="button"
                className={active ? 'metrics-site-chip is-active' : 'metrics-site-chip'}
                onClick={() => {
                  setUseCustomRange(false)
                  setWindowDays(p.days)
                }}
                aria-pressed={active}
              >
                {p.label}
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
                  value={toLocalDtInput(customFromMs)}
                  onChange={(e) => {
                    const ms = Date.parse(e.target.value)
                    if (!Number.isNaN(ms)) {
                      setCustomFromMs(ms)
                      setUseCustomRange(true)
                    }
                  }}
                />
              </label>
              <label className="subtle-copy">
                to{' '}
                <input
                  type="datetime-local"
                  value={toLocalDtInput(customToMs)}
                  onChange={(e) => {
                    const ms = Date.parse(e.target.value)
                    if (!Number.isNaN(ms)) {
                      setCustomToMs(ms)
                      setUseCustomRange(true)
                    }
                  }}
                />
              </label>
            </div>
            <RangeNudgeRow
              range={{ fromMs, toMs }}
              setRange={(next) => {
                // Nudging from a preset implicitly converts the window
                // to a custom range; the preset chip stops being
                // active because `useCustomRange` is now true.
                setCustomFromMs(next.fromMs)
                setCustomToMs(next.toMs)
                setUseCustomRange(true)
              }}
            />
          </details>
        </div>

        <div className="metrics-control-group">
          <label
            className="subtle-copy"
            title="Which set of customers do we count? Lifetime view, recently-active only, or just newly-acquired cohort."
          >
            cohort{' '}
            <select value={cohortScope} onChange={(e) => setCohortScope(e.target.value as CohortScope)}>
              {COHORT_SCOPES.map((c) => (
                <option key={c.id} value={c.id} title={c.help}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label
            className="subtle-copy"
            title="Customers with more purchases than this are bucketed into an overflow 'N+' bucket so the long tail doesn't sparsify the histogram. 'auto' lets the server pick the smallest N such that every higher bucket holds ≤1 customer — i.e. the long-tail cliff — capped at 50 bars."
          >
            max N{' '}
            <select
              value={String(maxN)}
              onChange={(e) => {
                const v = e.target.value
                setMaxN(v === 'auto' ? 'auto' : (Number(v) as MaxNChoice))
              }}
            >
              {MAX_N_OPTIONS.map((n) => (
                <option key={String(n)} value={String(n)}>
                  {n === 'auto' ? 'auto' : n}
                </option>
              ))}
            </select>
            {maxN === 'auto' && data ? (
              <span className="subtle-copy"> ({data.maxPurchaseNumber})</span>
            ) : null}
          </label>
          <label
            className="subtle-copy"
            title="Cohort granularity for the retention curve panel below. Weekly cohorts react faster and resolve ~12 cohorts in a 90-day window; monthly cohorts smooth out same-day-of-week noise but need a longer window to resolve."
          >
            cohort granularity{' '}
            <select
              value={cohortGranularity}
              onChange={(e) =>
                setCohortGranularity(e.target.value as CustomerValueCohortGranularity)
              }
            >
              <option value="week">week</option>
              <option value="month">month</option>
            </select>
          </label>
        </div>
      </div>
      </ControlsSection>

      {error ? (
        <p className="metric-chart-error">Failed to load: {error}</p>
      ) : loading && !data ? (
        <p className="subtle-copy">Loading…</p>
      ) : data ? (
        <CustomerValueBody
          data={data}
          percentiles={percentiles}
          onPercentileChange={(index, next) =>
            setPercentiles((prev) => {
              const copy = [...prev]
              copy[index] = normalizePurchaseCountPercentile(next)
              return copy
            })
          }
        />
      ) : null}
    </section>
  )
}

// v1.4 V4'4: synthetic metric ids for the customer-value histograms.
// These are NOT registered with the server metric registry (the data
// flows through /api/customer-value-analytics, not /api/metrics/<id>),
// but the URL selection contract still keys off them so that future
// drill targets can route on metricId without ambiguity.
const CUSTOMER_VALUE_METRIC_IDS = {
  purchaseCount: 'customer-value.purchase-count-histogram',
  basketByN: 'customer-value.basket-by-purchase-number',
  lifetimeByTotal: 'customer-value.lifetime-by-total-purchases',
  contributionByN: 'customer-value.contribution-by-purchase-number',
} as const

function CustomerValueBody({
  data,
  percentiles,
  onPercentileChange,
}: {
  data: CustomerValueAnalyticsResponse
  percentiles: ReadonlyArray<number>
  onPercentileChange: (index: number, next: number) => void
}) {
  const [moneyBasis, setMoneyBasis] = useState<MoneyBasis>('gross_sales')
  const moneyBasisDef =
    MONEY_BASES.find((b) => b.id === moneyBasis) ?? MONEY_BASES[0]!

  // Issue #38 / task A6: page-level structured Highlight. The only
  // surface on this tab with per-element identity that highlight can
  // dim is the Cohort retention chart (one line per acquisition
  // cohort). Bar histograms above it have no useful "per-row" axis
  // to dim, so the matcher is consumed only by <CohortRetentionCard>.
  const [highlightState, setHighlightState] = useState<HighlightSelectionState>(
    () => emptyHighlightSelection(),
  )
  const [highlightText, setHighlightText] = useState<string>('')
  const highlightMatcher = useMemo(
    () =>
      buildStructuredHighlightMatcher(
        COHORT_HIGHLIGHT_DIMS,
        highlightState,
        highlightText,
      ),
    [highlightState, highlightText],
  )

  // v1.4 V4'4: drill selection lives in the URL so share-link
  // parity holds. Escape key clears at the body level so any focused
  // bar can be deselected without re-clicking.
  const [selection, setSelection] = useMetricSelection()
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && selection != null) {
        setSelection(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selection, setSelection])

  return (
    <>
      {/* v1.4 V4'5: tab header — VeriScan coverage badge + gated
          toggle. Sits above the KPI strip so the badge is visible
          before any chart resolves. */}
      <VeriscanCoverageHeader meta={data.meta} />

      <SummaryStrip data={data} basis={moneyBasis} basisLabel={moneyBasisDef.label} />

      <div className="customer-value-basis-row metrics-control-group">
        <label
          className="subtle-copy"
          title="Which dollar dimension drives the histograms below. Hot-swappable without re-fetching."
        >
          $ basis{' '}
          <select
            value={moneyBasis}
            onChange={(e) => setMoneyBasis(e.target.value as MoneyBasis)}
          >
            {MONEY_BASES.map((b) => (
              <option key={b.id} value={b.id} title={b.help}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <span className="subtle-copy">{moneyBasisDef.help}</span>
      </div>

      <TrailingSpendPercentilesStrip
        title="Trailing-12-mo spend"
        help="Distribution of each customer's total spend over the trailing 12 months ending at the range end. Population: non-guest customers with at least one non-cancelled order in that window at the selected sites. Switches with the $ basis selector above. Independent of the cohort-scope / from-date controls (the lookback is always a fixed 12 months back from the range end)."
        percentiles={data.summary.trailing12moSpendPercentiles}
        basis={moneyBasis}
        basisLabel={moneyBasisDef.label}
      />
      {data.summary.trailing12moSpendPercentilesByMinVisits.map((cohort) => (
        <TrailingSpendPercentilesStrip
          key={cohort.minVisits}
          title={`Trailing-12-mo spend, >${cohort.minVisits - 1} visit${cohort.minVisits - 1 === 1 ? '' : 's'} (${fmtInt(cohort.customers)} cust)`}
          help={`Same as the all-customers row, but restricted to customers with ${cohort.minVisits} or more non-cancelled orders in the trailing 12 months (i.e. more than ${cohort.minVisits - 1} visit${cohort.minVisits - 1 === 1 ? '' : 's'}). ${fmtInt(cohort.customers)} customers qualify.`}
          percentiles={cohort.percentiles}
          basis={moneyBasis}
          basisLabel={moneyBasisDef.label}
        />
      ))}

      {/* v1.4 V4'4: selection callout — visible iff a histogram bucket
          is currently selected via URL state. Click ✕ or press Escape
          (anywhere) to clear. */}
      {selection != null && selection.kind === 'histogramBucket' ? (
        <SelectionCallout selection={selection} onClear={() => setSelection(null)} />
      ) : null}

      <div className="customer-value-grid">
        <PurchaseCountHistogramCard
          data={data.purchaseCountHistogram}
          maxN={data.maxPurchaseNumber}
          percentiles={percentiles}
          percentileValues={data.summary.purchaseCountPercentiles}
          onPercentileChange={onPercentileChange}
          selection={selection}
          onSelect={setSelection}
        />
        <BasketByPurchaseNumberCard
          data={data.basketByPurchaseNumber}
          maxN={data.maxPurchaseNumber}
          basis={moneyBasis}
          basisLabel={moneyBasisDef.label}
          selection={selection}
          onSelect={setSelection}
        />
        <LifetimeByTotalPurchasesCard
          data={data.lifetimeByTotalPurchases}
          maxN={data.maxPurchaseNumber}
          basis={moneyBasis}
          basisLabel={moneyBasisDef.label}
          selection={selection}
          onSelect={setSelection}
        />
        <ContributionByPurchaseNumberCard
          data={data.contributionByPurchaseNumber}
          maxN={data.maxPurchaseNumber}
          basis={moneyBasis}
          basisLabel={moneyBasisDef.label}
          selection={selection}
          onSelect={setSelection}
        />
      </div>

      {/* Issue #38 / task A6: structured Highlight section. Sits
          directly above the cohort retention row so the operator can
          see immediately which dimension's chips affect what. Mobile
          defaults to collapsed so the section doesn't shove the
          retention chart off-screen on phones. */}
      <ControlsSection title="Highlight" defaultOpen="desktop-only">
        <HighlightControls
          dims={COHORT_HIGHLIGHT_DIMS}
          state={highlightState}
          setState={setHighlightState}
          filteredPoints={data.cohortRetention}
          freeText={highlightText}
          setFreeText={setHighlightText}
          freeTextPlaceholder="cohort key (e.g. 2026-W18)"
        />
      </ControlsSection>

      {/* v1.4 V4'3: cohort retention curves + first-to-second sparkline. */}
      <div className="customer-value-retention-row">
        <CohortRetentionCard
          rows={data.cohortRetention}
          granularity={data.cohortGranularity}
          highlightMatcher={highlightMatcher}
        />
        <FirstSecondConversionCard rows={data.firstSecondConversion} />
      </div>

      <MissingDataSection cards={data.missingDataCards} />
    </>
  )
}

// ---------------------------------------------------------------------------
// Issue #38 / task A6: structured-highlight dimensions for the
// CustomerValueTab. The only per-element surface on this tab is the
// cohort retention chart (one line per acquisition cohort), so the
// dim list is short:
//
//   Cohort  — chips per distinct cohortKey from data.cohortRetention.
//             Useful for "isolate Q1 2026 onboarding cohorts" style
//             highlights.
//   Free-text continues to substring-match cohort labels
//             (cohortKey contributes to the haystack via pointKey).
//
// The dim operates over CohortRetentionRow because that is what the
// retention card consumes. Bar histograms above aren't keyed off
// cohort, so they receive no matcher.
const COHORT_HIGHLIGHT_DIMS: ReadonlyArray<HighlightDimensionSpec<CohortRetentionRow>> = [
  {
    id: 'cohort',
    label: 'Cohort',
    getOptions: (rows) => {
      // Group by cohortKey so the chip option count = number of
      // periods the cohort has been observed (= line length on chart),
      // which is a useful hint for picking which cohorts to highlight.
      const counts = new Map<string, number>()
      for (const r of rows) counts.set(r.cohortKey, (counts.get(r.cohortKey) ?? 0) + 1)
      return Array.from(counts.entries())
        .map(([cohortKey, n]) => ({
          id: cohortKey,
          label: fmtCohortLabel(cohortKey),
          itemCount: n,
        }))
        // Newest cohort first — operators usually want to highlight
        // recently-acquired groups.
        .sort((a, b) => b.id.localeCompare(a.id))
    },
    pointKey: (r) => [r.cohortKey, fmtCohortLabel(r.cohortKey)],
  },
]

// =========================== VeriScan coverage header (v1.4 V4'5) ==========

/**
 * Renders the VeriScan link-coverage badge `N% linked` plus the gated
 * "Show only VeriScan-linked customers" toggle. Tooltip wording was
 * operator-approved on virusdave/top-level#7 (2026-05-31) — see
 * `VERISCAN_BADGE_TOOLTIP_TEMPLATE`.
 *
 * The toggle:
 *   * is *disabled* while `pct < 25%` — affordance is present so the
 *     operator can see what's coming, but it's not actionable until
 *     coverage crosses the threshold;
 *   * becomes *enabled* at `pct >= 25%` but is still a no-op in v1.4
 *     (full VeriScan-only filtering ships in the v1.4.1 follow-on).
 */
function VeriscanCoverageHeader({
  meta,
}: {
  meta: CustomerValueAnalyticsResponse['meta']
}) {
  const [veriscanOnly, setVeriscanOnly] = useState<boolean>(false)
  const { linked, total, pct } = meta.veriscanCoverage
  const pctRounded = Math.round(pct * 1000) / 10 // one decimal
  const aboveThreshold = pct >= VERISCAN_COVERAGE_THRESHOLD_PCT
  const tooltip = VERISCAN_BADGE_TOOLTIP_TEMPLATE
    .replace('{linked}', linked.toLocaleString())
    .replace('{total}', total.toLocaleString())
    .replace('{thresholdPct}', String(Math.round(VERISCAN_COVERAGE_THRESHOLD_PCT * 100)))
  const badgeText = `${pctRounded.toFixed(1)}% linked`
  return (
    <div className="customer-value-tab-header" role="group" aria-label="VeriScan coverage">
      <div className="metrics-coverage-badge">
        <span
          className={
            aboveThreshold
              ? 'metrics-coverage-chip metrics-coverage-chip--real'
              : 'metrics-coverage-chip metrics-coverage-chip--pending'
          }
          title={tooltip}
          aria-label={`${badgeText}. ${tooltip}`}
        >
          {badgeText}
        </span>
        <HelpIcon text={tooltip} />
      </div>
      <label
        className="metrics-coverage-toggle subtle-copy"
        title={
          aboveThreshold
            ? 'Coverage is above the 25% threshold; the affordance is enabled. Full VeriScan-only filtering ships in the v1.4.1 follow-on dispatched once coverage crosses the threshold.'
            : `Disabled — VeriScan link coverage (${pctRounded.toFixed(1)}%) is below the operator-set 25% threshold. Affordance becomes enabled once coverage crosses 25%.`
        }
      >
        <input
          type="checkbox"
          checked={aboveThreshold ? veriscanOnly : false}
          disabled={!aboveThreshold}
          onChange={(e) => {
            // No-op in v1.4 — the v1.4.1 follow-on wires this to a
            // per-customer filter. We still flip the local state so the
            // operator can see the toggle moves and so a future bind
            // is a one-line change.
            setVeriscanOnly(e.target.checked)
          }}
        />{' '}
        Show only VeriScan-linked customers (gated on ≥ 25% coverage)
        {aboveThreshold ? (
          <span className="subtle-copy customer-value-veriscan-followon">
            {' '}(no-op in v1.4 — full filtering ships in v1.4.1; see{' '}
            <a
              href="https://github.com/virusdave/top-level/issues/7"
              target="_blank"
              rel="noreferrer noopener"
            >
              top-level#7
            </a>
            )
          </span>
        ) : null}
      </label>
    </div>
  )
}

// =========================== Summary strip =================================

function SummaryStrip({
  data,
  basis,
  basisLabel,
}: {
  data: CustomerValueAnalyticsResponse
  basis: MoneyBasis
  basisLabel: string
}) {
  const sumDollars =
    basis === 'gross_sales'
      ? data.summary.grossSalesDollars
      : basis === 'net_sales'
        ? data.summary.netSalesDollars
        : data.summary.grossReceiptsDollars
  return (
    <div className="customer-value-kpis">
      <Kpi
        label="Known customers"
        value={fmtInt(data.summary.knownCustomers)}
        help="Unique Sweed customer_ids in scope. Guests are excluded — they cannot be deduped into customers."
      />
      <Kpi
        label="Total orders"
        value={fmtInt(data.summary.totalOrders)}
        help="All orders in the selected range, including guest orders (so this is wider than the per-customer aggregates below)."
      />
      <Kpi
        label="First-time purchases"
        value={fmtInt(data.summary.firstPurchases)}
        help="Known-customer orders where this was the customer's 1st ever purchase across all history."
      />
      <Kpi
        label="Repeat purchases"
        value={fmtInt(data.summary.repeatPurchases)}
        help="Known-customer orders where the customer had at least one prior purchase before this one."
      />
      <Kpi
        label="Repeat share"
        value={fmtPctOrDash(data.summary.repeatPurchaseRate)}
        help="Repeat purchases ÷ known-customer purchases (in range). Higher = more business comes from loyal returning customers."
      />
      <Kpi
        label={`Avg observed LTV (${basisLabel})`}
        value={fmtMoneyOrDash(data.summary.observedAvgLtvGrossDollars)}
        help="Average lifetime-to-date gross sales per known customer in scope. 'Observed' = up to the selected end date; recent customers are right-censored."
      />
      <Kpi
        label={`Median observed LTV (${basisLabel})`}
        value={fmtMoneyOrDash(data.summary.observedMedianLtvGrossDollars)}
        help="Median (not mean) lifetime-to-date gross sales per known customer. Less skewed by whale outliers than the mean."
      />
      <Kpi
        label={`Total ${basisLabel.toLowerCase()} (in range)`}
        value={fmtMoney(sumDollars)}
        help="Sum of the selected $ basis across all in-scope orders in the selected range."
      />
    </div>
  )
}

function Kpi({ label, value, help }: { label: string; value: string; help: string }) {
  return (
    <div className="customer-value-kpi">
      <div className="customer-value-kpi-label">
        {label} <HelpIcon text={help} />
      </div>
      <div className="customer-value-kpi-value">{value}</div>
    </div>
  )
}

// =================== Trailing-12-month spend percentiles ===================

/** Compact strip of trailing-12-month per-customer spend percentiles
 *  (fixed P50/P80/P90/P95). The displayed $ value tracks the page's
 *  `$ basis` selector. Population = non-guest customers with >= 1
 *  non-cancelled order in the trailing 12 months ending at the range
 *  end, at the selected sites. */
function TrailingSpendPercentilesStrip({
  title,
  help,
  percentiles,
  basis,
  basisLabel,
}: {
  title: string
  help: string
  percentiles: TrailingSpendPercentiles
  basis: MoneyBasis
  basisLabel: string
}) {
  const pick = (p: TrailingSpendPercentiles[number]): number | null =>
    basis === 'gross_sales'
      ? p.grossSalesDollars
      : basis === 'net_sales'
        ? p.netSalesDollars
        : p.grossReceiptsDollars
  return (
    <div className="customer-value-kpis customer-value-ttm-spend">
      <div className="customer-value-kpi">
        <div className="customer-value-kpi-label">
          {title} ({basisLabel.toLowerCase()}) <HelpIcon text={help} />
        </div>
        <div className="customer-value-kpi-value subtle-copy" style={{ fontSize: '0.8em' }}>
          percentiles
        </div>
      </div>
      {percentiles.map((p) => (
        <Kpi
          key={p.percentile}
          label={`P${p.percentile}`}
          value={fmtMoneyOrDash(pick(p))}
          help={`The spend at or below which ${p.percentile}% of the population fall (${basisLabel.toLowerCase()}).`}
        />
      ))}
    </div>
  )
}

// =========================== Selection callout (v1.4 V4'4) ================

/** Inline banner that surfaces the current drill-selection plus a clear
 *  affordance. Rendered when the URL carries a `histogramBucket`
 *  selection so the operator never lands on a "why is this chart
 *  highlighted?" question without an obvious next action. */
function SelectionCallout({
  selection,
  onClear,
}: {
  selection: Extract<MetricSelection, { kind: 'histogramBucket' }>
  onClear: () => void
}) {
  // Map the synthetic metricId back to a human label.
  const friendly =
    selection.metricId === CUSTOMER_VALUE_METRIC_IDS.purchaseCount
      ? 'Customer count by total purchases'
      : selection.metricId === CUSTOMER_VALUE_METRIC_IDS.basketByN
        ? 'Basket size at purchase number N'
        : selection.metricId === CUSTOMER_VALUE_METRIC_IDS.lifetimeByTotal
          ? 'Avg lifetime $ by total purchases'
          : selection.metricId === CUSTOMER_VALUE_METRIC_IDS.contributionByN
            ? '$ contributed at purchase number N'
            : selection.metricId
  return (
    <aside
      className="customer-value-selection-callout"
      role="status"
      aria-live="polite"
    >
      <strong>Drilled:</strong> {friendly} → bucket{' '}
      <code>{selection.bucketKey}</code>{' '}
      <button
        type="button"
        className="ghost-button"
        onClick={onClear}
        aria-label="Clear drill selection"
        title="Clear drill selection (Escape)"
      >
        ✕
      </button>
    </aside>
  )
}

// =========================== Chart cards ===================================

function PurchaseCountHistogramCard({
  data,
  maxN,
  percentiles,
  percentileValues,
  onPercentileChange,
  selection,
  onSelect,
}: {
  data: ReadonlyArray<PurchaseCountBucket>
  maxN: number
  /** Operator-requested percentiles (page state, drives the inputs). */
  percentiles: ReadonlyArray<number>
  /** Server-computed values, index-aligned with `percentiles`. */
  percentileValues: PurchaseCountPercentiles
  onPercentileChange: (index: number, next: number) => void
  selection: MetricSelection | null
  onSelect: (next: MetricSelection | null) => void
}) {
  const [logScale, setLogScale] = useState<boolean>(true)
  const metricId = CUSTOMER_VALUE_METRIC_IDS.purchaseCount
  const bars: BarPoint[] = data.map((b) => ({
    x: b.totalPurchases,
    y: b.customerCount,
    overflow: b.isOverflowBucket,
    label: b.isOverflowBucket ? `${maxN}+` : String(b.totalPurchases),
    tooltipLines: [
      `${b.isOverflowBucket ? `${maxN}+` : b.totalPurchases} purchase${b.totalPurchases === 1 ? '' : 's'}`,
      `${fmtInt(b.customerCount)} customer${b.customerCount === 1 ? '' : 's'}`,
    ],
    selectionKey: b.isOverflowBucket ? 'overflow' : String(b.totalPurchases),
  }))
  const selectedKey =
    selection != null &&
    selection.kind === 'histogramBucket' &&
    selection.metricId === metricId
      ? selection.bucketKey
      : null
  return (
    <article className="metric-chart-card customer-value-card">
      <header className="metric-chart-header">
        <div className="metric-chart-titlewrap">
          <h3 className="metric-chart-title">Customer count by total purchases</h3>
          <HelpIcon text="One bar per total-purchases-to-date bucket; bar height = number of unique customers in scope with exactly that many purchases. The 'maxN+' bar aggregates the long tail. Log Y default lets you see one-and-done vs whales on the same chart. Use this to spot whether the business is fueled by many low-frequency customers or by a small loyal core. Click a bar (or Tab + Enter) to drill — the URL carries the selection so you can share the drilled state." />
        </div>
        <label className="subtle-copy customer-value-card-control">
          <input
            type="checkbox"
            checked={logScale}
            onChange={(e) => setLogScale(e.target.checked)}
          />{' '}
          log Y
        </label>
      </header>
      <BarChart
        bars={bars}
        logScale={logScale}
        yLabel="customers"
        selectedKey={selectedKey}
        onSelect={(key) => onSelect(key == null ? null : { kind: 'histogramBucket', metricId, bucketKey: key })}
      />
      <PurchaseCountPercentilesRow
        percentiles={percentiles}
        percentileValues={percentileValues}
        onPercentileChange={onPercentileChange}
      />
    </article>
  )
}

/** Compact, editable percentile readout for per-customer total
 *  purchase count, rendered under the histogram. Each chip's
 *  percentile is operator-adjustable (50..99); the value answers
 *  "X% of in-scope customers made at most this many purchases".
 *  Honours the same site / date / cohort-scope filters as the chart
 *  above it. */
function PurchaseCountPercentilesRow({
  percentiles,
  percentileValues,
  onPercentileChange,
}: {
  percentiles: ReadonlyArray<number>
  percentileValues: PurchaseCountPercentiles
  onPercentileChange: (index: number, next: number) => void
}) {
  return (
    <div className="customer-value-percentiles" role="group" aria-label="Purchase-count percentiles">
      <span className="customer-value-percentiles-title subtle-copy">
        Purchases per customer{' '}
        <HelpIcon text="Percentiles of the number of purchases per in-scope customer, over the same site / date / cohort-scope filters as this chart. e.g. p90 = 90% of customers made at most this many purchases. Edit any percentile (50–99) to re-query. Whole numbers (an actual observed purchase count, not interpolated)." />
      </span>
      {percentiles.map((p, i) => (
        <span key={i} className="customer-value-percentile-chip">
          <span className="customer-value-percentile-key">
            p
            <PercentileInput value={p} onCommit={(next) => onPercentileChange(i, next)} />
          </span>
          <span className="customer-value-percentile-val">
            {percentileValues[i]?.value == null ? '—' : fmtInt(percentileValues[i]!.value!)}
          </span>
        </span>
      ))}
    </div>
  )
}

/** Small number input for one percentile. Keeps a local draft so the
 *  operator can type freely (no clamp-mid-keystroke, no per-keystroke
 *  re-query); commits a clamped value to the parent on blur / Enter,
 *  which is what triggers the page refetch. */
function PercentileInput({
  value,
  onCommit,
}: {
  value: number
  onCommit: (next: number) => void
}) {
  const [draft, setDraft] = useState<string>(String(value))
  // Re-sync if the canonical value changes from elsewhere (e.g. the
  // server normalized it, or another control reset state).
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const n = Number(draft)
    if (Number.isFinite(n)) {
      const clamped = normalizePurchaseCountPercentile(n)
      setDraft(String(clamped))
      if (clamped !== value) onCommit(clamped)
    } else {
      setDraft(String(value))
    }
  }
  return (
    <input
      type="number"
      min={50}
      max={99}
      step={1}
      className="customer-value-percentile-input"
      value={draft}
      aria-label="percentile (50–99)"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ;(e.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}

function BasketByPurchaseNumberCard({
  data,
  maxN,
  basis,
  basisLabel,
  selection,
  onSelect,
}: {
  data: ReadonlyArray<BasketByPurchaseNumberPoint>
  maxN: number
  basis: MoneyBasis
  basisLabel: string
  selection: MetricSelection | null
  onSelect: (next: MetricSelection | null) => void
}) {
  const [aggKind, setAggKind] = useState<'avg' | 'median'>('avg')
  const metricId = CUSTOMER_VALUE_METRIC_IDS.basketByN
  const bars: BarPoint[] = data.map((b) => {
    const y =
      basis === 'gross_sales'
        ? aggKind === 'avg'
          ? b.avgGrossSalesDollars
          : b.medianGrossSalesDollars
        : basis === 'net_sales'
          ? aggKind === 'avg'
            ? b.avgNetSalesDollars
            : b.medianNetSalesDollars
          : aggKind === 'avg'
            ? b.avgGrossReceiptsDollars
            : null // no median for receipts (server doesn't compute)
    return {
      x: b.purchaseNumber,
      y: y ?? 0,
      lowSample: b.orderCount < 10,
      overflow: b.isOverflowBucket,
      label: b.isOverflowBucket ? `${maxN}+` : String(b.purchaseNumber),
      tooltipLines: [
        `Purchase #${b.isOverflowBucket ? `${maxN}+` : b.purchaseNumber}`,
        `${aggKind === 'avg' ? 'Avg' : 'Median'} basket: ${fmtMoneyOrDash(y)}`,
        `n = ${fmtInt(b.orderCount)} order${b.orderCount === 1 ? '' : 's'}`,
        b.orderCount < 10 ? '⚠ small sample' : '',
      ].filter(Boolean) as string[],
      selectionKey: b.isOverflowBucket ? 'overflow' : String(b.purchaseNumber),
    }
  })
  const selectedKey =
    selection != null &&
    selection.kind === 'histogramBucket' &&
    selection.metricId === metricId
      ? selection.bucketKey
      : null
  return (
    <article className="metric-chart-card customer-value-card">
      <header className="metric-chart-header">
        <div className="metric-chart-titlewrap">
          <h3 className="metric-chart-title">Basket size at purchase number N</h3>
          <HelpIcon
            text={`X axis = purchase ordinal (1st purchase, 2nd, …). Y axis = ${aggKind === 'avg' ? 'mean' : 'median'} ${basisLabel.toLowerCase()} of orders at that ordinal across all in-scope customers. Use this to see whether basket size grows (customers up-sell themselves as they become regulars), holds steady, or shrinks (returning customers cherry-pick). Hatched bars = small sample (<10 orders); survivorship bias inflates higher-N values. Click a bar (or Tab + Enter) to drill — the URL carries the selection so you can share the drilled state.`}
          />
        </div>
        <label className="subtle-copy customer-value-card-control">
          agg{' '}
          <select value={aggKind} onChange={(e) => setAggKind(e.target.value as 'avg' | 'median')}>
            <option value="avg">avg</option>
            <option value="median">median</option>
          </select>
        </label>
      </header>
      <BarChart
        bars={bars}
        logScale={false}
        yLabel="$"
        yFormatter={(v) => fmtMoney(v)}
        selectedKey={selectedKey}
        onSelect={(key) => onSelect(key == null ? null : { kind: 'histogramBucket', metricId, bucketKey: key })}
      />
    </article>
  )
}

function LifetimeByTotalPurchasesCard({
  data,
  maxN,
  basis,
  basisLabel,
  selection,
  onSelect,
}: {
  data: ReadonlyArray<LifetimeByTotalPurchasesPoint>
  maxN: number
  basis: MoneyBasis
  basisLabel: string
  selection: MetricSelection | null
  onSelect: (next: MetricSelection | null) => void
}) {
  const [aggKind, setAggKind] = useState<'avg' | 'median'>('avg')
  const metricId = CUSTOMER_VALUE_METRIC_IDS.lifetimeByTotal
  const bars: BarPoint[] = data.map((b) => {
    const y =
      basis === 'gross_sales'
        ? aggKind === 'avg'
          ? b.avgLifetimeGrossSalesDollars
          : b.medianLifetimeGrossSalesDollars
        : basis === 'net_sales'
          ? aggKind === 'avg'
            ? b.avgLifetimeNetSalesDollars
            : b.medianLifetimeNetSalesDollars
          : null // no receipts series here (lifetime by total purchases doesn't carry receipts)
    return {
      x: b.totalPurchases,
      y: y ?? 0,
      lowSample: b.customerCount < 10,
      overflow: b.isOverflowBucket,
      label: b.isOverflowBucket ? `${maxN}+` : String(b.totalPurchases),
      tooltipLines: [
        `${b.isOverflowBucket ? `${maxN}+` : b.totalPurchases} purchase${b.totalPurchases === 1 ? '' : 's'}`,
        `${aggKind === 'avg' ? 'Avg' : 'Median'} lifetime: ${fmtMoneyOrDash(y)}`,
        `n = ${fmtInt(b.customerCount)} customer${b.customerCount === 1 ? '' : 's'}`,
        b.customerCount < 10 ? '⚠ small sample' : '',
      ].filter(Boolean) as string[],
      selectionKey: b.isOverflowBucket ? 'overflow' : String(b.totalPurchases),
    }
  })
  const selectedKey =
    selection != null &&
    selection.kind === 'histogramBucket' &&
    selection.metricId === metricId
      ? selection.bucketKey
      : null
  return (
    <article className="metric-chart-card customer-value-card">
      <header className="metric-chart-header">
        <div className="metric-chart-titlewrap">
          <h3 className="metric-chart-title">Avg lifetime $ for customers who end up at N purchases</h3>
          <HelpIcon
            text={`For each total-purchases bucket N, compute lifetime-to-date ${basisLabel.toLowerCase()} per customer, then ${aggKind === 'avg' ? 'average' : 'take the median'} across all customers whose CURRENT total purchase count is exactly N (or ${maxN}+ for the last bucket). This is a cohort statistic, NOT a cumulative one — bucket N and bucket N+1 contain different customers, so the line is not guaranteed to be monotone. Small dips between adjacent buckets are real cohort variance (e.g., the 10-purchase cohort may happen to skew lower-AOV than the 9-purchase cohort) and not a bug. Use this to ask "if a customer becomes a 3x customer, how much money have they generally spent with us by then?". Receipt basis is not computed here (use the contribution card for receipts). Click a bar (or Tab + Enter) to drill — the URL carries the selection.`}
          />
        </div>
        <label className="subtle-copy customer-value-card-control">
          agg{' '}
          <select value={aggKind} onChange={(e) => setAggKind(e.target.value as 'avg' | 'median')}>
            <option value="avg">avg</option>
            <option value="median">median</option>
          </select>
        </label>
      </header>
      {basis === 'gross_receipts' ? (
        <p className="customer-value-no-data">Not computed for receipts basis — choose gross sales or net sales.</p>
      ) : (
        <BarChart
          bars={bars}
          logScale={false}
          yLabel="$"
          yFormatter={(v) => fmtMoney(v)}
          selectedKey={selectedKey}
          onSelect={(key) => onSelect(key == null ? null : { kind: 'histogramBucket', metricId, bucketKey: key })}
        />
      )}
    </article>
  )
}

function ContributionByPurchaseNumberCard({
  data,
  maxN,
  basis,
  basisLabel,
  selection,
  onSelect,
}: {
  data: ReadonlyArray<ContributionByPurchaseNumberPoint>
  maxN: number
  basis: MoneyBasis
  basisLabel: string
  selection: MetricSelection | null
  onSelect: (next: MetricSelection | null) => void
}) {
  // Default log-Y: the contribution histogram is dominated by the
  // 1st-purchase bar (everybody contributes a 1st purchase, only a
  // shrinking fraction make it to the Nth), so a linear scale buries
  // every bar past N=3 in the floor.
  const [logScale, setLogScale] = useState<boolean>(true)
  const metricId = CUSTOMER_VALUE_METRIC_IDS.contributionByN
  const bars: BarPoint[] = data.map((b) => {
    const y =
      basis === 'gross_sales'
        ? b.totalGrossSalesDollars
        : basis === 'net_sales'
          ? b.totalNetSalesDollars
          : b.totalGrossReceiptsDollars
    return {
      x: b.purchaseNumber,
      y,
      overflow: b.isOverflowBucket,
      label: b.isOverflowBucket ? `${maxN}+` : String(b.purchaseNumber),
      tooltipLines: [
        `Purchase #${b.isOverflowBucket ? `${maxN}+` : b.purchaseNumber}`,
        `${basisLabel}: ${fmtMoney(y)}`,
        `${fmtInt(b.orderCount)} order${b.orderCount === 1 ? '' : 's'}`,
      ],
      selectionKey: b.isOverflowBucket ? 'overflow' : String(b.purchaseNumber),
    }
  })
  const totalDollars = bars.reduce((acc, b) => acc + b.y, 0)
  const selectedKey =
    selection != null &&
    selection.kind === 'histogramBucket' &&
    selection.metricId === metricId
      ? selection.bucketKey
      : null
  return (
    <article className="metric-chart-card customer-value-card">
      <header className="metric-chart-header">
        <div className="metric-chart-titlewrap">
          <h3 className="metric-chart-title">$ contributed at purchase number N (in range)</h3>
          <HelpIcon
            text={`In the selected range only, total ${basisLabel.toLowerCase()} aggregated by the purchase ordinal of the order. Reads as "during this period, how much revenue came from 1st-time-ever orders vs 2nd vs 3rd…". If bar #1 dominates you're tourist-driven; if bars #2+ dominate you're loyalty-driven. The ordinal is always computed against the customer's FULL history through the end of the range, so a 5th-purchase event in the range correctly counts as 5, even if the 1st-4th purchases happened earlier. Click a bar (or Tab + Enter) to drill — the URL carries the selection.`}
          />
        </div>
        <span className="subtle-copy customer-value-card-control">
          total: {fmtMoney(totalDollars)}
        </span>
        <label className="subtle-copy customer-value-card-control">
          <input
            type="checkbox"
            checked={logScale}
            onChange={(e) => setLogScale(e.target.checked)}
          />{' '}
          log Y
        </label>
      </header>
      <BarChart
        bars={bars}
        logScale={logScale}
        yLabel="$"
        yFormatter={(v) => fmtMoney(v)}
        selectedKey={selectedKey}
        onSelect={(key) => onSelect(key == null ? null : { kind: 'histogramBucket', metricId, bucketKey: key })}
      />
    </article>
  )
}

// =========================== Cohort retention (v1.4 V4'3) =================

const DEFAULT_VISIBLE_COHORTS = 12

function CohortRetentionCard({
  rows,
  granularity,
  highlightMatcher,
}: {
  rows: ReadonlyArray<CohortRetentionRow>
  granularity: CustomerValueCohortGranularity
  /**
   * Issue #38 / task A6: when non-null, cohort lines whose rows do
   * not satisfy the matcher render at a fixed dim opacity so the
   * matched cohorts visibly pop. Null = legacy behaviour (every
   * cohort uses its standard newest→oldest opacity ramp).
   */
  highlightMatcher?: ((row: CohortRetentionRow) => boolean) | null
}) {
  const [showAll, setShowAll] = useState<boolean>(false)
  const [hover, setHover] = useState<
    { cohortKey: string; periodIndex: number; clientX: number; clientY: number } | null
  >(null)

  // Group rows by cohort, then sort cohorts oldest → newest so we
  // can pick the most recent N for the default view.
  const byCohort = useMemo(() => {
    const m = new Map<string, CohortRetentionRow[]>()
    for (const r of rows) {
      const list = m.get(r.cohortKey) ?? []
      list.push(r)
      m.set(r.cohortKey, list)
    }
    for (const list of m.values()) {
      list.sort((a, b) => a.periodIndex - b.periodIndex)
    }
    return Array.from(m.entries())
      .map(([cohortKey, points]) => ({ cohortKey, points }))
      .sort((a, b) => a.cohortKey.localeCompare(b.cohortKey))
  }, [rows])

  const visibleCohorts = useMemo(() => {
    if (showAll || byCohort.length <= DEFAULT_VISIBLE_COHORTS) return byCohort
    return byCohort.slice(byCohort.length - DEFAULT_VISIBLE_COHORTS)
  }, [byCohort, showAll])

  const periodLabel = granularity === 'week' ? 'weeks' : 'months'

  return (
    <article className="metric-chart-card customer-value-card">
      <header className="metric-chart-header">
        <div className="metric-chart-titlewrap">
          <h3 className="metric-chart-title">Cohort retention</h3>
          <HelpIcon
            text={`Each line is one acquisition cohort (customers whose 1st-ever purchase fell in that ${granularity}); Y axis = fraction of that cohort that purchased again in period N. Period 0 is the acquisition ${granularity} itself (always 100%). Most-recent cohort = most opaque; older cohorts fade. Lines that flatten high mean the cohort is sticking; lines that decay sharply mean churn. Cohort scope (top of page) filters which cohorts are considered.`}
          />
        </div>
        {byCohort.length > DEFAULT_VISIBLE_COHORTS ? (
          <label className="subtle-copy customer-value-card-control">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
            />{' '}
            show all {byCohort.length} cohorts
          </label>
        ) : null}
      </header>
      {visibleCohorts.length === 0 ? (
        <p className="customer-value-no-data">No cohorts in range.</p>
      ) : (
        <CohortRetentionChart
          cohorts={visibleCohorts}
          periodLabel={periodLabel}
          hover={hover}
          setHover={setHover}
          highlightMatcher={highlightMatcher ?? null}
        />
      )}
    </article>
  )
}

function CohortRetentionChart({
  cohorts,
  periodLabel,
  hover,
  setHover,
  highlightMatcher,
}: {
  cohorts: ReadonlyArray<{ cohortKey: string; points: ReadonlyArray<CohortRetentionRow> }>
  periodLabel: string
  hover:
    | { cohortKey: string; periodIndex: number; clientX: number; clientY: number }
    | null
  setHover: (
    h: { cohortKey: string; periodIndex: number; clientX: number; clientY: number } | null,
  ) => void
  /** See parent <CohortRetentionCard>. Null = no dimming. */
  highlightMatcher: ((row: CohortRetentionRow) => boolean) | null
}) {
  const width = 480
  const height = 220
  const marginTop = 8
  const marginRight = 12
  const marginBottom = 32
  const marginLeft = 56
  const plotW = width - marginLeft - marginRight
  const plotH = height - marginTop - marginBottom

  // X axis: 0..maxPeriod across all visible cohorts.
  // Y axis: 0..1 (pct). Tick at every 0.25.
  const maxPeriod = Math.max(
    1,
    ...cohorts.flatMap((c) => c.points.map((p) => p.periodIndex)),
  )
  const xTicks = niceXTicksLocal(0, maxPeriod)
  const yTicks = [0, 0.25, 0.5, 0.75, 1]

  const xScale = (v: number) => marginLeft + (v / Math.max(1, maxPeriod)) * plotW
  const yScale = (v: number) => marginTop + (1 - Math.min(1, Math.max(0, v))) * plotH

  // Most-recent cohort fully opaque; older cohorts fade. Linear ramp.
  const opacityFor = (idx: number, n: number) => {
    if (n === 1) return 1
    const t = idx / (n - 1) // oldest = 0, newest = 1
    return 0.25 + 0.75 * t
  }

  // Hover hit-target: nearest cohort point to the pointer.
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    const svg = e.currentTarget
    const rect = svg.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * width
    const py = ((e.clientY - rect.top) / rect.height) * height
    let best: { cohortKey: string; periodIndex: number; dist: number } | null = null
    for (const c of cohorts) {
      for (const p of c.points) {
        const dx = xScale(p.periodIndex) - px
        const dy = yScale(p.retentionPct) - py
        const dist = dx * dx + dy * dy
        if (best === null || dist < best.dist) {
          best = { cohortKey: c.cohortKey, periodIndex: p.periodIndex, dist }
        }
      }
    }
    if (best && best.dist < 400) {
      setHover({
        cohortKey: best.cohortKey,
        periodIndex: best.periodIndex,
        clientX: e.clientX,
        clientY: e.clientY,
      })
    } else {
      setHover(null)
    }
  }

  const hoveredRow = hover
    ? cohorts
        .find((c) => c.cohortKey === hover.cohortKey)
        ?.points.find((p) => p.periodIndex === hover.periodIndex) ?? null
    : null
  const hoveredCohortLabel = hover ? fmtCohortLabel(hover.cohortKey) : null

  return (
    <div className="customer-value-chart-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        className="customer-value-chart-svg"
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
      >
        {/* Y gridlines + labels */}
        {yTicks.map((t) => (
          <g key={`y-${t}`}>
            <line
              x1={marginLeft}
              x2={marginLeft + plotW}
              y1={yScale(t)}
              y2={yScale(t)}
              stroke="currentColor"
              opacity="0.12"
              strokeDasharray="4 4"
            />
            <text
              x={marginLeft - 6}
              y={yScale(t)}
              dy="0.32em"
              textAnchor="end"
              fontSize="10"
              fill="currentColor"
              opacity="0.7"
            >
              {`${Math.round(t * 100)}%`}
            </text>
          </g>
        ))}
        {/* X gridlines + labels */}
        {xTicks.map((t) => (
          <g key={`x-${t}`}>
            <line
              x1={xScale(t)}
              x2={xScale(t)}
              y1={marginTop}
              y2={marginTop + plotH}
              stroke="currentColor"
              opacity="0.08"
              strokeDasharray="4 4"
            />
            <text
              x={xScale(t)}
              y={marginTop + plotH + 14}
              textAnchor="middle"
              fontSize="10"
              fill="currentColor"
              opacity="0.7"
            >
              {t}
            </text>
          </g>
        ))}
        <text
          x={marginLeft + plotW / 2}
          y={height - 4}
          textAnchor="middle"
          fontSize="10"
          fill="currentColor"
          opacity="0.6"
        >
          {periodLabel} since acquisition
        </text>

        {/* Cohort lines. When highlightMatcher is non-null, a
            cohort counts as matched iff ANY of its rows match (since
            chips dim by cohortKey, this is effectively "the chip
            for this cohortKey is selected"). Non-matched cohorts
            render at a fixed dim opacity. */}
        {cohorts.map((c, idx) => {
          const path = c.points
            .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.periodIndex)} ${yScale(p.retentionPct)}`)
            .join(' ')
          const isHovered = hover?.cohortKey === c.cohortKey
          const matched =
            highlightMatcher == null ? true : c.points.some((p) => highlightMatcher(p))
          const baseOpacity = opacityFor(idx, cohorts.length)
          const opacity = matched ? baseOpacity : 0.12
          return (
            <g key={c.cohortKey}>
              <path
                d={path}
                fill="none"
                stroke="currentColor"
                strokeWidth={isHovered ? 2 : 1}
                opacity={opacity}
              />
            </g>
          )
        })}
      </svg>
      {hover && hoveredRow && hoveredCohortLabel ? (
        <FollowTooltip
          lines={[
            `Cohort: ${hoveredCohortLabel}`,
            `${periodLabel} since acquisition: ${hoveredRow.periodIndex}`,
            `Retained: ${fmtInt(hoveredRow.retainedCount)} / ${fmtInt(hoveredRow.cohortSize)}`,
            `Retention: ${(hoveredRow.retentionPct * 100).toFixed(1)}%`,
          ]}
          clientX={hover.clientX}
          clientY={hover.clientY}
        />
      ) : null}
    </div>
  )
}

function FirstSecondConversionCard({
  rows,
}: {
  rows: ReadonlyArray<FirstSecondConversionRow>
}) {
  // Pick which series the bars represent. Default = "within 30d" — the
  // operator's primary KPI for activation. Hover reveals all four.
  type Series = 'ever' | 'within30d' | 'within60d' | 'within90d'
  const [series, setSeries] = useState<Series>('within30d')

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => a.cohortKey.localeCompare(b.cohortKey)),
    [rows],
  )

  // Show every cohort (no max-12 cap — the sparkline is small and one
  // bar per cohort scans fine even with 26 weekly cohorts).
  const bars: BarPoint[] = sortedRows.map((r) => {
    const pct =
      series === 'ever'
        ? r.everPct
        : series === 'within30d'
          ? r.within30dPct
          : series === 'within60d'
            ? r.within60dPct
            : r.within90dPct
    return {
      x: 0, // unused for label-keyed bar chart
      y: pct,
      overflow: false,
      lowSample: r.cohortSize < 10,
      label: fmtCohortShortLabel(r.cohortKey),
      tooltipLines: [
        `Cohort: ${fmtCohortLabel(r.cohortKey)}`,
        `Cohort size: ${fmtInt(r.cohortSize)}`,
        `Ever → 2nd: ${fmtInt(r.everCount)} (${(r.everPct * 100).toFixed(1)}%)`,
        `Within 30d: ${fmtInt(r.within30dCount)} (${(r.within30dPct * 100).toFixed(1)}%)`,
        `Within 60d: ${fmtInt(r.within60dCount)} (${(r.within60dPct * 100).toFixed(1)}%)`,
        `Within 90d: ${fmtInt(r.within90dCount)} (${(r.within90dPct * 100).toFixed(1)}%)`,
        r.cohortSize < 10 ? '⚠ small cohort' : '',
      ].filter(Boolean) as string[],
    }
  })

  return (
    <article className="metric-chart-card customer-value-card">
      <header className="metric-chart-header">
        <div className="metric-chart-titlewrap">
          <h3 className="metric-chart-title">First → second purchase conversion</h3>
          <HelpIcon
            text="One bar per acquisition cohort. Bar height = fraction of cohort whose 2nd-ever purchase landed within the selected window (or ever, before the end of the date range). Hover any bar to see all four windows (ever / 30d / 60d / 90d). The strongest leading indicator of cohort LTV — 30d in particular is the operator's primary activation KPI. Hatched bars = small cohort (<10 customers); ratios may be noisy."
          />
        </div>
        <label className="subtle-copy customer-value-card-control">
          window{' '}
          <select value={series} onChange={(e) => setSeries(e.target.value as Series)}>
            <option value="within30d">within 30d</option>
            <option value="within60d">within 60d</option>
            <option value="within90d">within 90d</option>
            <option value="ever">ever</option>
          </select>
        </label>
      </header>
      {bars.length === 0 ? (
        <p className="customer-value-no-data">No cohorts in range.</p>
      ) : (
        <BarChart
          bars={bars}
          logScale={false}
          yLabel=""
          yFormatter={(v) => `${Math.round(v * 100)}%`}
          yDomainMax={1}
        />
      )}
    </article>
  )
}

/** Minimal local X-tick helper for the retention chart — we don't pull
 *  in `niceXTicks` because the retention X axis is a strict integer
 *  period index (0..N) and we want tick-at-each-integer behaviour up
 *  to 12, then every 2nd beyond that. */
function niceXTicksLocal(min: number, max: number): number[] {
  const span = Math.max(1, max - min)
  const step = span <= 12 ? 1 : span <= 26 ? 2 : Math.ceil(span / 12)
  const out: number[] = []
  for (let v = Math.ceil(min); v <= Math.floor(max); v += step) out.push(v)
  if (out.length === 0) out.push(min)
  return out
}

function fmtCohortLabel(iso: string): string {
  // e.g. 2025-W47 (Mon 2025-11-17) for weekly, 2025-11 for monthly.
  // We don't know granularity from the row itself, so we format the
  // ISO date in a human-friendly way that works for both. NY-local
  // (canon: "Always use NY timezones for aggregate and display") so
  // a cohort whose acquisition Monday is Nov 17 NY doesn't drift to
  // Nov 16 / Nov 18 depending on the browser timezone.
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return nyIsoDate(d.getTime())
}
function fmtCohortShortLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return nyMonthDaySlash(d.getTime())
}

// =========================== Generic bar chart =============================

interface BarPoint {
  readonly x: number
  readonly y: number
  readonly overflow: boolean
  readonly lowSample?: boolean
  readonly label: string
  readonly tooltipLines: ReadonlyArray<string>
  /**
   * v1.4 V4'4: optional stable key for the drill-selection URL state.
   * When set together with the chart's `onSelect`, this bar becomes
   * keyboard-focusable, clicking emits this key, and the bar gets a
   * 2px stroke when `selectedKey === selectionKey`. Per-bar so the
   * histogram card can encode the bucket identity (e.g. "3" / "overflow").
   */
  readonly selectionKey?: string
}

function BarChart({
  bars,
  logScale,
  yLabel,
  yFormatter,
  yDomainMax,
  selectedKey,
  onSelect,
}: {
  bars: ReadonlyArray<BarPoint>
  logScale: boolean
  yLabel: string
  yFormatter?: (v: number) => string
  /**
   * Optional fixed upper bound for the linear Y domain. Used by the
   * v1.4 V4'3 first→second conversion sparkline so the bars always
   * scale against 100% (the natural percentage ceiling) instead of
   * the largest observed value. Ignored for log-scale.
   */
  yDomainMax?: number
  /**
   * v1.4 V4'4: currently-selected bar key (matches one of
   * `bars[i].selectionKey`); `null` = no selection. When set, the
   * matching bar renders with a 2px stroke + label.
   */
  selectedKey?: string | null
  /**
   * v1.4 V4'4: click/Enter/Space handler. Receives the bar's
   * `selectionKey`; pass `null` to deselect (BarChart calls this with
   * the same key on a re-click to toggle off). Bars without a
   * `selectionKey` are NOT focusable / clickable regardless.
   */
  onSelect?: (selectionKey: string | null) => void
}) {
  // Hover state carries the bar index AND the most recent pointer
  // position so the tooltip can be rendered as a viewport-clamped
  // fixed-position panel that follows the mouse instead of sitting
  // pinned over a fixed corner of the chart (which on desktop
  // happens to cover whichever bar the operator was inspecting).
  const [hover, setHover] = useState<
    { idx: number; clientX: number; clientY: number } | null
  >(null)

  // Sticky-tooltip plumbing for touch — pattern matches MetricChart.
  // Mouse pointerleave clears immediately; touch/pen pointerleave
  // delays the clear by 3500ms so the browser's long-press handler
  // doesn't eat the touch and scroll the page.
  const lastPointerTypeRef = useRef<string>('mouse')
  const stickyTimerRef = useRef<number | null>(null)
  const cancelStickyClear = useCallback(() => {
    if (stickyTimerRef.current !== null) {
      globalThis.clearTimeout(stickyTimerRef.current)
      stickyTimerRef.current = null
    }
  }, [])
  useEffect(() => () => cancelStickyClear(), [cancelStickyClear])

  if (bars.length === 0) {
    return <p className="customer-value-no-data">No data in range.</p>
  }

  const width = 480
  const height = 220
  const marginTop = 8
  const marginRight = 12
  const marginBottom = 32
  const marginLeft = 56
  const plotW = width - marginLeft - marginRight
  const plotH = height - marginTop - marginBottom

  // Y scale: log or linear. Clamp values to [1, …] when log so zero
  // doesn't disappear.
  const observedMax = Math.max(1, ...bars.map((b) => b.y))
  const rawMax =
    logScale || yDomainMax === undefined ? observedMax : Math.max(yDomainMax, observedMax)
  const yMin = logScale ? 1 : 0
  const yMax = rawMax
  const yScale = (v: number): number => {
    if (logScale) {
      const lv = Math.log10(Math.max(1, v))
      const lo = Math.log10(Math.max(1, yMin))
      const hi = Math.log10(Math.max(1, yMax))
      const t = hi === lo ? 0 : (lv - lo) / (hi - lo)
      return marginTop + plotH - t * plotH
    }
    const t = yMax === yMin ? 0 : (v - yMin) / (yMax - yMin)
    return marginTop + plotH - t * plotH
  }

  // X positions: equally spaced bars.
  const barCount = bars.length
  const bandW = plotW / Math.max(1, barCount)
  const barW = bandW * 0.78
  const xCenter = (i: number): number => marginLeft + bandW * (i + 0.5)

  // Y axis ticks — log uses 10^k ticks; linear uses niceYTicks.
  const yTicks: { value: number; label: string }[] = logScale
    ? makeLogTicks(yMin, yMax).map((v) => ({
        value: v,
        label: yFormatter ? yFormatter(v) : compactInt(v),
      }))
    : (() => {
        const t = niceYTicks(0, yMax, 5)
        return t.ticks.map((v) => ({
          value: v,
          label: yFormatter ? yFormatter(v) : formatYTick(v, t.fractionDigits),
        }))
      })()

  const labelEveryN = Math.max(1, Math.ceil(barCount / 14))

  const hoveredBar = hover === null ? null : bars[hover.idx] ?? null

  return (
    <div className="metric-chart-svg-wrap customer-value-chart-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        className="metric-chart-svg"
        role="img"
        aria-label={`Bar chart, ${barCount} buckets`}
      >
        {/* Y axis gridlines + labels */}
        {yTicks.map((t, i) => {
          const y = yScale(t.value)
          return (
            <g key={`yt-${i}`}>
              <line
                x1={marginLeft}
                x2={width - marginRight}
                y1={y}
                y2={y}
                stroke="#eee"
                strokeDasharray="2 3"
              />
              <text
                x={marginLeft - 6}
                y={y + 4}
                fontSize="10"
                fill="#555"
                textAnchor="end"
              >
                {t.label}
              </text>
            </g>
          )
        })}
        {/* Axis frame */}
        <line
          x1={marginLeft}
          x2={width - marginRight}
          y1={marginTop + plotH}
          y2={marginTop + plotH}
          stroke="#999"
        />
        <line x1={marginLeft} x2={marginLeft} y1={marginTop} y2={marginTop + plotH} stroke="#999" />
        {/* Bars */}
        {bars.map((b, i) => {
          const cx = xCenter(i)
          const top = yScale(Math.max(b.y, yMin))
          const bottom = yScale(yMin)
          const h = Math.max(0, bottom - top)
          const x = cx - barW / 2
          const fill = b.overflow ? '#9467bd' : '#1f77b4'
          const isHover = hover?.idx === i
          // v1.4 V4'4: selection wiring. A bar is "drillable" when it
          // carries a selectionKey AND the chart has an onSelect cb.
          // Selected bars render a 2px stroke (regardless of hover).
          const drillable = onSelect != null && b.selectionKey != null
          const isSelected = drillable && selectedKey != null && selectedKey === b.selectionKey
          const strokeColour = isSelected ? '#000' : isHover ? '#000' : 'none'
          const strokeWidth = isSelected ? 2 : isHover ? 1 : 0
          const onActivate = (): void => {
            if (!drillable || b.selectionKey === undefined) return
            // Toggle: re-clicking the selected bar clears the selection.
            onSelect!(isSelected ? null : b.selectionKey)
          }
          return (
            <g key={`b-${i}`}>
              <rect
                x={x}
                y={top}
                width={barW}
                height={h}
                fill={fill}
                opacity={isHover || isSelected ? 1 : 0.85}
                stroke={strokeColour}
                strokeWidth={strokeWidth}
              />
              {b.lowSample ? (
                // Diagonal hatch overlay for small-sample bars.
                <rect
                  x={x}
                  y={top}
                  width={barW}
                  height={h}
                  fill="url(#cv-bar-hatch)"
                  opacity={0.6}
                />
              ) : null}
              {/* Click/hover capture surface — wider than bar for easy
                  touch. When the chart is drillable AND this bar
                  carries a selectionKey, the rect becomes a focusable
                  button (role + tabindex + key handler) so keyboard
                  users can Tab → Enter → drill. Escape clears at the
                  card level (see CustomerValueBody). */}
              <rect
                x={marginLeft + bandW * i}
                y={marginTop}
                width={bandW}
                height={plotH}
                fill="transparent"
                role={drillable ? 'button' : undefined}
                tabIndex={drillable ? 0 : undefined}
                aria-pressed={drillable ? isSelected : undefined}
                aria-label={
                  drillable ? `Drill into bucket ${b.label}` : undefined
                }
                style={drillable ? { cursor: 'pointer', outline: 'none' } : undefined}
                onClick={drillable ? onActivate : undefined}
                onKeyDown={
                  drillable
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onActivate()
                        }
                      }
                    : undefined
                }
                onPointerEnter={(e) => {
                  lastPointerTypeRef.current = e.pointerType
                  cancelStickyClear()
                  setHover({ idx: i, clientX: e.clientX, clientY: e.clientY })
                }}
                onPointerDown={(e) => {
                  lastPointerTypeRef.current = e.pointerType
                  cancelStickyClear()
                  setHover({ idx: i, clientX: e.clientX, clientY: e.clientY })
                }}
                onPointerMove={(e) => {
                  lastPointerTypeRef.current = e.pointerType
                  cancelStickyClear()
                  setHover({ idx: i, clientX: e.clientX, clientY: e.clientY })
                }}
                onPointerLeave={() => {
                  if (
                    lastPointerTypeRef.current === 'touch' ||
                    lastPointerTypeRef.current === 'pen'
                  ) {
                    cancelStickyClear()
                    stickyTimerRef.current = globalThis.setTimeout(() => {
                      stickyTimerRef.current = null
                      setHover(null)
                    }, 3500)
                    return
                  }
                  setHover(null)
                }}
              />
            </g>
          )
        })}
        {/* X axis labels (every Nth to avoid pile-up) */}
        {bars.map((b, i) => {
          if (i % labelEveryN !== 0 && i !== bars.length - 1) return null
          const cx = xCenter(i)
          return (
            <text
              key={`xl-${i}`}
              x={cx}
              y={marginTop + plotH + 14}
              fontSize="10"
              fill="#555"
              textAnchor="middle"
            >
              {b.label}
            </text>
          )
        })}
        {/* Y axis label */}
        <text
          x={marginLeft - 44}
          y={marginTop + plotH / 2}
          fontSize="10"
          fill="#777"
          textAnchor="middle"
          transform={`rotate(-90, ${marginLeft - 44}, ${marginTop + plotH / 2})`}
        >
          {yLabel}
        </text>
        <defs>
          <pattern
            id="cv-bar-hatch"
            patternUnits="userSpaceOnUse"
            width="6"
            height="6"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="6" stroke="#fff" strokeWidth="1" />
          </pattern>
        </defs>
      </svg>
      {hoveredBar && hover ? (
        <FollowTooltip
          lines={hoveredBar.tooltipLines}
          clientX={hover.clientX}
          clientY={hover.clientY}
        />
      ) : null}
    </div>
  )
}

/**
 * Tooltip rendered as a viewport-clamped fixed-position panel that
 * follows the cursor. Offset 14px from the pointer so the cursor
 * itself isn't covered; flipped to the left / above when the
 * default placement would clip past the right / bottom edge.
 */
function FollowTooltip({
  lines,
  clientX,
  clientY,
}: {
  lines: ReadonlyArray<string>
  clientX: number
  clientY: number
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const margin = 6
    const offset = 14
    // Default: place below-right of the pointer.
    let left = clientX + offset
    let top = clientY + offset
    if (left + rect.width + margin > vw) left = clientX - offset - rect.width
    if (top + rect.height + margin > vh) top = clientY - offset - rect.height
    // Final clamp so nothing pokes off-screen on small viewports.
    if (left < margin) left = margin
    if (top < margin) top = margin
    setPos({ left, top })
  }, [clientX, clientY, lines])
  return (
    <div
      ref={ref}
      className="customer-value-tooltip"
      // Hide until the layout pass writes a real position to avoid
      // a brief flash at (0,0) on first render.
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
      role="tooltip"
    >
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  )
}

function makeLogTicks(min: number, max: number): number[] {
  const lo = Math.floor(Math.log10(Math.max(1, min)))
  const hi = Math.ceil(Math.log10(Math.max(1, max)))
  const out: number[] = []
  for (let p = lo; p <= hi; p++) out.push(Math.pow(10, p))
  return out
}

// =========================== Missing data section ==========================

function MissingDataSection({ cards }: { cards: ReadonlyArray<CustomerValueMissingDataCard> }) {
  if (cards.length === 0) return null
  return (
    <details className="metrics-pending-section" open={false}>
      <summary>
        <span className="metrics-section-title">Missing data</span>{' '}
        <span className="subtle-copy">
          ({cards.length} card{cards.length === 1 ? '' : 's'} blocked on ingest / modeling work)
        </span>
      </summary>
      <p className="subtle-copy metrics-pending-explainer">
        These visualizations are intentionally <strong>not</strong> rendered with fabricated data.
        Each card explains what source would unblock it.
      </p>
      <div className="metrics-grid">
        {cards.map((c) => (
          <article key={c.id} className="metric-chart-card metric-chart-card--pending">
            <header className="metric-chart-header">
              <div className="metric-chart-titlewrap">
                <h3 className="metric-chart-title">{c.title}</h3>
                <span className="metric-chart-pending-badge">MISSING DATA</span>
              </div>
            </header>
            <div className="metric-chart-pending-body">
              <p className="subtle-copy">
                <strong>Why missing:</strong> {c.whyMissing}
              </p>
              <p className="subtle-copy">
                <strong>Needed source:</strong> {c.neededSource}
              </p>
              <p className="subtle-copy">
                <strong>Would unlock:</strong>
                <ul>
                  {c.unlockedMetrics.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </p>
              {c.blockedByUrl ? (
                <p className="subtle-copy">
                  Tracked in{' '}
                  <a href={c.blockedByUrl} target="_blank" rel="noreferrer noopener">
                    {c.blockedByUrl.replace(/^https?:\/\//, '')}
                  </a>
                </p>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </details>
  )
}

// =========================== Formatting helpers ============================

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString()
}
function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 10_000) {
    return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  }
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}
function fmtMoneyOrDash(n: number | null): string {
  return n === null ? '—' : fmtMoney(n)
}
function fmtPctOrDash(n: number | null): string {
  return n === null ? '—' : `${(n * 100).toFixed(1)}%`
}
function compactInt(v: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v)
}
function toLocalDtInput(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`
}
