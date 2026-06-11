import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { MetricQueryResponse } from '../../../shared/contracts/index.js'
import { crossMarkerPath, formatYTick, niceYTicks, smoothedPath } from './gridlines.js'

const FALLBACK_COLOURS = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b']

export interface GhostRidersSvgProps {
  readonly response: MetricQueryResponse | null
  readonly loading: boolean
  readonly error: string | null
  readonly interactive: boolean
}

/**
 * Opacity ramp by period age. Current period (age 0) is fully opaque
 * and rendered thicker by the caller; each older ghost fades.
 */
function opacityForAge(age: number): number {
  if (age === 0) return 1
  return Math.max(0.14, 0.6 - age * 0.1)
}

interface BaseSeries {
  readonly id: string
  readonly label: string
  readonly colour: string
}

/**
 * Ghost Riders renderer — overlays the current period's intra-period
 * cumulative trajectory against the same-phase trajectory of the prior
 * N periods. X axis = phase within the period (hour-of-day or
 * day-of-week); Y axis = cumulative value. Older periods are faded.
 *
 * Wholly separate from `ChartSvg` (whose X axis is absolute time);
 * this keeps both renderers simple.
 */
export function GhostRidersSvg(props: GhostRidersSvgProps): JSX.Element {
  const { response, loading, error, interactive } = props
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

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

  const [hiddenBase, setHiddenBase] = useState<ReadonlySet<string>>(() => new Set<string>())
  const toggleBase = useCallback((id: string) => {
    setHiddenBase((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const [hoverPhase, setHoverPhase] = useState<number | null>(null)

  const ghost = response?.ghost ?? null

  const baseSeries: BaseSeries[] = useMemo(() => {
    if (!response) return []
    return response.metric.series.map((s, i) => ({
      id: s.id,
      label: s.label,
      colour: s.colour ?? FALLBACK_COLOURS[i % FALLBACK_COLOURS.length]!,
    }))
  }, [response])

  const width = renderedWidthPx
  const height = interactive ? (renderedWidthPx < 480 ? 280 : 300) : 150
  const marginLeft = 48
  const marginRight = 12
  const marginTop = 12
  const marginBottom = 30
  const plotW = Math.max(50, width - marginLeft - marginRight)
  const plotH = Math.max(50, height - marginTop - marginBottom)

  const model = useMemo(() => {
    if (!response || !ghost) return null
    const phaseCount = ghost.phaseCount
    const visibleBase = baseSeries.filter((b) => !hiddenBase.has(b.id))
    const visibleBaseIds = new Set(visibleBase.map((b) => b.id))

    // Y range across visible ghost series.
    let lo = Infinity
    let hi = -Infinity
    for (const sinfo of ghost.series) {
      if (!visibleBaseIds.has(sinfo.baseSeriesId)) continue
      for (const row of response.data) {
        const v = row[sinfo.key]
        if (typeof v === 'number' && Number.isFinite(v)) {
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = 0
      hi = 1
    }
    // Always include zero baseline for cumulative trajectories.
    const yMin = Math.min(0, lo)
    const yMax = hi > yMin ? hi : yMin + 1

    const xScale = (phase: number): number =>
      marginLeft + (phaseCount <= 1 ? 0 : (phase / (phaseCount - 1)) * plotW)
    const yScale = (v: number): number =>
      marginTop + plotH - ((v - yMin) / (yMax - yMin)) * plotH

    // One drawable line per (period age, base series).
    interface GhostLine {
      key: string
      baseId: string
      colour: string
      age: number
      isCurrent: boolean
      d: string
      points: Array<{ phase: number; x: number; y: number; value: number }>
    }
    const lines: GhostLine[] = []
    for (const sinfo of ghost.series) {
      if (!visibleBaseIds.has(sinfo.baseSeriesId)) continue
      const base = baseSeries.find((b) => b.id === sinfo.baseSeriesId)
      if (!base) continue
      const pts: Array<{ phase: number; x: number; y: number; value: number }> = []
      for (let phase = 0; phase < phaseCount; phase++) {
        const v = response.data[phase]?.[sinfo.key]
        if (typeof v !== 'number' || !Number.isFinite(v)) continue
        pts.push({ phase, x: xScale(phase), y: yScale(v), value: v })
      }
      if (pts.length === 0) continue
      lines.push({
        key: sinfo.key,
        baseId: sinfo.baseSeriesId,
        colour: base.colour,
        age: sinfo.periodAge,
        isCurrent: sinfo.periodAge === 0,
        d: smoothedPath(pts),
        points: pts,
      })
    }
    // Draw oldest first so the current period sits on top.
    lines.sort((a, b) => b.age - a.age)

    const yTicks = niceYTicks(yMin, yMax, 5)

    return { phaseCount, yMin, yMax, xScale, yScale, lines, yTicks, visibleBase }
  }, [response, ghost, baseSeries, hiddenBase, marginLeft, marginTop, plotW, plotH])

  const clientXToPhase = useCallback(
    (clientX: number): number | null => {
      const svg = svgRef.current
      if (!svg || !model) return null
      const ctm = svg.getScreenCTM()
      if (!ctm) return null
      const point = svg.createSVGPoint()
      point.x = clientX
      point.y = 0
      const svgX = point.matrixTransform(ctm.inverse()).x
      const frac = (svgX - marginLeft) / plotW
      const phase = Math.round(frac * (model.phaseCount - 1))
      if (phase < 0 || phase > model.phaseCount - 1) return null
      return phase
    },
    [model, marginLeft, plotW],
  )

  if (loading && !response) {
    return (
      <div className="metric-chart-svg-wrap" ref={wrapRef}>
        <p className="subtle-copy">Loading…</p>
      </div>
    )
  }
  if (error) {
    return (
      <div className="metric-chart-svg-wrap" ref={wrapRef}>
        <p className="metric-chart-error">⚠ {error}</p>
      </div>
    )
  }
  if (!response || !ghost || !model) {
    return (
      <div className="metric-chart-svg-wrap" ref={wrapRef}>
        <p className="subtle-copy">No data.</p>
      </div>
    )
  }

  const hovered = hoverPhase
  const periodsByAge = [...ghost.periods].sort((a, b) => a.age - b.age)

  return (
    <div className="metric-chart-svg-wrap ghost-riders-wrap" ref={wrapRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Ghost Riders overlay chart"
        onPointerMove={
          interactive
            ? (e) => {
                const p = clientXToPhase(e.clientX)
                setHoverPhase(p)
              }
            : undefined
        }
        onPointerLeave={interactive ? () => setHoverPhase(null) : undefined}
      >
        {/* Y gridlines + labels */}
        {model.yTicks.ticks.map((tick) => {
          const y = model.yScale(tick)
          return (
            <g key={`y-${tick}`}>
              <line
                x1={marginLeft}
                x2={width - marginRight}
                y1={y}
                y2={y}
                stroke="var(--hairline, #e5e5e5)"
                strokeWidth="1"
              />
              <text
                x={marginLeft - 6}
                y={y + 3}
                textAnchor="end"
                fontSize="10"
                fill="#555"
              >
                {formatYTick(tick, model.yTicks.fractionDigits)}
              </text>
            </g>
          )
        })}

        {/* X phase labels (subset to avoid crowding) */}
        {ghost.phaseLabels.map((label, phase) => {
          const step = ghost.phaseCount > 12 ? Math.ceil(ghost.phaseCount / 8) : 1
          if (phase % step !== 0 && phase !== ghost.phaseCount - 1) return null
          const x = model.xScale(phase)
          return (
            <text
              key={`x-${phase}`}
              x={x}
              y={height - 10}
              textAnchor="middle"
              fontSize="10"
              fill="#555"
            >
              {label}
            </text>
          )
        })}

        {/* Hover guide */}
        {hovered !== null ? (
          <line
            x1={model.xScale(hovered)}
            x2={model.xScale(hovered)}
            y1={marginTop}
            y2={marginTop + plotH}
            stroke="var(--hairline-strong, #bbb)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
        ) : null}

        {/* Ghost + current lines */}
        {model.lines.map((line) => (
          <path
            key={line.key}
            d={line.d}
            fill="none"
            stroke={line.colour}
            strokeWidth={line.isCurrent ? 2.6 : 1.3}
            strokeOpacity={opacityForAge(line.age)}
            strokeLinecap="round"
          />
        ))}

        {/* Current-period markers */}
        {model.lines
          .filter((l) => l.isCurrent)
          .flatMap((line) =>
            line.points.map((pt) => (
              <path
                key={`${line.key}-m-${pt.phase}`}
                d={crossMarkerPath(pt.x, pt.y, 3)}
                stroke={line.colour}
                strokeWidth="1.5"
                fill="none"
              />
            )),
          )}

        {/* Hover dots on every visible line at the hovered phase */}
        {hovered !== null
          ? model.lines.map((line) => {
              const pt = line.points.find((p) => p.phase === hovered)
              if (!pt) return null
              return (
                <circle
                  key={`${line.key}-h`}
                  cx={pt.x}
                  cy={pt.y}
                  r={line.isCurrent ? 3.5 : 2.5}
                  fill={line.colour}
                  fillOpacity={opacityForAge(line.age)}
                />
              )
            })
          : null}
      </svg>

      {/* Hover readout */}
      {hovered !== null ? (
        <div className="ghost-riders-readout" role="status">
          <div className="ghost-riders-readout-head">
            {ghost.period === 'day' ? 'Hour' : 'Day'} · {ghost.phaseLabels[hovered]}
          </div>
          {model.visibleBase.map((base) => (
            <div key={base.id} className="ghost-riders-readout-series">
              {model.visibleBase.length > 1 ? (
                <div className="ghost-riders-readout-serieslabel">
                  <span
                    className="metric-chart-readout-swatch"
                    style={{ background: base.colour }}
                  />
                  {base.label}
                </div>
              ) : null}
              {periodsByAge.map((p) => {
                const key = `${base.id}__ghost_${p.age}`
                const v = response.data[hovered]?.[key]
                if (typeof v !== 'number') return null
                return (
                  <div key={p.age} className="ghost-riders-readout-row">
                    <span
                      className="ghost-riders-readout-agedot"
                      style={{
                        background: base.colour,
                        opacity: opacityForAge(p.age),
                      }}
                    />
                    <span className="ghost-riders-readout-label">{p.label}</span>
                    <span className="ghost-riders-readout-value">
                      {formatYTick(v, 0)}
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      ) : null}

      {/* Legend: base-series toggles (only meaningful for multi-series) */}
      {baseSeries.length > 1 ? (
        <div className="metric-chart-legend" role="group" aria-label="Series visibility">
          {baseSeries.map((b) => {
            const hidden = hiddenBase.has(b.id)
            return (
              <button
                type="button"
                key={b.id}
                className={`metric-chart-legend-item${hidden ? ' is-hidden' : ''}`}
                onClick={() => toggleBase(b.id)}
                aria-pressed={!hidden}
                title={hidden ? `Show ${b.label}` : `Hide ${b.label}`}
              >
                <span
                  className="metric-chart-legend-swatch"
                  style={{ background: hidden ? 'transparent' : b.colour, borderColor: b.colour }}
                />
                <span className="metric-chart-legend-label">{b.label}</span>
              </button>
            )
          })}
        </div>
      ) : null}
      <p className="ghost-riders-period-note subtle-copy">
        Bold = {periodsByAge[0]?.label ?? 'current'} (through{' '}
        {ghost.phaseLabels[ghost.currentPhaseIndex] ?? ''}); faded ={' '}
        {ghost.lookback} prior {ghost.period === 'day' ? 'day' : 'week'}
        {ghost.lookback > 1 ? 's' : ''} (older = fainter).
      </p>
    </div>
  )
}
