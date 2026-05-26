import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

/**
 * Page-level shared time axis. Every `<MetricChart/>` on the /metrics
 * page subscribes by default; an individual chart can opt out via its
 * 🔒/🔓 toggle and maintain its own local axis state.
 *
 * The axis is the visible `[from, to)` window in epoch milliseconds.
 * The chart's pan and wheel-zoom interactions write back through
 * `setWindow` when locked, so every other locked chart re-renders to
 * match. When unlocked, the chart keeps its own local `window` in
 * component state and ignores the context updates.
 *
 * The context also carries a shared `hoverMs` so hovering one card on
 * a multi-card dashboard renders a faint synchronised crosshair on every
 * other locked card at the same timestamp. Hover updates are intentionally
 * NOT routed through React state for every pointermove — that re-renders
 * every chart on the page at pointer-event frequency. Instead, we keep a
 * ref + per-chart subscriber list so charts that care can subscribe with
 * a low-cost callback, draw their crosshair imperatively, and skip the
 * render path entirely.
 */
export interface TimeWindow {
  readonly fromMs: number
  readonly toMs: number
}

export type HoverListener = (ms: number | null) => void

export interface TimeAxisContextValue {
  window: TimeWindow
  setWindow: (next: TimeWindow) => void
  /** Publish a hover timestamp (or null to clear). All subscribed charts run their listeners. */
  publishHover: (ms: number | null) => void
  /** Subscribe to hover changes. Returns an unsubscribe fn. */
  subscribeHover: (fn: HoverListener) => () => void
  /** Read the most recent hover ms synchronously (e.g. when a chart first mounts). */
  getHoverMs: () => number | null
}

const TimeAxisContext = createContext<TimeAxisContextValue | null>(null)

export interface TimeAxisProviderProps {
  readonly initial: TimeWindow
  readonly children: ReactNode
}

export function TimeAxisProvider({ initial, children }: TimeAxisProviderProps) {
  const [window, setWindowState] = useState<TimeWindow>(initial)
  const setWindow = useCallback((next: TimeWindow) => {
    setWindowState(clampWindow(next))
  }, [])

  const hoverMsRef = useRef<number | null>(null)
  const listenersRef = useRef<Set<HoverListener>>(new Set())
  const publishHover = useCallback((ms: number | null) => {
    if (hoverMsRef.current === ms) return
    hoverMsRef.current = ms
    for (const fn of listenersRef.current) {
      try {
        fn(ms)
      } catch {
        /* never let one bad listener break others */
      }
    }
  }, [])
  const subscribeHover = useCallback((fn: HoverListener) => {
    listenersRef.current.add(fn)
    return () => {
      listenersRef.current.delete(fn)
    }
  }, [])
  const getHoverMs = useCallback(() => hoverMsRef.current, [])

  const value = useMemo<TimeAxisContextValue>(
    () => ({ window, setWindow, publishHover, subscribeHover, getHoverMs }),
    [window, setWindow, publishHover, subscribeHover, getHoverMs],
  )
  return <TimeAxisContext.Provider value={value}>{children}</TimeAxisContext.Provider>
}

export function useTimeAxis(): TimeAxisContextValue {
  const value = useContext(TimeAxisContext)
  if (!value) {
    throw new Error('useTimeAxis must be used inside <TimeAxisProvider>')
  }
  return value
}

/**
 * Disallow degenerate windows (from >= to) and absurdly tiny windows
 * (< 60 seconds) — they break the wheel-zoom feedback loop. We do not
 * clamp the upper bound: the operator can legitimately scroll forward
 * past "now" to see annotations placed in the future.
 */
function clampWindow(window: TimeWindow): TimeWindow {
  const MIN_SPAN_MS = 60 * 1000
  if (window.toMs - window.fromMs < MIN_SPAN_MS) {
    return { fromMs: window.fromMs, toMs: window.fromMs + MIN_SPAN_MS }
  }
  return window
}
