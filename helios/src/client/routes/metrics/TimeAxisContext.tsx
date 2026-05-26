import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

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
 */
export interface TimeWindow {
  readonly fromMs: number
  readonly toMs: number
}

export interface TimeAxisContextValue {
  window: TimeWindow
  setWindow: (next: TimeWindow) => void
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
  const value = useMemo<TimeAxisContextValue>(() => ({ window, setWindow }), [window, setWindow])
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
