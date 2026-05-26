import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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

import { useTimeAxis, type TimeWindow } from './TimeAxisContext.js'
import { bucketXTicks, formatXTick, formatYTick, niceYTicks } from './gridlines.js'

// We re-fetch the annotation list after every mutation, so we don't
// need to consume the response payload — a passthrough schema lets us
// stay out of the strict-zod return-type loop.
const PassthroughSchema = z.unknown()

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

export interface MetricChartProps {
  readonly metric: MetricDefSummary
  /** Comma-separated list (the API parses to an array). */
  readonly sitesParam: string
  /** Page-default aggregation; the chart's own aggregation override wins if set. */
  readonly defaultAgg: MetricAggregation
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
}

export function MetricChart({
  metric,
  sitesParam,
  defaultAgg,
  annotations,
  onAnnotationsChanged,
  variant = 'expanded',
  onExpand,
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

  const [response, setResponse] = useState<MetricQueryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [annotateMode, setAnnotateMode] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams()
    if (sitesParam) params.set('sites', sitesParam)
    params.set('from', new Date(window.fromMs).toISOString())
    params.set('to', new Date(window.toMs).toISOString())
    params.set('agg', agg)
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
  }, [metric.id, sitesParam, agg, window.fromMs, window.toMs])

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
          <h3 className="metric-chart-title">{metric.title}</h3>
          {variant === 'expanded' && metric.description ? (
            <details className="metric-chart-desc-wrap">
              <summary className="subtle-copy">about this metric</summary>
              <p className="subtle-copy metric-chart-desc">{metric.description}</p>
            </details>
          ) : null}
        </div>
        {variant === 'expanded' ? (
          <div className="metric-chart-controls">
            <select
              value={aggOverride ?? ''}
              onChange={(e) => setAggOverride((e.target.value || null) as MetricAggregation | null)}
              aria-label={`Aggregation for ${metric.title}`}
            >
              <option value="">agg: {defaultAgg} (page)</option>
              {metric.supportedAggregations.map((a) => (
                <option key={a} value={a}>
                  agg: {a}
                </option>
              ))}
            </select>
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
      />
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
  } = props
  const svgRef = useRef<SVGSVGElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const sharedAxis = useTimeAxis()

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

  const { yMin, yMax, series, datumByMs } = useMemo(() => {
    if (!response)
      return {
        yMin: 0,
        yMax: 1,
        series: [] as Array<{ id: string; label: string; colour: string; points: Array<{ raw: number; t: number }> }>,
        datumByMs: [] as Array<{ t: number; values: Record<string, number | null> }>,
      }
    const ids = response.metric.series.map((s) => s.id)
    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY
    for (const d of response.data) {
      for (const id of ids) {
        const v = (d as MetricDatum)[id]
        if (typeof v === 'number') {
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
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
    const seriesOut = response.metric.series.map((s, i) => {
      const colour = s.colour ?? FALLBACK_COLOURS[i % FALLBACK_COLOURS.length]
      const points: Array<{ raw: number; t: number }> = []
      for (const d of response.data) {
        const v = (d as MetricDatum)[s.id]
        const t = Date.parse(d.t)
        if (typeof v === 'number') {
          points.push({ raw: v, t })
        }
      }
      return { id: s.id, label: s.label, colour, points }
    })
    const datumByMs = response.data
      .map((d) => {
        const values: Record<string, number | null> = {}
        for (const id of ids) {
          const v = (d as MetricDatum)[id]
          values[id] = typeof v === 'number' ? v : null
        }
        return { t: Date.parse(d.t), values }
      })
      .sort((a, b) => a.t - b.t)
    return { yMin: lo, yMax: hi, series: seriesOut, datumByMs }
  }, [response])

  const yScale = useCallback(
    (v: number) => marginTop + plotH - ((v - yMin) / (yMax - yMin)) * plotH,
    [yMin, yMax, plotH, marginTop],
  )

  const seriesPaths = useMemo(() => {
    return series.map((s) => {
      const d = s.points
        .map((p, i) => {
          const x = xScale(p.t)
          const y = yScale(p.raw)
          return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
        })
        .join(' ')
      return { ...s, d }
    })
  }, [series, xScale, yScale])

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
    const fromY = new Date(window.fromMs).getUTCFullYear()
    const toY = new Date(window.toMs).getUTCFullYear()
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
      const t = clientXToTime(e.clientX)
      if (t === null) return
      setHoverMs(t)
      sharedAxis.publishHover(t)
    },
    [clientXToTime, sharedAxis],
  )

  const onPointerLeave = useCallback(() => {
    setHoverMs(null)
    sharedAxis.publishHover(null)
  }, [sharedAxis])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!interactive) return
      if (e.button !== 0 && e.pointerType === 'mouse') return
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
    [annotateMode, clientXToTime, interactive, window],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const tracked = activePointersRef.current.get(e.pointerId)
      if (tracked) {
        tracked.clientX = e.clientX
      }

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
    [clientXToTime, drag, plotW, setWindow, sharedAxis],
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

  const hasData = !!response && response.data.length > 0 && seriesPaths.some((s) => s.d.length > 0)

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

        {seriesPaths.map((s) => (
          <path key={s.id} d={s.d} fill="none" stroke={s.colour} strokeWidth="1.5" />
        ))}

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
                  const v = nearestForHover.values[s.id]
                  if (v == null) return null
                  const colour = s.colour ?? FALLBACK_COLOURS[i % FALLBACK_COLOURS.length]
                  return (
                    <circle
                      key={`hov-${s.id}`}
                      cx={xScale(nearestForHover.t)}
                      cy={yScale(v)}
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

      <ChartLegend series={response?.metric.series ?? []} />

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

function ChartLegend({ series }: { series: ReadonlyArray<{ id: string; label: string; colour?: string }> }) {
  if (series.length === 0) return null
  return (
    <div className="metric-chart-legend">
      {series.map((s, i) => {
        const colour = s.colour ?? FALLBACK_COLOURS[i % FALLBACK_COLOURS.length]
        return (
          <span className="metric-chart-legend-item" key={s.id}>
            <span className="metric-chart-legend-swatch" style={{ background: colour }} />
            {s.label}
          </span>
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

function shortDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function shortDateLong(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`
}
