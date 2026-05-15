/**
 * HTML-string renderer for the canonical pricing-ladder.
 *
 * Returns a self-contained HTML fragment using the class taxonomy
 * documented in style.ts. The returned string is safe to drop into a
 * static reviewer-packet page or a server-rendered Helios route.
 *
 * Slider behavior is opt-in at runtime: the renderer always emits the
 * proposed marker (when a proposed price exists), but a marker only
 * becomes draggable if the consumer calls
 *   attachPricingLadderSlider(ladderEl, onChange)
 * (see ./slider.ts) after mounting. Without that call the marker is
 * purely visual.
 */
import { DISTANCE_BANDS, type DistanceBand } from './bands.js'
import {
  buildLadderGeometry,
  type LadderCompetitorGeometry,
  type LadderGeometry,
  type LadderMarkerGeometry,
  type PricingLadderInput,
} from './geometry.js'

export interface RenderOptions {
  /** 'compact' for embedded table-row use; 'detail' for full-width pages. */
  variant?: 'compact' | 'detail'
  /** Text shown in the head row alongside the metric (e.g. "current → proposed"). */
  headHtml?: string
  /** Optional SKU label for tooltips and accessibility. */
  productLabel?: string
  /** Render the band legend immediately above the ladder (default true). */
  includeLegend?: boolean
  /** Show the meta caption row beneath the ladder (default true). */
  includeMeta?: boolean
}

export function renderPricingLadder(
  input: PricingLadderInput,
  options: RenderOptions = {},
): string {
  const geometry = buildLadderGeometry(input)
  return renderPricingLadderFromGeometry(geometry, input, options)
}

/**
 * Same as renderPricingLadder() but accepts a pre-built geometry. Useful
 * when the caller already invoked buildLadderGeometry() (e.g. to derive
 * stats) and wants to avoid recomputing.
 */
export function renderPricingLadderFromGeometry(
  geometry: LadderGeometry,
  input: PricingLadderInput,
  options: RenderOptions = {},
): string {
  const variant = options.variant ?? 'compact'
  const includeLegend = options.includeLegend !== false
  const includeMeta = options.includeMeta !== false

  const legend = includeLegend ? renderLegend(geometry.bandsPresent) : ''

  const head = options.headHtml
    ? `<div class="canonical-pricing-ladder-head">${options.headHtml}</div>`
    : ''

  const dataAttrs = [
    'data-canonical-pricing-ladder=""',
    `data-product-id="${escapeHtml(String(geometry.productId))}"`,
    `data-ladder-min="${geometry.domainMin.toFixed(4)}"`,
    `data-ladder-max="${geometry.domainMax.toFixed(4)}"`,
    `data-variant="${escapeHtml(variant)}"`,
  ].join(' ')

  const iqrHtml = geometry.iqr
    ? `<div class="canonical-ladder-iqr" style="left:${geometry.iqr.leftPercent.toFixed(2)}%; width:${geometry.iqr.widthPercent.toFixed(2)}%;"></div>`
    : ''

  const competitorsHtml = geometry.competitors.map(renderCompetitor).join('')
  const markersHtml = geometry.markers.map(renderMarker).join('')

  const meta = includeMeta ? renderMeta(geometry) : ''

  return `<div class="canonical-pricing-ladder ${variant === 'detail' ? 'is-detail' : 'is-compact'}" ${dataAttrs}>
${head}
${legend}
<div class="canonical-pricing-ladder-track">
<div class="canonical-ladder-baseline"></div>
${iqrHtml}
${geometry.iqr && geometry.stats.medianPostTax !== null ? renderMedianTick(geometry) : ''}
${competitorsHtml}
${markersHtml}
<div class="canonical-ladder-axis axis-min">${formatUsd(geometry.domainMin)}</div>
<div class="canonical-ladder-axis axis-max">${formatUsd(geometry.domainMax)}</div>
</div>
${meta}
</div>`
}

function renderMedianTick(geometry: LadderGeometry): string {
  if (geometry.stats.medianPostTax === null) return ''
  const min = geometry.domainMin
  const max = geometry.domainMax
  const ratio = max <= min ? 0.5 : (geometry.stats.medianPostTax - min) / (max - min)
  const left = Math.max(0, Math.min(100, ratio * 100))
  return `<div class="canonical-ladder-median" style="left:${left.toFixed(2)}%;" title="Median ${formatUsd(geometry.stats.medianPostTax)}"></div>`
}

function renderCompetitor(c: LadderCompetitorGeometry): string {
  const titleParts: string[] = []
  if (c.dispensaryName) titleParts.push(c.dispensaryName)
  titleParts.push(`Post-tax: ${formatUsd(c.postTaxPrice)}`)
  titleParts.push(c.distanceMiles !== null ? `${c.distanceMiles.toFixed(2)} mi` : 'distance unknown')
  if (c.listingName) titleParts.push(c.listingName)
  if (c.dispensaryAddress) titleParts.push(c.dispensaryAddress)
  if (!c.eligibleForPricing) titleParts.push('display only (excluded from pricing comps)')
  const title = escapeHtml(titleParts.join(' \u00b7 '))

  const style = `left:${c.leftPercent.toFixed(2)}%; top:${c.topPx.toFixed(1)}px; background:${c.color};`
  const dataAttrs = [
    `data-canonical-pricing-ladder-competitor=""`,
    `data-band="${escapeHtml(c.bandKey)}"`,
    `data-listing-id="${escapeHtml(String(c.listingId))}"`,
    `data-eligible="${c.eligibleForPricing ? 'true' : 'false'}"`,
    c.distanceMiles !== null ? `data-distance-miles="${c.distanceMiles.toFixed(3)}"` : '',
    `data-proximity="${c.proximity.toFixed(3)}"`,
  ]
    .filter(Boolean)
    .join(' ')
  const className = `canonical-ladder-competitor band-${c.bandKey}`

  if (c.url) {
    return `<a class="${className}" ${dataAttrs} style="${style}" href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer" title="${title}"></a>`
  }
  return `<span class="${className}" ${dataAttrs} style="${style}" title="${title}"></span>`
}

function renderMarker(marker: LadderMarkerGeometry): string {
  const labelMap: Record<LadderMarkerGeometry['kind'], string> = {
    live: 'Live',
    proposed: 'Proposed',
    'market-average': 'Market avg',
    'market-median': 'Market median',
  }
  const label = labelMap[marker.kind]
  const dataMarker = `data-canonical-pricing-ladder-marker="${marker.kind}"`
  const title = escapeHtml(`${label}: ${formatUsd(marker.postTaxPrice)}`)
  return `<div class="canonical-ladder-marker ${marker.kind}" ${dataMarker} style="left:${marker.leftPercent.toFixed(2)}%;" title="${title}">
<span class="pip"></span>
<span class="pin"></span>
<span class="label">${escapeHtml(label)} ${escapeHtml(formatUsd(marker.postTaxPrice))}</span>
</div>`
}

function renderLegend(bandsPresent: DistanceBand[]): string {
  const bands = bandsPresent.length > 0 ? bandsPresent : DISTANCE_BANDS
  const pills = bands
    .map(
      (band) => `<span class="legend-pill"><span class="legend-dot" style="background:${band.color};"></span>${escapeHtml(band.label)}</span>`,
    )
    .join('')
  return `<div class="canonical-pricing-ladder-legend">${pills}</div>`
}

function renderMeta(geometry: LadderGeometry): string {
  const stats = geometry.stats
  const parts: string[] = [
    `${stats.totalCompCount} competitor listing${stats.totalCompCount === 1 ? '' : 's'}`,
  ]
  if (stats.pricingCompCount !== stats.totalCompCount) {
    parts.push(`${stats.pricingCompCount} eligible for comps`)
  }
  if (stats.medianPostTax !== null) parts.push(`median ${formatUsd(stats.medianPostTax)}`)
  if (stats.q1PostTax !== null && stats.q3PostTax !== null) {
    parts.push(`IQR ${formatUsd(stats.q1PostTax)}\u2013${formatUsd(stats.q3PostTax)}`)
  }
  if (stats.minPostTax !== null && stats.maxPostTax !== null) {
    parts.push(`range ${formatUsd(stats.minPostTax)}\u2013${formatUsd(stats.maxPostTax)}`)
  }
  return `<div class="canonical-pricing-ladder-meta">${parts.map((p) => `<span>${escapeHtml(p)}</span>`).join('')}</div>`
}

function formatUsd(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value < 100 ? 2 : 0,
  })
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
