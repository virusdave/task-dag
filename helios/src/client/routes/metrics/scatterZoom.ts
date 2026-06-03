/**
 * Shared zoom + pan behaviour for scatter SVGs.
 *
 * Used by both `ScatterSvg` (weather correlation) and `CatalogScatterSvg`
 * (catalog analytics per-variant scatter). The contract is intentionally
 * minimal so the caller still owns axis scaling / rendering — this hook
 * only manages the *visible domain* (`view`) on top of the data domain
 * (`baseDomain`), plus all the pointer-event plumbing.
 *
 * Interaction contract (per oracle review 2026-05-27):
 *   - Desktop: Ctrl/⌘ + wheel zooms toward cursor. Plain wheel always
 *     bubbles so the operator can scroll a grid of charts.
 *   - Desktop: when already zoomed in, primary-mouse drag pans (touch is
 *     unaffected; one-finger touch still scrolls the page).
 *   - Mobile: two-finger pinch zooms + pans in one gesture; we set
 *     `touch-action: pan-y` so single-finger scroll still works.
 *   - Double-click / double-tap resets the view to the base domain.
 *   - During an active gesture, the caller is notified via the
 *     `gestureActive` flag and is expected to suppress hover tooltips
 *     and skip nearest-point search.
 *
 * NB: React's synthetic `onWheel` is passive by default — calling
 * `preventDefault()` in the synthetic handler doesn't suppress page
 * scroll on Chrome/Firefox. We attach a native non-passive listener
 * inside the hook to make Ctrl+wheel actually preventDefault.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** Closed axis-aligned rectangle in data space. */
export interface ZoomView {
  readonly xMin: number
  readonly xMax: number
  readonly yMin: number
  readonly yMax: number
}

/**
 * Top-level interaction mode for the scatter.
 *
 *  - `inspect` (default): hover tooltips, click-to-drill, page-scroll
 *    on wheel; pinch/Ctrl+wheel still zoom for power users.
 *  - `zoom`: scatter captures wheel + pointer; plain wheel zooms
 *    toward cursor (no Ctrl required), single-pointer drag draws a
 *    zoom box (`tool='box'`) or pans (`tool='pan'`).
 */
export type ScatterInteractionMode = 'inspect' | 'zoom'

/** Drag tool when interaction mode is `zoom`. */
export type ScatterZoomTool = 'box' | 'pan'

export interface UseScatterZoomArgs {
  /**
   * Reset/default visible domain. Double-click and `resetView()`
   * return the view to this rectangle. May be `null` while loading.
   *
   * When the caller uses outlier-resistant auto-zoom this is the
   * *compact* (e.g. p5/p95) view, not the full data extent — see
   * scatterAutoZoom.ts.
   */
  readonly baseDomain: ZoomView | null
  /**
   * Maximum reachable domain for pan / wheel / pinch zoom-out.
   * Defaults to `baseDomain` for backward compatibility. When the
   * caller uses auto-zoom this is the *full* padded data extent,
   * so outliers stay reachable by zooming out past the compact
   * view.
   */
  readonly boundsDomain?: ZoomView | null
  /** Ref to the SVG element that captures gestures. */
  readonly svgRef: React.RefObject<SVGSVGElement | null>
  /** Plot rectangle inside the SVG viewBox (units = viewBox units). */
  readonly plot: {
    readonly left: number
    readonly top: number
    readonly width: number
    readonly height: number
  }
  /**
   * Interaction mode. Defaults to `inspect` so callers that haven't
   * adopted the toolbar still behave exactly as before.
   */
  readonly mode?: ScatterInteractionMode
  /**
   * Drag tool when `mode === 'zoom'`. Defaults to `box`. Ignored in
   * inspect mode.
   */
  readonly tool?: ScatterZoomTool
}

export interface UseScatterZoomResult {
  /** Visible domain — defaults to `baseDomain` when not zoomed. */
  readonly view: ZoomView | null
  /** `true` when `view` differs from `baseDomain` (controls reset chip). */
  readonly isZoomed: boolean
  /** Reset the view back to `baseDomain`. */
  readonly resetView: () => void
  /** True while user is mid-gesture (pinch / pan / wheel-zoom). */
  readonly gestureActive: boolean
  /** Event handlers to spread on the SVG. */
  readonly handlers: {
    readonly onPointerDown: (e: React.PointerEvent<SVGSVGElement>) => void
    readonly onPointerMove: (e: React.PointerEvent<SVGSVGElement>) => void
    readonly onPointerUp: (e: React.PointerEvent<SVGSVGElement>) => void
    readonly onPointerCancel: (e: React.PointerEvent<SVGSVGElement>) => void
    readonly onDoubleClick: (e: React.MouseEvent<SVGSVGElement>) => void
  }
  /**
   * Drag-box rectangle in SVG viewBox coordinates (matches the
   * caller's `plot` units). Non-null only while a box-zoom drag is
   * in progress. The caller renders an overlay <rect/> from this.
   */
  readonly dragBox: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  } | null
  /**
   * Style hint to apply to the SVG (or its wrapper).
   *  - `pan-y` (default / inspect mode): native vertical scroll still
   *    works so the page is scrollable through a grid of charts.
   *  - `none` (zoom mode): the browser cannot steal touch gestures,
   *    so single-finger drag draws a zoom box and two-finger pinch
   *    zooms without page-scroll interference.
   *  - `cursor` flips to `crosshair` for the box tool and `grab` for
   *    pan tool while in zoom mode so the operator gets clear visual
   *    feedback about what dragging will do.
   */
  readonly svgStyle: {
    readonly touchAction: 'pan-y' | 'none'
    readonly cursor: string
  }
}

// Minimum view span as a fraction of the base span (anti-microscopic
// zoom). 1/200 is plenty for operator-grade insight without letting
// pixel jitter blow up the axis ticks.
const MIN_SPAN_RATIO = 1 / 200

/** Compute view → data X. */
function svgToDataX(view: ZoomView, plot: UseScatterZoomArgs['plot'], svgX: number): number {
  return view.xMin + ((svgX - plot.left) / plot.width) * (view.xMax - view.xMin)
}
/** Compute view → data Y (svg-Y is inverted vs data-Y). */
function svgToDataY(view: ZoomView, plot: UseScatterZoomArgs['plot'], svgY: number): number {
  return view.yMax - ((svgY - plot.top) / plot.height) * (view.yMax - view.yMin)
}

/** Map a client (mouse / touch) coordinate to local SVG-viewBox space. */
function clientToSvg(
  svg: SVGSVGElement | null,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (!svg) return null
  const ctm = svg.getScreenCTM()
  if (!ctm) return null
  const pt = svg.createSVGPoint()
  pt.x = clientX
  pt.y = clientY
  const local = pt.matrixTransform(ctm.inverse())
  return { x: local.x, y: local.y }
}

/**
 * Clamp the proposed view to:
 *  - never extend beyond the base domain
 *  - never collapse below MIN_SPAN_RATIO of the base span
 *
 * If the proposed view is already wider than the base (e.g. zoom-out
 * past base), it snaps to base on that axis.
 */
function clampToBase(view: ZoomView, base: ZoomView): ZoomView {
  const baseXSpan = base.xMax - base.xMin
  const baseYSpan = base.yMax - base.yMin
  let { xMin, xMax, yMin, yMax } = view

  const minXSpan = baseXSpan * MIN_SPAN_RATIO
  const minYSpan = baseYSpan * MIN_SPAN_RATIO
  if (xMax - xMin < minXSpan) {
    const mid = (xMin + xMax) / 2
    xMin = mid - minXSpan / 2
    xMax = mid + minXSpan / 2
  }
  if (yMax - yMin < minYSpan) {
    const mid = (yMin + yMax) / 2
    yMin = mid - minYSpan / 2
    yMax = mid + minYSpan / 2
  }

  // Snap to base on full zoom-out.
  if (xMax - xMin >= baseXSpan) {
    xMin = base.xMin
    xMax = base.xMax
  } else {
    // Pan: keep current span but clamp to base bounds.
    if (xMin < base.xMin) {
      const span = xMax - xMin
      xMin = base.xMin
      xMax = xMin + span
    }
    if (xMax > base.xMax) {
      const span = xMax - xMin
      xMax = base.xMax
      xMin = xMax - span
    }
  }
  if (yMax - yMin >= baseYSpan) {
    yMin = base.yMin
    yMax = base.yMax
  } else {
    if (yMin < base.yMin) {
      const span = yMax - yMin
      yMin = base.yMin
      yMax = yMin + span
    }
    if (yMax > base.yMax) {
      const span = yMax - yMin
      yMax = base.yMax
      yMin = yMax - span
    }
  }
  return { xMin, xMax, yMin, yMax }
}

function viewsEqual(a: ZoomView | null, b: ZoomView | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.xMin === b.xMin && a.xMax === b.xMax && a.yMin === b.yMin && a.yMax === b.yMax
}

export function useScatterZoom(args: UseScatterZoomArgs): UseScatterZoomResult {
  const { baseDomain, boundsDomain, svgRef, plot } = args
  const mode: ScatterInteractionMode = args.mode ?? 'inspect'
  const tool: ScatterZoomTool = args.tool ?? 'box'
  const modeRef = useRef<ScatterInteractionMode>(mode)
  modeRef.current = mode
  const toolRef = useRef<ScatterZoomTool>(tool)
  toolRef.current = tool
  const [view, setView] = useState<ZoomView | null>(baseDomain)
  const viewRef = useRef<ZoomView | null>(view)
  viewRef.current = view
  // Drag-box state for box-zoom (zoom-mode + box tool). Stored in a
  // ref for high-frequency move updates; mirrored into React state
  // only when the overlay rectangle actually changes so the
  // re-render cost is bounded.
  const dragBoxRef = useRef<{ x: number; y: number; width: number; height: number } | null>(
    null,
  )
  const [dragBox, setDragBox] = useState<
    { x: number; y: number; width: number; height: number } | null
  >(null)
  // `baseRef` is the reset/default view (compact view when auto-zoom
  // is on). `boundsRef` is the maximum reachable view for pan / zoom
  // (full padded data extent when auto-zoom is on). When the caller
  // doesn't pass an explicit `boundsDomain`, bounds == base — that
  // matches the pre-auto-zoom behaviour exactly.
  const baseRef = useRef<ZoomView | null>(baseDomain)
  baseRef.current = baseDomain
  const boundsRef = useRef<ZoomView | null>(boundsDomain ?? baseDomain)
  boundsRef.current = boundsDomain ?? baseDomain
  const plotRef = useRef(plot)
  plotRef.current = plot

  // Whenever the underlying data domain changes (filters changed,
  // axes changed, etc.), snap the view back to the new base. Without
  // this, swapping the X axis would leave the previous numeric range
  // applied to totally different units.
  useEffect(() => {
    setView(baseDomain)
  }, [baseDomain])

  const [gestureActive, setGestureActive] = useState<boolean>(false)
  const gestureActiveRef = useRef<boolean>(false)
  const setGestureActiveBoth = useCallback((v: boolean) => {
    gestureActiveRef.current = v
    setGestureActive(v)
  }, [])

  // Pointer tracker. Stored in a ref so high-frequency move events
  // don't churn React state — we only commit `view` updates.
  const pointersRef = useRef<
    Map<number, { clientX: number; clientY: number; pointerType: string }>
  >(new Map())

  // Active gesture metadata. `kind === null` means no gesture in
  // flight. `box` is the zoom-mode box-zoom drag (a rectangle the
  // user sweeps over the area they want to zoom into).
  const gestureRef = useRef<{
    kind: 'pinch' | 'pan' | 'box' | null
    startView: ZoomView | null
    // pinch
    startDistance: number
    startMidSvg: { x: number; y: number } | null
    startMidData: { x: number; y: number } | null
    // pan / box
    panStartSvg: { x: number; y: number } | null
    panPointerId: number | null
    // box: pointer-moved-past-threshold flag, used to suppress
    // dot-click drill on a real drag
    boxMoved: boolean
  }>({
    kind: null,
    startView: null,
    startDistance: 0,
    startMidSvg: null,
    startMidData: null,
    panStartSvg: null,
    panPointerId: null,
    boxMoved: false,
  })

  // Minimum sweep size (in SVG units, == viewBox units) before a
  // box-zoom drag is treated as a real zoom request. Below this
  // we treat the gesture as a click, so a fat-finger tap doesn't
  // collapse the chart to a single pixel.
  const BOX_THRESHOLD = 8

  const clearDragBox = useCallback(() => {
    if (dragBoxRef.current != null) {
      dragBoxRef.current = null
      setDragBox(null)
    }
  }, [])

  // Non-passive wheel listener so Ctrl/⌘+wheel can preventDefault
  // and not page-scroll. React's synthetic onWheel is passive.
  useLayoutEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const handler = (e: WheelEvent) => {
      const inZoomMode = modeRef.current === 'zoom'
      // Inspect mode keeps the legacy "wheel scrolls the page;
      // Ctrl/⌘+wheel zooms" power-user behaviour. Zoom mode
      // captures plain wheel so the operator can zoom without
      // chording — at the cost of locking page scroll while the
      // pointer is inside the plot, which is exactly the trade
      // they opted into by toggling zoom mode on.
      if (!inZoomMode && !e.ctrlKey && !e.metaKey) return
      const currentView = viewRef.current ?? baseRef.current
      const bounds = boundsRef.current ?? baseRef.current
      if (!currentView || !bounds) return
      const plotNow = plotRef.current
      const local = clientToSvg(svg, e.clientX, e.clientY)
      if (!local) return
      if (
        local.x < plotNow.left ||
        local.x > plotNow.left + plotNow.width ||
        local.y < plotNow.top ||
        local.y > plotNow.top + plotNow.height
      ) {
        return
      }
      e.preventDefault()
      // factor < 1 = zoom out (deltaY > 0); factor > 1 = zoom in.
      const factor = Math.exp(-e.deltaY * 0.0015)
      const anchorX = svgToDataX(currentView, plotNow, local.x)
      const anchorY = svgToDataY(currentView, plotNow, local.y)
      const xMin = anchorX - (anchorX - currentView.xMin) / factor
      const xMax = anchorX + (currentView.xMax - anchorX) / factor
      const yMin = anchorY - (anchorY - currentView.yMin) / factor
      const yMax = anchorY + (currentView.yMax - anchorY) / factor
      const next = clampToBase({ xMin, xMax, yMin, yMax }, bounds)
      setView(next)
      // Briefly flag a gesture so any hover tooltip is suppressed
      // during a wheel burst.
      gestureActiveRef.current = true
      setGestureActive(true)
      window.clearTimeout((handler as unknown as { _t?: number })._t ?? 0)
      ;(handler as unknown as { _t?: number })._t = window.setTimeout(() => {
        gestureActiveRef.current = false
        setGestureActive(false)
      }, 180)
    }
    svg.addEventListener('wheel', handler, { passive: false })
    return () => svg.removeEventListener('wheel', handler)
  }, [svgRef])

  // ---------------- Pointer handlers (touch + mouse pan) -----------------

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const local = clientToSvg(e.currentTarget, e.clientX, e.clientY)
      if (!local) return
      const inPlot =
        local.x >= plot.left &&
        local.x <= plot.left + plot.width &&
        local.y >= plot.top &&
        local.y <= plot.top + plot.height
      if (!inPlot) return
      pointersRef.current.set(e.pointerId, {
        clientX: e.clientX,
        clientY: e.clientY,
        pointerType: e.pointerType,
      })

      const currentView = viewRef.current ?? baseRef.current
      const base = baseRef.current
      if (!currentView || !base) return

      // Two pointers down → start pinch (works for both touch and mouse
      // pairs, but in practice this fires on multi-touch).
      if (pointersRef.current.size === 2) {
        const [a, b] = Array.from(pointersRef.current.values())
        if (!a || !b) return
        const ax = clientToSvg(e.currentTarget, a.clientX, a.clientY)
        const bx = clientToSvg(e.currentTarget, b.clientX, b.clientY)
        if (!ax || !bx) return
        const mid = { x: (ax.x + bx.x) / 2, y: (ax.y + bx.y) / 2 }
        const dx = bx.x - ax.x
        const dy = bx.y - ax.y
        const distance = Math.hypot(dx, dy)
        gestureRef.current = {
          kind: 'pinch',
          startView: currentView,
          startDistance: Math.max(distance, 1),
          startMidSvg: mid,
          startMidData: {
            x: svgToDataX(currentView, plot, mid.x),
            y: svgToDataY(currentView, plot, mid.y),
          },
          panStartSvg: null,
          panPointerId: null,
          boxMoved: false,
        }
        clearDragBox()
        setGestureActiveBoth(true)
        return
      }

      // Single pointer + zoom mode → box-zoom or pan, depending on
      // active tool. Works for mouse AND touch in zoom mode because
      // the caller has set touch-action:none on the SVG.
      if (modeRef.current === 'zoom' && pointersRef.current.size === 1) {
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          // ignore — pointer capture is best-effort
        }
        if (toolRef.current === 'pan') {
          gestureRef.current = {
            kind: 'pan',
            startView: currentView,
            startDistance: 0,
            startMidSvg: null,
            startMidData: null,
            panStartSvg: local,
            panPointerId: e.pointerId,
            boxMoved: false,
          }
        } else {
          gestureRef.current = {
            kind: 'box',
            startView: currentView,
            startDistance: 0,
            startMidSvg: null,
            startMidData: null,
            panStartSvg: local,
            panPointerId: e.pointerId,
            boxMoved: false,
          }
        }
        setGestureActiveBoth(true)
        e.preventDefault()
        return
      }

      // Inspect-mode legacy: single mouse pointer + already-zoomed →
      // start drag-pan. Touch is unaffected so one-finger touch
      // continues to scroll the page in inspect mode.
      if (
        e.pointerType === 'mouse' &&
        pointersRef.current.size === 1 &&
        !viewsEqual(currentView, base)
      ) {
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          // ignore — pointer capture is best-effort
        }
        gestureRef.current = {
          kind: 'pan',
          startView: currentView,
          startDistance: 0,
          startMidSvg: null,
          startMidData: null,
          panStartSvg: local,
          panPointerId: e.pointerId,
          boxMoved: false,
        }
        setGestureActiveBoth(true)
        e.preventDefault()
      }
    },
    [plot, setGestureActiveBoth],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const tracked = pointersRef.current.get(e.pointerId)
      if (!tracked) return
      pointersRef.current.set(e.pointerId, {
        clientX: e.clientX,
        clientY: e.clientY,
        pointerType: tracked.pointerType,
      })
      const g = gestureRef.current
      const bounds = boundsRef.current ?? baseRef.current
      if (!g.kind || !g.startView || !bounds) return

      if (g.kind === 'pinch') {
        const [a, b] = Array.from(pointersRef.current.values())
        if (!a || !b) return
        const ax = clientToSvg(e.currentTarget, a.clientX, a.clientY)
        const bx = clientToSvg(e.currentTarget, b.clientX, b.clientY)
        if (!ax || !bx) return
        const mid = { x: (ax.x + bx.x) / 2, y: (ax.y + bx.y) / 2 }
        const distance = Math.max(Math.hypot(bx.x - ax.x, bx.y - ax.y), 1)
        const scale = distance / g.startDistance
        const xSpan0 = g.startView.xMax - g.startView.xMin
        const ySpan0 = g.startView.yMax - g.startView.yMin
        const xSpan = xSpan0 / scale
        const ySpan = ySpan0 / scale
        // Center the new view so the original midpoint data coord
        // re-projects under the current midpoint svg coord.
        const midDataX = g.startMidData!.x
        const midDataY = g.startMidData!.y
        const fracX = (mid.x - plot.left) / plot.width
        const fracY = (mid.y - plot.top) / plot.height
        const xMin = midDataX - xSpan * fracX
        const xMax = midDataX + xSpan * (1 - fracX)
        const yMax = midDataY + ySpan * fracY
        const yMin = midDataY - ySpan * (1 - fracY)
        const next = clampToBase({ xMin, xMax, yMin, yMax }, bounds)
        setView(next)
        e.preventDefault()
      } else if (g.kind === 'pan' && g.panStartSvg) {
        const local = clientToSvg(e.currentTarget, e.clientX, e.clientY)
        if (!local) return
        const dxSvg = local.x - g.panStartSvg.x
        const dySvg = local.y - g.panStartSvg.y
        const xSpan = g.startView.xMax - g.startView.xMin
        const ySpan = g.startView.yMax - g.startView.yMin
        const dxData = -(dxSvg / plot.width) * xSpan
        const dyData = (dySvg / plot.height) * ySpan
        const next = clampToBase(
          {
            xMin: g.startView.xMin + dxData,
            xMax: g.startView.xMax + dxData,
            yMin: g.startView.yMin + dyData,
            yMax: g.startView.yMax + dyData,
          },
          bounds,
        )
        setView(next)
        e.preventDefault()
      } else if (g.kind === 'box' && g.panStartSvg) {
        // Box-zoom drag: update the overlay rectangle (clipped to
        // the plot). We don't change the view yet — the actual zoom
        // commits in `endPointer` so the operator can preview the
        // sweep before releasing.
        const local = clientToSvg(e.currentTarget, e.clientX, e.clientY)
        if (!local) return
        const clampedX = Math.max(plot.left, Math.min(plot.left + plot.width, local.x))
        const clampedY = Math.max(plot.top, Math.min(plot.top + plot.height, local.y))
        const x0 = g.panStartSvg.x
        const y0 = g.panStartSvg.y
        const x = Math.min(x0, clampedX)
        const y = Math.min(y0, clampedY)
        const width = Math.abs(clampedX - x0)
        const height = Math.abs(clampedY - y0)
        if (width >= BOX_THRESHOLD || height >= BOX_THRESHOLD) {
          g.boxMoved = true
        }
        const nextBox = { x, y, width, height }
        const prev = dragBoxRef.current
        if (
          !prev ||
          prev.x !== nextBox.x ||
          prev.y !== nextBox.y ||
          prev.width !== nextBox.width ||
          prev.height !== nextBox.height
        ) {
          dragBoxRef.current = nextBox
          setDragBox(nextBox)
        }
        e.preventDefault()
      }
    },
    [plot],
  )

  const endPointer = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      pointersRef.current.delete(e.pointerId)
      const g = gestureRef.current
      if (!g.kind) return
      // End pinch when we drop below two fingers. End pan when the
      // captured pointer goes up.
      if (g.kind === 'pinch' && pointersRef.current.size < 2) {
        gestureRef.current = {
          kind: null,
          startView: null,
          startDistance: 0,
          startMidSvg: null,
          startMidData: null,
          panStartSvg: null,
          panPointerId: null,
          boxMoved: false,
        }
        setGestureActiveBoth(false)
      } else if (g.kind === 'pan' && g.panPointerId === e.pointerId) {
        try {
          e.currentTarget.releasePointerCapture(e.pointerId)
        } catch {
          // best-effort
        }
        gestureRef.current = {
          kind: null,
          startView: null,
          startDistance: 0,
          startMidSvg: null,
          startMidData: null,
          panStartSvg: null,
          panPointerId: null,
          boxMoved: false,
        }
        setGestureActiveBoth(false)
      } else if (g.kind === 'box' && g.panPointerId === e.pointerId) {
        try {
          e.currentTarget.releasePointerCapture(e.pointerId)
        } catch {
          // best-effort
        }
        const box = dragBoxRef.current
        const bounds = boundsRef.current ?? baseRef.current
        const startView = g.startView
        // Only commit if the operator actually swept past the
        // threshold; a sub-threshold drag is treated as a click
        // so dot-drill / no-op semantics still work.
        if (
          g.boxMoved &&
          box &&
          startView &&
          bounds &&
          box.width >= BOX_THRESHOLD &&
          box.height >= BOX_THRESHOLD
        ) {
          const xMin = svgToDataX(startView, plotRef.current, box.x)
          const xMax = svgToDataX(startView, plotRef.current, box.x + box.width)
          const yMax = svgToDataY(startView, plotRef.current, box.y)
          const yMin = svgToDataY(startView, plotRef.current, box.y + box.height)
          const next = clampToBase(
            {
              xMin: Math.min(xMin, xMax),
              xMax: Math.max(xMin, xMax),
              yMin: Math.min(yMin, yMax),
              yMax: Math.max(yMin, yMax),
            },
            bounds,
          )
          setView(next)
        }
        clearDragBox()
        gestureRef.current = {
          kind: null,
          startView: null,
          startDistance: 0,
          startMidSvg: null,
          startMidData: null,
          panStartSvg: null,
          panPointerId: null,
          boxMoved: false,
        }
        setGestureActiveBoth(false)
      }
    },
    [setGestureActiveBoth, clearDragBox],
  )

  const onDoubleClick = useCallback(
    (_e: React.MouseEvent<SVGSVGElement>) => {
      setView(baseRef.current)
    },
    [],
  )

  const resetView = useCallback(() => {
    setView(baseRef.current)
  }, [])

  const isZoomed = !viewsEqual(view, baseDomain)

  // In zoom mode the SVG must own touch gestures (otherwise iOS /
  // Android route single-finger drag into page scroll and box-zoom
  // never fires). Inspect mode keeps the legacy `pan-y` so a grid of
  // charts remains vertically scrollable.
  const touchAction: 'pan-y' | 'none' = mode === 'zoom' ? 'none' : 'pan-y'
  const cursor =
    mode === 'zoom'
      ? gestureActive
        ? tool === 'pan'
          ? 'grabbing'
          : 'crosshair'
        : tool === 'pan'
          ? 'grab'
          : 'crosshair'
      : 'default'

  return {
    view: view ?? baseDomain,
    isZoomed,
    resetView,
    gestureActive,
    dragBox,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endPointer,
      onPointerCancel: endPointer,
      onDoubleClick,
    },
    svgStyle: { touchAction, cursor },
  }
}
