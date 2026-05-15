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
}

export function CanonicalPricingLadder(props: CanonicalPricingLadderProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  const ladderHtml = useMemo(
    () =>
      renderPricingLadder(
        {
          productId: props.productId,
          livePrice: props.livePrice,
          proposedPrice: props.proposedPrice,
          marketAveragePostTax: props.marketAveragePostTax,
          marketMedianPostTax: props.marketMedianPostTax,
          competitorListings: props.competitorListings,
        },
        { 
          variant: props.variant ?? 'detail',
          headHtml: props.headHtml,
        },
      ),
    [
      props.productId,
      props.livePrice,
      props.proposedPrice,
      props.marketAveragePostTax,
      props.marketMedianPostTax,
      props.competitorListings,
      props.variant,
      props.headHtml,
    ],
  )

  useEffect(() => {
    const el = containerRef.current?.querySelector<HTMLElement>('[data-canonical-pricing-ladder]')
    if (!el || !props.onProposedPriceChange) return

    const detach = attachPricingLadderSlider(el, (rawPrice) => {
      const snapped = Math.round(rawPrice * 4) / 4 // Snap to quarters
      props.onProposedPriceChange!(snapped)
      return snapped
    })

    return () => {
      detach()
    }
  }, [ladderHtml, props.onProposedPriceChange])

  return <div ref={containerRef} dangerouslySetInnerHTML={{ __html: ladderHtml }} />
}
