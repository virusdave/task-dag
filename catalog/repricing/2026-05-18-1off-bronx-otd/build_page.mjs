#!/usr/bin/env node
/**
 * v2 of the Bronx 1Off OTD scratchpad. Reads `data.json` (produced
 * by `gather_data.mjs`) and emits `page.html` next to this script.
 *
 * Implements the operator-stated requirements captured in
 *   docs/helios/pricing-page-promo-aware-scratchpad/README.md
 *
 * Highlights over v1:
 *   - The three "our price" markers (current / proposed / post-promo)
 *     are all diamonds, as the operator standard prescribes.
 *   - Competitor dots use the canonical 5-tier color + vertical-band
 *     scheme from helios/src/shared/ui/pricing-ladder/bands.ts so the
 *     scratchpad and the real Helios pricing pages stay visually
 *     consistent.
 *   - Per-row + per-group + page-level promo % overrides, cascading
 *     row > group > page. Group price-marker labels reflect the
 *     *effective* promo % for that group.
 *   - Per-row + per-group + page-level review state
 *     (unreviewed/approved/rejected). Group state is computed from
 *     its rows; page state from the brands.
 *   - The proposed-price input has a scope radio
 *     (local Bronx vs global chain) so the apply engine can emit the
 *     right edit. Default scope is local, since this scratchpad is
 *     site-specific (Bronx); the radio remembers per-row choices.
 *   - "Export apply plan" button serializes the approved-only diff
 *     into a JSON that `apply_plan.py` can dry-run / apply.
 *   - Promo-percent edits are *informational only* — the apply
 *     engine prints a promo-plan summary but never writes promo
 *     changes (operator handles out-of-band).
 *
 * Output: `page.html`. Upload via
 *   scripts/upload-to-mss page.html "..." 86400
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_PATH = resolve(HERE, 'data.json')
const OUT_PATH = resolve(HERE, 'page.html')

// ---- helpers ------------------------------------------------------

function escapeHtml(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fmtMoney(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—'
  return `$${Number(value).toFixed(2)}`
}

function fmtPct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—'
  return `${Number(value).toFixed(1)}%`
}

// Canonical 5-tier band definitions mirrored from
// helios/src/shared/ui/pricing-ladder/bands.ts. Kept in sync by hand
// for now — when the scratchpad pattern graduates into the real
// pricing pages, that copy should be deleted in favor of importing
// from the canonical module.
const BANDS = [
  { key: 'very-near', label: '≤2 mi',      lowerMiles: 0,  upperMiles: 2,    color: '#1d7a4f', trackTopPct: 18, microAdjustPct: 6 },
  { key: 'near',      label: '2–5 mi',     lowerMiles: 2,  upperMiles: 5,    color: '#3aa269', trackTopPct: 32, microAdjustPct: 6 },
  { key: 'mid',       label: '5–15 mi',    lowerMiles: 5,  upperMiles: 15,   color: '#caa53a', trackTopPct: 48, microAdjustPct: 6 },
  { key: 'far',       label: '15–50 mi',   lowerMiles: 15, upperMiles: 50,   color: '#c87132', trackTopPct: 64, microAdjustPct: 6 },
  { key: 'statewide', label: '>50/unknown', lowerMiles: 50, upperMiles: null, color: '#7d7569', trackTopPct: 80, microAdjustPct: 4 },
]

function bandForDistance(miles) {
  if (miles == null || !Number.isFinite(miles)) return BANDS[BANDS.length - 1]
  for (const b of BANDS) {
    if (b.upperMiles == null || miles <= b.upperMiles) return b
  }
  return BANDS[BANDS.length - 1]
}

function withinBandProximity(band, miles) {
  if (miles == null || !Number.isFinite(miles)) return 0
  if (band.upperMiles == null) return 0
  const span = band.upperMiles - band.lowerMiles
  if (span <= 0) return 1
  const clamped = Math.min(band.upperMiles, Math.max(band.lowerMiles, miles))
  return (band.upperMiles - clamped) / span
}

function topPctForListing(miles) {
  const band = bandForDistance(miles)
  const proximity = withinBandProximity(band, miles)
  return band.trackTopPct - proximity * band.microAdjustPct
}

function colorForListing(miles) {
  const band = bandForDistance(miles)
  const proximity = withinBandProximity(band, miles)
  const fadePercent = Math.round((1 - proximity) * 35)
  return `color-mix(in srgb, ${band.color}, white ${fadePercent}%)`
}

function deriveDomainForProduct(product, postTaxMultiplier, initialDiscountFraction) {
  const liveGlobalPrice = Number(product.globalPrice) || 0
  const liveActualPrice = Number(product.bronxActualPrice ?? product.globalPrice) || 0
  const initialLocalPrice = Number(product.bronxLocalPrice ?? product.globalPrice)
  const initialPostPromo = initialLocalPrice * (1 - initialDiscountFraction)

  const anchors = []
  anchors.push(liveActualPrice * postTaxMultiplier)
  anchors.push(liveGlobalPrice * postTaxMultiplier)
  anchors.push(initialPostPromo * postTaxMultiplier)
  for (const listing of product.market?.matchedListings ?? []) {
    if (Number.isFinite(Number(listing.postTaxPrice)) && Number(listing.postTaxPrice) > 0) {
      anchors.push(Number(listing.postTaxPrice))
    }
  }
  const valid = anchors.filter((v) => Number.isFinite(v) && v > 0)
  if (valid.length === 0) return { min: 0, max: 50 }
  const rawMin = Math.min(...valid)
  const rawMax = Math.max(...valid)
  const span = Math.max(rawMax - rawMin, rawMax * 0.4, 5)
  return {
    min: Math.max(0, rawMin - span * 0.35),
    max: rawMax + span * 0.45,
  }
}

function renderLadder(product, domain, initialDiscountFraction, postTax) {
  const matchedListings = product.market?.matchedListings ?? []
  const liveOtd = Number(product.bronxActualPrice ?? product.globalPrice) * postTax
  const initialLocalPrice = Number(product.bronxLocalPrice ?? product.globalPrice)
  const initialProposedOtd = initialLocalPrice * postTax
  const initialPostPromoOtd = initialLocalPrice * (1 - initialDiscountFraction) * postTax
  const span = domain.max - domain.min
  const toPct = (priceOtd) => {
    if (!Number.isFinite(priceOtd) || span <= 0) return null
    return ((priceOtd - domain.min) / span) * 100
  }

  // Render each competitor listing as a dot positioned by post-tax price + distance band.
  const sortedListings = [...matchedListings].sort((a, b) => {
    // Draw farther/less-relevant dots first so near ones float on top.
    return (bandForDistance(b.distanceMiles)?.trackTopPct ?? 0) - (bandForDistance(a.distanceMiles)?.trackTopPct ?? 0)
  })
  const dots = sortedListings.map((listing) => {
    const left = toPct(Number(listing.postTaxPrice))
    if (left === null) return ''
    const clamped = Math.max(-2, Math.min(102, left))
    const offAxis = clamped !== left
    const band = bandForDistance(listing.distanceMiles)
    const topPct = topPctForListing(listing.distanceMiles)
    const color = colorForListing(listing.distanceMiles)
    const eligibilityClass = listing.eligibleForPricing ? '' : ' display-only'
    const tooltipParts = [
      listing.dispensaryName ?? '—',
      listing.listingName ?? '',
      listing.distanceMiles != null
        ? `${Number(listing.distanceMiles).toFixed(1)} mi (band: ${band?.key ?? 'unknown'})`
        : `band: ${band?.key ?? 'unknown'}`,
      `post-tax ${fmtMoney(listing.postTaxPrice)}`,
      listing.preTaxPrice != null ? `pre-tax ${fmtMoney(listing.preTaxPrice)}` : '',
      listing.eligibleForPricing ? '' : '(display-only)',
    ].filter(Boolean).join(' · ')
    const urlAttr = listing.url ? ` data-url="${escapeHtml(listing.url)}"` : ''
    return `<div class="dot${eligibilityClass}${offAxis ? ' off-axis' : ''}" style="left:${clamped.toFixed(2)}%;top:${topPct.toFixed(2)}%;background:${color};border-color:${color};" title="${escapeHtml(tooltipParts)}"${urlAttr}></div>`
  }).join('')

  const market = product.market ?? {}
  const avgPct = market.averagePostTaxPrice != null ? toPct(Number(market.averagePostTaxPrice)) : null
  const medPct = market.medianPostTaxPrice != null ? toPct(Number(market.medianPostTaxPrice)) : null
  const marketAvg = avgPct != null
    ? `<div class="marker market-avg" style="left:${avgPct.toFixed(2)}%;" title="Market avg post-tax ${fmtMoney(market.averagePostTaxPrice)}"><span class="tick"></span><span class="lbl">avg ${escapeHtml(fmtMoney(market.averagePostTaxPrice))}</span></div>`
    : ''
  const marketMed = medPct != null
    ? `<div class="marker market-median" style="left:${medPct.toFixed(2)}%;" title="Market median post-tax ${fmtMoney(market.medianPostTaxPrice)}"><span class="tick"></span><span class="lbl">med ${escapeHtml(fmtMoney(market.medianPostTaxPrice))}</span></div>`
    : ''

  // The three "our price" markers — all diamonds.
  const liveLeft = toPct(liveOtd)
  const proposedLeft = toPct(initialProposedOtd)
  const postPromoLeft = toPct(initialPostPromoOtd)

  const liveMarker = liveLeft != null
    ? `<div class="ours current" data-marker="current" style="left:${Math.max(-2, Math.min(102, liveLeft)).toFixed(2)}%;" title="Current price OTD ${fmtMoney(liveOtd)}">
         <span class="dia"></span>
         <span class="lbl">cur <span data-bind="current-otd">${escapeHtml(fmtMoney(liveOtd))}</span></span>
       </div>`
    : ''
  const proposedMarker = proposedLeft != null
    ? `<div class="ours proposed" data-marker="proposed" style="left:${Math.max(-2, Math.min(102, proposedLeft)).toFixed(2)}%;" title="Proposed price OTD">
         <span class="dia"></span>
         <span class="lbl">prop <span data-bind="proposed-otd-lbl">${escapeHtml(fmtMoney(initialProposedOtd))}</span></span>
       </div>`
    : ''
  const postPromoMarker = postPromoLeft != null
    ? `<div class="ours post-promo" data-marker="post-promo" style="left:${Math.max(-2, Math.min(102, postPromoLeft)).toFixed(2)}%;" title="Post-promo price OTD">
         <span class="dia"></span>
         <span class="lbl">promo <span data-bind="post-promo-otd-lbl">${escapeHtml(fmtMoney(initialPostPromoOtd))}</span> <span data-bind="post-promo-pct-lbl" class="pct">@${fmtPct(initialDiscountFraction * 100)}</span></span>
       </div>`
    : ''

  const minLabel = `<div class="axis axis-min">${escapeHtml(fmtMoney(domain.min))}</div>`
  const maxLabel = `<div class="axis axis-max">${escapeHtml(fmtMoney(domain.max))}</div>`

  return `<div class="ladder" data-domain-min="${domain.min}" data-domain-max="${domain.max}">
    <div class="track">
      ${dots}
      ${marketAvg}
      ${marketMed}
      ${liveMarker}
      ${proposedMarker}
      ${postPromoMarker}
      ${minLabel}
      ${maxLabel}
    </div>
  </div>`
}

// ---- main ---------------------------------------------------------

async function main() {
  const data = JSON.parse(await readFile(DATA_PATH, 'utf8'))
  const initialDiscountFraction = (Number(data.currentPromoDiscountPercent) || 20) / 100
  const postTax = Number(data.postTaxMultiplier) || 1.13

  const byBrand = new Map()
  for (const product of data.products) {
    if (!byBrand.has(product.brandName)) byBrand.set(product.brandName, new Map())
    const byGroup = byBrand.get(product.brandName)
    if (!byGroup.has(product.groupId)) byGroup.set(product.groupId, [])
    byGroup.get(product.groupId).push(product)
  }
  const brandNames = [...byBrand.keys()].sort((a, b) => a.localeCompare(b))

  const totalProducts = data.products.length
  const productsWithListings = data.products.filter((p) => (p.market?.listingCount ?? 0) > 0).length
  const productsWithoutCost = data.products.filter((p) => !(Number(p.wholesaleCost) > 0)).length
  const productsWithLocalOverride = data.products.filter((p) => p.bronxLocalPrice != null).length

  const chunks = []
  chunks.push(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>1Off Bronx OTD scratchpad v2 — campaign ${data.campaignId} / action ${data.actionId}</title>
<style>
:root {
  --bg:#f4efe4; --card:#fffaf0; --ink:#1f1b17; --muted:#6d665b;
  --line:#d9ceb7; --rule:#e9dec2;
  --current:#27417e; --proposed:#1f5d42; --post-promo:#5b3aa6;
  --avg:#8b5e11; --median:#a23f6c;
  --warn:#8b5e11; --up:#1f5d42; --down:#8d2f52;
  --approved:#1f5d42; --rejected:#8d2f52; --unreviewed:#7d7569; --mixed:#8b5e11;
}
*{box-sizing:border-box}
body{margin:0;padding:24px;font:14px/1.5 -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--ink)}
.wrap{max-width:1600px;margin:0 auto}
h1{margin:0 0 6px}
.sub{color:var(--muted);margin:0 0 12px;font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin:14px 0;box-shadow:0 4px 16px rgba(31,27,23,0.05)}
.toolbar{position:sticky;top:8px;z-index:50;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 18px;box-shadow:0 6px 14px rgba(31,27,23,0.08);display:flex;flex-wrap:wrap;gap:18px;align-items:center}
.toolbar label{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px}
.toolbar input[type=number]{font:inherit;font-weight:700;font-size:17px;padding:5px 9px;border:1px solid var(--line);border-radius:8px;width:104px;background:#fff;text-align:right;color:var(--post-promo)}
input[type=number]::placeholder{color:#8a7f6c;opacity:1;font-weight:500;font-style:italic}
input[type=number]::-webkit-input-placeholder{color:#8a7f6c;opacity:1;font-weight:500;font-style:italic}
.toolbar .meta{color:var(--muted);font-size:12px;line-height:1.4;max-width:340px;transition:max-width 0.18s ease,opacity 0.18s ease,margin 0.18s ease}
.toolbar.pinned .meta{max-width:0;opacity:0;margin:0;padding:0;overflow:hidden;pointer-events:none}
.toolbar button{font:inherit;padding:6px 12px;border:1px solid var(--line);background:#fff;border-radius:8px;cursor:pointer;font-size:12px}
.toolbar button.primary{background:var(--approved);color:#fff;border-color:var(--approved);font-weight:600}
.toolbar .review-pill{display:inline-flex;gap:4px;align-items:center}
.toolbar .summary{font-size:12px;color:var(--muted);min-width:220px}
.toolbar .summary strong{color:var(--ink)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:10px}
.stat{padding:10px 12px;background:#fff;border:1px solid var(--line);border-radius:10px}
.stat .v{font-size:22px;font-weight:600}
.stat .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px}
.brand-h{margin:24px 0 8px;font-size:20px;display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.brand-h .count{color:var(--muted);font-size:13px;font-weight:400}
.brand-controls{display:flex;gap:14px;align-items:center;font-size:12px;margin-left:auto;flex-wrap:wrap}
.brand-controls label{font-weight:600;display:flex;align-items:center;gap:6px}
.brand-controls input[type=number]{font:inherit;font-weight:700;padding:3px 6px;width:84px;border:1px solid var(--line);border-radius:6px;text-align:right;background:#fff}
.group-h{margin:14px 0 4px;font-size:14px;color:var(--muted);font-weight:600;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.group-h .group-title{color:var(--ink)}
.group-controls{display:flex;gap:10px;align-items:center;font-size:11px;margin-left:auto;flex-wrap:wrap}
.group-controls label{font-weight:600;display:flex;align-items:center;gap:4px}
.group-controls input[type=number]{font:inherit;font-weight:700;padding:2px 5px;width:78px;border:1px solid var(--line);border-radius:6px;text-align:right;background:#fff}
.row{display:grid;grid-template-columns:minmax(240px,1.4fr) minmax(220px,1.2fr) minmax(170px,0.9fr) minmax(440px,3fr);gap:14px;align-items:start;padding:12px 0;border-top:1px dashed var(--rule)}
.row:first-of-type{border-top:none}
.row.review-approved{background:linear-gradient(to right,rgba(31,93,66,0.05),transparent 50%)}
.row.review-rejected{background:linear-gradient(to right,rgba(141,47,82,0.05),transparent 50%)}
.row .name{font-weight:700;font-size:14px}
.row .name-line{display:flex;align-items:center;gap:8px}
.row .image{width:32px;height:32px;border-radius:6px;background:#eee;background-size:cover;background-position:center;flex-shrink:0;border:1px solid var(--line)}
.row .meta{color:var(--muted);font-size:11px;margin-top:2px}
.row .meta code{font-family:'SFMono-Regular',Menlo,monospace;font-size:10px}
.row .market-meta{font-size:11px;color:var(--muted);margin-top:4px}
.row .market-meta .badge{display:inline-block;padding:1px 6px;border-radius:999px;background:#efe3cf;font-weight:600;font-size:10px;color:var(--ink);margin-right:4px}
.row .market-meta .badge.fresh{background:#dfeae2;color:var(--up)}
.row .market-meta .badge.stale{background:#f0e1c2;color:var(--warn)}
.row .market-meta .badge.absent{background:#f3dde4;color:var(--down)}
.row .input-cell{display:flex;flex-direction:column;gap:4px;font-size:12px}
.row input[type=number]{font:inherit;font-weight:700;font-size:14px;padding:4px 7px;border:1px solid var(--line);border-radius:6px;width:120px;background:#fff;text-align:right}
.row .input-cell .l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;margin-top:2px}
.row .scope-toggle{display:flex;gap:6px;font-size:11px;margin-top:2px}
.row .scope-toggle label{display:flex;align-items:center;gap:3px;cursor:pointer;padding:2px 6px;border:1px solid var(--line);border-radius:6px;background:#fff}
.row .scope-toggle input{margin:0;cursor:pointer}
.row .scope-toggle label.local{color:var(--proposed)}
.row .scope-toggle label.global{color:var(--current)}
.row .scope-toggle label:has(input:checked){background:#efe3cf;border-color:var(--ink);font-weight:600}
.row .gm-cell{display:grid;grid-template-columns:auto auto;gap:2px 8px;font-size:12px;align-items:baseline}
.row .gm-cell .lbl{color:var(--muted);font-size:11px}
.row .gm-cell .v{font-weight:700;font-variant-numeric:tabular-nums;text-align:right}
.row .gm-cell .v.current{color:var(--current)}
.row .gm-cell .v.proposed{color:var(--proposed)}
.row .gm-cell .v.post-promo{color:var(--post-promo)}
.row .gm-cell .v.warn{color:var(--down)}
.row.no-cost{opacity:0.65}
.row .row-promo-row{font-size:11px;display:flex;align-items:center;gap:6px;margin-top:6px;color:var(--muted)}
.row .row-promo-row input[type=number]{font:inherit;font-weight:700;width:84px;padding:2px 5px;font-size:11px}
.row .effective-promo{font-weight:600;color:var(--post-promo)}
.review-pill{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--line);border-radius:999px;padding:1px 6px;font-size:11px;background:#fff}
.review-pill button{appearance:none;background:transparent;border:none;cursor:pointer;font:inherit;padding:1px 5px;border-radius:999px;color:var(--muted);font-weight:600}
.review-pill button.active.approved{background:var(--approved);color:#fff}
.review-pill button.active.rejected{background:var(--rejected);color:#fff}
.review-pill button.active.unreviewed{background:var(--unreviewed);color:#fff}
.review-pill .rollup{font-size:10px;color:var(--muted);padding-right:4px}
.review-pill .rollup.approved{color:var(--approved)}
.review-pill .rollup.rejected{color:var(--rejected)}
.review-pill .rollup.mixed{color:var(--mixed)}

.ladder{position:relative;height:120px;margin:4px 0 14px}
.track{position:relative;height:96px;background:repeating-linear-gradient(to right,rgba(0,0,0,0.03) 0,rgba(0,0,0,0.03) 1px,transparent 1px,transparent 25%);border-bottom:2px solid var(--ink);border-radius:6px;overflow:visible}
.track .dot{position:absolute;width:9px;height:9px;border-radius:50%;margin-left:-4.5px;margin-top:-4.5px;opacity:0.92;border:1px solid;box-shadow:0 1px 1px rgba(0,0,0,0.1);cursor:default;z-index:1}
.track .dot.display-only{opacity:0.45;width:7px;height:7px;margin-left:-3.5px;margin-top:-3.5px}
.track .dot.off-axis{opacity:0.35}
.track .dot[data-url]{cursor:pointer}
.axis{position:absolute;bottom:-18px;font-size:10px;color:var(--muted);font-variant-numeric:tabular-nums}
.axis-min{left:0}
.axis-max{right:0}
.marker{position:absolute;top:0;height:96px;width:0;z-index:4;pointer-events:none;display:flex;flex-direction:column;align-items:center}
.marker .tick{position:absolute;top:0;width:1px;height:90px;background:currentColor;opacity:0.55}
.marker .lbl{position:absolute;bottom:-15px;left:0;transform:translateX(-50%);font-size:9px;font-weight:700;color:currentColor;white-space:nowrap;background:rgba(255,250,240,0.92);padding:1px 4px;border-radius:3px;border:1px solid rgba(0,0,0,0.05);font-variant-numeric:tabular-nums}
.marker.market-avg{color:var(--avg)}
.marker.market-median{color:var(--median)}
.ours{position:absolute;top:-4px;height:96px;width:0;z-index:8;pointer-events:none;display:flex;flex-direction:column;align-items:center}
.ours .dia{width:14px;height:14px;background:currentColor;transform:rotate(45deg);border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.25);border-radius:2px;margin-top:0}
.ours .lbl{position:absolute;top:-16px;left:0;transform:translateX(-50%);font-size:10px;font-weight:700;color:currentColor;background:#fff;padding:1px 5px;border-radius:4px;border:1px solid currentColor;white-space:nowrap;font-variant-numeric:tabular-nums}
.ours.current{color:var(--current);top:32px}
.ours.current .lbl{top:-18px}
.ours.proposed{color:var(--proposed);top:8px}
.ours.proposed .lbl{top:-18px}
.ours.post-promo{color:var(--post-promo);top:60px}
.ours.post-promo .lbl{top:auto;bottom:-32px;font-size:11px;font-weight:800;background:#fff;border:1.5px solid var(--post-promo)}
.ours.post-promo .pct{color:var(--post-promo);opacity:0.7;font-weight:600;margin-left:2px}
.ours.post-promo .dia{width:18px;height:18px;border-width:2.5px}
.ours .lbl-override{font-style:italic;opacity:0.95}
.ours.off-axis{opacity:0.55}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:11px;color:var(--muted);margin:6px 0 0;align-items:center}
.legend .dot-s{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:4px;vertical-align:middle}
.legend .dia-s{display:inline-block;width:10px;height:10px;margin-right:4px;vertical-align:middle;transform:rotate(45deg);background:currentColor}
.legend strong{color:var(--ink)}
.warn-banner{background:#fffaee;border:1px solid #f0e1c2;border-radius:10px;padding:10px 14px;color:#5d4214;margin:10px 0;font-weight:600;font-size:13px}
.export-panel{margin-top:24px;padding:16px;background:#fff;border:1px dashed var(--line);border-radius:12px;font-size:13px}
.export-panel pre{background:#1f1b17;color:#fffaf0;padding:10px;border-radius:8px;font-size:11px;overflow:auto;max-height:280px;font-family:'SFMono-Regular',Menlo,monospace}
.export-panel button{font-weight:600;padding:8px 14px}
</style>
</head>
<body>
<div class="wrap">
  <h1>1Off Bronx OTD scratchpad <span style="font-size:14px;color:var(--muted);font-weight:400">v2 — promo-aware, scope-aware, review-aware</span></h1>
  <p class="sub">
    Bronx site dealer ${data.bronxDealerId} ·
    campaign <strong>${escapeHtml(data.campaignName)}</strong> (id ${data.campaignId}) ·
    action <strong>${escapeHtml(data.actionName)}</strong> (id ${data.actionId}, currently <strong>${fmtPct(data.currentPromoDiscountPercent)}</strong>) ·
    9 brands · ${totalProducts} products ·
    generated ${escapeHtml(data.generatedAt)}
    · UX design input recorded at <code>docs/helios/pricing-page-promo-aware-scratchpad/</code>
  </p>

  <div id="toolbarSentinel" aria-hidden="true" style="height:1px;margin:0;padding:0"></div>
  <div class="toolbar" id="mainToolbar">
    <label>
      Page discount %:
      <input id="globalDiscount" type="number" min="0" max="80" step="0.5" value="${data.currentPromoDiscountPercent}">
    </label>
    <div class="review-pill">
      <span class="rollup" id="pageRollupRollup">…</span>
      <button type="button" data-page-review="approved">approve all</button>
      <button type="button" data-page-review="rejected">reject all</button>
      <button type="button" data-page-review="unreviewed">clear</button>
    </div>
    <button id="resetDiscount" type="button">reset promo → ${fmtPct(data.currentPromoDiscountPercent)}</button>
    <button id="resetAllLocal" type="button">reset every proposed → chain price</button>
    <button id="exportPlan" type="button" class="primary">export apply plan</button>
    <div class="summary" id="approvalSummary">no rows reviewed yet</div>
    <div class="meta">
      Promo % cascades <strong>row → group → page</strong>. Approval is per row + rolled up per group/brand/page.
      Apply engine writes <strong>price</strong> edits only; promo-percent moves are operator-managed out-of-band.
    </div>
  </div>

  <div class="card" style="margin-top:14px">
    <strong>Reading the price ladder.</strong>
    <div class="legend" style="margin-top:6px">
      <span><span class="dot-s" style="background:#1d7a4f"></span>≤2 mi (very-near)</span>
      <span><span class="dot-s" style="background:#3aa269"></span>2–5 mi (near)</span>
      <span><span class="dot-s" style="background:#caa53a"></span>5–15 mi (mid)</span>
      <span><span class="dot-s" style="background:#c87132"></span>15–50 mi (far)</span>
      <span><span class="dot-s" style="background:#7d7569;opacity:0.5"></span>statewide / display-only</span>
      <span style="color:var(--current)"><span class="dia-s"></span><strong>current price</strong></span>
      <span style="color:var(--proposed)"><span class="dia-s"></span><strong>proposed price</strong></span>
      <span style="color:var(--post-promo)"><span class="dia-s"></span><strong>post-promo price</strong></span>
      <span><span style="display:inline-block;width:1px;height:10px;background:var(--avg);vertical-align:middle;margin-right:4px"></span>market avg</span>
      <span><span style="display:inline-block;width:1px;height:10px;background:var(--median);vertical-align:middle;margin-right:4px"></span>market median</span>
      <span style="color:var(--muted);font-size:10px">Dots position vertically by distance band — color saturation + height micro-adjust by within-band proximity. Click a dot to open its source listing. Once <a href="https://github.com/virusdave/top-level/issues/4" target="_blank" rel="noopener">litalerts matching #4</a> ships, exact-SKU dots become triangles and family dots stay as circles.</span>
    </div>
  </div>

  <div class="stats">
    <div class="stat"><div class="l">Products in scope</div><div class="v">${totalProducts}</div></div>
    <div class="stat"><div class="l">With competitor listings</div><div class="v">${productsWithListings}</div></div>
    <div class="stat"><div class="l">No wholesale cost</div><div class="v">${productsWithoutCost}</div></div>
    <div class="stat"><div class="l">Bronx currently overrides</div><div class="v">${productsWithLocalOverride}</div></div>
    <div class="stat"><div class="l">Post-tax multiplier</div><div class="v">${postTax.toFixed(2)}×</div></div>
    <div class="stat"><div class="l">Action selector productCount</div><div class="v">${totalProducts}</div></div>
  </div>

  ${productsWithoutCost > 0 ? `<div class="warn-banner">${productsWithoutCost} of the ${totalProducts} products have no wholesale cost at state dealer ${data.stateDealerId}. GM% columns read "—" for those.</div>` : ''}
`)

  for (const brandName of brandNames) {
    const groupMap = byBrand.get(brandName)
    const allProducts = [...groupMap.values()].flat()
    chunks.push(`<h2 class="brand-h" data-brand="${escapeHtml(brandName)}">
      <span>${escapeHtml(brandName)}</span>
      <span class="count">${allProducts.length} product${allProducts.length === 1 ? '' : 's'} · ${[...groupMap.keys()].length} groups</span>
      <div class="brand-controls">
        <label>Brand promo % override:
          <input type="number" min="0" max="80" step="0.5" placeholder="(use page)" data-brand-promo="${escapeHtml(brandName)}">
        </label>
        <div class="review-pill" data-brand-review-pill="${escapeHtml(brandName)}">
          <span class="rollup" data-brand-rollup="${escapeHtml(brandName)}">…</span>
          <button type="button" data-brand-review="${escapeHtml(brandName)}" data-state="approved">✓</button>
          <button type="button" data-brand-review="${escapeHtml(brandName)}" data-state="rejected">✗</button>
          <button type="button" data-brand-review="${escapeHtml(brandName)}" data-state="unreviewed">·</button>
        </div>
      </div>
    </h2><div class="card">`)
    const sortedGroupKeys = [...groupMap.keys()].sort((a, b) => {
      const an = (groupMap.get(a)[0]?.groupName ?? '').toLowerCase()
      const bn = (groupMap.get(b)[0]?.groupName ?? '').toLowerCase()
      return an.localeCompare(bn)
    })
    for (const gid of sortedGroupKeys) {
      const products = groupMap.get(gid)
      const groupName = products[0]?.groupName
      const category = products[0]?.categoryName
      const sub = products[0]?.subcategoryName
      chunks.push(`<div class="group-h" data-group="${gid}">
        <span class="group-title">${escapeHtml(groupName)}</span>
        <span>· ${escapeHtml(category)}${sub ? ` / ${escapeHtml(sub)}` : ''} · group ${gid}</span>
        <div class="group-controls">
          <label>Group promo % override:
            <input type="number" min="0" max="80" step="0.5" placeholder="(inherit)" data-group-promo="${gid}">
          </label>
          <div class="review-pill" data-group-review-pill="${gid}">
            <span class="rollup" data-group-rollup="${gid}">…</span>
            <button type="button" data-group-review="${gid}" data-state="approved">✓</button>
            <button type="button" data-group-review="${gid}" data-state="rejected">✗</button>
            <button type="button" data-group-review="${gid}" data-state="unreviewed">·</button>
          </div>
        </div>
      </div>`)
      for (const product of products.sort((a, b) => (a.tab ?? '').localeCompare(b.tab ?? ''))) {
        const domain = deriveDomainForProduct(product, postTax, initialDiscountFraction)
        const cost = Number(product.wholesaleCost) || 0
        const globalPrice = Number(product.globalPrice) || 0
        const initialLocal = Number(product.bronxLocalPrice ?? product.globalPrice)
        const hasOverrideNow = product.bronxLocalPrice != null
        const ladderHtml = renderLadder(product, domain, initialDiscountFraction, postTax)
        const status = product.market?.status ?? '—'
        const statusBadgeClass = status === 'matched' ? 'fresh' :
          status === 'display_only' ? 'stale' :
          ['absent','disabled','no_brand','unresolved_brand','no_data','no_catalog_group','no_family_matches','no_safe_matches','error'].includes(status) ? 'absent' : ''
        const listingMeta = `${product.market?.pricingEligibleListingCount ?? 0} eligible · ${product.market?.listingCount ?? 0} total`

        chunks.push(`<div class="row${cost > 0 ? '' : ' no-cost'} review-unreviewed"
            data-product-id="${product.productId}"
            data-group-id="${product.groupId}"
            data-brand="${escapeHtml(product.brandName ?? '')}"
            data-cost="${cost}"
            data-global-price="${globalPrice}"
            data-current-local-price="${product.bronxLocalPrice ?? ''}"
            data-post-tax="${postTax}">
  <div>
    <div class="name-line">
      ${product.imageUrl ? `<div class="image" style="background-image:url('${escapeHtml(product.imageUrl)}')"></div>` : `<div class="image"></div>`}
      <div>
        <div class="name">${escapeHtml(product.name ?? '')}</div>
        <div class="meta">prod ${product.productId} · tab ${escapeHtml(product.tab ?? '—')} · cost ${escapeHtml(fmtMoney(product.wholesaleCost))}</div>
      </div>
    </div>
    <div class="market-meta"><span class="badge ${statusBadgeClass}">${escapeHtml(status)}</span>${listingMeta}${product.market?.searchTerm ? ` · <code>${escapeHtml(product.market.searchTerm.slice(0, 80))}${product.market.searchTerm.length > 80 ? '…' : ''}</code>` : ''}</div>
    <div class="review-pill" data-row-review-pill="${product.productId}" style="margin-top:6px">
      <button type="button" data-row-review="${product.productId}" data-state="approved">✓ approve</button>
      <button type="button" data-row-review="${product.productId}" data-state="rejected">✗ reject</button>
      <button type="button" data-row-review="${product.productId}" data-state="unreviewed">· unreviewed</button>
    </div>
  </div>
  <div class="input-cell">
    <div class="l">Chain (global) — pre-tax</div>
    <div style="display:flex;align-items:center;gap:6px">
      <input type="number" min="0" step="0.25" value="${globalPrice.toFixed(2)}"
        data-input="chain-price">
      <span style="font-weight:400;color:var(--muted);font-size:11px">→ OTD <span data-bind="chain-otd-display">${escapeHtml(fmtMoney(globalPrice * postTax))}</span></span>
    </div>
    <div class="l">Proposed Bronx local — pre-tax</div>
    <div style="display:flex;align-items:center;gap:6px">
      <input type="number" min="0" step="0.25" value="${initialLocal.toFixed(2)}"
        data-input="local-price">
      <span style="font-weight:400;color:var(--muted);font-size:11px">→ OTD <span data-bind="local-otd-display">${escapeHtml(fmtMoney(initialLocal * postTax))}</span></span>
    </div>
    <div class="scope-toggle">
      <label class="local"><input type="radio" name="scope-${product.productId}" value="local" ${hasOverrideNow ? 'checked' : 'checked'}>apply as local override</label>
      <label class="global"><input type="radio" name="scope-${product.productId}" value="global">apply as global chain price</label>
    </div>
    ${hasOverrideNow
      ? `<div class="meta" style="color:var(--warn);margin-top:2px">currently overridden at Bronx: ${escapeHtml(fmtMoney(product.bronxLocalPrice))}</div>`
      : `<div class="meta" style="margin-top:2px">no current Bronx override (uses chain)</div>`}
    <div class="row-promo-row">
      promo % for this row:
      <input type="number" min="0" max="80" step="0.5" placeholder="(inherit)" data-input="row-promo">
      <span>effective: <span class="effective-promo" data-bind="effective-promo-lbl">${fmtPct(data.currentPromoDiscountPercent)}</span></span>
    </div>
  </div>
  <div class="gm-cell">
    <span class="lbl">Current OTD:</span><span class="v current" data-bind="current-otd-cell">${escapeHtml(fmtMoney(Number(product.bronxActualPrice ?? globalPrice) * postTax))}</span>
    <span class="lbl">GM% current:</span><span class="v current" data-bind="current-gm">${escapeHtml(fmtPct(cost > 0 ? (1 - (postTax * cost) / Number(product.bronxActualPrice ?? globalPrice)) * 100 : null))}</span>
    <span class="lbl">Proposed OTD:</span><span class="v proposed" data-bind="proposed-otd-cell">${escapeHtml(fmtMoney(initialLocal * postTax))}</span>
    <span class="lbl">GM% proposed:</span><span class="v proposed" data-bind="proposed-gm">${escapeHtml(fmtPct(cost > 0 ? (1 - (postTax * cost) / initialLocal) * 100 : null))}</span>
    <span class="lbl">Post-promo OTD:</span><span class="v post-promo" data-bind="post-promo-otd-cell">${escapeHtml(fmtMoney(initialLocal * (1 - initialDiscountFraction) * postTax))}</span>
    <span class="lbl">GM% post-promo:</span><span class="v post-promo" data-bind="post-promo-gm">${escapeHtml(fmtPct(cost > 0 ? (1 - (postTax * cost) / (initialLocal * (1 - initialDiscountFraction))) * 100 : null))}</span>
  </div>
  ${ladderHtml}
</div>`)
      }
    }
    chunks.push(`</div>`)
  }

  // Export-plan panel.
  chunks.push(`
<div class="export-panel">
  <strong>Apply plan</strong> — emits only edits for <em>approved</em> rows. Promo % moves are documented but not written.
  <div style="margin:8px 0"><button id="rebuildPlan" type="button">build plan from current state</button> · <button id="copyPlanJson" type="button">copy JSON</button></div>
  <pre id="planJson">(approve some rows to see the plan)</pre>
  <p style="font-size:11px;color:var(--muted);margin:6px 0 0">
    Then run: <code>python3 catalog/repricing/2026-05-18-1off-bronx-otd/apply_plan.py plan.json</code> (dry-run by default; pass <code>--apply</code> to write).
  </p>
</div>
`)

  // Footer notes.
  chunks.push(`<div class="card" style="margin-top:20px">
    <strong>Computation reference.</strong>
    <ul style="margin:6px 0 0 18px;padding:0;font-size:13px;line-height:1.5">
      <li>Chain (global) price is read live from state dealer ${data.stateDealerId}.</li>
      <li>Proposed values are local-only scratch; nothing is written.</li>
      <li>OTD = pre-tax price × ${postTax.toFixed(2)} (NY combined sales tax).</li>
      <li>Effective promo % for a row = row override > group override > brand override > page default.</li>
      <li>GM% = 1 − (${postTax.toFixed(2)} × cost) / price — matches <code>reprice.py</code>'s convention.</li>
      <li>Approve rolls UP: a brand's pill shows <em>approved</em> only when every product under it is approved; <em>mixed</em> when some rows disagree.</li>
      <li>Apply engine differentiates global vs local edits per row using the radio. Local-override creation, update, and reset are all distinct calls.</li>
    </ul>
  </div>
</div>

<script>
${buildClientScript({ data, postTax, initialDiscountFraction })}
</script>
</body>
</html>
`)
  await writeFile(OUT_PATH, chunks.join(''))
  console.log(`Wrote ${OUT_PATH}`)
}

function buildClientScript({ data, postTax, initialDiscountFraction }) {
  // Inline client-side state machine: per-row state, group rollup,
  // brand rollup, page rollup. Plus the plan exporter.
  // We embed the canonical promoPct default + per-product current
  // (chain + local) snapshot for diff computation in the plan.
  const snapshot = data.products.map((p) => ({
    productId: p.productId,
    groupId: p.groupId,
    brandName: p.brandName,
    name: p.name,
    cost: Number(p.wholesaleCost) || 0,
    currentChainPrice: Number(p.globalPrice) || 0,
    currentLocalPrice: p.bronxLocalPrice != null ? Number(p.bronxLocalPrice) : null,
  }))
  return `
(function () {
  const POST_TAX = ${postTax};
  const INITIAL_PAGE_PROMO = ${data.currentPromoDiscountPercent};
  const SNAPSHOT = ${JSON.stringify(snapshot)};
  const BRONX_DEALER_ID = ${data.bronxDealerId};
  const STATE_DEALER_ID = ${data.stateDealerId};

  const fmtMoney = (v) => (v == null || !isFinite(v)) ? '—' : '$' + Number(v).toFixed(2);
  const fmtPct = (v) => (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(1) + '%';

  const snapById = new Map(SNAPSHOT.map((s) => [String(s.productId), s]));

  const globalDiscountInput = document.getElementById('globalDiscount');
  const planPre = document.getElementById('planJson');
  const summaryEl = document.getElementById('approvalSummary');

  function pageDiscountFraction() {
    const v = Number(globalDiscountInput.value);
    if (!isFinite(v) || v < 0) return 0;
    return Math.min(99, v) / 100;
  }

  function readOverride(input) {
    if (!input) return null;
    const v = input.value.trim();
    if (v === '') return null;
    const n = Number(v);
    if (!isFinite(n) || n < 0) return null;
    return Math.min(99, n) / 100;
  }

  function effectivePromoForRow(rowEl) {
    const rowInput = rowEl.querySelector('input[data-input="row-promo"]');
    const rowOverride = readOverride(rowInput);
    if (rowOverride != null) return { fraction: rowOverride, source: 'row' };
    const groupId = rowEl.dataset.groupId;
    const groupInput = document.querySelector('input[data-group-promo="' + groupId + '"]');
    const groupOverride = readOverride(groupInput);
    if (groupOverride != null) return { fraction: groupOverride, source: 'group' };
    const brand = rowEl.dataset.brand;
    const brandInput = document.querySelector('input[data-brand-promo="' + CSS.escape(brand) + '"]');
    const brandOverride = readOverride(brandInput);
    if (brandOverride != null) return { fraction: brandOverride, source: 'brand' };
    return { fraction: pageDiscountFraction(), source: 'page' };
  }

  function effectivePromoForGroup(groupId) {
    const anyRow = document.querySelector('.row[data-group-id="' + groupId + '"]');
    if (!anyRow) return null;
    const groupInput = document.querySelector('input[data-group-promo="' + groupId + '"]');
    const groupOverride = readOverride(groupInput);
    if (groupOverride != null) return { fraction: groupOverride, source: 'group' };
    const brand = anyRow.dataset.brand;
    const brandInput = document.querySelector('input[data-brand-promo="' + CSS.escape(brand) + '"]');
    const brandOverride = readOverride(brandInput);
    if (brandOverride != null) return { fraction: brandOverride, source: 'brand' };
    return { fraction: pageDiscountFraction(), source: 'page' };
  }

  function placeMarker(rowEl, selector, otdValue, labelKey) {
    const marker = rowEl.querySelector(selector);
    if (!marker) return;
    const ladder = rowEl.querySelector('.ladder');
    if (!ladder) return;
    const min = Number(ladder.dataset.domainMin);
    const max = Number(ladder.dataset.domainMax);
    const span = max - min;
    if (!(span > 0)) return;
    const raw = ((otdValue - min) / span) * 100;
    const clamped = Math.max(-2, Math.min(102, raw));
    marker.style.left = clamped.toFixed(2) + '%';
    marker.classList.toggle('off-axis', raw !== clamped);
    if (labelKey) {
      const lbl = marker.querySelector('[data-bind="' + labelKey + '"]');
      if (lbl) lbl.textContent = fmtMoney(otdValue);
    }
  }

  function updateRow(rowEl) {
    const cost = Number(rowEl.dataset.cost) || 0;
    const chainInput = rowEl.querySelector('input[data-input="chain-price"]');
    const localInput = rowEl.querySelector('input[data-input="local-price"]');
    const proposedChain = Number(chainInput.value) || 0;
    const proposedLocal = Number(localInput.value) || 0;
    // Effective proposed = local (this scratchpad always uses local
    // for the diamond, since Bronx is the site we're tuning). The
    // scope radio decides where the apply engine writes.
    const proposedPrice = proposedLocal;
    const { fraction: promoFraction, source: promoSource } = effectivePromoForRow(rowEl);
    const postPromoPrice = proposedPrice * (1 - promoFraction);
    const currentPrice = Number(rowEl.dataset.currentLocalPrice) || Number(rowEl.dataset.globalPrice);

    const set = (sel, txt, warn) => {
      const el = rowEl.querySelector('[data-bind="' + sel + '"]');
      if (!el) return;
      el.textContent = txt;
      if (warn !== undefined) el.classList.toggle('warn', !!warn);
    };
    set('chain-otd-display', fmtMoney(proposedChain * POST_TAX));
    set('local-otd-display', fmtMoney(proposedLocal * POST_TAX));
    set('current-otd-cell', fmtMoney(currentPrice * POST_TAX));
    set('current-gm', fmtPct(cost > 0 && currentPrice > 0 ? (1 - (POST_TAX * cost) / currentPrice) * 100 : null));
    set('proposed-otd-cell', fmtMoney(proposedPrice * POST_TAX));
    const proposedGm = cost > 0 && proposedPrice > 0 ? (1 - (POST_TAX * cost) / proposedPrice) * 100 : null;
    set('proposed-gm', fmtPct(proposedGm), proposedGm != null && proposedGm < 0);
    set('post-promo-otd-cell', fmtMoney(postPromoPrice * POST_TAX));
    const postPromoGm = cost > 0 && postPromoPrice > 0 ? (1 - (POST_TAX * cost) / postPromoPrice) * 100 : null;
    set('post-promo-gm', fmtPct(postPromoGm), postPromoGm != null && postPromoGm < 0);
    set('effective-promo-lbl', fmtPct(promoFraction * 100) + ' (' + promoSource + ')');

    // Reposition the 3 diamonds on the ladder.
    placeMarker(rowEl, '.ours[data-marker="current"]', currentPrice * POST_TAX, 'current-otd');
    placeMarker(rowEl, '.ours[data-marker="proposed"]', proposedPrice * POST_TAX, 'proposed-otd-lbl');
    placeMarker(rowEl, '.ours[data-marker="post-promo"]', postPromoPrice * POST_TAX, 'post-promo-otd-lbl');
    // Promo pct label on the diamond.
    const pctLbl = rowEl.querySelector('[data-bind="post-promo-pct-lbl"]');
    if (pctLbl) {
      pctLbl.textContent = '@' + fmtPct(promoFraction * 100) + (promoSource !== 'page' ? ' (' + promoSource + ')' : '');
    }
  }

  function refreshAllRows() {
    document.querySelectorAll('.row[data-product-id]').forEach(updateRow);
    refreshRollups();
    rebuildPlan();
  }

  // -------- review state --------
  function getRowState(rowEl) {
    if (rowEl.classList.contains('review-approved')) return 'approved';
    if (rowEl.classList.contains('review-rejected')) return 'rejected';
    return 'unreviewed';
  }
  function setRowState(rowEl, state) {
    rowEl.classList.remove('review-approved','review-rejected','review-unreviewed');
    rowEl.classList.add('review-' + state);
    const pill = rowEl.querySelector('[data-row-review-pill="' + rowEl.dataset.productId + '"]');
    if (pill) {
      pill.querySelectorAll('button').forEach((b) => {
        const wanted = b.dataset.state === state;
        b.classList.toggle('active', wanted);
        b.classList.toggle('approved', wanted && state === 'approved');
        b.classList.toggle('rejected', wanted && state === 'rejected');
        b.classList.toggle('unreviewed', wanted && state === 'unreviewed');
      });
    }
  }
  function rollupOfStates(states) {
    if (states.length === 0) return 'unreviewed';
    const unique = new Set(states);
    if (unique.size === 1) return [...unique][0];
    return 'mixed';
  }
  function refreshRollups() {
    // Group rollups
    const groups = new Map();
    document.querySelectorAll('.row[data-product-id]').forEach((row) => {
      const gid = row.dataset.groupId;
      if (!groups.has(gid)) groups.set(gid, []);
      groups.get(gid).push(getRowState(row));
    });
    for (const [gid, states] of groups) {
      const rollup = rollupOfStates(states);
      const el = document.querySelector('[data-group-rollup="' + gid + '"]');
      if (el) {
        el.textContent = rollup === 'unreviewed' ? '· unreviewed' :
                         rollup === 'approved' ? '✓ all approved' :
                         rollup === 'rejected' ? '✗ all rejected' :
                                                 '~ mixed';
        el.classList.remove('approved','rejected','mixed');
        if (rollup === 'approved') el.classList.add('approved');
        if (rollup === 'rejected') el.classList.add('rejected');
        if (rollup === 'mixed') el.classList.add('mixed');
      }
    }
    // Brand rollups
    const brands = new Map();
    document.querySelectorAll('.row[data-product-id]').forEach((row) => {
      const b = row.dataset.brand;
      if (!brands.has(b)) brands.set(b, []);
      brands.get(b).push(getRowState(row));
    });
    for (const [b, states] of brands) {
      const rollup = rollupOfStates(states);
      const el = document.querySelector('[data-brand-rollup="' + CSS.escape(b) + '"]');
      if (el) {
        el.textContent = rollup === 'unreviewed' ? '· unreviewed' :
                         rollup === 'approved' ? '✓ all approved' :
                         rollup === 'rejected' ? '✗ all rejected' :
                                                 '~ mixed';
        el.classList.remove('approved','rejected','mixed');
        if (rollup === 'approved') el.classList.add('approved');
        if (rollup === 'rejected') el.classList.add('rejected');
        if (rollup === 'mixed') el.classList.add('mixed');
      }
    }
    // Page rollup
    const all = [...document.querySelectorAll('.row[data-product-id]')].map(getRowState);
    const pageRollup = rollupOfStates(all);
    const pageEl = document.getElementById('pageRollupRollup');
    if (pageEl) {
      pageEl.textContent = pageRollup === 'unreviewed' ? '· unreviewed' :
                           pageRollup === 'approved' ? '✓ all approved' :
                           pageRollup === 'rejected' ? '✗ all rejected' :
                                                       '~ mixed';
      pageEl.classList.remove('approved','rejected','mixed');
      if (pageRollup === 'approved') pageEl.classList.add('approved');
      if (pageRollup === 'rejected') pageEl.classList.add('rejected');
      if (pageRollup === 'mixed') pageEl.classList.add('mixed');
    }
    const approvedN = all.filter((s) => s === 'approved').length;
    const rejectedN = all.filter((s) => s === 'rejected').length;
    const unreviewedN = all.filter((s) => s === 'unreviewed').length;
    summaryEl.innerHTML = '<strong>' + approvedN + '</strong> approved · <strong>' + rejectedN + '</strong> rejected · <strong>' + unreviewedN + '</strong> unreviewed';
  }

  // -------- plan exporter --------
  function buildPlan() {
    const approvedRows = [...document.querySelectorAll('.row.review-approved[data-product-id]')];
    const pricingEdits = [];
    const promoNotes = [];
    for (const row of approvedRows) {
      const pid = row.dataset.productId;
      const snap = snapById.get(pid);
      if (!snap) continue;
      const chainInput = row.querySelector('input[data-input="chain-price"]');
      const localInput = row.querySelector('input[data-input="local-price"]');
      const proposedChain = Number(chainInput.value) || 0;
      const proposedLocal = Number(localInput.value) || 0;
      const scope = row.querySelector('input[name="scope-' + pid + '"]:checked')?.value || 'local';
      const { fraction: effFraction, source: effSource } = effectivePromoForRow(row);
      if (effSource !== 'page') {
        promoNotes.push({
          productId: Number(pid),
          name: snap.name,
          source: effSource,
          effectivePromoPercent: Math.round(effFraction * 1000) / 10,
        });
      }
      if (scope === 'global') {
        if (Math.abs(proposedChain - snap.currentChainPrice) > 0.005) {
          pricingEdits.push({
            kind: 'global-price-edit',
            dealerId: STATE_DEALER_ID,
            productId: Number(pid),
            name: snap.name,
            currentPrice: snap.currentChainPrice,
            newPrice: proposedChain,
          });
        }
        // If a local override exists and we're moving global, the
        // operator probably wants the override gone — flag it.
        if (snap.currentLocalPrice != null) {
          pricingEdits.push({
            kind: 'local-price-reset',
            dealerId: BRONX_DEALER_ID,
            productId: Number(pid),
            name: snap.name,
            currentLocalPrice: snap.currentLocalPrice,
            reason: 'scope=global; existing local override would mask the new chain price at Bronx',
          });
        }
      } else {
        // scope === 'local'
        const wantLocal = proposedLocal;
        const wantLocalEqualsChain = Math.abs(wantLocal - snap.currentChainPrice) < 0.005;
        if (wantLocalEqualsChain) {
          if (snap.currentLocalPrice != null) {
            pricingEdits.push({
              kind: 'local-price-reset',
              dealerId: BRONX_DEALER_ID,
              productId: Number(pid),
              name: snap.name,
              currentLocalPrice: snap.currentLocalPrice,
              reason: 'proposed local equals chain; remove override so Bronx tracks chain',
            });
          }
        } else if (snap.currentLocalPrice == null) {
          pricingEdits.push({
            kind: 'local-price-create',
            dealerId: BRONX_DEALER_ID,
            productId: Number(pid),
            name: snap.name,
            newPrice: wantLocal,
            chainPrice: snap.currentChainPrice,
          });
        } else if (Math.abs(wantLocal - snap.currentLocalPrice) > 0.005) {
          pricingEdits.push({
            kind: 'local-price-update',
            dealerId: BRONX_DEALER_ID,
            productId: Number(pid),
            name: snap.name,
            currentLocalPrice: snap.currentLocalPrice,
            newPrice: wantLocal,
          });
        }
      }
    }
    return {
      generatedAt: new Date().toISOString(),
      source: 'catalog/repricing/2026-05-18-1off-bronx-otd/page.html (v2 scratchpad)',
      campaignId: '${data.campaignId}',
      actionId: '${data.actionId}',
      pageDiscountPercent: Number(globalDiscountInput.value) || 0,
      approvedRowCount: approvedRows.length,
      pricingEdits,
      promoNotes,
    };
  }

  function rebuildPlan() {
    const plan = buildPlan();
    planPre.textContent = JSON.stringify(plan, null, 2);
  }

  // -------- event handlers --------
  document.addEventListener('input', (e) => {
    if (e.target === globalDiscountInput) {
      refreshAllRows();
      return;
    }
    if (e.target.matches('input[data-input]')) {
      const row = e.target.closest('.row[data-product-id]');
      if (row) {
        updateRow(row);
        rebuildPlan();
      }
      return;
    }
    if (e.target.matches('input[data-group-promo],input[data-brand-promo]')) {
      refreshAllRows();
      return;
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.matches('input[type=radio][name^="scope-"]')) {
      rebuildPlan();
    }
  });

  document.addEventListener('click', (e) => {
    // Row review.
    const rowBtn = e.target.closest('[data-row-review]');
    if (rowBtn) {
      const pid = rowBtn.dataset.rowReview;
      const row = document.querySelector('.row[data-product-id="' + pid + '"]');
      if (row) {
        setRowState(row, rowBtn.dataset.state);
        refreshRollups();
        rebuildPlan();
      }
      return;
    }
    // Group review.
    const grpBtn = e.target.closest('[data-group-review]');
    if (grpBtn) {
      const gid = grpBtn.dataset.groupReview;
      const state = grpBtn.dataset.state;
      document.querySelectorAll('.row[data-group-id="' + gid + '"]').forEach((row) => setRowState(row, state));
      refreshRollups();
      rebuildPlan();
      return;
    }
    // Brand review.
    const brandBtn = e.target.closest('[data-brand-review]');
    if (brandBtn) {
      const brand = brandBtn.dataset.brandReview;
      const state = brandBtn.dataset.state;
      document.querySelectorAll('.row[data-brand="' + CSS.escape(brand) + '"]').forEach((row) => setRowState(row, state));
      refreshRollups();
      rebuildPlan();
      return;
    }
    // Page review.
    const pageBtn = e.target.closest('[data-page-review]');
    if (pageBtn) {
      const state = pageBtn.dataset.pageReview;
      document.querySelectorAll('.row[data-product-id]').forEach((row) => setRowState(row, state));
      refreshRollups();
      rebuildPlan();
      return;
    }
    // Diamond click → open url.
    const d = e.target.closest('.dot[data-url]');
    if (d) {
      window.open(d.dataset.url, '_blank', 'noopener');
      return;
    }
  });

  document.getElementById('resetDiscount').addEventListener('click', () => {
    globalDiscountInput.value = String(INITIAL_PAGE_PROMO);
    refreshAllRows();
  });
  document.getElementById('resetAllLocal').addEventListener('click', () => {
    document.querySelectorAll('.row[data-product-id]').forEach((row) => {
      const localInput = row.querySelector('input[data-input="local-price"]');
      if (!localInput) return;
      const globalPrice = Number(row.dataset.globalPrice) || 0;
      localInput.value = globalPrice.toFixed(2);
    });
    refreshAllRows();
  });
  document.getElementById('exportPlan').addEventListener('click', () => {
    const plan = buildPlan();
    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '1off-bronx-otd-plan.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  document.getElementById('rebuildPlan').addEventListener('click', rebuildPlan);
  document.getElementById('copyPlanJson').addEventListener('click', async () => {
    await navigator.clipboard.writeText(planPre.textContent || '');
  });

  // initialize: mark every row unreviewed and refresh.
  document.querySelectorAll('.row[data-product-id]').forEach((row) => setRowState(row, 'unreviewed'));
  refreshAllRows();

  // Collapse the toolbar's info-only "how this works" copy as soon as
  // the toolbar starts floating (sentinel scrolls past the sticky top
  // offset). The hint is useful at most once; once the reviewer is
  // working, we reclaim the visual space.
  const toolbar = document.getElementById('mainToolbar');
  const sentinel = document.getElementById('toolbarSentinel');
  if (toolbar && sentinel && 'IntersectionObserver' in window) {
    const stickyTop = 8; // matches .toolbar { top: 8px }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        toolbar.classList.toggle('pinned', !entry.isIntersecting);
      }
    }, { rootMargin: '-' + (stickyTop + 1) + 'px 0px 0px 0px', threshold: 0 });
    observer.observe(sentinel);
  }
})();
`
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
