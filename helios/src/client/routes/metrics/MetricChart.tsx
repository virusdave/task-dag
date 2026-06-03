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
  type MetricQueryResponse,
} from '../../../shared/contracts/index.js'
import { loadJson, mutateJson } from '../../app/fetchJson.js'
import { nyLongDateTime, nyParts, nyShortDateTime } from '../../app/nyTime.js'

import type { CatalogFilterSelection } from './CatalogFilterBar.js'
import { useTimeAxis, type TimeWindow } from './TimeAxisContext.js'
import {
  bucketXTicks,
  catmullRomBezierSegment,
  crossMarkerPath,
  formatXTick,
  formatYTick,
  niceYTicks,
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
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent): void => {
      if (
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node) &&
        popRef.current &&
        !popRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])
  useViewportClampedPopover(open, anchorRef, popRef)
  if (!text || text.trim() === '') return null
  return (
    <span
      className={`metric-chart-help ${open ? 'is-open' : ''}`}
      ref={anchorRef}
      onClick={(e) => {
        e.stopPropagation()
        setOpen((v) => !v)
      }}
      onMouseEnter={() => {
        hoverInsideRef.current = true
        setOpen(true)
      }}
      onMouseLeave={() => {
        hoverInsideRef.current = false
        // Only auto-close on mouse-leave; touch-tap toggles persist
        // until the operator taps elsewhere (handled by onDocClick).
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

  const [response, setResponse] = useState<MetricQueryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [annotateMode, setAnnotateMode] = useState(false)

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
    params.set('from', new Date(window.fromMs).toISOString())
    params.set('to', new Date(window.toMs).toISOString())
    params.set('agg', agg)
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
          agg={agg}
          stackMode={stackMode}
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
  /** Effective aggregation (drives X-axis bucket-aligned tick placement). */
  readonly agg: MetricAggregation
  /** How to stack the series. Forced to 'none' for single-series charts. */
  readonly stackMode: MetricStackMode
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
    agg,
    stackMode,
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
      /**
       * Projected full-natural-bucket value for THIS series, plus
       * the x position where it should be plotted. The renderer
       * draws a dashed tangent-continuous extension from the solid
       * point at `(t, raw)` to `(projectedT, projected)` whenever
       * `projectedT > t` (right edge). When `projectedT === t`
       * (left edge, projected sits at bucketStart = same x as the
       * partial actual), the dashed extension is degenerate and
       * the renderer just outlines the marker.
       */
      projected: number | null
      projectedT: number | null
    }
    type SeriesPoint = {
      t: number
      raw: number
      y0: number
      y1: number
      /**
       * Server-marked partial-bucket metadata, populated only for
       * the leftmost / rightmost row when the displayed window
       * doesn't align with the natural aggregation boundary. See
       * `partialBuckets.ts` (server wrapper) for the data shape.
       */
      partial?: PartialMeta
    }
    type Series = {
      id: string
      label: string
      colour: string
      points: SeriesPoint[]
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

    // datumByMs is the hover-readout source — it always shows raw values,
    // regardless of stack mode, so the operator sees the real number.
    const datumByMs = rows.map((d) => {
      const values: Record<string, number | null> = {}
      for (const id of ids) {
        const v = (d as MetricDatum)[id]
        values[id] = typeof v === 'number' ? v : null
      }
      return { t: Date.parse(d.t), values }
    })

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
      }
    })

    // Server-marked partial-bucket edge rows. The ACTUAL measured value
    // is on the row's regular series field (so the solid line is
    // anchored to real data); a separate per-series `partialProjected`
    // map carries the projected full-natural-bucket value, and
    // `partialProjectedT` carries its x position (lastEnd for right,
    // firstStart for left). The renderer attaches `partial` metadata
    // to the corresponding SeriesPoint so the marker / dashed extension
    // can be drawn in the SVG block below.
    function partialSideOf(d: MetricDatum): 'left' | 'right' | 'both' | null {
      const p = d.partial
      return p === 'left' || p === 'right' || p === 'both' ? p : null
    }
    function partialKindOf(d: MetricDatum): 'truncated' | 'extrapolated' {
      return d.partialKind === 'extrapolated' ? 'extrapolated' : 'truncated'
    }
    function partialMetaForSeries(
      d: MetricDatum,
      seriesId: string,
    ): PartialMeta | undefined {
      const side = partialSideOf(d)
      if (side === null) return undefined
      const projected = d.partialProjected?.[seriesId]
      const projectedT = d.partialProjectedT ? Date.parse(d.partialProjectedT) : null
      return {
        side,
        kind: partialKindOf(d),
        coverage:
          typeof d.partialCoverage === 'number' ? d.partialCoverage : null,
        projected:
          typeof projected === 'number' && Number.isFinite(projected)
            ? projected
            : null,
        projectedT: projectedT !== null && Number.isFinite(projectedT) ? projectedT : null,
      }
    }

    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY

    if (stackMode === 'none') {
      // Raw values only; null cells are skipped (matches the pre-stack
      // behaviour exactly so 'none' mode is bit-for-bit unchanged).
      for (const d of rows) {
        const t = Date.parse(d.t)
        for (let i = 0; i < seriesOut.length; i++) {
          const id = ids[i]!
          const v = (d as MetricDatum)[id]
          if (typeof v !== 'number') continue
          if (v < lo) lo = v
          if (v > hi) hi = v
          const partial = partialMetaForSeries(d as MetricDatum, id)
          // Include partial-projected value in the y-range so the
          // dashed extension doesn't render off-chart.
          if (partial?.projected !== null && partial?.projected !== undefined) {
            if (partial.projected < lo) lo = partial.projected
            if (partial.projected > hi) hi = partial.projected
          }
          // y0/y1 placeholders — only y1 is used; the axis baseline
          // for y0 is filled in below once lo/hi are known.
          seriesOut[i]!.points.push({ t, raw: v, y0: 0, y1: v, partial })
        }
      }
      if (!isFinite(lo) || !isFinite(hi)) {
        lo = 0
        hi = 1
      } else if (lo === hi) {
        lo -= 1
        hi += 1
      } else {
        const span = hi - lo
        lo -= span * 0.05
        hi += span * 0.05
      }
      // Set y0 = axis bottom so a future "fill under line" affordance
      // doesn't need a second pass.
      for (const s of seriesOut) {
        for (const p of s.points) p.y0 = lo
      }
      return { yMin: lo, yMax: hi, series: seriesOut, datumByMs }
    }

    // Stacked / percent: every bucket contributes ONE column of bands,
    // ordered by series-declaration index. Null / negative cells are
    // clamped to 0 so the stack stays monotonic and operators don't see
    // weird inverted bands.
    let stackTop = 0
    for (const d of rows) {
      const t = Date.parse(d.t)
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
  }, [response, stackMode, hiddenSeries])

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
    type PartialOverlay = {
      /** Outlined marker around the partial-actual point on the solid line. */
      actual: {
        x: number
        y: number
        side: 'left' | 'right' | 'both'
        kind: 'truncated' | 'extrapolated'
        coverage: number | null
      }
      /**
       * Tangent-continuous dashed bezier extending from the partial-
       * actual point to the projected endpoint, plus the projected
       * endpoint marker. Absent when the projected endpoint sits at
       * the same x as the actual (left edge — degenerate).
       */
      extension: {
        path: string
        endX: number
        endY: number
        endValue: number
      } | null
    }
    return series.map((s) => {
      // Partial-bucket edge overlays: for each series point flagged
      // with `partial`, render an outlined marker on top of the solid
      // line, and (right edge only) a tangent-continuous dashed
      // bezier extension to the projected endpoint at `projectedT`.
      // Tangent continuity is what makes the dashed line look like a
      // smooth continuation of the Catmull-Rom solid path rather
      // than a straight tangent-free segment.
      const sortedPts = s.points.slice().sort((a, b) => a.t - b.t)
      const partialOverlays: PartialOverlay[] = []
      if (stackMode === 'none') {
        for (let i = 0; i < sortedPts.length; i++) {
          const p = sortedPts[i]!
          if (!p.partial) continue
          const ax = xScale(p.t)
          const ay = yScale(p.y1)
          const overlay: PartialOverlay = {
            actual: {
              x: ax,
              y: ay,
              side: p.partial.side,
              kind: p.partial.kind,
              coverage: p.partial.coverage,
            },
            extension: null,
          }
          // Right-edge dashed extension. Per operator spec
          // (2026-06-03): the dashed projection FORKS from the
          // last full-bucket dot (the interior point immediately
          // before the partial), NOT from the partial-actual dot.
          // So the last full-bucket dot has two curves diverging
          // out of it: the existing solid Catmull-Rom segment
          // continues to the partial-actual point, and a dashed
          // segment splits off to the projected (full-bucket /
          // pace-extrapolated) endpoint. Skip the dashed extension
          // when no interior point precedes the partial (e.g. a
          // window narrow enough that the partial IS the first
          // and only point — nothing to fork from).
          const projT = p.partial.projectedT
          const projV = p.partial.projected
          if (projT !== null && projV !== null && projT > p.t && i > 0) {
            const lastFullPt = sortedPts[i - 1]!
            // Tangent at the fork dot: same convention smoothedPath
            // uses — neighbour 2 back on the solid side, partial-
            // actual or projected on the other. We use the point
            // 2 back from the partial (i.e. 1 back from the fork)
            // for the prev neighbour so the dashed tangent at the
            // fork dot blends with the solid curve's incoming
            // tangent. The far end reflects (no point past the
            // projected endpoint).
            const prevFullPt = i >= 2 ? sortedPts[i - 2]! : lastFullPt
            const prev = { x: xScale(prevFullPt.t), y: yScale(prevFullPt.y1) }
            const curr = {
              x: xScale(lastFullPt.t),
              y: yScale(lastFullPt.y1),
            }
            const next = { x: xScale(projT), y: yScale(projV) }
            const path = catmullRomBezierSegment({
              prev,
              curr,
              next,
              after: next,
            })
            overlay.extension = { path, endX: next.x, endY: next.y, endValue: projV }
          }
          partialOverlays.push(overlay)
        }
      }
      if (s.points.length === 0) {
        return {
          ...s,
          d: '',
          markers: [] as Array<{ x: number; y: number }>,
          fill: stackMode !== 'none' as const,
          partialOverlays,
        }
      }
      const topPts = s.points.map((p) => ({ x: xScale(p.t), y: yScale(p.y1) }))
      if (stackMode === 'none') {
        return {
          ...s,
          d: smoothedPath(topPts),
          markers: topPts,
          fill: false as const,
          partialOverlays,
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
        d: `${top} ${bottomAsLine} Z`,
        markers: topPts,
        fill: true as const,
        partialOverlays,
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

  const onWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.stopPropagation()
  }, [])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg || !interactive) return
    function handler(this: SVGSVGElement, ev: WheelEvent) {
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
  }, [clientXToTime, interactive, setWindow, window.fromMs, window.toMs])

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
    seriesPaths.some((s) => s.d.length > 0 || s.partialOverlays.length > 0)

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
          touchAction: interactive ? 'none' : 'auto',
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
              <path d={s.d} fill="none" stroke={s.colour} strokeWidth="1.5" />
              {/* Data-point markers: small × at every real measurement so the
                  reader can distinguish points from the interpolated curve
                  between them. */}
              {s.markers.map((m, i) => (
                <path
                  key={`${s.id}-m-${i}`}
                  d={crossMarkerPath(m.x, m.y, 3)}
                  stroke={s.colour}
                  strokeWidth={1.25}
                  fill="none"
                  pointerEvents="none"
                />
              ))}
              {/* Partial-bucket overlays. The solid line already
                  passes through the ACTUAL measured value at the
                  partial-bucket position; here we add (a) an
                  outlined ring around that point so the reader can
                  tell it's a partial-window measurement, and (b)
                  for right-edge partials, a tangent-continuous
                  dashed extension to the projected (full-bucket /
                  pace-extrapolated) endpoint. */}
              {s.partialOverlays.map((ov, i) => (
                <g key={`${s.id}-p-${i}`} pointerEvents="none">
                  {ov.extension ? (
                    <>
                      <path
                        d={ov.extension.path}
                        fill="none"
                        stroke={s.colour}
                        strokeWidth={1.5}
                        strokeDasharray="4 3"
                        opacity={0.85}
                      />
                      <circle
                        cx={ov.extension.endX}
                        cy={ov.extension.endY}
                        r={3.5}
                        fill="#fff"
                        stroke={s.colour}
                        strokeWidth={1.5}
                      >
                        <title>
                          {ov.actual.kind === 'extrapolated'
                            ? `Projected full bucket (pace-extrapolated${
                                ov.actual.coverage !== null
                                  ? `, ${Math.round(ov.actual.coverage * 100)}% observed`
                                  : ''
                              })`
                            : `Projected full bucket${
                                ov.actual.coverage !== null
                                  ? ` (${Math.round(ov.actual.coverage * 100)}% inside window)`
                                  : ''
                              }`}
                        </title>
                      </circle>
                    </>
                  ) : null}
                  {/* Outlined marker on the partial-actual point itself. */}
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
              ))}
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
                  const sp = s.points.find((p) => p.t === nearestForHover.t) ?? null
                  const raw = nearestForHover.values[s.id]
                  if (sp == null || raw == null) return null
                  const colour = s.colour ?? FALLBACK_COLOURS[i % FALLBACK_COLOURS.length]
                  return (
                    <circle
                      key={`hov-${s.id}`}
                      cx={xScale(nearestForHover.t)}
                      cy={yScale(stackMode === 'none' ? raw : sp.y1)}
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
