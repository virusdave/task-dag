/**
 * Vanilla pointer-driven slider for the canonical pricing-ladder's
 * proposed marker. Framework-agnostic — works in static-HTML packets and
 * inside React/Svelte by passing the rendered ladder element.
 *
 * Contract: a ladder element rendered with renderPricingLadder() carries
 *
 *   data-canonical-pricing-ladder
 *   data-product-id
 *   data-ladder-min
 *   data-ladder-max
 *
 * and contains a `[data-canonical-pricing-ladder-marker="proposed"]` child
 * that becomes the drag handle. The slider becomes interactive ONLY after
 * `attachPricingLadderSlider(ladderEl, onChange)` is called; without that,
 * the marker is purely visual (per the canonical spec).
 *
 * The handler receives:
 *   - postTaxPrice: the price represented by the new pointer position
 *   - meta: { ratio, productId, source: 'pointer-drag' }
 *
 * If the handler returns a number, the marker snaps to that price (lets
 * the consumer round to e.g. quarter-dollar steps). Returning undefined
 * keeps the raw pointer-derived price.
 */

export interface SliderChangeMeta {
  ratio: number
  productId: string
  source: 'pointer-drag' | 'pointer-down' | 'pointer-up'
}

export type SliderChangeHandler = (
  postTaxPrice: number,
  meta: SliderChangeMeta,
) => number | void

export function attachPricingLadderSlider(
  ladderEl: HTMLElement,
  onChange: SliderChangeHandler,
): () => void {
  const track = ladderEl.querySelector<HTMLElement>('.canonical-pricing-ladder-track')
  const marker = ladderEl.querySelector<HTMLElement>('[data-canonical-pricing-ladder-marker="proposed"]')
  if (!track || !marker) {
    throw new Error(
      'attachPricingLadderSlider: ladder element is missing required .canonical-pricing-ladder-track or proposed marker',
    )
  }
  marker.setAttribute('data-canonical-ladder-slider', 'active')

  const productId = ladderEl.getAttribute('data-product-id') ?? ''
  const minimum = Number.parseFloat(ladderEl.getAttribute('data-ladder-min') ?? '')
  const maximum = Number.parseFloat(ladderEl.getAttribute('data-ladder-max') ?? '')
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) {
    throw new Error(
      `attachPricingLadderSlider: ladder ${productId} has invalid data-ladder-min/data-ladder-max`,
    )
  }

  let pointerId: number | null = null

  const repositionMarker = (price: number): void => {
    const ratio = (price - minimum) / (maximum - minimum)
    const clamped = Math.max(0, Math.min(1, ratio))
    marker.style.left = `${(clamped * 100).toFixed(2)}%`
  }

  const apply = (clientX: number, source: SliderChangeMeta['source']): void => {
    const rect = track.getBoundingClientRect()
    if (rect.width <= 0) return
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const rawPrice = minimum + (maximum - minimum) * ratio
    const snapped = onChange(rawPrice, { ratio, productId, source })
    const next = typeof snapped === 'number' && Number.isFinite(snapped) ? snapped : rawPrice
    repositionMarker(next)
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== undefined && event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    pointerId = event.pointerId
    marker.classList.add('is-dragging')
    if (typeof marker.setPointerCapture === 'function') {
      try {
        marker.setPointerCapture(event.pointerId)
      } catch {
        // ignore: setPointerCapture is best-effort
      }
    }
    apply(event.clientX, 'pointer-down')
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (pointerId === null || event.pointerId !== pointerId) return
    event.preventDefault()
    apply(event.clientX, 'pointer-drag')
  }

  const finish = (event: PointerEvent): void => {
    if (pointerId === null || event.pointerId !== pointerId) return
    apply(event.clientX, 'pointer-up')
    marker.classList.remove('is-dragging')
    pointerId = null
  }

  marker.addEventListener('pointerdown', onPointerDown)
  document.addEventListener('pointermove', onPointerMove)
  document.addEventListener('pointerup', finish)
  document.addEventListener('pointercancel', finish)

  return function detach(): void {
    marker.removeEventListener('pointerdown', onPointerDown)
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerup', finish)
    document.removeEventListener('pointercancel', finish)
    marker.classList.remove('is-dragging')
    marker.removeAttribute('data-canonical-ladder-slider')
    pointerId = null
  }
}

/**
 * Convenience: wire every pricing-ladder under `root` to the same handler.
 * Returns a teardown function that detaches all of them.
 */
export function attachAllPricingLadderSliders(
  root: ParentNode,
  onChange: SliderChangeHandler,
): () => void {
  const detachers: Array<() => void> = []
  for (const ladder of Array.from(root.querySelectorAll<HTMLElement>('[data-canonical-pricing-ladder]'))) {
    detachers.push(attachPricingLadderSlider(ladder, onChange))
  }
  return function detachAll(): void {
    for (const detach of detachers) detach()
  }
}
