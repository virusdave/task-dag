import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { z } from 'zod'

import {
  MetricQueryResponseSchema,
  type MetricAggregation,
  type MetricAnnotationRecord,
  type MetricDatum,
  type MetricDefSummary,
  type MetricGhostPeriod,
  type MetricQueryResponse,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { nyLongDateTime, nyParts, nyShortDateTime } from '../../app/nyTime.js'

import type { CatalogFilterSelection } from './CatalogFilterBar.js'
import { GhostRidersSvg } from './GhostRidersSvg.js'
import { useTimeAxis, type TimeWindow } from './TimeAxisContext.js'
import {
  bucketXTicks,
  crossMarkerPath,
  formatXTick,
  formatYTick,
  niceYTicks,
  partialAwareSplinePath,
  smoothedPath,
} from './gridlines.js'
import { computeCompactDomain } from './scatterAutoZoom.js'
import { ScatterViewToolbar } from './ScatterViewToolbar.js'
import {
  useScatterZoom,
  type ScatterInteractionMode,
  type ScatterZoomTool,
  type ZoomView,
} from './scatterZoom.js'
import {
  computeLineYRange,
  resolveYAxisBaseline,
  Y_AXIS_BASELINE_CHOICES,
  Y_AXIS_BASELINE_CHOICE_LABEL,
  Y_AXIS_BASELINE_PAGE_DEFAULT_LABEL,
  type YAxisBaseline,
  type YAxisBaselineChoice,
  type YAxisBaselinePageDefault,
} from './yAxisBaseline.js'

// We re-fetch the annotation list after every mutation, so we don't
// need to consume the response payload — a passthrough schema lets us
// stay out of the strict-zod return-type loop.
const PassthroughSchema = z.unknown()

/**
 * Small ! help-icon button shown next to a chart title. Hover or
 * focus reveals a popover with `text`; on touch devices the icon is
 * clickable and toggles the same popover. The native `title`
 * attribute is set as an accessible fallback for screen-reader users.
 *
 * The popover uses `position: fixed` with a JS-driven viewport-aware
 * layout (see `useViewportClampedPopover`) so it never clips off the
 * edge of a mobile screen — which the pure-CSS `translateX(-50%)`
 * approach was doing on narrow viewports.
 */
export function HelpIcon({ text }: { text: string }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const popRef = useRef<HTMLSpanElement | null>(null)
  const hoverInsideRef = useRef<boolean>(false)
  // Remembers how the most recent interaction arrived so the click
  // handler can tell a real touch/pen TAP apart from the synthetic
  // click a mouse fires after a hover. Defaults to 'mouse' (desktop).
  const lastPointerTypeRef = useRef<string>('mouse')
  useEffect(() => {
    if (!open) return
    // Close when the operator taps/clicks anywhere outside the icon or
    // its popover. `pointerdown` (not `mousedown`) so a touch tap-away
    // closes it on mobile too — mobile only synthesises `mousedown`
    // after a delay, and not at all while scrolling.
    const onDocPointerDown = (e: PointerEvent): void => {
      if (
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node) &&
        popRef.current &&
        !popRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onDocPointerDown)
    return () => document.removeEventListener('pointerdown', onDocPointerDown)
  }, [open])
  useViewportClampedPopover(open, anchorRef, popRef)
  if (!text || text.trim() === '') return null
  return (
    <span
      className={`metric-chart-help ${open ? 'is-open' : ''}`}
      ref={anchorRef}
      onPointerDown={(e) => {
        lastPointerTypeRef.current = e.pointerType || 'mouse'
      }}
      onClick={(e) => {
        e.stopPropagation()
        // On a MOUSE the popover is already driven by hover (pointer
        // enter/leave below), and the browser also fires a `click`
        // right after a tap — if we toggled here unconditionally, a
        // mobile tap would open via the synthetic pointerenter and then
        // immediately close via this click, so the popover never stuck.
        // Only treat touch/pen taps (no hover) as a toggle.
        if (lastPointerTypeRef.current === 'mouse') return
        setOpen((v) => !v)
      }}
      onPointerEnter={(e) => {
        // Hover-to-open is a mouse affordance only. Touch/pen "enter"
        // events fire on tap and must NOT auto-open (the click toggle
        // owns touch).
        if (e.pointerType !== 'mouse') return
        hoverInsideRef.current = true
        setOpen(true)
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'mouse') return
        hoverInsideRef.current = false
        // Only auto-close on mouse-leave; touch-tap toggles persist
        // until the operator taps elsewhere (handled by onDocPointerDown).
        setTimeout(() => {
          if (!hoverInsideRef.current) setOpen(false)
        }, 80)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          setOpen((v) => !v)
        } else if (e.key === 'Escape') {
          setOpen(false)
        }
      }}
      tabIndex={0}
      role="button"
      aria-label="Help: what does this chart show?"
      aria-expanded={open}
      title={text}
    >
      <span className="metric-chart-help-glyph" aria-hidden="true">!</span>
      <span
        className="metric-chart-help-popover"
        role="tooltip"
        ref={popRef}
        // Inline default: hidden until useViewportClampedPopover writes
        // a real top/left after measuring the anchor. Without this
        // the popover briefly flashes at (0,0) on first open.
        style={{ visibility: open ? undefined : 'hidden' }}
      >
        {text}
      </span>
    </span>
  )
}

/**
 * Positions a `position: fixed` popover near the anchor element,
 * clamped to the visible viewport so neither edge of the popover ever
 * extends off-screen.
 *
 * Algorithm:
 *   * Default: place the popover BELOW the anchor and centered on it.
 *   * If that would extend past the bottom edge by more than the
 *     anchor's own height, flip to ABOVE the anchor instead.
 *   * Clamp horizontally so a `margin` of 8px is kept from both
 *     viewport edges. The arrow / pointer-style chrome therefore has
 *     to be drawn via CSS pseudo-elements anchored to the popover
 *     body, not absolutely on the anchor — easier for the operator
 *     to read on a phone than a pointer that drifts off-side.
 *
 * Repositioned on `open` flip, window resize, and `scroll` (capture
 * phase, so internal scroll containers also re-trigger).
 */
function useViewportClampedPopover(
  open: boolean,
  anchorRef: React.RefObject<HTMLElement>,
  popRef: React.RefObject<HTMLElement>,
): void {
  useLayoutEffect(() => {
    if (!open) return
    const anchor = anchorRef.current
    const pop = popRef.current
    if (!anchor || !pop) return
    const place = (): void => {
      const aRect = anchor.getBoundingClientRect()
      // Force `position: fixed` for the duration of the popover's life.
      // Done inline so the CSS rule can stay opt-in (other call-sites
      // of `.metric-chart-help-popover` keep their nicer hover-only
      // behaviour if they ever come back).
      pop.style.position = 'fixed'
      pop.style.transform = 'none'
      pop.style.left = '0px'
      pop.style.top = '0px'
      pop.style.maxWidth = `${Math.min(320, window.innerWidth - 16)}px`
      // Measure AFTER setting maxWidth so wrapping reflects the
      // actual rendered width.
      const pRect = pop.getBoundingClientRect()
      const margin = 8
      let top = aRect.bottom + 6
      // Flip above if it would extend past the bottom edge.
      if (top + pRect.height > window.innerHeight - margin) {
        const aboveTop = aRect.top - pRect.height - 6
        if (aboveTop >= margin) top = aboveTop
      }
      let left = aRect.left + aRect.width / 2 - pRect.width / 2
      if (left < margin) left = margin
      if (left + pRect.width > window.innerWidth - margin) {
        left = window.innerWidth - margin - pRect.width
      }
      pop.style.top = `${top}px`
      pop.style.left = `${left}px`
      pop.style.visibility = 'visible'
    }
    place()
    const onResize = (): void => place()
    const onScroll = (): void => place()
    window.addEventListener('resize', onResize)
    // Capture-phase scroll so nested scrollable parents also reposition.
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
}

const FALLBACK_COLOURS = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b']
const TAG_COLOURS: Record<string, string> = {
  incident: '#d62728',
  change: '#1f77b4',
  launch: '#2ca02c',
  experiment: '#9467bd',
  sale: '#ff7f0e',
  note: '#888888',
}

const POINTER_MOVE_PX_THRESHOLD = 4
const TOUCH_MOVE_PX_THRESHOLD = 10
const FETCH_DEBOUNCE_MS = 200

/**
 * How a multi-series LINE chart stacks its series. Only meaningful for
 * line metrics with ≥ 2 numeric series; ignored entirely for scatter
 * (chartType='scatter') and for single-series line charts.
 *
 *   - `none`    — default. Each series is its own polyline; the Y axis
 *                 reflects raw series values.
 *   - `stacked` — each series fills a band on top of the cumulative
 *                 sum of the series before it (declared order). The Y
 *                 axis is the cumulative total per bucket. Negative /
 *                 null values are treated as 0 inside the stack.
 *   - `percent` — like `stacked`, but every bucket's total is
 *                 normalized to 100. The Y axis is 0–100% and each
 *                 series shows its share of the per-bucket whole.
 *                 Buckets whose total is 0 are drawn as a single
 *                 zero-thickness slice (no series wins the share).
 */
export type MetricStackMode = 'none' | 'stacked' | 'percent'

export const METRIC_STACK_MODES: ReadonlyArray<MetricStackMode> = ['none', 'stacked', 'percent']

const STACK_MODE_LABEL: Record<MetricStackMode, string> = {
  none: 'off',
  stacked: 'stacked',
  percent: '100%',
}

export interface MetricChartProps {
  readonly metric: MetricDefSummary
  /** Comma-separated list (the API parses to an array). */
  readonly sitesParam: string
  /** Page-default aggregation; the chart's own aggregation override wins if set. */
  readonly defaultAgg: MetricAggregation
  /**
   * Page-default stack mode for line charts. The chart's own stack-mode
   * override wins when set. Ignored when the metric is a scatter (or has
   * fewer than two series).
   */
  readonly defaultStackMode?: MetricStackMode
  /**
   * Page-wide Y-axis baseline default for non-scatter line charts. The
   * chart's own per-chart override ('page' | 'zero' | 'data') wins; when
   * it defers ('page') this default decides. Defaults to 'per-chart'
   * (no page-wide policy → float).
   */
  readonly yBaselineDefault?: YAxisBaselinePageDefault
  /**
   * Currently-visible annotations (already filtered to scope=global +
   * `metric:<this.id>` upstream). Re-renders when the parent re-fetches.
   */
  readonly annotations: ReadonlyArray<MetricAnnotationRecord>
  readonly onAnnotationsChanged: () => void
  /**
   * `card` is the small dashboard variant — fixed compact height, no pan/zoom/annotate
   * toolbar, click-to-expand affordance. `expanded` is the full focus panel — full
   * interactive surface (pan/zoom, annotate, lock/unlock, per-chart agg override).
   */
  readonly variant?: 'card' | 'expanded'
  /** Card-only: invoked when the operator clicks/taps to expand the metric. */
  readonly onExpand?: () => void
  /**
   * Shared catalog-scope filter selection (category / subcategory /
   * brand / size). Forwarded as URL params for the dimensions this
   * metric's `supportedCatalogFilters` declares; dimensions outside
   * that set are omitted (no silent server-side no-op) AND, if any
   * are selected, a "filters not applied" badge is rendered in the
   * chart header so the operator knows this card is intentionally
   * not narrowed.
   */
  readonly catalogFilterSelection?: CatalogFilterSelection
}

export function MetricChart({
  metric,
  sitesParam,
  defaultAgg,
  defaultStackMode = 'none',
  yBaselineDefault = 'per-chart',
  annotations,
  onAnnotationsChanged,
  variant = 'expanded',
  onExpand,
  catalogFilterSelection,
}: MetricChartProps) {
  const sharedAxis = useTimeAxis()
  const [locked, setLocked] = useState(true)
  const [localWindow, setLocalWindow] = useState<TimeWindow>(sharedAxis.window)
  const window = locked ? sharedAxis.window : localWindow
  const setWindow = locked ? sharedAxis.setWindow : setLocalWindow

  const [aggOverride, setAggOverride] = useState<MetricAggregation | null>(null)
  const effectiveAgg = aggOverride ?? defaultAgg
  const agg = metric.supportedAggregations.includes(effectiveAgg)
    ? effectiveAgg
    : metric.defaultAggregation
  // Aggregation has no semantic meaning for a scatter chart (the X axis
  // isn't time, it's the first series' value). Hide the per-chart dropdown
  // for scatter so the operator can't accidentally rebucket weather dots
  // into a no-op "weekly high temperature" cohort. The dashboard-level
  // page-agg control is hidden in the same situation by the tab config.
  const aggControlApplicable = metric.chartType !== 'scatter'

  // Stack mode applies only to multi-series LINE charts; the dropdown
  // is hidden (and the effective mode forced to 'none') otherwise so
  // we don't expose a no-op control on scatter / single-series cards.
  const stackModeApplicable =
    metric.chartType !== 'scatter' && metric.series.length >= 2
  const [stackModeOverride, setStackModeOverride] = useState<MetricStackMode | null>(null)
  const stackMode: MetricStackMode = stackModeApplicable
    ? stackModeOverride ?? defaultStackMode
    : 'none'

  // Y-axis baseline (line charts only). The per-chart control is only
  // meaningful in 'none' mode — stacked / percent area charts always
  // include zero — so we hide it otherwise. Scatter charts have their
  // own auto-zoom axis logic and never see this control.
  const yBaselineApplicable = metric.chartType !== 'scatter' && stackMode === 'none'
  const [yBaselineOverride, setYBaselineOverride] = useState<YAxisBaselineChoice>('page')
  const yBaseline: YAxisBaseline = resolveYAxisBaseline(yBaselineOverride, yBaselineDefault)

  // Ghost Riders overlay — only offered for additive line metrics that
  // declare supports.ghostRiders. When active, the chart renders the
  // current period's cumulative trajectory overlaid against the prior
  // N periods (aligned on phase-within-period) instead of the normal
  // single timeline.
  const ghostEligible =
    metric.chartType !== 'scatter' && metric.supports?.ghostRiders === true
  const [overlayMode, setOverlayMode] = useState<'off' | 'ghost'>('off')
  const ghostActive = ghostEligible && overlayMode === 'ghost'
  // The wheel-zoom toggle only governs the time-series `ChartSvg`. Scatter
  // has its own in-chart pan/zoom toolbar and Ghost Riders has no zoom, so
  // the header toggle would be inert there — don't render it.
  const wheelZoomApplicable = metric.chartType !== 'scatter' && !ghostActive
  const [ghostPeriod, setGhostPeriod] = useState<MetricGhostPeriod>(() =>
    effectiveAgg === 'hour' ? 'day' : 'week',
  )
  const [ghostLookback, setGhostLookback] = useState<number>(4)

  const [response, setResponse] = useState<MetricQueryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [annotateMode, setAnnotateMode] = useState(false)
  // Plain-wheel zoom is OFF by default: with it on, scrolling the page
  // accidentally zooms any chart the cursor happens to stop over. The
  // operator opts in via the toolbar toggle. Ctrl/⌘+wheel and pinch
  // still zoom for power users regardless of this flag.
  const [zoomEnabled, setZoomEnabled] = useState(false)

  // Per-dimension CSV catalog-filter params. We forward each
  // dimension ONLY when the metric declares it in
  // supportedCatalogFilters — the route returns 400 for unsupported
  // dimensions and silently dropping them client-side would let the
  // operator believe a card was narrowed when it wasn't.
  const supportedDims = useMemo(
    () => new Set(metric.supportedCatalogFilters),
    [metric.supportedCatalogFilters],
  )
  const categoryParam =
    supportedDims.has('category') && catalogFilterSelection
      ? Array.from(catalogFilterSelection.categoryIds).join(',')
      : ''
  const subcategoryParam =
    supportedDims.has('subcategory') && catalogFilterSelection
      ? Array.from(catalogFilterSelection.subcategoryIds).join(',')
      : ''
  const brandParam =
    supportedDims.has('brand') && catalogFilterSelection
      ? Array.from(catalogFilterSelection.brandIds).join(',')
      : ''
  const sizeParam =
    supportedDims.has('size') && catalogFilterSelection
      ? Array.from(catalogFilterSelection.sizes).join(',')
      : ''

  // True when the operator has at least one catalog filter selected
  // AND this metric ignores at least one of those dimensions. We
  // render a header badge in that case so the lack of filtering is
  // visible (rather than the chart looking unfiltered for no reason).
  const filtersNotApplied = useMemo(() => {
    if (!catalogFilterSelection) return false
    const selected: Array<[keyof CatalogFilterSelection, 'category' | 'subcategory' | 'brand' | 'size']> = [
      ['categoryIds', 'category'],
      ['subcategoryIds', 'subcategory'],
      ['brandIds', 'brand'],
      ['sizes', 'size'],
    ]
    for (const [field, dim] of selected) {
      if (catalogFilterSelection[field].size > 0 && !supportedDims.has(dim)) return true
    }
    return false
  }, [catalogFilterSelection, supportedDims])

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams()
    if (sitesParam) params.set('sites', sitesParam)
    params.set('to', new Date(window.toMs).toISOString())
    if (ghostActive) {
      // Ghost mode: the server derives the fine bucket agg + lookback
      // window from period/lookback; `from`/`agg` are ignored. `to`
      // (above) is the anchor for the current period.
      params.set('overlay', 'ghost')
      params.set('ghostPeriod', ghostPeriod)
      params.set('ghostLookback', String(ghostLookback))
    } else {
      params.set('from', new Date(window.fromMs).toISOString())
      params.set('agg', agg)
    }
    if (categoryParam) params.set('categoryIds', categoryParam)
    if (subcategoryParam) params.set('subcategoryIds', subcategoryParam)
    if (brandParam) params.set('brandIds', brandParam)
    if (sizeParam) params.set('sizes', sizeParam)
    const url = `/api/metrics/${encodeURIComponent(metric.id)}?${params.toString()}`

    const timeout = globalThis.setTimeout(() => {
      setLoading(true)
      setError(null)
      loadJson(url, MetricQueryResponseSchema, { signal: controller.signal })
        .then((r) => setResponse(r))
        .catch((e: unknown) => {
          if ((e as { name?: string })?.name === 'AbortError') return
          setError(e instanceof Error ? e.message : String(e))
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }, FETCH_DEBOUNCE_MS)

    return () => {
      controller.abort()
      globalThis.clearTimeout(timeout)
    }
  }, [
    metric.id,
    sitesParam,
    agg,
    window.fromMs,
    window.toMs,
    categoryParam,
    subcategoryParam,
    brandParam,
    sizeParam,
    ghostActive,
    ghostPeriod,
    ghostLookback,
  ])

  useEffect(() => {
    setResponse(null)
  }, [metric.id])

  const visibleAnnotations = useMemo(() => {
    const pad = (window.toMs - window.fromMs) * 0.05
    const fromMs = window.fromMs - pad
    const toMs = window.toMs + pad
    const scopeMatch = `metric:${metric.id}`
    return annotations.filter((a) => {
      if (a.scope !== 'global' && a.scope !== scopeMatch) return false
      const aStart = Date.parse(a.tStart)
      const aEnd = a.tEnd ? Date.parse(a.tEnd) : aStart
      return aStart <= toMs && aEnd >= fromMs
    })
  }, [annotations, metric.id, window.fromMs, window.toMs])

  const cardClickable = variant === 'card' && onExpand
  const cardKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (!cardClickable) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onExpand?.()
      }
    },
    [cardClickable, onExpand],
  )

  return (
    <article
      className={`metric-chart-card metric-chart-card--${variant}`}
      role={cardClickable ? 'button' : undefined}
      tabIndex={cardClickable ? 0 : undefined}
      onClick={cardClickable ? () => onExpand?.() : undefined}
      onKeyDown={cardClickable ? cardKeyDown : undefined}
      aria-label={cardClickable ? `Open ${metric.title} in expanded view` : undefined}
    >
      <header className="metric-chart-header">
        <div className="metric-chart-titlewrap">
          <h3 className="metric-chart-title">
            {metric.title}
            {metric.description ? <HelpIcon text={metric.description} /> : null}
            {filtersNotApplied ? (
              <span
                className="metrics-filter-na-badge"
                title="The catalog filters selected at the top of the page (category / subcategory / brand / size) do not apply to this metric — its query does not honour them, so the chart shows the unfiltered series."
              >
                catalog filters not applied
              </span>
            ) : null}
          </h3>
          {variant === 'expanded' && metric.description ? (
            <details className="metric-chart-desc-wrap">
              <summary className="subtle-copy">about this metric</summary>
              <p className="subtle-copy metric-chart-desc">{metric.description}</p>
            </details>
          ) : null}
        </div>
        {variant === 'expanded' ? (
          <div className="metric-chart-controls">
            {aggControlApplicable ? (
              <select
                value={aggOverride ?? ''}
                onChange={(e) =>
                  setAggOverride((e.target.value || null) as MetricAggregation | null)
                }
                aria-label={`Aggregation for ${metric.title}`}
              >
                <option value="">agg: {defaultAgg} (page)</option>
                {metric.supportedAggregations.map((a) => (
                  <option key={a} value={a}>
                    agg: {a}
                  </option>
                ))}
              </select>
            ) : null}
            {stackModeApplicable ? (
              <select
                value={stackModeOverride ?? ''}
                onChange={(e) =>
                  setStackModeOverride((e.target.value || null) as MetricStackMode | null)
                }
                aria-label={`Stack mode for ${metric.title}`}
                title="Stack the series into a cumulative band, or show each series as % of the per-bucket total"
              >
                <option value="">stack: {STACK_MODE_LABEL[defaultStackMode]} (page)</option>
                {METRIC_STACK_MODES.map((m) => (
                  <option key={m} value={m}>
                    stack: {STACK_MODE_LABEL[m]}
                  </option>
                ))}
              </select>
            ) : null}
            {yBaselineApplicable ? (
              <select
                value={yBaselineOverride}
                onChange={(e) =>
                  setYBaselineOverride(e.target.value as YAxisBaselineChoice)
                }
                aria-label={`Y-axis baseline for ${metric.title}`}
                title="Pin the Y axis to include zero, float it to the data range, or take the page default."
              >
                {Y_AXIS_BASELINE_CHOICES.map((c) => (
                  <option key={c} value={c}>
                    {c === 'page'
                      ? `y: ${Y_AXIS_BASELINE_PAGE_DEFAULT_LABEL[yBaselineDefault]} (page)`
                      : `y: ${Y_AXIS_BASELINE_CHOICE_LABEL[c]}`}
                  </option>
                ))}
              </select>
            ) : null}
            {ghostEligible ? (
              <select
                value={overlayMode}
                onChange={(e) => setOverlayMode(e.target.value as 'off' | 'ghost')}
                aria-label={`Overlay mode for ${metric.title}`}
                title="Ghost Riders: overlay the current period's cumulative trajectory against the prior periods (aligned on phase within the period)."
              >
                <option value="off">overlay: off</option>
                <option value="ghost">overlay: ghosts</option>
              </select>
            ) : null}
            {ghostActive ? (
              <select
                value={ghostPeriod}
                onChange={(e) => setGhostPeriod(e.target.value as MetricGhostPeriod)}
                aria-label={`Ghost Riders period for ${metric.title}`}
                title="Period each ghost spans. day: consecutive days (hour-of-day phase). weekday: same weekday across prior weeks (hour-of-day phase) — best when traffic has a strong weekly shape. week: consecutive weeks (day-of-week phase)."
              >
                <option value="day">period: day</option>
                <option value="weekday">period: weekday</option>
                <option value="week">period: week</option>
              </select>
            ) : null}
            {ghostActive ? (
              <select
                value={ghostLookback}
                onChange={(e) => setGhostLookback(Number(e.target.value))}
                aria-label={`Ghost Riders lookback for ${metric.title}`}
                title="How many prior periods (ghosts) to draw behind the current one."
              >
                <option value={2}>ghosts: 2</option>
                <option value={4}>ghosts: 4</option>
                <option value={6}>ghosts: 6</option>
                <option value={8}>ghosts: 8</option>
              </select>
            ) : null}
            <button
              type="button"
              className={annotateMode ? 'ghost-button is-active' : 'ghost-button'}
              onClick={(e) => {
                e.stopPropagation()
                setAnnotateMode((v) => !v)
              }}
              aria-pressed={annotateMode}
              aria-label="Toggle annotate mode"
              title="Toggle annotate mode (tap to drop a point annotation, drag to mark a range)"
            >
              {annotateMode ? '✏️ annotating' : '✏️ annotate'}
            </button>
            {wheelZoomApplicable ? (
              <button
                type="button"
                className={zoomEnabled ? 'ghost-button is-active' : 'ghost-button'}
                onClick={(e) => {
                  e.stopPropagation()
                  setZoomEnabled((v) => !v)
                }}
                aria-pressed={zoomEnabled}
                aria-label={zoomEnabled ? 'Turn off wheel zoom' : 'Turn on wheel zoom'}
                title={
                  zoomEnabled
                    ? 'Wheel zoom on — scrolling over the chart zooms it. Toggle off to scroll the page past it.'
                    : 'Wheel zoom off — scroll the page freely. Toggle on to zoom with the wheel (Ctrl/⌘+wheel and pinch always zoom).'
                }
              >
                {zoomEnabled ? '✓ wheel zoom' : '🔍 wheel zoom'}
              </button>
            ) : null}
            <button
              type="button"
              className="ghost-button"
              onClick={(e) => {
                e.stopPropagation()
                if (locked) setLocalWindow(sharedAxis.window)
                setLocked((v) => !v)
              }}
              aria-pressed={locked}
              aria-label={locked ? 'Unlock from shared time axis' : 'Lock to shared time axis'}
              title={locked ? 'Unlock from shared time axis' : 'Lock to shared time axis'}
            >
              {locked ? '🔒 locked' : '🔓 unlocked'}
            </button>
          </div>
        ) : (
          <span className="metric-chart-expand-hint" aria-hidden="true">
            ↗
          </span>
        )}
      </header>
      {metric.chartType === 'scatter' ? (
        <ScatterSvg
          response={response}
          loading={loading}
          error={error}
          window={window}
          interactive={variant === 'expanded'}
        />
      ) : ghostActive ? (
        <GhostRidersSvg
          response={response}
          loading={loading}
          error={error}
          interactive={variant === 'expanded'}
        />
      ) : (
        <ChartSvg
          response={response}
          loading={loading}
          error={error}
          window={window}
          setWindow={setWindow}
          annotateMode={variant === 'expanded' && annotateMode}
          annotations={visibleAnnotations}
          metricId={metric.id}
          onAnnotationsChanged={onAnnotationsChanged}
          interactive={variant === 'expanded'}
          zoomEnabled={zoomEnabled}
          agg={agg}
          stackMode={stackMode}
          yBaseline={yBaseline}
        />
      )}
      <ScreenReaderSummary metric={metric} response={response} window={window} loading={loading} />
    </article>
  )
}

interface ChartSvgProps {
  readonly response: MetricQueryResponse | null
  readonly loading: boolean
  readonly error: string | null
  readonly window: TimeWindow
  readonly setWindow: (next: TimeWindow) => void
  readonly annotateMode: boolean
  readonly annotations: ReadonlyArray<MetricAnnotationRecord>
  readonly metricId: string
  readonly onAnnotationsChanged: () => void
  /** Card variant disables pan/zoom/annotate to keep the dashboard scannable. */
  readonly interactive: boolean
  /** When false (default), plain wheel scrolls the page instead of zooming
   *  the chart; Ctrl/⌘+wheel and pinch still zoom. Operator toggles it on. */
  readonly zoomEnabled: boolean
  /** Effective aggregation (drives X-axis bucket-aligned tick placement). */
  readonly agg: MetricAggregation
  /** How to stack the series. Forced to 'none' for single-series charts. */
  readonly stackMode: MetricStackMode
  /** Resolved Y-axis baseline ('zero' | 'data'). Only consulted in
   *  'none' stack mode — stacked / percent always include zero. */
  readonly yBaseline: YAxisBaseline
}

interface DragState {
  readonly kind: 'pan' | 'annotate'
  readonly startMs: number
  readonly currentMs: number
  readonly startClientX: number
  readonly currentClientX: number
  readonly originWindow: TimeWindow
  readonly pointerType: string
}

interface PinchState {
  readonly p1: { id: number; clientX: number }
  readonly p2: { id: number; clientX: number }
  readonly startDistancePx: number
  readonly midpointMs: number
  readonly originWindow: TimeWindow
}

function ChartSvg(props: ChartSvgProps) {
  const {
    response,
    loading,
    error,
    window,
    setWindow,
    annotateMode,
    annotations,
    metricId,
    onAnnotationsChanged,
    interactive,
    zoomEnabled,
    agg,
    stackMode,
    yBaseline,
  } = props
  const svgRef = useRef<SVGSVGElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const sharedAxis = useTimeAxis()

  // Per-card hidden series. Clicking a legend chip toggles its id in
  // and out of this Set; the chart re-computes its y-range and skips
  // the hidden series in rendering, so e.g. hiding one giant series
  // lets the others re-fit the y-axis.
  const [hiddenSeries, setHiddenSeries] = useState<ReadonlySet<string>>(() => new Set<string>())
  const toggleSeries = useCallback((id: string) => {
    setHiddenSeries((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const [renderedWidthPx, setRenderedWidthPx] = useState<number>(600)
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const w = Math.max(220, Math.floor(entries[0]?.contentRect.width ?? 600))
      setRenderedWidthPx(w)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const width = renderedWidthPx
  // Card variant is shorter; expanded variant grows on narrow widths so the
  // chart doesn't feel letterboxed on a phone.
  const height = interactive ? (renderedWidthPx < 480 ? 260 : 280) : 150
  const marginLeft = 44
  const marginRight = 12
  const marginTop = 12
  const marginBottom = 28
  const plotW = Math.max(50, width - marginLeft - marginRight)
  const plotH = Math.max(50, height - marginTop - marginBottom)

  const xScale = useCallback(
    (ms: number) => marginLeft + ((ms - window.fromMs) / (window.toMs - window.fromMs)) * plotW,
    [window.fromMs, window.toMs, plotW, marginLeft],
  )

  const clientXToSvgX = useCallback((clientX: number): number | null => {
    const svg = svgRef.current
    if (!svg) return null
    const ctm = svg.getScreenCTM()
    if (!ctm) return null
    const point = svg.createSVGPoint()
    point.x = clientX
    point.y = 0
    return point.matrixTransform(ctm.inverse()).x
  }, [])

  const clientXToTime = useCallback(
    (clientX: number): number | null => {
      const svgX = clientXToSvgX(clientX)
      if (svgX === null) return null
      return window.fromMs + ((svgX - marginLeft) / plotW) * (window.toMs - window.fromMs)
    },
    [clientXToSvgX, marginLeft, plotW, window.fromMs, window.toMs],
  )

  // Build per-series points + per-(series, bucket) stack bands. `series[i].points`
  // carries `raw` (the original series value) for the hover read-out and the
  // 'none'-mode polyline, and `y0`/`y1` for the stacked-area renderer. For
  // stack mode 'none', y0 is the axis baseline (yMin) and y1 is the raw value
  // — we only draw the polyline at y1 in that case. For 'stacked' / 'percent'
  // we draw a filled area between y0 and y1.
  const { yMin, yMax, series, datumByMs } = useMemo(() => {
    type PartialMeta = {
      side: 'left' | 'right' | 'both'
      kind: 'truncated' | 'extrapolated'
      coverage: number | null
    }
    type SeriesPoint = { t: number; raw: number; y0: number; y1: number }
    /**
     * Floating-actual dot for a RIGHT partial bucket. Plotted at the
     * moment of observation (`partialActualT`), disconnected from
     * the spline. Carries the measured value so the dot is rendered
     * with an outlined marker + hoverover.
     */
    type FloatingActual = {
      t: number
      raw: number
      meta: PartialMeta
    }
    /**
     * Sample point along the optional dotted projection curve
     * linking the floating-actual dot to the spline's right-edge
     * knot. Already converted to the y space of this series.
     */
    type ProjectionCurvePoint = { t: number; raw: number }
    type Series = {
      id: string
      label: string
      colour: string
      /**
       * The drawn spline knots in order. For LEFT partial rows the
       * first knot's `raw` is `T2'` (server-side full-completion);
       * for RIGHT partial rows the last knot's `raw` is `T(N)'`
       * (extrapolated or full-completion) at the BUCKET END
       * (`partialProjectedT`), and the last spline segment is
       * rendered dashed.
       */
      points: SeriesPoint[]
      /** True ⇔ the last entry in `points` is a server-projected
       *  endpoint knot for a right partial. Triggers `dashLastSegment`
       *  in the spline renderer. */
      dashLastSegment: boolean
      /** Tangent neighbour at `points[0]` for the LEFT partial spline.
       *  Used only by the Catmull-Rom calculation; never drawn. */
      leftTangent: { x: number; y: number } | null
      /** Optional reflection / projected next-bucket value for the
       *  RIGHT partial spline. Currently always null (we let the
       *  spline reflect the endpoint), kept on the type so a future
       *  iteration can supply a real `T(N+1)'` here. */
      rightTangent: { x: number; y: number } | null
      /** Floating actual dots for right partials (disconnected from
       *  the spline). */
      floatingActuals: FloatingActual[]
      /** Optional dotted-curve trajectory linking each floating
       *  actual to the spline's right endpoint. Same series order
       *  as `floatingActuals`. */
      projectionCurves: ProjectionCurvePoint[][]
    }
    const empty = {
      yMin: 0,
      yMax: 1,
      series: [] as Series[],
      datumByMs: [] as Array<{ t: number; values: Record<string, number | null> }>,
    }
    if (!response) return empty
    // Only visible (i.e. not legend-toggled-off) series participate
    // in the y-range, stacking, and rendering. Hidden series are
    // still iterable in the legend (so the operator can toggle them
    // back on) but contribute nothing to the chart.
    const visibleSeriesDefs = response.metric.series.filter((s) => !hiddenSeries.has(s.id))
    const ids = visibleSeriesDefs.map((s) => s.id)

    // Sort rows by t once so the stack accumulator (per-bucket) gets a
    // deterministic order; the polyline / area renderer also wants them
    // sorted left-to-right.
    const rows = response.data
      .slice()
      .sort((a, b) => Date.parse(a.t) - Date.parse(b.t))

    /**
     * Display x position for a row's bucket-aggregate value. The
     * server attaches `tEnd` (= natural bucket-end ISO) to every
     * time-bucket line-chart row, so the marker for "Jun 3" lands
     * at end-of-Jun-3 (= start-of-Jun-4) — keeping the spline's
     * spacing linear in time even when the rightmost knot is the
     * right-partial extrapolated endpoint (already plotted at
     * `partialProjectedT = lastEnd`).
     *
     * Falls back to `t` for categorical aggregations (`total` /
     * `dow` / …), which don't have a calendar bucket-end, and for
     * any old client/proxy that hasn't picked up the new contract
     * yet — preserving the legacy bucket-START display rather than
     * crashing.
     */
    function displayMs(d: MetricDatum): number {
      const e = d.tEnd
      const parsed = typeof e === 'string' ? Date.parse(e) : NaN
      if (Number.isFinite(parsed)) return parsed
      return Date.parse(d.t)
    }

    // Server-marked partial-bucket edge rows. Under the 2026-06-04
    // spec the wire shape varies by side:
    //   * LEFT  → row.values = T2' (full completion). partialTangentPrev
    //             carries T1' (the prior natural full bucket) as the
    //             hidden spline-tangent neighbour.
    //   * RIGHT → row.values = T(N) measured (the floating actual at
    //             `partialActualT`). partialProjected/T carries the
    //             spline's right-edge knot value/position; optional
    //             partialProjectionCurve carries the dotted-curve
    //             trajectory between the floating dot and the
    //             projected endpoint.
    //   * BOTH  → legacy degenerate single-bucket fallback; no
    //             refactor support yet (the spline has no curve to
    //             draw across a single bucket anyway).
    function partialSideOf(d: MetricDatum): 'left' | 'right' | 'both' | null {
      const p = d.partial
      return p === 'left' || p === 'right' || p === 'both' ? p : null
    }
    function partialKindOf(d: MetricDatum): 'truncated' | 'extrapolated' {
      return d.partialKind === 'extrapolated' ? 'extrapolated' : 'truncated'
    }
    function partialMetaForRow(d: MetricDatum): PartialMeta | null {
      const side = partialSideOf(d)
      if (side === null) return null
      return {
        side,
        kind: partialKindOf(d),
        coverage:
          typeof d.partialCoverage === 'number' ? d.partialCoverage : null,
      }
    }

    // datumByMs is the hover-readout source — it always shows raw values,
    // regardless of stack mode, so the operator sees the real number.
    // For full buckets and LEFT partials (whose row value is already the
    // T2' full-completion estimate plotted at the bucket end) we emit
    // one entry per row at the bucket-END x position.
    //
    // For RIGHT partials we emit TWO entries per row so the tooltip
    // matches the rendered dot under the cursor:
    //   * one at `partialActualT` (the floating-actual dot's position)
    //     carrying the MEASURED value the dot represents, and
    //   * one at `partialProjectedT` (the spline's right-edge knot,
    //     which is the bucket end) carrying the PROJECTED value the
    //     extrapolated knot represents.
    // Without this split, hovering near either dot would snap to
    // `tEnd` and surface the raw row value — i.e. the actual reading
    // shown next to the extrapolated dot, and the extrapolated dot's
    // own value never reachable. Bug observed 2026-06-04.
    type DatumEntry = { t: number; values: Record<string, number | null> }
    const datumMap = new Map<number, DatumEntry>()
    const putValue = (tms: number, id: string, v: unknown) => {
      let row = datumMap.get(tms)
      if (!row) {
        const fresh: DatumEntry = { t: tms, values: {} }
        for (const sid of ids) fresh.values[sid] = null
        datumMap.set(tms, fresh)
        row = fresh
      }
      row.values[id] = typeof v === 'number' && Number.isFinite(v) ? v : null
    }
    for (const d of rows) {
      const md = d as MetricDatum
      const side = partialSideOf(md)
      if (side === 'right') {
        // RIGHT partial: split into actual @ partialActualT and
        // projected @ partialProjectedT. Fall back to the bucket-end
        // t-position if the server didn't supply the explicit
        // timestamps (older deploys / synthetic test rows).
        const tEnd = displayMs(md)
        const actualT = md.partialActualT
          ? Date.parse(md.partialActualT)
          : Date.parse(md.t)
        const projT = md.partialProjectedT
          ? Date.parse(md.partialProjectedT)
          : tEnd
        for (const id of ids) {
          putValue(
            Number.isFinite(actualT) ? actualT : Date.parse(md.t),
            id,
            md[id],
          )
          const projV = md.partialProjected?.[id]
          putValue(
            Number.isFinite(projT) ? projT : tEnd,
            id,
            typeof projV === 'number' ? projV : null,
          )
        }
        continue
      }
      // Default (full buckets + left-partial rows): single entry at
      // bucket end carrying the row's values.
      const tDisplay = displayMs(md)
      for (const id of ids) putValue(tDisplay, id, md[id])
    }
    const datumByMs: DatumEntry[] = Array.from(datumMap.values()).sort(
      (a, b) => a.t - b.t,
    )

    // Build per-series buffers, then layer stacking on top. Use the
    // ORIGINAL series-declaration index for colour fallback so series
    // colours stay stable as the legend toggles items on/off.
    const seriesOut: Series[] = visibleSeriesDefs.map((s) => {
      const origIdx = response.metric.series.findIndex((x) => x.id === s.id)
      return {
        id: s.id,
        label: s.label,
        colour: s.colour ?? FALLBACK_COLOURS[origIdx % FALLBACK_COLOURS.length]!,
        points: [],
        dashLastSegment: false,
        leftTangent: null,
        rightTangent: null,
        floatingActuals: [],
        projectionCurves: [],
      }
    })

    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY

    if (stackMode === 'none') {
      // Raw values only; null cells are skipped (matches the pre-stack
      // behaviour exactly so 'none' mode is bit-for-bit unchanged).
      for (const d of rows) {
        // `tDisplay` is the bucket-END x position (server's `tEnd`,
        // with `t` as fallback). Bucket-aggregate values render here;
        // within-bucket instants (floating actual, curve points)
        // use their own explicit timestamps.
        const tDisplay = displayMs(d as MetricDatum)
        const partial = partialMetaForRow(d as MetricDatum)
        for (let i = 0; i < seriesOut.length; i++) {
          const id = ids[i]!
          const v = (d as MetricDatum)[id]
          // Right partials carry the measured value on the row's
          // main field; we route that to floatingActuals and add the
          // server-projected endpoint to s.points instead.
          if (partial?.side === 'right') {
            // Floating actual: requires partialActualT for the x
            // position. Fall back to bucket-start `row.t` (NOT
            // tDisplay, which would put the floating dot past the
            // bucket end) when the server didn't emit it (older
            // deploy / legacy data).
            if (typeof v === 'number' && Number.isFinite(v)) {
              if (v < lo) lo = v
              if (v > hi) hi = v
              const fallbackTms = Date.parse(d.t)
              const actualTms = d.partialActualT
                ? Date.parse(d.partialActualT)
                : fallbackTms
              seriesOut[i]!.floatingActuals.push({
                t: Number.isFinite(actualTms) ? actualTms : fallbackTms,
                raw: v,
                meta: partial,
              })
            }
            // Spline endpoint: projected value at partialProjectedT
            // (which is `lastEnd`, i.e. one full bucket-width past
            // the row's `t`). With every other interior knot now
            // also plotted at its bucket-END (via `displayMs`), the
            // extrapolated endpoint sits exactly one bucket-width
            // past the penultimate marker — uniform spacing,
            // linear x axis.
            const projV = (d as MetricDatum).partialProjected?.[id]
            const projT = (d as MetricDatum).partialProjectedT
              ? Date.parse((d as MetricDatum).partialProjectedT!)
              : null
            if (
              typeof projV === 'number' &&
              Number.isFinite(projV) &&
              projT !== null &&
              Number.isFinite(projT)
            ) {
              if (projV < lo) lo = projV
              if (projV > hi) hi = projV
              seriesOut[i]!.points.push({
                t: projT,
                raw: projV,
                y0: 0,
                y1: projV,
              })
              seriesOut[i]!.dashLastSegment = true
            }
            // Trajectory curve: optional dotted-line sample points
            // connecting the floating-actual dot out to the
            // projected endpoint. Each point carries its own series
            // value.
            const curveRows = (d as MetricDatum).partialProjectionCurve
            const curve: ProjectionCurvePoint[] = []
            if (curveRows && Array.isArray(curveRows)) {
              for (const cr of curveRows) {
                const cv = cr[id]
                if (typeof cv !== 'number' || !Number.isFinite(cv)) continue
                const ct = typeof cr.t === 'string' ? Date.parse(cr.t) : NaN
                if (!Number.isFinite(ct)) continue
                if (cv < lo) lo = cv
                if (cv > hi) hi = cv
                curve.push({ t: ct, raw: cv })
              }
            }
            seriesOut[i]!.projectionCurves.push(curve)
            continue
          }
          // Left partials: row.values already carry T2' (full
          // completion); we treat them as a normal interior knot
          // (at the bucket-END x position) and additionally stash
          // T1' as the spline's tangent neighbour at this point.
          // T1' is hidden — never drawn.
          if (partial?.side === 'left') {
            if (typeof v === 'number' && Number.isFinite(v)) {
              if (v < lo) lo = v
              if (v > hi) hi = v
              seriesOut[i]!.points.push({ t: tDisplay, raw: v, y0: 0, y1: v })
            }
            const prevV = (d as MetricDatum).partialTangentPrev?.[id]
            if (typeof prevV === 'number' && Number.isFinite(prevV)) {
              // Don't include T1' in the y-range — it's invisible.
              // The Catmull-Rom tangent calc only needs its
              // x/y delta to the leftmost drawn knot. In the
              // bucket-END display convention T1's marker would
              // sit at the END of T1's bucket = the START of T2's
              // bucket = the partial-left row's `t` (= one
              // bucket-width before T2', which is at `tDisplay`).
              seriesOut[i]!.leftTangent = { x: Date.parse(d.t), y: prevV }
            }
            continue
          }
          // BOTH partials: keep legacy "actual on solid line"
          // behaviour. The current spec has no clean rendering for
          // a single bucket that's both left and right partial, so
          // we leave it as the existing interior plot.
          if (typeof v !== 'number') continue
          if (v < lo) lo = v
          if (v > hi) hi = v
          seriesOut[i]!.points.push({ t: tDisplay, raw: v, y0: 0, y1: v })
        }
      }
      // 'zero' baseline pins the axis to include the zero line; 'data'
      // floats to the observed range with padding. See computeLineYRange.
      {
        const r = computeLineYRange(lo, hi, yBaseline)
        lo = r.yMin
        hi = r.yMax
      }
      // Set y0 = axis bottom so a future "fill under line" affordance
      // doesn't need a second pass.
      for (const s of seriesOut) {
        // Sort points by t — the LEFT partial row's `t` is the
        // bucket start, RIGHT partial endpoint's `t` is the bucket
        // END (one bucket-width after `lastStart`), so the ordered
        // sequence is automatically: [T2', T3, T4, ..., T(N-1), T(N)'].
        s.points.sort((a, b) => a.t - b.t)
        for (const p of s.points) p.y0 = lo
      }
      return { yMin: lo, yMax: hi, series: seriesOut, datumByMs }
    }

    // Stacked / percent: every bucket contributes ONE column of bands,
    // ordered by series-declaration index. Null / negative cells are
    // clamped to 0 so the stack stays monotonic and operators don't see
    // weird inverted bands. Same bucket-END x-position convention as
    // 'none' mode so the area's right edge lines up with the line
    // chart's rightmost marker.
    let stackTop = 0
    for (const d of rows) {
      const t = displayMs(d as MetricDatum)
      // First pass per bucket: gather values, possibly normalise for
      // percent mode.
      const vals = ids.map((id) => {
        const v = (d as MetricDatum)[id]
        return typeof v === 'number' && v > 0 ? v : 0
      })
      let scale = 1
      if (stackMode === 'percent') {
        const total = vals.reduce((a, b) => a + b, 0)
        scale = total > 0 ? 100 / total : 0
      }
      let cum = 0
      for (let i = 0; i < seriesOut.length; i++) {
        const id = ids[i]!
        const raw = (d as MetricDatum)[id]
        const v = vals[i]! * scale
        const y0 = cum
        const y1 = cum + v
        cum = y1
        seriesOut[i]!.points.push({
          t,
          raw: typeof raw === 'number' ? raw : 0,
          y0,
          y1,
        })
      }
      if (cum > stackTop) stackTop = cum
    }

    // Y axis: always starts at 0 for stacked; for percent it's 0..100.
    lo = 0
    hi = stackMode === 'percent' ? 100 : stackTop > 0 ? stackTop * 1.05 : 1

    return { yMin: lo, yMax: hi, series: seriesOut, datumByMs }
  }, [response, stackMode, hiddenSeries, yBaseline])

  const yScale = useCallback(
    (v: number) => marginTop + plotH - ((v - yMin) / (yMax - yMin)) * plotH,
    [yMin, yMax, plotH, marginTop],
  )

  // Path strings + per-point marker positions for each series.
  //
  // In 'none' mode (single-series line chart) the path is a smoothed
  // Catmull-Rom curve through every data point, and we emit a small
  // ×-marker at each point so the reader can tell which positions are
  // real measurements vs interpolated curve.
  //
  // In stacked / percent mode the path is a closed filled area whose
  // top edge is smoothed and whose bottom edge is smoothed in reverse.
  // We don't emit markers for stacked series — the stack already shows
  // where each bucket lives, and an × per point per series would
  // visually swamp the area.
  const seriesPaths = useMemo(() => {
    /** Pre-projected pixel coordinates + metadata for the right-
     *  partial floating actual + its optional dotted-curve
     *  trajectory connecting it to the spline endpoint. */
    type RightFloatingOverlay = {
      actual: {
        x: number
        y: number
        kind: 'truncated' | 'extrapolated'
        coverage: number | null
      }
      /** Right-edge knot pixel position (from s.points[last]). */
      endpoint: { x: number; y: number; value: number } | null
      /** Sampled trajectory points (in pixel space). Empty array
       *  ⇒ render a straight dotted line instead. */
      curve: Array<{ x: number; y: number }>
    }
    return series.map((s) => {
      const sortedPts = s.points
      const rightOverlays: RightFloatingOverlay[] = []
      // Right partial knot is always the LAST entry in s.points when
      // dashLastSegment is true; pre-compute its pixel coords so the
      // curve / actual overlays can reference it.
      let endpointPx: { x: number; y: number; value: number } | null = null
      if (stackMode === 'none' && s.dashLastSegment && sortedPts.length > 0) {
        const ep = sortedPts[sortedPts.length - 1]!
        endpointPx = {
          x: xScale(ep.t),
          y: yScale(ep.y1),
          value: ep.raw,
        }
      }
      if (stackMode === 'none' && s.floatingActuals.length > 0) {
        for (let i = 0; i < s.floatingActuals.length; i++) {
          const fa = s.floatingActuals[i]!
          const curveSrc = s.projectionCurves[i] ?? []
          const curve = curveSrc.map((p) => ({
            x: xScale(p.t),
            y: yScale(p.raw),
          }))
          rightOverlays.push({
            actual: {
              x: xScale(fa.t),
              y: yScale(fa.raw),
              kind: fa.meta.kind,
              coverage: fa.meta.coverage,
            },
            endpoint: endpointPx,
            curve,
          })
        }
      }
      if (s.points.length === 0) {
        return {
          ...s,
          dSolid: '',
          dDashed: '',
          markers: [] as Array<{ x: number; y: number; isEndpoint?: boolean }>,
          fill: stackMode !== 'none' as const,
          rightOverlays,
          d: '',
        }
      }
      const topPts = s.points.map((p) => ({ x: xScale(p.t), y: yScale(p.y1) }))
      if (stackMode === 'none') {
        // Spline path: optionally split into solid + dashed tail when
        // the right edge is a server-projected endpoint. The
        // leftTangent (T1') silently steers the slope at points[0]
        // when the left edge is a partial.
        const leftTangentPx = s.leftTangent
          ? { x: xScale(s.leftTangent.x), y: yScale(s.leftTangent.y) }
          : undefined
        const rightTangentPx = s.rightTangent
          ? { x: xScale(s.rightTangent.x), y: yScale(s.rightTangent.y) }
          : undefined
        const { solid: dSolid, dashed: dDashed } = partialAwareSplinePath({
          knots: topPts,
          leftTangent: leftTangentPx,
          rightTangent: rightTangentPx,
          dashLastSegment: s.dashLastSegment,
        })
        // Markers: every interior knot gets the small × marker; the
        // server-projected endpoint (last knot when dashLastSegment)
        // is instead drawn as an outlined circle in the SVG block
        // and is suppressed from the × markers here.
        const markerPts = topPts.map((m, idx) => ({
          ...m,
          isEndpoint:
            s.dashLastSegment && idx === topPts.length - 1 ? true : false,
        }))
        return {
          ...s,
          dSolid,
          dDashed,
          markers: markerPts,
          fill: false as const,
          rightOverlays,
          d: dSolid, // legacy alias for hasData test
        }
      }
      const bottomPts = s.points
        .slice()
        .reverse()
        .map((p) => ({ x: xScale(p.t), y: yScale(p.y0) }))
      const top = smoothedPath(topPts)
      const bottom = smoothedPath(bottomPts)
      // Stitch the two smoothed edges into a closed area. Replace the
      // bottom's leading 'M' with 'L' so the path stays continuous.
      const bottomAsLine = bottom.length > 0 ? 'L' + bottom.slice(1) : ''
      // Even in stacked mode we still mark the top edge of each real
      // bucket sample so the reader can tell where the actual data
      // points are (vs the smoothed interpolation between them).
      return {
        ...s,
        dSolid: '',
        dDashed: '',
        d: `${top} ${bottomAsLine} Z`,
        markers: topPts.map((m) => ({ ...m, isEndpoint: false })),
        fill: true as const,
        rightOverlays,
      }
    })
  }, [series, xScale, yScale, stackMode])

  // Y-axis "nice" gridline ticks (e.g. 0, 0.2, 0.4, 0.6, 0.8, 1.0).
  // Pick fewer intervals on the short card variant so labels don't pack.
  const yTicks = useMemo(() => {
    const target = interactive ? (height < 220 ? 4 : 5) : 3
    return niceYTicks(yMin, yMax, target)
  }, [yMin, yMax, interactive, height])

  // X-axis bucket-aligned ticks. Pixel-aware: pick a target tick count so
  // each label has enough horizontal room not to collide with its
  // neighbour. Different aggregations produce different label widths
  // (e.g. "05-18 14:00" is wider than "May 18"), so the min-pixel
  // budget tracks the aggregation.
  const xTicks = useMemo(() => {
    const minLabelPx =
      agg === 'hour' ? 76 : agg === 'month' ? 68 : agg === 'date' || agg === 'week' ? 60 : 56
    const target = Math.max(1, Math.floor(plotW / minLabelPx) - 1)
    return bucketXTicks({ fromMs: window.fromMs, toMs: window.toMs, agg, targetCount: target })
  }, [window.fromMs, window.toMs, agg, plotW])

  const xTickStraddlesYear = useMemo(() => {
    if (xTicks.length === 0) return false
    // NY-calendar year — a window like Dec 28 NY → Jan 3 NY straddles
    // the year boundary in NY even though Dec 31 23:00 NY is already
    // Jan 1 in UTC. Using getUTCFullYear here previously caused the
    // tick formatter to omit the year on windows the operator
    // perceives as straddling, and add it spuriously on windows that
    // don't straddle.
    const fromY = nyParts(window.fromMs).y
    const toY = nyParts(window.toMs).y
    return fromY !== toY
  }, [xTicks, window.fromMs, window.toMs])

  const [drag, setDrag] = useState<DragState | null>(null)
  const pinchRef = useRef<PinchState | null>(null)
  const activePointersRef = useRef<Map<number, { clientX: number }>>(new Map())
  const [hoverAnnotation, setHoverAnnotation] = useState<MetricAnnotationRecord | null>(null)
  const [pendingCreate, setPendingCreate] = useState<{ tStart: string; tEnd: string | null } | null>(null)

  // ---- Hover read-out -----------------------------------------------------
  // We track hover in local state for THIS chart's own readout (the
  // tooltip + crosshair are rendered by this chart) AND publish the
  // timestamp to the shared TimeAxisContext so other locked charts can
  // draw their faint synchronised crosshairs.
  const [hoverMs, setHoverMs] = useState<number | null>(null)
  // Track whether the most recent pointer interaction was a touch so we
  // can keep the hover readout sticky for a few seconds after release
  // (otherwise the browser's long-press handler eats the touch and
  // scrolls the page, killing the tooltip immediately). Mouse hover
  // still clears on leave, as it always has.
  const lastPointerTypeRef = useRef<string>('mouse')
  const stickyHoverTimerRef = useRef<number | null>(null)
  const cancelStickyHoverClear = useCallback(() => {
    if (stickyHoverTimerRef.current !== null) {
      globalThis.clearTimeout(stickyHoverTimerRef.current)
      stickyHoverTimerRef.current = null
    }
  }, [])
  useEffect(() => () => cancelStickyHoverClear(), [cancelStickyHoverClear])
  // External (other-chart-originated) hover so we can render the faint
  // synchronised crosshair when *some other* card is being hovered.
  const [externalHoverMs, setExternalHoverMs] = useState<number | null>(sharedAxis.getHoverMs())
  useEffect(() => {
    return sharedAxis.subscribeHover((ms) => {
      // Only react when this chart isn't the source. We can tell
      // by comparing: if our local hoverMs is set and equals ms, it's
      // our own publish coming back; otherwise it's external.
      setExternalHoverMs(ms)
    })
  }, [sharedAxis])

  const onPointerEnter = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      lastPointerTypeRef.current = e.pointerType
      cancelStickyHoverClear()
      const t = clientXToTime(e.clientX)
      if (t === null) return
      setHoverMs(t)
      sharedAxis.publishHover(t)
    },
    [cancelStickyHoverClear, clientXToTime, sharedAxis],
  )

  const onPointerLeave = useCallback(() => {
    // On touch devices, browsers fire pointerleave the instant the
    // finger lifts; clearing immediately makes the tooltip useless
    // and lets a delayed long-press trigger context menus / scroll.
    // Keep the readout visible for a few seconds, then auto-clear.
    if (lastPointerTypeRef.current === 'touch' || lastPointerTypeRef.current === 'pen') {
      cancelStickyHoverClear()
      stickyHoverTimerRef.current = globalThis.setTimeout(() => {
        stickyHoverTimerRef.current = null
        setHoverMs(null)
        sharedAxis.publishHover(null)
      }, 3500)
      return
    }
    setHoverMs(null)
    sharedAxis.publishHover(null)
  }, [cancelStickyHoverClear, sharedAxis])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!interactive) return
      if (e.button !== 0 && e.pointerType === 'mouse') return
      lastPointerTypeRef.current = e.pointerType
      cancelStickyHoverClear()
      // Touch interactions should immediately show the hover readout
      // even though pointerenter didn't fire (some browsers only fire
      // pointerenter for hover-capable devices).
      const tNow = clientXToTime(e.clientX)
      if (tNow !== null) {
        setHoverMs(tNow)
        sharedAxis.publishHover(tNow)
      }
      const t = clientXToTime(e.clientX)
      if (t === null) return
      activePointersRef.current.set(e.pointerId, { clientX: e.clientX })

      if (activePointersRef.current.size === 2) {
        setDrag(null)
        const ids = Array.from(activePointersRef.current.keys())
        const a = activePointersRef.current.get(ids[0]!)!
        const b = activePointersRef.current.get(ids[1]!)!
        const distance = Math.max(1, Math.abs(b.clientX - a.clientX))
        const midClientX = (a.clientX + b.clientX) / 2
        const midMs = clientXToTime(midClientX) ?? t
        pinchRef.current = {
          p1: { id: ids[0]!, clientX: a.clientX },
          p2: { id: ids[1]!, clientX: b.clientX },
          startDistancePx: distance,
          midpointMs: midMs,
          originWindow: window,
        }
        svgRef.current?.setPointerCapture(e.pointerId)
        return
      }

      if (annotateMode) {
        setDrag({
          kind: 'annotate',
          startClientX: e.clientX,
          currentClientX: e.clientX,
          startMs: t,
          currentMs: t,
          originWindow: window,
          pointerType: e.pointerType,
        })
      } else {
        setDrag({
          kind: 'pan',
          startClientX: e.clientX,
          currentClientX: e.clientX,
          startMs: t,
          currentMs: t,
          originWindow: window,
          pointerType: e.pointerType,
        })
      }
      svgRef.current?.setPointerCapture(e.pointerId)
    },
    [annotateMode, cancelStickyHoverClear, clientXToTime, interactive, sharedAxis, window],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const tracked = activePointersRef.current.get(e.pointerId)
      if (tracked) {
        tracked.clientX = e.clientX
      }
      lastPointerTypeRef.current = e.pointerType
      cancelStickyHoverClear()

      // Always update hover for the readout, even mid-drag — the operator
      // wants to see "what value was here" while panning.
      const t = clientXToTime(e.clientX)
      if (t !== null) {
        setHoverMs(t)
        sharedAxis.publishHover(t)
      }

      if (pinchRef.current) {
        const a = activePointersRef.current.get(pinchRef.current.p1.id)
        const b = activePointersRef.current.get(pinchRef.current.p2.id)
        if (a && b) {
          const distance = Math.max(1, Math.abs(b.clientX - a.clientX))
          const factor = pinchRef.current.startDistancePx / distance
          const origin = pinchRef.current.originWindow
          const tMid = pinchRef.current.midpointMs
          setWindow({
            fromMs: tMid - (tMid - origin.fromMs) * factor,
            toMs: tMid + (origin.toMs - tMid) * factor,
          })
        }
        return
      }

      if (!drag) return
      if (t === null) return
      if (drag.kind === 'pan') {
        const span = drag.originWindow.toMs - drag.originWindow.fromMs
        const dxPx = e.clientX - drag.startClientX
        const dMs = (dxPx / plotW) * span
        setWindow({ fromMs: drag.originWindow.fromMs - dMs, toMs: drag.originWindow.toMs - dMs })
      } else {
        setDrag({ ...drag, currentMs: t, currentClientX: e.clientX })
      }
    },
    [cancelStickyHoverClear, clientXToTime, drag, plotW, setWindow, sharedAxis],
  )

  const finishPointer = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      activePointersRef.current.delete(e.pointerId)
      if (pinchRef.current && activePointersRef.current.size < 2) {
        pinchRef.current = null
      }
      if (!drag) return
      if (drag.kind === 'annotate') {
        const a = Math.min(drag.startMs, drag.currentMs)
        const b = Math.max(drag.startMs, drag.currentMs)
        const threshold = drag.pointerType === 'touch' ? TOUCH_MOVE_PX_THRESHOLD : POINTER_MOVE_PX_THRESHOLD
        const isRange = Math.abs(drag.currentClientX - drag.startClientX) > threshold
        setPendingCreate({
          tStart: new Date(a).toISOString(),
          tEnd: isRange ? new Date(b).toISOString() : null,
        })
      }
      setDrag(null)
      try {
        svgRef.current?.releasePointerCapture(e.pointerId)
      } catch {
        /* normal on cancel */
      }
    },
    [drag],
  )

  const onWheel = useCallback(
    (e: React.WheelEvent<SVGSVGElement>) => {
      // Only swallow the wheel event (keeping it from bubbling to the
      // page) when this gesture actually zooms the chart. Otherwise let
      // it propagate so the page scrolls normally.
      if (zoomEnabled || e.ctrlKey || e.metaKey) e.stopPropagation()
    },
    [zoomEnabled],
  )

  useEffect(() => {
    const svg = svgRef.current
    if (!svg || !interactive) return
    function handler(this: SVGSVGElement, ev: WheelEvent) {
      // Plain wheel only zooms when the operator has opted in via the
      // toolbar toggle. Ctrl/⌘+wheel always zooms (power-user gesture).
      // When neither applies, do nothing — don't preventDefault — so the
      // wheel scrolls the page instead of accidentally zooming a chart
      // the cursor merely paused over.
      if (!zoomEnabled && !ev.ctrlKey && !ev.metaKey) return
      ev.preventDefault()
      const t = clientXToTime(ev.clientX)
      if (t === null) return
      const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2
      setWindow({
        fromMs: t - (t - window.fromMs) * factor,
        toMs: t + (window.toMs - t) * factor,
      })
    }
    svg.addEventListener('wheel', handler, { passive: false })
    return () => svg.removeEventListener('wheel', handler)
  }, [clientXToTime, interactive, zoomEnabled, setWindow, window.fromMs, window.toMs])

  const handleCreate = useCallback(
    async (payload: { title: string; body: string; tag: string | null; scope: string }) => {
      if (!pendingCreate) return
      await mutateJson('/api/metric-annotations', PassthroughSchema, {
        method: 'POST',
        body: JSON.stringify({
          ...pendingCreate,
          title: payload.title,
          body: payload.body,
          tag: payload.tag,
          scope: payload.scope,
        }),
      })
      setPendingCreate(null)
      onAnnotationsChanged()
    },
    [pendingCreate, onAnnotationsChanged],
  )

  const handleDelete = useCallback(
    async (id: string) => {
      await mutateJson(`/api/metric-annotations/${encodeURIComponent(id)}`, PassthroughSchema, {
        method: 'DELETE',
      })
      setHoverAnnotation(null)
      onAnnotationsChanged()
    },
    [onAnnotationsChanged],
  )

  const hasData =
    !!response &&
    response.data.length > 0 &&
    seriesPaths.some(
      (s) =>
        s.d.length > 0 ||
        s.dSolid.length > 0 ||
        s.dDashed.length > 0 ||
        s.rightOverlays.length > 0,
    )

  // Snap hover (this chart's own OR external from a sibling card) to the
  // nearest datum bucket for tooltip / crosshair readout.
  const nearestForHover = useMemo(() => {
    const probeMs = hoverMs ?? externalHoverMs
    if (probeMs == null || datumByMs.length === 0) return null
    // Only show if probe is inside the visible window (with a small pad).
    const pad = (window.toMs - window.fromMs) * 0.02
    if (probeMs < window.fromMs - pad || probeMs > window.toMs + pad) return null
    // Binary search.
    let lo = 0
    let hi = datumByMs.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (datumByMs[mid]!.t < probeMs) lo = mid + 1
      else hi = mid
    }
    const cand = datumByMs[lo]!
    const prev = lo > 0 ? datumByMs[lo - 1]! : cand
    return Math.abs(cand.t - probeMs) < Math.abs(prev.t - probeMs) ? cand : prev
  }, [datumByMs, externalHoverMs, hoverMs, window.fromMs, window.toMs])

  // Whether THIS chart owns the hover (we render the full tooltip).
  // If the hover came from another chart, we only render the faint sync crosshair.
  const ownsHover = hoverMs != null
  const crosshairMs = ownsHover ? hoverMs : externalHoverMs

  return (
    <div className="metric-chart-svg-wrap" ref={wrapRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        className="metric-chart-svg"
        role="img"
        aria-label={`Time series chart for ${metricId}`}
        tabIndex={interactive ? 0 : -1}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onWheel={onWheel}
        onKeyDown={(e) => {
          if (!interactive) return
          const span = window.toMs - window.fromMs
          if (e.key === 'ArrowLeft') {
            e.preventDefault()
            setWindow({ fromMs: window.fromMs - span * 0.1, toMs: window.toMs - span * 0.1 })
          } else if (e.key === 'ArrowRight') {
            e.preventDefault()
            setWindow({ fromMs: window.fromMs + span * 0.1, toMs: window.toMs + span * 0.1 })
          } else if (e.key === '+' || e.key === '=') {
            e.preventDefault()
            const mid = (window.fromMs + window.toMs) / 2
            setWindow({ fromMs: mid - span * 0.4, toMs: mid + span * 0.4 })
          } else if (e.key === '-') {
            e.preventDefault()
            const mid = (window.fromMs + window.toMs) / 2
            setWindow({ fromMs: mid - span * 0.6, toMs: mid + span * 0.6 })
          }
        }}
        style={{
          // 'pan-y' lets the browser keep handling vertical page scroll
          // (so a touch drag down the page isn't trapped by the chart)
          // while horizontal drags still pan the chart. Only when wheel
          // zoom is enabled do we capture all gestures with 'none'.
          touchAction: interactive ? (zoomEnabled ? 'none' : 'pan-y') : 'auto',
          cursor: !interactive ? 'pointer' : annotateMode ? 'crosshair' : drag?.kind === 'pan' ? 'grabbing' : 'crosshair',
        }}
      >
        <rect
          x={marginLeft}
          y={marginTop}
          width={plotW}
          height={plotH}
          fill="rgba(255,255,255,0.001)"
        />

        {/* Horizontal gridlines + Y-axis tick labels. Gridlines land on
            "nice" round numbers (least-significant digit 5/0, or even
            fractions like 0.2). Skip lines that fall outside the plot
            area (can happen if yMin/yMax span >= the rounded tick range). */}
        {yTicks.ticks.map((v) => {
          if (v < yMin || v > yMax) return null
          const y = yScale(v)
          if (!Number.isFinite(y)) return null
          return (
            <g key={`yt-${v}`} pointerEvents="none">
              <line
                x1={marginLeft}
                x2={width - marginRight}
                y1={y}
                y2={y}
                stroke="#eee"
                strokeWidth={1}
              />
              <text
                x={marginLeft - 4}
                y={y + 3}
                fontSize="10"
                textAnchor="end"
                fill="#555"
              >
                {formatYTick(v, yTicks.fractionDigits)}
              </text>
            </g>
          )
        })}

        {/* Vertical gridlines + X-axis tick labels at bucket boundaries.
            For categorical / total aggregations bucketXTicks returns [] so
            we fall back to the from/to corner labels below. */}
        {xTicks.map((t) => {
          const x = xScale(t)
          if (!Number.isFinite(x) || x < marginLeft - 0.5 || x > width - marginRight + 0.5) return null
          const label = formatXTick(t, agg, { straddlesYear: xTickStraddlesYear })
          // Anchor first/last labels to the inside of the plot so they
          // don't clip past the marginLeft/marginRight gutters.
          const isLeftEdge = x <= marginLeft + 12
          const isRightEdge = x >= width - marginRight - 12
          const textAnchor = isLeftEdge ? 'start' : isRightEdge ? 'end' : 'middle'
          return (
            <g key={`xt-${t}`} pointerEvents="none">
              <line
                x1={x}
                x2={x}
                y1={marginTop}
                y2={marginTop + plotH}
                stroke="#eee"
                strokeWidth={1}
              />
              <text
                x={x}
                y={marginTop + plotH + 12}
                fontSize="10"
                textAnchor={textAnchor}
                fill="#555"
              >
                {label}
              </text>
            </g>
          )
        })}

        {/* Plot-area baseline + left axis. Drawn AFTER gridlines so they sit
            on top, giving a clean frame. */}
        <line x1={marginLeft} x2={width - marginRight} y1={marginTop + plotH} y2={marginTop + plotH} stroke="#ccc" />
        <line x1={marginLeft} x2={marginLeft} y1={marginTop} y2={marginTop + plotH} stroke="#ccc" />

        {/* From/to range labels — only when bucketXTicks declined to emit
            ticks (categorical / total aggregations). Otherwise the
            in-plot ticks already convey the time window. */}
        {xTicks.length === 0 ? (
          <>
            <text x={marginLeft} y={height - 8} fontSize="10" fill="#555">
              {shortDate(window.fromMs)}
            </text>
            <text x={width - marginRight} y={height - 8} fontSize="10" textAnchor="end" fill="#555">
              {shortDate(window.toMs)}
            </text>
          </>
        ) : null}

        {seriesPaths.map((s) =>
          s.fill ? (
            <g key={s.id}>
              <path
                d={s.d}
                fill={s.colour}
                fillOpacity={0.55}
                stroke={s.colour}
                strokeWidth="1"
              />
              {/* Smaller markers on the top edge of each stacked sample
                  so the reader can see where the real bucket points are
                  vs the smoothed interpolation between them. */}
              {s.markers.map((m, i) => (
                <path
                  key={`${s.id}-m-${i}`}
                  d={crossMarkerPath(m.x, m.y, 2.25)}
                  stroke={s.colour}
                  strokeWidth={1}
                  fill="none"
                  pointerEvents="none"
                />
              ))}
            </g>
          ) : (
            <g key={s.id}>
              {/* Solid spline body: covers all but the last
                  segment when the right edge is a server-projected
                  endpoint (`s.dashLastSegment`). The leftTangent
                  / rightTangent pseudo-points (T1' / reflection)
                  steer the Catmull-Rom slope at the extreme knots
                  but are NEVER drawn. */}
              {s.dSolid ? (
                <path d={s.dSolid} fill="none" stroke={s.colour} strokeWidth="1.5" />
              ) : null}
              {/* Dashed last spline segment: terminates at the
                  server-projected endpoint (T(N)'). Only present
                  when the right edge is a partial bucket. */}
              {s.dDashed ? (
                <path
                  d={s.dDashed}
                  fill="none"
                  stroke={s.colour}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  opacity={0.85}
                />
              ) : null}
              {/* Data-point markers: small × at every interior
                  knot, suppressed on the server-projected endpoint
                  (which gets an outlined circle marker instead). */}
              {s.markers.map((m, i) =>
                m.isEndpoint ? (
                  <circle
                    key={`${s.id}-m-${i}`}
                    cx={m.x}
                    cy={m.y}
                    r={3.5}
                    fill="#fff"
                    stroke={s.colour}
                    strokeWidth={1.5}
                    pointerEvents="none"
                  >
                    <title>Projected full bucket (chart endpoint, estimated)</title>
                  </circle>
                ) : (
                  <path
                    key={`${s.id}-m-${i}`}
                    d={crossMarkerPath(m.x, m.y, 3)}
                    stroke={s.colour}
                    strokeWidth={1.25}
                    fill="none"
                    pointerEvents="none"
                  />
                ),
              )}
              {/* Right-partial floating-actual overlays:
                    * disconnected outlined dot at `partialActualT`
                      with the measured value,
                    * optional lightly-dotted trajectory linking
                      that dot out to the spline's right endpoint
                      (`T(N)'`); when the server didn't supply
                      sample points (e.g. metric doesn't support
                      a finer sub-aggregation) the connector
                      collapses to a straight dotted line. */}
              {s.rightOverlays.map((ov, i) => {
                // Build the trajectory path: starts at the floating
                // actual, walks through the sub-aggregated curve
                // sample points, ends at the spline's endpoint.
                let trajD = ''
                if (ov.endpoint) {
                  if (ov.curve.length > 0) {
                    const all = [
                      { x: ov.actual.x, y: ov.actual.y },
                      ...ov.curve,
                      { x: ov.endpoint.x, y: ov.endpoint.y },
                    ]
                    trajD = smoothedPath(all)
                  } else {
                    trajD =
                      `M${ov.actual.x.toFixed(2)},${ov.actual.y.toFixed(2)} ` +
                      `L${ov.endpoint.x.toFixed(2)},${ov.endpoint.y.toFixed(2)}`
                  }
                }
                return (
                  <g key={`${s.id}-fa-${i}`} pointerEvents="none">
                    {trajD ? (
                      <path
                        d={trajD}
                        fill="none"
                        stroke={s.colour}
                        strokeWidth={1}
                        strokeDasharray="1 3"
                        opacity={0.5}
                      />
                    ) : null}
                    <circle
                      cx={ov.actual.x}
                      cy={ov.actual.y}
                      r={3}
                      fill="#fff"
                      stroke={s.colour}
                      strokeWidth={1.5}
                    >
                      <title>
                        {ov.actual.kind === 'extrapolated'
                          ? `Partial bucket (in progress${
                              ov.actual.coverage !== null
                                ? `, ${Math.round(ov.actual.coverage * 100)}% observed`
                                : ''
                            })`
                          : `Partial bucket (window-aligned${
                              ov.actual.coverage !== null
                                ? `, ${Math.round(ov.actual.coverage * 100)}% inside window`
                                : ''
                            })`}
                      </title>
                    </circle>
                  </g>
                )
              })}
            </g>
          ),
        )}

        {annotations
          .filter((a) => a.tEnd !== null)
          .map((a) => {
            const x0 = xScale(Date.parse(a.tStart))
            const x1 = xScale(Date.parse(a.tEnd ?? a.tStart))
            const colour = annotationColour(a.tag)
            return (
              <rect
                key={`shade-${a.id}`}
                x={Math.min(x0, x1)}
                y={marginTop}
                width={Math.max(2, Math.abs(x1 - x0))}
                height={plotH}
                fill={colour}
                fillOpacity={0.06}
                pointerEvents="none"
              />
            )
          })}

        {annotations.map((a) => {
          const x = xScale(Date.parse(a.tStart))
          const colour = annotationColour(a.tag)
          return (
            <g
              key={a.id}
              role={interactive ? 'button' : undefined}
              tabIndex={interactive ? 0 : undefined}
              aria-label={`Annotation: ${a.title}`}
              onClick={interactive ? (e) => {
                e.stopPropagation()
                setHoverAnnotation(a)
              } : undefined}
              onKeyDown={interactive ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setHoverAnnotation(a)
                }
              } : undefined}
              style={{ cursor: interactive ? 'pointer' : 'default' }}
            >
              <rect
                x={x - 12}
                y={marginTop}
                width={24}
                height={plotH}
                fill="transparent"
                pointerEvents={interactive ? 'auto' : 'none'}
              />
              <rect x={x - 1} y={marginTop + plotH - 4} width={2} height={4} fill={colour} />
              <circle cx={x} cy={marginTop + plotH - 6} r={3} fill={colour} fillOpacity={0.6} />
            </g>
          )
        })}

        {drag?.kind === 'annotate' ? (
          <rect
            x={xScale(Math.min(drag.startMs, drag.currentMs))}
            y={marginTop}
            width={Math.max(2, Math.abs(xScale(drag.currentMs) - xScale(drag.startMs)))}
            height={plotH}
            fill="#2ca02c"
            fillOpacity={0.15}
            pointerEvents="none"
          />
        ) : null}

        {/* Crosshair + readout dots for hover */}
        {crosshairMs != null && nearestForHover ? (
          <g pointerEvents="none">
            <line
              x1={xScale(nearestForHover.t)}
              x2={xScale(nearestForHover.t)}
              y1={marginTop}
              y2={marginTop + plotH}
              stroke={ownsHover ? '#444' : '#bbb'}
              strokeWidth={ownsHover ? 1 : 1}
              strokeDasharray={ownsHover ? undefined : '3 3'}
              opacity={ownsHover ? 0.85 : 0.6}
            />
            {ownsHover
              ? series.map((s, i) => {
                  // In stack mode the hover dot must sit at the top of
                  // THIS series' band (y1), not at the raw value — the
                  // band is what's actually drawn at that x. Look up
                  // the series-local point at the hovered bucket.
                  //
                  // RIGHT-partial floating-actual dots aren't in
                  // `s.points` (they sit on `s.floatingActuals`,
                  // disconnected from the spline). When the hover
                  // snaps to one of those actual times, fall back to
                  // a matching floating-actual so the crosshair dot
                  // still lands on the visible marker.
                  const raw = nearestForHover.values[s.id]
                  if (raw == null) return null
                  const sp =
                    s.points.find((p) => p.t === nearestForHover.t) ?? null
                  const fa = sp
                    ? null
                    : s.floatingActuals.find(
                        (f) => f.t === nearestForHover.t,
                      ) ?? null
                  if (sp == null && fa == null) return null
                  const colour = s.colour ?? FALLBACK_COLOURS[i % FALLBACK_COLOURS.length]
                  return (
                    <circle
                      key={`hov-${s.id}`}
                      cx={xScale(nearestForHover.t)}
                      cy={yScale(stackMode === 'none' ? raw : (sp ? sp.y1 : raw))}
                      r={3.5}
                      fill={colour}
                      stroke="#fff"
                      strokeWidth={1.5}
                    />
                  )
                })
              : null}
          </g>
        ) : null}

        {loading && !response ? (
          <text x={width / 2} y={marginTop + plotH / 2} textAnchor="middle" fontSize="12" fill="#999">
            loading…
          </text>
        ) : null}

        {response && !hasData && !loading ? (
          <text x={width / 2} y={marginTop + plotH / 2} textAnchor="middle" fontSize="12" fill="#999">
            no data in this window / site filter
          </text>
        ) : null}
      </svg>

      <ChartLegend
        series={response?.metric.series ?? []}
        hiddenSeries={hiddenSeries}
        onToggle={toggleSeries}
      />

      {error ? <div className="metric-chart-error">⚠ {error}</div> : null}

      {/* Hover read-out — appears only when this chart owns the hover and we
          have a nearest bucket to talk about. Positioned absolute so it never
          shifts the page; CSS pins it inside the chart wrap. */}
      {ownsHover && nearestForHover ? (
        <HoverReadout
          series={series}
          datum={nearestForHover}
        />
      ) : null}

      {hoverAnnotation ? (
        <AnnotationTooltip
          key={hoverAnnotation.id}
          annotation={hoverAnnotation}
          metricId={metricId}
          onDelete={() => handleDelete(hoverAnnotation.id)}
          onClose={() => setHoverAnnotation(null)}
          onPatched={onAnnotationsChanged}
        />
      ) : null}

      {pendingCreate ? (
        <AnnotationCreateForm
          metricId={metricId}
          pending={pendingCreate}
          onCancel={() => setPendingCreate(null)}
          onSubmit={handleCreate}
        />
      ) : null}
    </div>
  )
}

function HoverReadout({
  series,
  datum,
}: {
  series: ReadonlyArray<{ id: string; label: string; colour: string }>
  datum: { t: number; values: Record<string, number | null> }
}) {
  const total = useMemo(() => {
    let t = 0
    let n = 0
    for (const s of series) {
      const v = datum.values[s.id]
      if (typeof v === 'number') {
        t += v
        n += 1
      }
    }
    return n > 1 ? t : null
  }, [series, datum])
  return (
    <div className="metric-chart-readout" aria-live="polite">
      <div className="metric-chart-readout-time">{shortDateLong(datum.t)}</div>
      <ul className="metric-chart-readout-list">
        {series.map((s) => {
          const v = datum.values[s.id]
          return (
            <li key={s.id}>
              <span className="metric-chart-readout-swatch" style={{ background: s.colour }} />
              <span className="metric-chart-readout-label">{s.label}</span>
              <span className="metric-chart-readout-value">
                {typeof v === 'number' ? compactNumber(v) : '—'}
              </span>
            </li>
          )
        })}
        {total != null ? (
          <li className="metric-chart-readout-total">
            <span className="metric-chart-readout-swatch" style={{ background: 'transparent' }} />
            <span className="metric-chart-readout-label">Total</span>
            <span className="metric-chart-readout-value">{compactNumber(total)}</span>
          </li>
        ) : null}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Scatter chart — used when `metric.chartType === 'scatter'`. X axis is the
// first declared series value, Y axis is the second. Each row in the
// response becomes one dot. Rows may carry an optional string `site_zip`
// column which the renderer uses to colour dots by site (so the operator
// can see, e.g., Midtown vs Bronx correlations side-by-side). The shared
// time-axis `window` still scopes which rows are included (server-side
// filtering on `from`/`to`), but pan / zoom interactions don't apply —
// scrolling the X axis would mean "scroll temperature", which is
// meaningless.
// ---------------------------------------------------------------------------

interface ScatterSvgProps {
  readonly response: MetricQueryResponse | null
  readonly loading: boolean
  readonly error: string | null
  readonly window: TimeWindow
  readonly interactive: boolean
}

const SITE_COLOURS = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#ff7f0e', '#8c564b']

function ScatterSvg({ response, loading, error, window, interactive }: ScatterSvgProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [renderedWidthPx, setRenderedWidthPx] = useState<number>(600)
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const w = Math.max(220, Math.floor(entries[0]?.contentRect.width ?? 600))
      setRenderedWidthPx(w)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const width = renderedWidthPx
  const height = interactive ? (renderedWidthPx < 480 ? 280 : 320) : 170
  const marginLeft = 56
  const marginRight = 14
  const marginTop = 14
  const marginBottom = 36
  const plotW = Math.max(50, width - marginLeft - marginRight)
  const plotH = Math.max(50, height - marginTop - marginBottom)

  const xSeries = response?.metric.series[0] ?? null
  const ySeries = response?.metric.series[1] ?? null

  // Index distinct site_zip values → stable colour. Sites are sorted
  // server-side, so the colour assignment is stable across reloads.
  const { points, sites, xMin, xMax, yMin, yMax } = useMemo(() => {
    const empty = {
      points: [] as Array<{ x: number; y: number; t: number; site: string | null }>,
      sites: [] as string[],
      xMin: 0,
      xMax: 1,
      yMin: 0,
      yMax: 1,
    }
    if (!response || !xSeries || !ySeries) return empty
    const xId = xSeries.id
    const yId = ySeries.id
    const pts: Array<{ x: number; y: number; t: number; site: string | null }> = []
    const siteSet = new Set<string>()
    let xLo = Number.POSITIVE_INFINITY
    let xHi = Number.NEGATIVE_INFINITY
    let yLo = Number.POSITIVE_INFINITY
    let yHi = Number.NEGATIVE_INFINITY
    for (const row of response.data) {
      const r = row as MetricDatum
      const x = r[xId]
      const y = r[yId]
      if (typeof x !== 'number' || typeof y !== 'number') continue
      const siteRaw = r.site_zip
      const site = typeof siteRaw === 'string' ? siteRaw : null
      if (site) siteSet.add(site)
      pts.push({ x, y, t: Date.parse(r.t), site })
      if (x < xLo) xLo = x
      if (x > xHi) xHi = x
      if (y < yLo) yLo = y
      if (y > yHi) yHi = y
    }
    if (pts.length === 0) return empty
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
    return {
      points: pts,
      sites: Array.from(siteSet).sort(),
      xMin: xLo,
      xMax: xHi,
      yMin: yLo,
      yMax: yHi,
    }
  }, [response, xSeries, ySeries])

  // Zoom / pan: shares the same hook with `CatalogScatterSvg`, so
  // gestures (Ctrl/⌘+wheel, pinch, double-click reset) and reset-chip
  // UX are identical across every scatter on the dashboard. Hovering
  // is suppressed during gestures and clipped points are ignored.
  const svgRef = useRef<SVGSVGElement | null>(null)
  // Full padded extent of the data (the legacy "base") — used as the
  // outer pan/zoom bounds and as the "Show all data" reset target.
  const fullDomain: ZoomView | null = useMemo(() => {
    if (points.length === 0) return null
    return { xMin, xMax, yMin, yMax }
  }, [points.length, xMin, xMax, yMin, yMax])
  // Outlier-resistant compact default view (densest ~90% per axis).
  // Outliers stay reachable: user can Ctrl/⌘-wheel or pinch out, or
  // click "Show all data" to swap the base view to the full domain.
  const autoZoom = useMemo(
    () => computeCompactDomain(points, { fullDomain }),
    [points, fullDomain],
  )
  const [fitMode, setFitMode] = useState<'compact' | 'full'>('compact')
  const baseDomain = fitMode === 'full' ? autoZoom.full : autoZoom.compact
  // June 2026: pan/zoom toggle UX. Default = inspect mode (legacy
  // hover/drill behaviour). Operator opts in via the toolbar to
  // capture wheel/pointer for box-zoom + pan.
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

  const xScale = useCallback(
    (v: number) => marginLeft + ((v - view.xMin) / (view.xMax - view.xMin)) * plotW,
    [marginLeft, plotW, view.xMin, view.xMax],
  )
  const yScale = useCallback(
    (v: number) => marginTop + plotH - ((v - view.yMin) / (view.yMax - view.yMin)) * plotH,
    [marginTop, plotH, view.yMin, view.yMax],
  )

  const colourForSite = useCallback(
    (site: string | null): string => {
      if (!site) return SITE_COLOURS[0]!
      const idx = sites.indexOf(site)
      if (idx < 0) return SITE_COLOURS[0]!
      return SITE_COLOURS[idx % SITE_COLOURS.length]!
    },
    [sites],
  )

  // Hover: track which visible dot (if any) is closest to the pointer.
  // Points panned/zoomed off-plot are ignored. Hover is also disabled
  // while a pan/pinch/wheel gesture is in flight.
  const [hover, setHover] = useState<{ idx: number; clientX: number; clientY: number } | null>(null)
  // Sticky-tooltip plumbing for touch — see MetricChart's matching block
  // for rationale. On touch / pen we delay the hover clear by 3500ms so
  // a finger lift doesn't immediately destroy the data readout (and we
  // duck under the long-press window).
  const lastPointerTypeRef = useRef<string>('mouse')
  const stickyHoverTimerRef = useRef<number | null>(null)
  const cancelStickyHoverClear = useCallback(() => {
    if (stickyHoverTimerRef.current !== null) {
      globalThis.clearTimeout(stickyHoverTimerRef.current)
      stickyHoverTimerRef.current = null
    }
  }, [])
  useEffect(() => () => cancelStickyHoverClear(), [cancelStickyHoverClear])
  const HOVER_PX = 18
  const HOVER_PX_SQ = HOVER_PX * HOVER_PX
  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      zoom.handlers.onPointerMove(e)
      lastPointerTypeRef.current = e.pointerType
      cancelStickyHoverClear()
      if (zoom.gestureActive) {
        if (hover) setHover(null)
        return
      }
      const svg = svgRef.current
      if (!svg || points.length === 0) return
      const ctm = svg.getScreenCTM()
      if (!ctm) return
      const pt = svg.createSVGPoint()
      pt.x = e.clientX
      pt.y = e.clientY
      const local = pt.matrixTransform(ctm.inverse())
      let bestIdx = -1
      let bestDistSq = Infinity
      for (let i = 0; i < points.length; i++) {
        const p = points[i]!
        if (
          p.x < view.xMin ||
          p.x > view.xMax ||
          p.y < view.yMin ||
          p.y > view.yMax
        ) {
          continue
        }
        const dx = xScale(p.x) - local.x
        const dy = yScale(p.y) - local.y
        const dsq = dx * dx + dy * dy
        if (dsq < bestDistSq) {
          bestDistSq = dsq
          bestIdx = i
        }
      }
      if (bestIdx >= 0 && bestDistSq <= HOVER_PX_SQ) {
        setHover({ idx: bestIdx, clientX: e.clientX, clientY: e.clientY })
      } else {
        setHover(null)
      }
    },
    [
      cancelStickyHoverClear,
      points,
      xScale,
      yScale,
      HOVER_PX_SQ,
      zoom,
      hover,
      view.xMin,
      view.xMax,
      view.yMin,
      view.yMax,
    ],
  )
  const onPointerLeave = useCallback(() => {
    if (lastPointerTypeRef.current === 'touch' || lastPointerTypeRef.current === 'pen') {
      cancelStickyHoverClear()
      stickyHoverTimerRef.current = globalThis.setTimeout(() => {
        stickyHoverTimerRef.current = null
        setHover(null)
      }, 3500)
      return
    }
    setHover(null)
  }, [cancelStickyHoverClear])

  const hovered = hover ? points[hover.idx] ?? null : null

  // Axis ticks — pick "nice" values (multiples of 1/2/5 × 10^k) so the
  // gridline labels land on 0/2/5/10/etc instead of arbitrary 4-sig-fig
  // floats. Shared `niceYTicks` helper for both axes; matches the
  // line-chart axis labels exactly.
  const xTicks = useMemo(() => niceYTicks(view.xMin, view.xMax, 5), [view.xMin, view.xMax])
  const yTicks = useMemo(() => niceYTicks(view.yMin, view.yMax, 5), [view.yMin, view.yMax])

  const hasData = points.length > 0
  const windowLabel = `${shortDate(window.fromMs)} → ${shortDate(window.toMs)}`

  return (
    <div className="metric-chart-svg-wrap" ref={wrapRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        className="metric-chart-svg"
        role="img"
        aria-label={
          xSeries && ySeries
            ? `Scatter chart: ${ySeries.label} (y) vs ${xSeries.label} (x), ${windowLabel}`
            : 'Scatter chart'
        }
        onPointerDown={interactive ? zoom.handlers.onPointerDown : undefined}
        onPointerMove={interactive ? onPointerMove : undefined}
        onPointerUp={interactive ? zoom.handlers.onPointerUp : undefined}
        onPointerCancel={interactive ? zoom.handlers.onPointerCancel : undefined}
        onPointerLeave={interactive ? onPointerLeave : undefined}
        onDoubleClick={interactive ? zoom.handlers.onDoubleClick : undefined}
        style={{
          touchAction: interactive ? zoom.svgStyle.touchAction : 'auto',
          cursor: interactive ? 'crosshair' : 'pointer',
        }}
      >
        {/* Clip dots so zoom/pan can't draw over the axis frame. */}
        <defs>
          <clipPath id={clipId}>
            <rect x={marginLeft} y={marginTop} width={plotW} height={plotH} />
          </clipPath>
        </defs>
        {/* axis frame */}
        <line
          x1={marginLeft}
          x2={width - marginRight}
          y1={marginTop + plotH}
          y2={marginTop + plotH}
          stroke="#ccc"
        />
        <line x1={marginLeft} x2={marginLeft} y1={marginTop} y2={marginTop + plotH} stroke="#ccc" />

        {/* Light dashed gridlines + tick labels. Gridlines are clipped to
            the plot area (niceYTicks may pick ticks just outside view if
            the rounded range straddles the data extent). */}
        {hasData
          ? yTicks.ticks.map((v) => {
              if (v < view.yMin || v > view.yMax) return null
              const y = yScale(v)
              return (
                <g key={`yt-${v}`}>
                  <line
                    x1={marginLeft}
                    x2={width - marginRight}
                    y1={y}
                    y2={y}
                    stroke="#d8d8d8"
                    strokeWidth={0.8}
                    strokeDasharray="3 3"
                    pointerEvents="none"
                  />
                  <text x={marginLeft - 6} y={y + 3} fontSize="10" textAnchor="end" fill="#555">
                    {formatYTick(v, yTicks.fractionDigits)}
                  </text>
                </g>
              )
            })
          : null}
        {hasData
          ? xTicks.ticks.map((v) => {
              if (v < view.xMin || v > view.xMax) return null
              const x = xScale(v)
              return (
                <g key={`xt-${v}`}>
                  <line
                    x1={x}
                    x2={x}
                    y1={marginTop}
                    y2={marginTop + plotH}
                    stroke="#d8d8d8"
                    strokeWidth={0.8}
                    strokeDasharray="3 3"
                    pointerEvents="none"
                  />
                  <text x={x} y={marginTop + plotH + 12} fontSize="10" textAnchor="middle" fill="#555">
                    {formatYTick(v, xTicks.fractionDigits)}
                  </text>
                </g>
              )
            })
          : null}

        {/* axis titles */}
        {xSeries ? (
          <text
            x={marginLeft + plotW / 2}
            y={height - 6}
            fontSize="11"
            textAnchor="middle"
            fill="#444"
          >
            {xSeries.label}
          </text>
        ) : null}
        {ySeries ? (
          <text
            transform={`translate(14 ${marginTop + plotH / 2}) rotate(-90)`}
            fontSize="11"
            textAnchor="middle"
            fill="#444"
          >
            {ySeries.label}
          </text>
        ) : null}

        {/* dots (clipped to the plot rect so panned points can't draw
            over the axis labels or chart frame) */}
        <g clipPath={`url(#${clipId})`}>
          {points.map((p, i) => (
            <circle
              key={i}
              cx={xScale(p.x)}
              cy={yScale(p.y)}
              r={hover?.idx === i ? 5 : 3}
              fill={colourForSite(p.site)}
              fillOpacity={hover?.idx === i ? 1 : 0.55}
              stroke={hover?.idx === i ? '#000' : 'none'}
              strokeWidth={hover?.idx === i ? 1 : 0}
              pointerEvents="none"
            />
          ))}
        </g>

        {loading && !response ? (
          <text x={width / 2} y={marginTop + plotH / 2} textAnchor="middle" fontSize="12" fill="#999">
            loading…
          </text>
        ) : null}

        {response && !hasData && !loading ? (
          <text x={width / 2} y={marginTop + plotH / 2} textAnchor="middle" fontSize="12" fill="#999">
            no (weather, margin) pairs in this window / site filter
          </text>
        ) : null}

        {/* Box-zoom drag preview overlay. Rendered outside the
            clipPath so the rectangle edges remain crisp at the plot
            border. */}
        {interactive && zoom.dragBox ? (
          <rect
            className="scatter-zoom-dragbox"
            x={zoom.dragBox.x}
            y={zoom.dragBox.y}
            width={zoom.dragBox.width}
            height={zoom.dragBox.height}
          />
        ) : null}
      </svg>

      {interactive ? (
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
      ) : null}

      <ScatterLegend sites={sites} colourFor={colourForSite} />

      {error ? <div className="metric-chart-error">⚠ {error}</div> : null}

      {hovered && xSeries && ySeries ? (
        <div className="metric-chart-readout" aria-live="polite">
          <div className="metric-chart-readout-time">
            {shortDateLong(hovered.t)}
            {hovered.site ? ` · ZIP ${hovered.site}` : ''}
          </div>
          <ul className="metric-chart-readout-list">
            <li>
              <span
                className="metric-chart-readout-swatch"
                style={{ background: xSeries.colour ?? '#888' }}
              />
              <span className="metric-chart-readout-label">{xSeries.label}</span>
              <span className="metric-chart-readout-value">{compactNumber(hovered.x)}</span>
            </li>
            <li>
              <span
                className="metric-chart-readout-swatch"
                style={{ background: ySeries.colour ?? '#888' }}
              />
              <span className="metric-chart-readout-label">{ySeries.label}</span>
              <span className="metric-chart-readout-value">{compactNumber(hovered.y)}</span>
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function ScatterLegend({
  sites,
  colourFor,
}: {
  sites: ReadonlyArray<string>
  colourFor: (site: string | null) => string
}) {
  if (sites.length === 0) return null
  return (
    <div className="metric-chart-legend">
      {sites.map((s) => (
        <span className="metric-chart-legend-item" key={s}>
          <span
            className="metric-chart-legend-swatch"
            style={{ background: colourFor(s) }}
          />
          ZIP {s}
        </span>
      ))}
    </div>
  )
}

/**
 * Pick `n` evenly-spaced tick values between `lo` and `hi` (inclusive
 * of both endpoints). Rounded to a few significant digits so the
 * labels don't carry 12 decimals of floating-point noise.
 */
function makeTicks(lo: number, hi: number, n: number): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || n < 2) return [lo]
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const v = lo + ((hi - lo) * i) / (n - 1)
    // Round to 4 sig figs; avoids '14.999999999999998' axis labels.
    const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(v) || 1)) - 3)
    out.push(mag > 0 ? Math.round(v / mag) * mag : v)
  }
  return out
}

function ChartLegend({
  series,
  hiddenSeries,
  onToggle,
}: {
  series: ReadonlyArray<{ id: string; label: string; colour?: string }>
  hiddenSeries: ReadonlySet<string>
  onToggle: (id: string) => void
}) {
  if (series.length === 0) return null
  return (
    <div className="metric-chart-legend" role="group" aria-label="Series visibility">
      {series.map((s, i) => {
        const colour = s.colour ?? FALLBACK_COLOURS[i % FALLBACK_COLOURS.length]
        const hidden = hiddenSeries.has(s.id)
        return (
          <button
            type="button"
            className={`metric-chart-legend-item${hidden ? ' is-hidden' : ''}`}
            key={s.id}
            onClick={(e) => {
              e.stopPropagation()
              onToggle(s.id)
            }}
            aria-pressed={!hidden}
            title={hidden ? `Show ${s.label}` : `Hide ${s.label}`}
          >
            <span
              className="metric-chart-legend-swatch"
              style={{ background: hidden ? 'transparent' : colour, borderColor: colour }}
            />
            <span className="metric-chart-legend-label">{s.label}</span>
          </button>
        )
      })}
    </div>
  )
}

function ScreenReaderSummary({
  metric,
  response,
  window,
  loading,
}: {
  metric: MetricDefSummary
  response: MetricQueryResponse | null
  window: TimeWindow
  loading: boolean
}) {
  return (
    <div className="sr-only" role="status" aria-live="polite">
      {loading && !response
        ? `Loading ${metric.title} data.`
        : response && response.data.length > 0
          ? `${metric.title} from ${new Date(window.fromMs).toISOString()} to ${new Date(window.toMs).toISOString()}. ` +
            response.metric.series
              .map((s) => {
                const last = response.data[response.data.length - 1]
                const v = last ? (last as MetricDatum)[s.id] : null
                return `${s.label}: ${typeof v === 'number' ? v : 'no data'}`
              })
              .join(', ')
          : response
            ? `No data in this range for ${metric.title}.`
            : ''}
    </div>
  )
}

interface AnnotationTooltipProps {
  readonly annotation: MetricAnnotationRecord
  readonly metricId: string
  readonly onDelete: () => void
  readonly onClose: () => void
  readonly onPatched: () => void
}

function AnnotationTooltip({ annotation, onDelete, onClose, onPatched }: AnnotationTooltipProps) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(annotation.title)
  const [body, setBody] = useState(annotation.body)
  const [tag, setTag] = useState(annotation.tag ?? '')
  const [mutationError, setMutationError] = useState<string | null>(null)
  const colour = annotationColour(annotation.tag)
  const closeBtnRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    closeBtnRef.current?.focus()
  }, [])
  const onSave = async () => {
    try {
      await mutateJson(
        `/api/metric-annotations/${encodeURIComponent(annotation.id)}`,
        PassthroughSchema,
        {
          method: 'PATCH',
          body: JSON.stringify({ title, body, tag: tag.trim() === '' ? null : tag.trim() }),
        },
      )
      setEditing(false)
      setMutationError(null)
      onPatched()
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div className="metric-chart-tooltip" role="dialog" aria-modal="false" aria-label="Annotation">
      <header style={{ borderLeft: `4px solid ${colour}` }}>
        <strong>{editing ? <input value={title} onChange={(e) => setTitle(e.target.value)} /> : annotation.title}</strong>
        <span className="metric-chart-tooltip-tag">{annotation.tag ?? 'untagged'}</span>
      </header>
      <p className="subtle-copy">
        {shortDateLong(Date.parse(annotation.tStart))}
        {annotation.tEnd ? ` → ${shortDateLong(Date.parse(annotation.tEnd))}` : ''}
      </p>
      <p className="subtle-copy">by {annotation.author}</p>
      {editing ? (
        <>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} />
          <label className="subtle-copy">
            tag: <input value={tag} onChange={(e) => setTag(e.target.value)} />
          </label>
        </>
      ) : (
        annotation.body && <p>{annotation.body}</p>
      )}
      {mutationError ? <p className="metric-chart-error">{mutationError}</p> : null}
      <div className="inline-row">
        {editing ? (
          <>
            <button type="button" className="ghost-button" onClick={onSave}>
              save
            </button>
            <button type="button" className="ghost-button" onClick={() => setEditing(false)}>
              cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" className="ghost-button" onClick={() => setEditing(true)}>
              edit
            </button>
            <button type="button" className="ghost-button" onClick={onDelete}>
              delete
            </button>
            <button type="button" className="ghost-button" ref={closeBtnRef} onClick={onClose}>
              close
            </button>
          </>
        )}
      </div>
    </div>
  )
}

interface AnnotationCreateFormProps {
  readonly metricId: string
  readonly pending: { tStart: string; tEnd: string | null }
  readonly onCancel: () => void
  readonly onSubmit: (payload: { title: string; body: string; tag: string | null; scope: string }) => Promise<void>
}

function AnnotationCreateForm({ metricId, pending, onCancel, onSubmit }: AnnotationCreateFormProps) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tag, setTag] = useState('note')
  // Default to GLOBAL so an annotation drops a cross-chart event indicator
  // by default, matching the parent epic spec ("have an event indicator on
  // other graphs at that moment that can hoverover to see details").
  const [scope, setScope] = useState<'global' | 'metric'>('global')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  return (
    <div className="metric-chart-create" role="dialog" aria-modal="true" aria-label="New annotation">
      <p className="subtle-copy">
        new annotation at {shortDateLong(Date.parse(pending.tStart))}
        {pending.tEnd ? ` → ${shortDateLong(Date.parse(pending.tEnd))}` : ' (point)'}
      </p>
      <label>
        title <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </label>
      <label>
        body <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} />
      </label>
      <label>
        tag{' '}
        <select value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="note">note</option>
          <option value="incident">incident</option>
          <option value="change">change</option>
          <option value="launch">launch</option>
          <option value="experiment">experiment</option>
          <option value="sale">sale</option>
        </select>
      </label>
      <label>
        scope{' '}
        <select value={scope} onChange={(e) => setScope(e.target.value as 'global' | 'metric')}>
          <option value="global">global (event on every chart)</option>
          <option value="metric">this chart only</option>
        </select>
      </label>
      {submitError ? <p className="metric-chart-error">{submitError}</p> : null}
      <div className="inline-row">
        <button
          type="button"
          className="ghost-button"
          disabled={!title.trim() || submitting}
          onClick={async () => {
            setSubmitting(true)
            setSubmitError(null)
            try {
              await onSubmit({
                title: title.trim(),
                body,
                tag: tag.trim() === '' ? null : tag.trim(),
                scope: scope === 'global' ? 'global' : `metric:${metricId}`,
              })
            } catch (e) {
              setSubmitError(e instanceof Error ? e.message : String(e))
              setSubmitting(false)
            }
          }}
        >
          create
        </button>
        <button type="button" className="ghost-button" onClick={onCancel}>
          cancel
        </button>
      </div>
    </div>
  )
}

function annotationColour(tag: string | null): string {
  if (!tag) return '#888888'
  return TAG_COLOURS[tag] ?? '#555555'
}

const COMPACT_FMT = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 })
function compactNumber(v: number): string {
  return COMPACT_FMT.format(v)
}

// Hover-readout / range-label timestamps render in **NY wall-clock**
// (canon: "Always use NY timezones for aggregate and display"). This
// matches the X-axis tick labels (gridlines.ts → formatXTick) and the
// server-side NY-bucketed data. Previously these were rendered in
// UTC, which caused the hover readout to read 4–5 hours ahead of the
// register-tape time the operator expects to see.
function shortDate(ms: number): string {
  return nyShortDateTime(ms)
}

function shortDateLong(ms: number): string {
  return nyLongDateTime(ms)
}
