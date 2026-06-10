import { useEffect, useMemo, useRef } from 'react'

import {
  attachPricingLadderSlider,
  renderPricingLadder,
  type CompetitorListing,
} from '../../shared/ui/pricing-ladder/index.js'

export interface CanonicalPricingLadderProps {
  productId: number
  livePrice: number | null
  proposedPrice: number | null
  marketAveragePostTax: number | null
  marketMedianPostTax: number | null
  competitorListings: CompetitorListing[]
  variant?: 'detail' | 'compact'
  headHtml?: string
  onProposedPriceChange?: (nextPrice: number) => void
  /** Cached competitor-evidence freshness; drives the chip + expired-lock. */
  freshness?: 'fresh' | 'stale' | 'very_stale' | 'expired' | 'absent'
  /** Age of the underlying observation, in days. */
  freshnessAgeDays?: number | null
  /** Per-row operator opt-in to view & apply expired evidence. */
  acknowledgeExpiredEvidence?: boolean
}

// Why this component is implemented the way it is (drag survival):
//
// The reviewer needs to DRAG the proposed-price marker, not just
// click-to-set it. The previous implementation included `proposedPrice`
// in the `useMemo` deps that built `ladderHtml`, so every `setDraftPrice`
// callback during a drag rebuilt the HTML, replaced the marker DOM node,
// and silently dropped the in-flight pointer capture — the perceived
// "the slider only works on click, not drag" bug.
//
// Fix: build the ladder HTML ONCE per shape-changing input (everything
// EXCEPT `proposedPrice`). When `proposedPrice` changes from outside
// (e.g. operator typed a value in the override-price input), mutate the
// marker's `style.left` and label text in place via DOM — no React
// re-render. During an interactive drag, `attachPricingLadderSlider`
// already mutates `marker.style.left` directly; we extend its onChange
// hook to also keep the label text in sync so the reviewer sees the
// live price as they drag.
export function CanonicalPricingLadder(props: CanonicalPricingLadderProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  // Latest external props captured in refs so the slider effect doesn't
  // need them in its deps (which would tear down the slider mid-drag).
  const onProposedPriceChangeRef = useRef(props.onProposedPriceChange)
  onProposedPriceChangeRef.current = props.onProposedPriceChange
  // Latest proposedPrice captured in a ref so the useMemo can read it
  // on the rare null↔non-null transitions that DO force a rebuild,
  // without making numeric proposedPrice changes a dependency.
  const proposedPriceRef = useRef(props.proposedPrice)
  proposedPriceRef.current = props.proposedPrice
  // The marker's *presence* in the rendered DOM is a shape change that
  // must trigger a rebuild — otherwise the slider effect tries to wire
  // up a marker that doesn't exist and throws (or, post-fix, warns and
  // no-ops, leaving the row un-draggable forever). Numeric drag changes
  // still bypass the rebuild and mutate marker.style.left directly.
  const hasProposedPrice =
    props.proposedPrice !== null && Number.isFinite(props.proposedPrice)

  // Depend on a STRUCTURAL signature of the competitor listings rather
  // than the array reference. Several callers build this array inline in
  // JSX (e.g. `mapToCompetitorListings(item.marketListings)` on the
  // pending-purchases page, `ladder.competitorListings.map(...)` on the
  // review page), so the reference changes on every parent render. If we
  // keyed the ladderHtml memo on that reference, every re-render — most
  // importantly the ones the slider itself triggers via setDraftPrice
  // mid-drag, plus typing in the override-price input or clicking
  // "Apply to family" — would rebuild the ladder HTML, replace the
  // marker DOM via dangerouslySetInnerHTML, and drop the in-flight
  // pointer capture. That silently defeats the whole drag-survival
  // design (the slider would only respond to the initial click). Keying
  // on a value-based signature keeps the memo stable across
  // referentially-unstable-but-identical arrays, so numeric
  // proposedPrice changes never rebuild the DOM.
  const competitorListingsSignature = useMemo(
    () => buildCompetitorListingsSignature(props.competitorListings),
    [props.competitorListings],
  )

  const ladderHtml = useMemo(
    () =>
      renderPricingLadder(
        {
          productId: props.productId,
          livePrice: props.livePrice,
          // Read the current proposedPrice (via ref) at rebuild time so
          // a null→number transition renders with the real marker
          // position instead of a stale value.
          proposedPrice: proposedPriceRef.current,
          marketAveragePostTax: props.marketAveragePostTax,
          marketMedianPostTax: props.marketMedianPostTax,
          competitorListings: props.competitorListings,
        },
        {
          variant: props.variant ?? 'detail',
          headHtml: props.headHtml,
          freshness: props.freshness,
          freshnessAgeDays: props.freshnessAgeDays,
          acknowledgeExpiredEvidence: props.acknowledgeExpiredEvidence,
        },
      ),
    // NOTE: the *numeric value* of proposedPrice is deliberately
    // excluded — see drag-survival comment above the component. We DO
    // depend on `hasProposedPrice` so the marker's presence/absence
    // triggers a rebuild.
    [
      props.productId,
      props.livePrice,
      props.marketAveragePostTax,
      props.marketMedianPostTax,
      competitorListingsSignature,
      props.variant,
      props.headHtml,
      props.freshness,
      props.freshnessAgeDays,
      props.acknowledgeExpiredEvidence,
      hasProposedPrice,
    ],
  )

  // Reflect EXTERNAL proposedPrice changes (override input typing,
  // family-level bulk set, server revalidation) without rebuilding the
  // ladder DOM. Find the marker each render in case React replaced the
  // root via dangerouslySetInnerHTML.
  useEffect(() => {
    const root = containerRef.current?.querySelector<HTMLElement>('[data-canonical-pricing-ladder]')
    if (!root) return
    const marker = root.querySelector<HTMLElement>('[data-canonical-pricing-ladder-marker="proposed"]')
    if (!marker) return
    const min = Number.parseFloat(root.getAttribute('data-ladder-min') ?? '')
    const max = Number.parseFloat(root.getAttribute('data-ladder-max') ?? '')
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return
    if (props.proposedPrice === null || !Number.isFinite(props.proposedPrice)) return
    updateProposedMarker(marker, props.proposedPrice, min, max)
  }, [props.proposedPrice, ladderHtml])

  useEffect(() => {
    const el = containerRef.current?.querySelector<HTMLElement>('[data-canonical-pricing-ladder]')
    if (!el) return
    const handler = onProposedPriceChangeRef.current
    if (!handler) return

    const marker = el.querySelector<HTMLElement>('[data-canonical-pricing-ladder-marker="proposed"]')
    const min = Number.parseFloat(el.getAttribute('data-ladder-min') ?? '')
    const max = Number.parseFloat(el.getAttribute('data-ladder-max') ?? '')
    const validRange = Number.isFinite(min) && Number.isFinite(max) && max > min

    const detach = attachPricingLadderSlider(el, (rawPrice) => {
      const snapped = Math.round(rawPrice * 4) / 4 // Snap to quarters
      // Keep the marker's visible label in sync with the live drag price.
      if (marker && validRange) {
        const labelEl = marker.querySelector<HTMLElement>('.label')
        if (labelEl) labelEl.textContent = `Proposed ${formatUsdForLabel(snapped)}`
      }
      // Always read the latest handler via ref so the effect doesn't
      // have to depend on (and re-attach to) the React closure.
      onProposedPriceChangeRef.current?.(snapped)
      return snapped
    })

    return () => {
      detach()
    }
    // Re-attach only when the ladder HTML itself was rebuilt (i.e. the
    // marker DOM was actually replaced). Excluding proposedPrice is
    // what keeps drag-state alive across re-renders.
  }, [ladderHtml])

  return <div ref={containerRef} dangerouslySetInnerHTML={{ __html: ladderHtml }} />
}

// Value-based fingerprint of the competitor listings. MUST include every
// field that affects how a listing is rendered/positioned on the ladder
// (see CompetitorListingInput): identity, price, distance, the label
// strings, eligibility (dims the dot + excludes from stats), and the
// matchTier (drops `weak`, dims `fallback`). If a new rendered field is
// added to CompetitorListing, add it here too, otherwise a change to it
// won't trigger a ladder rebuild.
function buildCompetitorListingsSignature(listings: readonly CompetitorListing[]): string {
  return listings
    .map((listing) =>
      [
        listing.listingId,
        signatureNumber(listing.postTaxPrice),
        signatureNumber(listing.distanceMiles),
        listing.dispensaryName ?? '',
        listing.dispensaryAddress ?? '',
        listing.listingName ?? '',
        listing.url ?? '',
        listing.eligibleForPricing === false ? '0' : '1',
        listing.matchTier ?? 'exact',
      ].join('\u001f'),
    )
    .join('\u001e')
}

function signatureNumber(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

function updateProposedMarker(
  marker: HTMLElement,
  price: number,
  min: number,
  max: number,
): void {
  const ratio = Math.max(0, Math.min(1, (price - min) / (max - min)))
  marker.style.left = `${(ratio * 100).toFixed(2)}%`
  const labelEl = marker.querySelector<HTMLElement>('.label')
  if (labelEl) labelEl.textContent = `Proposed ${formatUsdForLabel(price)}`
  marker.setAttribute('title', `Proposed: ${formatUsdForLabel(price)}`)
}

function formatUsdForLabel(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value < 100 ? 2 : 0,
  })
}
