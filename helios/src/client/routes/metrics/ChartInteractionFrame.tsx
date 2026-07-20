import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

export interface ChartAnchor {
  readonly rect: () => DOMRect
  readonly trigger: HTMLElement | SVGElement
}

export interface OpenChartTooltip {
  readonly anchor: ChartAnchor
  readonly content: ReactNode
  readonly label: string
  readonly sticky: boolean
  readonly onDismiss?: () => void
}

interface ChartInteractionContextValue {
  readonly tooltip: OpenChartTooltip | null
  readonly showTooltip: (next: OpenChartTooltip) => void
  readonly dismissTooltip: (restoreFocus?: boolean) => void
}

const ChartInteractionContext = createContext<ChartInteractionContextValue | null>(null)

export function useChartInteraction(): ChartInteractionContextValue {
  const value = useContext(ChartInteractionContext)
  if (value === null) throw new Error('useChartInteraction must be used inside ChartInteractionFrame')
  return value
}

export function svgPointAnchor(
  svg: SVGSVGElement,
  viewBoxPoint: { readonly x: number; readonly y: number },
  trigger: HTMLElement | SVGElement = svg,
): ChartAnchor {
  return {
    trigger,
    rect: () => {
      const bounds = svg.getBoundingClientRect()
      const viewBox = svg.viewBox.baseVal
      const x = bounds.left + ((viewBoxPoint.x - viewBox.x) / viewBox.width) * bounds.width
      const y = bounds.top + ((viewBoxPoint.y - viewBox.y) / viewBox.height) * bounds.height
      return new DOMRect(x, y, 0, 0)
    },
  }
}

export interface TooltipPosition {
  readonly left: number
  readonly top: number
  readonly maxHeight: number
  readonly maxWidth: number
}

export function clampChartTooltip(
  anchor: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
  panel: { readonly width: number; readonly height: number },
  viewport: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
): TooltipPosition {
  const margin = 8
  const offset = 14
  const rightEdge = viewport.left + viewport.width
  const bottomEdge = viewport.top + viewport.height
  const availableHeight = Math.max(80, viewport.height - margin * 2)
  const availableWidth = Math.max(80, viewport.width - margin * 2)
  const renderedWidth = Math.min(panel.width, availableWidth)
  const renderedHeight = Math.min(panel.height, availableHeight)
  let left = anchor.right + offset
  let top = anchor.bottom + offset
  if (left + renderedWidth > rightEdge - margin) left = anchor.left - offset - renderedWidth
  if (top + renderedHeight > bottomEdge - margin) top = anchor.top - offset - renderedHeight
  left = Math.max(viewport.left + margin, Math.min(rightEdge - margin - renderedWidth, left))
  top = Math.max(viewport.top + margin, Math.min(bottomEdge - margin - renderedHeight, top))
  return { left, top, maxHeight: availableHeight, maxWidth: availableWidth }
}

export function isTapGesture(
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  threshold = 10,
): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) <= threshold
}

export class TapGestureTracker {
  private readonly active = new Set<number>()
  private candidate: { pointerId: number; x: number; y: number } | null = null

  pointerDown(pointerId: number, point: { readonly x: number; readonly y: number }): boolean {
    const first = this.active.size === 0
    if (first) this.candidate = { pointerId, ...point }
    else this.candidate = null
    this.active.add(pointerId)
    return first
  }

  pointerUp(pointerId: number, point: { readonly x: number; readonly y: number }): boolean {
    if (!this.active.delete(pointerId)) return false
    const candidate = this.candidate
    if (this.active.size === 0) this.candidate = null
    return candidate?.pointerId === pointerId && isTapGesture(candidate, point)
  }

  pointerCancel(pointerId: number): void {
    this.active.delete(pointerId)
    this.candidate = null
  }
}

export function ChartInteractionFrame({
  label,
  children,
  showFullscreenControl = true,
}: {
  readonly label: string
  readonly children: ReactNode
  readonly showFullscreenControl?: boolean
}): JSX.Element {
  const frameRef = useRef<HTMLDivElement | null>(null)
  const fullscreenButtonRef = useRef<HTMLButtonElement | null>(null)
  const outsideGestureRef = useRef<{ tracker: TapGestureTracker; outside: boolean }>({
    tracker: new TapGestureTracker(),
    outside: false,
  })
  const [tooltip, setTooltip] = useState<OpenChartTooltip | null>(null)
  const tooltipRef = useRef<OpenChartTooltip | null>(null)
  const [nativeFullscreen, setNativeFullscreen] = useState(false)
  const [fallbackFullscreen, setFallbackFullscreen] = useState(false)
  const fullscreen = nativeFullscreen || fallbackFullscreen

  const showTooltip = useCallback((next: OpenChartTooltip): void => {
    tooltipRef.current = next
    setTooltip(next)
  }, [])

  const dismissTooltip = useCallback((restoreFocus = false): void => {
    const current = tooltipRef.current
    if (restoreFocus && current?.sticky) current.anchor.trigger.focus()
    current?.onDismiss?.()
    tooltipRef.current = null
    setTooltip(null)
  }, [])

  useEffect(() => {
    const onFullscreenChange = (): void => {
      const active = document.fullscreenElement === frameRef.current
      setNativeFullscreen(active)
      if (!active) fullscreenButtonRef.current?.focus()
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  useEffect(() => {
    if (!tooltip?.sticky) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      const gesture = outsideGestureRef.current
      if (gesture.tracker.pointerDown(event.pointerId, { x: event.clientX, y: event.clientY })) {
        gesture.outside = !frameRef.current?.querySelector('.chart-tooltip-panel')?.contains(target) &&
          !tooltip.anchor.trigger.contains(target)
      } else gesture.outside = false
    }
    const onPointerUp = (event: PointerEvent): void => {
      const gesture = outsideGestureRef.current
      const tapped = gesture.tracker.pointerUp(
        event.pointerId,
        { x: event.clientX, y: event.clientY },
      )
      if (gesture.outside && tapped) {
        dismissTooltip(false)
      }
    }
    const onPointerCancel = (event: PointerEvent): void => {
      outsideGestureRef.current.tracker.pointerCancel(event.pointerId)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('pointercancel', onPointerCancel, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('pointercancel', onPointerCancel, true)
    }
  }, [dismissTooltip, tooltip])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (tooltip !== null) {
        event.preventDefault()
        event.stopImmediatePropagation()
        dismissTooltip(true)
      } else if (fallbackFullscreen) {
        event.preventDefault()
        event.stopImmediatePropagation()
        setFallbackFullscreen(false)
        fullscreenButtonRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [dismissTooltip, fallbackFullscreen, tooltip])

  const toggleFullscreen = async (): Promise<void> => {
    const frame = frameRef.current
    if (frame === null) return
    dismissTooltip(false)
    if (document.fullscreenElement === frame) {
      await document.exitFullscreen()
    } else if (fallbackFullscreen) {
      setFallbackFullscreen(false)
      fullscreenButtonRef.current?.focus()
    } else if (typeof frame.requestFullscreen === 'function') {
      try {
        await frame.requestFullscreen()
      } catch {
        setFallbackFullscreen(true)
      }
    } else {
      setFallbackFullscreen(true)
    }
  }

  return (
    <ChartInteractionContext.Provider value={{ tooltip, showTooltip, dismissTooltip }}>
      <div
        ref={frameRef}
        className={`chart-interaction-frame${fallbackFullscreen ? ' is-fallback-fullscreen' : ''}`}
        aria-label={label}
      >
        {showFullscreenControl ? <button
          ref={fullscreenButtonRef}
          type="button"
          className="chart-fullscreen-button"
          onClick={() => void toggleFullscreen()}
          aria-label={fullscreen ? `Exit fullscreen ${label}` : `View ${label} fullscreen`}
          aria-pressed={fullscreen}
          title={fullscreen ? 'Exit fullscreen' : 'View fullscreen'}
        >
          {fullscreen ? '×' : '⛶'}
        </button> : null}
        {children}
        {tooltip ? <ChartTooltipPanel tooltip={tooltip} dismiss={() => dismissTooltip(true)} /> : null}
      </div>
    </ChartInteractionContext.Provider>
  )
}

export function ChartTooltipPanel({
  tooltip,
  dismiss,
}: {
  readonly tooltip: OpenChartTooltip
  readonly dismiss: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const panelId = useId()
  const [position, setPosition] = useState<TooltipPosition | null>(null)

  useLayoutEffect(() => {
    const panel = ref.current
    if (panel === null) return
    const place = (): void => {
      const visual = window.visualViewport
      const viewport = visual
        ? { left: visual.offsetLeft, top: visual.offsetTop, width: visual.width, height: visual.height }
        : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
      const rect = panel.getBoundingClientRect()
      setPosition(clampChartTooltip(tooltip.anchor.rect(), rect, viewport))
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(panel)
    observer.observe(tooltip.anchor.trigger)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    document.addEventListener('fullscreenchange', place)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      document.removeEventListener('fullscreenchange', place)
      window.visualViewport?.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('scroll', place)
    }
  }, [tooltip])

  useEffect(() => {
    const trigger = tooltip.anchor.trigger
    const previous = trigger.getAttribute('aria-details')
    trigger.setAttribute('aria-details', panelId)
    return () => {
      if (previous === null) trigger.removeAttribute('aria-details')
      else trigger.setAttribute('aria-details', previous)
    }
  }, [panelId, tooltip])

  return (
    <div
      ref={ref}
      id={panelId}
      className="chart-tooltip-panel catalog-analytics-tooltip"
      role={tooltip.sticky ? 'region' : 'tooltip'}
      aria-label={tooltip.sticky ? tooltip.label : undefined}
      aria-live="polite"
      style={position
        ? {
            left: position.left,
            top: position.top,
            maxHeight: position.maxHeight,
            maxWidth: position.maxWidth,
          }
        : { visibility: 'hidden' }}
    >
      {tooltip.sticky ? (
        <button type="button" className="chart-tooltip-close" onClick={dismiss} aria-label="Dismiss chart details">
          ×
        </button>
      ) : null}
      {tooltip.content}
    </div>
  )
}
