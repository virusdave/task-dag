import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
}

export function MetricChart({
  metric,
  sitesParam,
  defaultAgg,
  annotations,
  onAnnotationsChanged,
}: MetricChartProps) {
  const sharedAxis = useTimeAxis()
  const [locked, setLocked] = useState(true)
  // When unlocked, the chart owns its own window; when locked, it uses
  // the shared axis as the source of truth.
  const [localWindow, setLocalWindow] = useState<TimeWindow>(sharedAxis.window)
  const window = locked ? sharedAxis.window : localWindow
  const setWindow = locked ? sharedAxis.setWindow : setLocalWindow

  // Per-chart aggregation override (null = follow page default).
  const [aggOverride, setAggOverride] = useState<MetricAggregation | null>(null)
  const agg = aggOverride ?? defaultAgg

  const [response, setResponse] = useState<MetricQueryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [annotateMode, setAnnotateMode] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const params = new URLSearchParams()
    if (sitesParam) params.set('sites', sitesParam)
    params.set('from', new Date(window.fromMs).toISOString())
    params.set('to', new Date(window.toMs).toISOString())
    params.set('agg', agg)
    loadJson(`/api/metrics/${encodeURIComponent(metric.id)}?${params.toString()}`, MetricQueryResponseSchema)
      .then((r) => {
        if (!cancelled) setResponse(r)
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
  }, [metric.id, sitesParam, agg, window.fromMs, window.toMs])

  // Filter annotations to this chart: global ones always render, plus
  // any explicitly scoped to this metric. Then trim to the visible
  // window with a 5% pad on each side so a tooltip near the edge still
  // shows.
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

  return (
    <article className="metric-chart-card">
      <header className="metric-chart-header">
        <div>
          <h3 className="metric-chart-title">{metric.title}</h3>
          {metric.description ? <p className="subtle-copy metric-chart-desc">{metric.description}</p> : null}
        </div>
        <div className="metric-chart-controls">
          <select
            value={aggOverride ?? ''}
            onChange={(e) => setAggOverride((e.target.value || null) as MetricAggregation | null)}
            title="Aggregation override for this chart"
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
            onClick={() => setAnnotateMode((v) => !v)}
            title="Toggle annotate mode (click to drop a point annotation, drag to mark a range)"
          >
            {annotateMode ? '✏️ annotating' : '✏️ annotate'}
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              if (locked) {
                // On unlock, seed local window from shared.
                setLocalWindow(sharedAxis.window)
              }
              setLocked((v) => !v)
            }}
            title={locked ? 'Unlock from shared time axis' : 'Lock to shared time axis'}
          >
            {locked ? '🔒 locked' : '🔓 unlocked'}
          </button>
        </div>
      </header>
      <ChartSvg
        response={response}
        loading={loading}
        error={error}
        window={window}
        setWindow={setWindow}
        annotateMode={annotateMode}
        annotations={visibleAnnotations}
        metricId={metric.id}
        onAnnotationsChanged={onAnnotationsChanged}
      />
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
}

interface DragState {
  readonly kind: 'pan' | 'annotate'
  readonly startClientX: number
  readonly startMs: number
  readonly currentClientX: number
  readonly currentMs: number
}

function ChartSvg(props: ChartSvgProps) {
  const { response, loading, error, window, setWindow, annotateMode, annotations, metricId, onAnnotationsChanged } =
    props
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [hoverAnnotation, setHoverAnnotation] = useState<MetricAnnotationRecord | null>(null)
  const [pendingCreate, setPendingCreate] = useState<{ tStart: string; tEnd: string | null } | null>(null)

  const width = 600
  const height = 220
  const marginLeft = 48
  const marginRight = 16
  const marginTop = 12
  const marginBottom = 28
  const plotW = width - marginLeft - marginRight
  const plotH = height - marginTop - marginBottom

  const xScale = useCallback(
    (ms: number) => marginLeft + ((ms - window.fromMs) / (window.toMs - window.fromMs)) * plotW,
    [window.fromMs, window.toMs, plotW, marginLeft],
  )
  const xUnscale = useCallback(
    (px: number) => window.fromMs + ((px - marginLeft) / plotW) * (window.toMs - window.fromMs),
    [window.fromMs, window.toMs, plotW, marginLeft],
  )

  const { yMin, yMax, series } = useMemo(() => {
    if (!response) return { yMin: 0, yMax: 1, series: [] as Array<{ id: string; label: string; colour: string; points: Array<{ x: number; y: number; raw: number; t: number }> }> }
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
      const points: Array<{ x: number; y: number; raw: number; t: number }> = []
      for (const d of response.data) {
        const v = (d as MetricDatum)[s.id]
        const t = Date.parse(d.t)
        if (typeof v === 'number') {
          points.push({ x: 0, y: 0, raw: v, t })
        }
      }
      return { id: s.id, label: s.label, colour, points }
    })
    return { yMin: lo, yMax: hi, series: seriesOut }
  }, [response])

  const yScale = useCallback(
    (v: number) => marginTop + plotH - ((v - yMin) / (yMax - yMin)) * plotH,
    [yMin, yMax, plotH, marginTop],
  )

  // Pre-compute scaled paths.
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

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!svgRef.current) return
      const rect = svgRef.current.getBoundingClientRect()
      const px = e.clientX - rect.left
      const t = xUnscale(px)
      if (annotateMode) {
        setDrag({ kind: 'annotate', startClientX: e.clientX, startMs: t, currentClientX: e.clientX, currentMs: t })
      } else {
        setDrag({ kind: 'pan', startClientX: e.clientX, startMs: t, currentClientX: e.clientX, currentMs: t })
      }
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
    },
    [annotateMode, xUnscale],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!svgRef.current) return
      const rect = svgRef.current.getBoundingClientRect()
      const px = e.clientX - rect.left
      const t = xUnscale(px)
      if (drag) {
        if (drag.kind === 'pan') {
          // Shift the window opposite to the drag delta. Recompute the
          // delta in ms space from the pixel delta since the previous
          // move, then reset the drag origin so the next move stays
          // relative.
          const span = window.toMs - window.fromMs
          const dxPx = e.clientX - drag.startClientX
          const dMs = (dxPx / plotW) * span
          setWindow({ fromMs: window.fromMs - dMs, toMs: window.toMs - dMs })
          setDrag({ ...drag, startClientX: e.clientX, startMs: t, currentClientX: e.clientX, currentMs: t })
        } else {
          setDrag({ ...drag, currentClientX: e.clientX, currentMs: t })
        }
      }
    },
    [drag, plotW, setWindow, window.fromMs, window.toMs, xUnscale],
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!drag) return
      if (drag.kind === 'annotate') {
        const a = Math.min(drag.startMs, drag.currentMs)
        const b = Math.max(drag.startMs, drag.currentMs)
        const isRange = Math.abs(drag.currentClientX - drag.startClientX) > 4
        setPendingCreate({
          tStart: new Date(a).toISOString(),
          tEnd: isRange ? new Date(b).toISOString() : null,
        })
      }
      setDrag(null)
      ;(e.target as Element).releasePointerCapture?.(e.pointerId)
    },
    [drag],
  )

  const onWheel = useCallback(
    (e: React.WheelEvent<SVGSVGElement>) => {
      if (!svgRef.current) return
      e.preventDefault()
      const rect = svgRef.current.getBoundingClientRect()
      const px = e.clientX - rect.left
      const t = xUnscale(px)
      // Multiplicative zoom anchored on the mouse cursor.
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2
      const newFromMs = t - (t - window.fromMs) * factor
      const newToMs = t + (window.toMs - t) * factor
      setWindow({ fromMs: newFromMs, toMs: newToMs })
    },
    [setWindow, window.fromMs, window.toMs, xUnscale],
  )

  const handleCreate = useCallback(
    async (payload: { title: string; body: string; tag: string | null; scope: string }) => {
      if (!pendingCreate) return
      await mutateJson(
        '/api/metric-annotations',
        PassthroughSchema,
        {
          method: 'POST',
          body: JSON.stringify({
            ...pendingCreate,
            title: payload.title,
            body: payload.body,
            tag: payload.tag,
            scope: payload.scope,
          }),
        },
      )
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

  if (error) {
    return <div className="metric-chart-svg metric-chart-error">⚠ {error}</div>
  }

  return (
    <div className="metric-chart-svg-wrap">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        className="metric-chart-svg"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onWheel={onWheel}
        style={{ cursor: annotateMode ? 'crosshair' : drag?.kind === 'pan' ? 'grabbing' : 'grab' }}
      >
        {/* Y axis baseline */}
        <line x1={marginLeft} x2={width - marginRight} y1={marginTop + plotH} y2={marginTop + plotH} stroke="#ccc" />
        <line x1={marginLeft} x2={marginLeft} y1={marginTop} y2={marginTop + plotH} stroke="#ccc" />

        {/* Y axis labels (just min / max) */}
        <text x={marginLeft - 4} y={marginTop + 10} fontSize="10" textAnchor="end" fill="#555">
          {yMax.toFixed(2)}
        </text>
        <text x={marginLeft - 4} y={marginTop + plotH} fontSize="10" textAnchor="end" fill="#555">
          {yMin.toFixed(2)}
        </text>

        {/* X axis labels: from / to */}
        <text x={marginLeft} y={height - 8} fontSize="10" fill="#555">
          {new Date(window.fromMs).toISOString().slice(0, 16).replace('T', ' ')}
        </text>
        <text x={width - marginRight} y={height - 8} fontSize="10" textAnchor="end" fill="#555">
          {new Date(window.toMs).toISOString().slice(0, 16).replace('T', ' ')}
        </text>

        {/* Series paths */}
        {seriesPaths.map((s) => (
          <path key={s.id} d={s.d} fill="none" stroke={s.colour} strokeWidth="1.5" />
        ))}

        {/* Range-annotation shading */}
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
              />
            )
          })}

        {/* Annotation ticks: 4-px vertical tick at the bottom of the plot. */}
        {annotations.map((a) => {
          const x = xScale(Date.parse(a.tStart))
          const colour = annotationColour(a.tag)
          return (
            <rect
              key={a.id}
              x={x - 1}
              y={marginTop + plotH - 4}
              width={2}
              height={4}
              fill={colour}
              onPointerEnter={(e) => {
                e.stopPropagation()
                setHoverAnnotation(a)
              }}
              onPointerLeave={(e) => {
                e.stopPropagation()
                setHoverAnnotation(null)
              }}
              style={{ cursor: 'pointer', pointerEvents: 'all' }}
            />
          )
        })}

        {/* In-progress annotate drag preview */}
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

        {loading ? (
          <text x={width / 2} y={marginTop + plotH / 2} textAnchor="middle" fontSize="11" fill="#999">
            loading…
          </text>
        ) : null}
      </svg>

      <ChartLegend series={response?.metric.series ?? []} />

      {hoverAnnotation ? (
        <AnnotationTooltip
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
  const colour = annotationColour(annotation.tag)
  const onSave = async () => {
    await mutateJson(
      `/api/metric-annotations/${encodeURIComponent(annotation.id)}`,
      PassthroughSchema,
      {
        method: 'PATCH',
        body: JSON.stringify({ title, body, tag: tag.trim() === '' ? null : tag.trim() }),
      },
    )
    setEditing(false)
    onPatched()
  }
  return (
    <div className="metric-chart-tooltip" role="dialog" aria-label="Annotation">
      <header style={{ borderLeft: `4px solid ${colour}` }}>
        <strong>{editing ? <input value={title} onChange={(e) => setTitle(e.target.value)} /> : annotation.title}</strong>
        <span className="metric-chart-tooltip-tag">{annotation.tag ?? 'untagged'}</span>
      </header>
      <p className="subtle-copy">
        {new Date(annotation.tStart).toISOString().slice(0, 16).replace('T', ' ')}
        {annotation.tEnd ? ` → ${new Date(annotation.tEnd).toISOString().slice(0, 16).replace('T', ' ')}` : ''}
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
            <button type="button" className="ghost-button" onClick={onClose}>
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
  const [scope, setScope] = useState<'global' | 'metric'>('metric')
  const [submitting, setSubmitting] = useState(false)
  return (
    <div className="metric-chart-create" role="dialog" aria-label="New annotation">
      <p className="subtle-copy">
        new annotation at {pending.tStart.slice(0, 16).replace('T', ' ')}
        {pending.tEnd ? ` → ${pending.tEnd.slice(0, 16).replace('T', ' ')}` : ' (point)'}
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
          <option value="metric">this chart only</option>
          <option value="global">global (every chart)</option>
        </select>
      </label>
      <div className="inline-row">
        <button
          type="button"
          className="ghost-button"
          disabled={!title.trim() || submitting}
          onClick={async () => {
            setSubmitting(true)
            try {
              await onSubmit({
                title: title.trim(),
                body,
                tag: tag.trim() === '' ? null : tag.trim(),
                scope: scope === 'global' ? 'global' : `metric:${metricId}`,
              })
            } finally {
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
