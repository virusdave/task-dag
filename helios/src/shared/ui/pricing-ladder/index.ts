/**
 * Canonical pricing-ladder UI control.
 *
 * Public surface re-exported below. See README.md for usage.
 */
export {
  DISTANCE_BANDS,
  bandForDistance,
  colorForListing,
  topPxForListing,
  withinBandProximity,
} from './bands.js'
export type { DistanceBand, DistanceBandKey } from './bands.js'

export { buildLadderGeometry } from './geometry.js'
export type {
  CompetitorListing,
  CompetitorListingInput,
  LadderCompetitorGeometry,
  LadderGeometry,
  LadderMarkerGeometry,
  LadderStats,
  PricingLadderInput,
} from './geometry.js'

export { PRICING_LADDER_STYLE } from './style.js'

export {
  renderPricingLadder,
  renderPricingLadderFromGeometry,
} from './render.js'
export type { RenderOptions } from './render.js'

export {
  attachPricingLadderSlider,
  attachAllPricingLadderSliders,
} from './slider.js'
export type { SliderChangeHandler, SliderChangeMeta } from './slider.js'
