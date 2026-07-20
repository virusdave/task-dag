// @vitest-environment happy-dom

import { act, useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ChartInteractionFrame,
  clampChartTooltip,
  isTapGesture,
  TapGestureTracker,
  useChartInteraction,
} from './ChartInteractionFrame.js'
import { Sparkline } from './BudtenderPerformanceTab.js'

function Harness(): JSX.Element {
  const { tooltip, showTooltip, dismissTooltip } = useChartInteraction()
  const startRef = useRef<{ x: number; y: number } | null>(null)
  return (
    <button
      type="button"
      data-testid="datum"
      onPointerDown={(event) => {
        startRef.current = { x: event.clientX, y: event.clientY }
      }}
      onPointerUp={(event) => {
        const start = startRef.current
        startRef.current = null
        if (start === null || !isTapGesture(start, { x: event.clientX, y: event.clientY })) return
        const trigger = event.currentTarget
        showTooltip({
          anchor: { trigger, rect: () => trigger.getBoundingClientRect() },
          content: <span>Selected datum</span>,
          label: 'Selected datum details',
          sticky: event.pointerType !== 'mouse',
        })
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse' && !tooltip?.sticky) dismissTooltip(false)
      }}
    >
      Datum
    </button>
  )
}

function ControlledHarness(): JSX.Element {
  const [selected, setSelected] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const { showTooltip } = useChartInteraction()
  useEffect(() => {
    const trigger = triggerRef.current
    if (!selected || trigger === null) return
    showTooltip({
      anchor: { trigger, rect: () => trigger.getBoundingClientRect() },
      content: 'Controlled details',
      label: 'Controlled details',
      sticky: true,
      onDismiss: () => setSelected(false),
    })
  }, [selected, showTooltip])
  return <button ref={triggerRef} type="button" onClick={() => setSelected(true)}>Select</button>
}

function FocusCircleHarness(): JSX.Element {
  const [selected, setSelected] = useState(false)
  const triggerRef = useRef<SVGCircleElement | null>(null)
  const { showTooltip } = useChartInteraction()
  useEffect(() => {
    const trigger = triggerRef.current
    if (!selected || trigger === null) return
    showTooltip({
      anchor: { trigger, rect: () => trigger.getBoundingClientRect() },
      content: 'Circle details',
      label: 'Circle details',
      sticky: true,
      onDismiss: () => setSelected(false),
    })
  }, [selected, showTooltip])
  return (
    <svg role="group" aria-label="Test scatter">
      <circle ref={triggerRef} role="button" tabIndex={0} onFocus={() => setSelected(true)} />
    </svg>
  )
}

describe('chart tooltip helpers', () => {
  it('flips and clamps a panel inside a narrow visual viewport', () => {
    expect(clampChartTooltip(
      new DOMRect(290, 190, 0, 0),
      { width: 180, height: 120 },
      { left: 0, top: 0, width: 320, height: 220 },
    )).toEqual({ left: 96, top: 56, maxHeight: 204, maxWidth: 304 })
  })

  it('shrinks an oversized panel to the visual viewport', () => {
    expect(clampChartTooltip(
      new DOMRect(100, 100, 0, 0),
      { width: 500, height: 900 },
      { left: 20, top: 30, width: 240, height: 300 },
    )).toEqual({ left: 28, top: 38, maxHeight: 284, maxWidth: 224 })
  })

  it('distinguishes an outside tap from a scrolling drag', () => {
    expect(isTapGesture({ x: 10, y: 10 }, { x: 14, y: 16 })).toBe(true)
    expect(isTapGesture({ x: 10, y: 10 }, { x: 10, y: 40 })).toBe(false)
  })

  it('invalidates a tap candidate when a second pointer joins', () => {
    const tracker = new TapGestureTracker()
    tracker.pointerDown(1, { x: 10, y: 10 })
    tracker.pointerDown(2, { x: 20, y: 20 })
    expect(tracker.pointerUp(2, { x: 20, y: 20 })).toBe(false)
    expect(tracker.pointerUp(1, { x: 10, y: 10 })).toBe(false)
  })
})

describe('ChartInteractionFrame', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root.render(<ChartInteractionFrame label="Test chart"><Harness /></ChartInteractionFrame>))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  function pointer(target: EventTarget, type: string, init: PointerEventInit): void {
    act(() => target.dispatchEvent(new PointerEvent(type, { bubbles: true, ...init })))
  }

  it('keeps a sticky tooltip through scrolling and dismisses only an outside tap', () => {
    const datum = host.querySelector<HTMLButtonElement>('[data-testid="datum"]')!
    pointer(datum, 'pointerdown', { pointerId: 11, pointerType: 'touch', clientX: 20, clientY: 20 })
    pointer(datum, 'pointerup', { pointerId: 11, pointerType: 'touch', clientX: 20, clientY: 20 })
    const frame = host.querySelector('.chart-interaction-frame')!
    expect(frame.querySelector('[role="region"]')?.textContent).toContain('Selected datum')

    act(() => window.dispatchEvent(new Event('scroll')))
    expect(frame.querySelector('[role="region"]')).not.toBeNull()

    pointer(document.body, 'pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    pointer(document.body, 'pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 20, clientY: 20 })
    pointer(document.body, 'pointerup', { pointerId: 2, pointerType: 'touch', clientX: 20, clientY: 20 })
    pointer(document.body, 'pointerup', { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    expect(frame.querySelector('[role="region"]')).not.toBeNull()

    pointer(document.body, 'pointerdown', { pointerId: 3, pointerType: 'touch', clientX: 10, clientY: 10 })
    pointer(document.body, 'pointerup', { pointerId: 3, pointerType: 'touch', clientX: 10, clientY: 50 })
    expect(frame.querySelector('[role="region"]')).not.toBeNull()

    pointer(document.body, 'pointerdown', { pointerId: 4, pointerType: 'touch', clientX: 10, clientY: 10 })
    pointer(document.body, 'pointerup', { pointerId: 4, pointerType: 'touch', clientX: 12, clientY: 12 })
    expect(frame.querySelector('[role="region"]')).toBeNull()
  })

  it('dismisses mouse hover on leave and restores focus after Escape', () => {
    const datum = host.querySelector<HTMLButtonElement>('[data-testid="datum"]')!
    pointer(datum, 'pointerdown', { pointerType: 'mouse' })
    pointer(datum, 'pointerup', { pointerType: 'mouse' })
    expect(host.querySelector('[role="tooltip"]')).not.toBeNull()
    pointer(datum, 'pointerout', { pointerType: 'mouse' })
    expect(host.querySelector('[role="tooltip"]')).toBeNull()

    pointer(datum, 'pointerdown', { pointerType: 'touch' })
    pointer(datum, 'pointerup', { pointerType: 'touch' })
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(host.querySelector('[role="region"]')).toBeNull()
    expect(document.activeElement).toBe(datum)

    pointer(datum, 'pointerdown', { pointerType: 'touch' })
    pointer(datum, 'pointerup', { pointerType: 'touch' })
    act(() => host.querySelector<HTMLButtonElement>('.chart-tooltip-close')!.click())
    expect(host.querySelector('[role="region"]')).toBeNull()
    expect(document.activeElement).toBe(datum)
  })

  it('tracks native fullscreenchange and exits through the same control', async () => {
    const button = host.querySelector<HTMLButtonElement>('.chart-fullscreen-button')!
    const frame = host.querySelector<HTMLDivElement>('.chart-interaction-frame')!
    let active: Element | null = null
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => active })
    Object.defineProperty(frame, 'requestFullscreen', {
      configurable: true,
      value: async () => {
        active = frame
        document.dispatchEvent(new Event('fullscreenchange'))
      },
    })
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: async () => {
        active = null
        document.dispatchEvent(new Event('fullscreenchange'))
      },
    })
    await act(async () => button.click())
    expect(button.getAttribute('aria-pressed')).toBe('true')
    await act(async () => button.click())
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(document.activeElement).toBe(button)
  })

  it('uses a wrapper-contained CSS fullscreen fallback', () => {
    const button = host.querySelector<HTMLButtonElement>('.chart-fullscreen-button')!
    const frame = host.querySelector<HTMLDivElement>('.chart-interaction-frame')!
    Object.defineProperty(frame, 'requestFullscreen', { value: undefined, configurable: true })
    act(() => button.click())
    expect(frame.classList.contains('is-fallback-fullscreen')).toBe(true)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    act(() => button.click())
    expect(frame.classList.contains('is-fallback-fullscreen')).toBe(false)
    expect(document.activeElement).toBe(button)
  })

  it('clears caller-owned selection so dismissed details stay closed on rerender', () => {
    act(() => root.render(
      <ChartInteractionFrame label="Controlled chart"><ControlledHarness /></ChartInteractionFrame>,
    ))
    const select = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Select')!
    act(() => select.click())
    expect(host.querySelector('[role="region"]')).not.toBeNull()
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(host.querySelector('[role="region"]')).toBeNull()
    act(() => window.dispatchEvent(new Event('resize')))
    expect(host.querySelector('[role="region"]')).toBeNull()
  })

  it('restores circle focus without reopening details after close or Escape', () => {
    act(() => root.render(
      <ChartInteractionFrame label="Focus chart"><FocusCircleHarness /></ChartInteractionFrame>,
    ))
    const circle = host.querySelector<SVGCircleElement>('circle')!
    act(() => circle.focus())
    expect(host.querySelector('[role="region"]')).not.toBeNull()
    const firstClose = host.querySelector<HTMLButtonElement>('.chart-tooltip-close')!
    act(() => firstClose.focus())
    act(() => firstClose.click())
    expect(document.activeElement).toBe(circle)
    expect(host.querySelector('[role="region"]')).toBeNull()

    act(() => circle.blur())
    act(() => circle.focus())
    const close = host.querySelector<HTMLButtonElement>('.chart-tooltip-close')!
    act(() => close.focus())
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.activeElement).toBe(circle)
    expect(host.querySelector('[role="region"]')).toBeNull()
  })
})

describe('Budtender Sparkline touch gestures', () => {
  it('does not open details for a scroll gesture, then opens on a tap', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(
      <ChartInteractionFrame label="Sparkline test">
        <Sparkline days={['2026-07-18', '2026-07-19']} values={[10, 20]} format={String} />
      </ChartInteractionFrame>,
    ))
    const svg = host.querySelector<SVGSVGElement>('svg')!
    Object.defineProperty(svg, 'getBoundingClientRect', {
      value: () => new DOMRect(0, 0, 700, 220),
    })
    const pointer = (type: string, init: PointerEventInit): void => {
      act(() => svg.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'touch', ...init })))
    }
    pointer('pointerdown', { pointerId: 7, clientX: 100, clientY: 100 })
    pointer('pointerup', { pointerId: 7, clientX: 100, clientY: 150 })
    expect(host.querySelector('[role="region"]')).toBeNull()
    pointer('pointerdown', { pointerId: 9, clientX: 100, clientY: 100 })
    pointer('pointerdown', { pointerId: 10, clientX: 110, clientY: 100 })
    pointer('pointerup', { pointerId: 10, clientX: 110, clientY: 100 })
    pointer('pointerup', { pointerId: 9, clientX: 100, clientY: 100 })
    expect(host.querySelector('[role="region"]')).toBeNull()
    pointer('pointerdown', { pointerId: 8, clientX: 100, clientY: 100 })
    pointer('pointerup', { pointerId: 8, clientX: 102, clientY: 102 })
    expect(host.querySelector('[role="region"]')).not.toBeNull()
    act(() => root.unmount())
    host.remove()
  })
})
