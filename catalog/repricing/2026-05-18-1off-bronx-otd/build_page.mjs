#!/usr/bin/env node
/**
 * Render `data.json` (produced by `gather_data.mjs`) into a self-
 * contained, interactive scratchpad HTML page for the Bronx 1Off promo.
 *
 * What the page does:
 *  - Lets the operator set a global "target discount %" (default 20,
 *    matching the live action 45102). Affects every row's post-promo
 *    OTD marker simultaneously.
 *  - Lets the operator set a per-row "proposed local price" (Bronx-
 *    only; the page never persists, never touches state/global
 *    pricing). Defaults to the live Bronx local price if any, else
 *    the chain (global) price.
 *  - For every row, draws a price ladder with:
 *      · Live competitor diamonds (post-tax) refreshed via the
 *        partner-API Lit Alerts pipeline at gather time.
 *      · The current chain-price OTD marker (read-only).
 *      · The proposed local-price OTD marker — moves with the
 *        per-row input.
 *      · The post-promo OTD diamond — moves with BOTH the per-row
 *        proposed price AND the global discount %.
 *  - For every row, shows two GMs (operator-visible at all times):
 *      · GM% on proposed catalog price (no promo).
 *      · GM% on proposed × (1 - global discount%) i.e. the actual
 *        post-promo subtotal.
 *
 * GM formula matches the repo convention (`reprice.py`):
 *     GM = 1 - (1.13 × cost) / price
 *
 * OTD = price × 1.13 (NY combined sales tax).
 *
 * Output: `page.html` next to this script. Upload via
 *     scripts/upload-to-mss page.html "1Off Bronx OTD scratchpad" 86400
 *
 * The page is purely a scratchpad — no apply button. Once the operator
 * settles on a discount % they want, applying it would mean:
 *     store.promo.action.edit { id: 45102, discountPercent: <new> }
 * applied only to Bronx (action 45102 lives only at dealer 210249).
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_PATH = resolve(HERE, 'data.json')
const OUT_PATH = resolve(HERE, 'page.html')

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
  const n = Number(value)
  return `$${n.toFixed(2)}`
}

function fmtPct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—'
  return `${Number(value).toFixed(1)}%`
}

/**
 * For a single product, compute the initial price-axis domain that
 * comfortably covers competitor diamonds, the current price, and the
 * initial proposed-and-discounted price — plus enough padding that
 * the user can drag the proposed input around without the moving
 * diamond falling off the chart. Domain is in post-tax (OTD) dollars
 * because that's what every marker on the axis is denominated in.
 */
function deriveDomainForProduct(product, postTaxMultiplier, initialDiscountFraction) {
  const liveGlobalPrice = Number(product.globalPrice) || 0
  const liveActualPrice = Number(product.bronxActualPrice ?? product.globalPrice) || 0
  const initialLocalPrice = product.bronxLocalPrice ?? product.globalPrice
  const initialPostPromo = Number(initialLocalPrice) * (1 - initialDiscountFraction)

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
  if (valid.length === 0) {
    return { min: 0, max: 50 }
  }
  const rawMin = Math.min(...valid)
  const rawMax = Math.max(...valid)
  // Pad both sides generously so the user has room to drag the proposed
  // price up or down without the marker pinning to an axis edge.
  const span = Math.max(rawMax - rawMin, rawMax * 0.4, 5)
  const min = Math.max(0, rawMin - span * 0.35)
  const max = rawMax + span * 0.45
  return { min, max }
}

function bandColor(band) {
  switch (band) {
    case 'near':
      return '#1f5d42'
    case 'mid':
      return '#3565a8'
    case 'far':
      return '#8e6b1a'
    case 'very_far':
      return '#7c4a2e'
    case 'statewide':
    case 'unknown':
    default:
      return '#86827c'
  }
}

function renderLadder(product, domain, initialDiscountFraction, postTaxMultiplier) {
  const matchedListings = product.market?.matchedListings ?? []
  const liveOtd = Number(product.bronxActualPrice ?? product.globalPrice) * postTaxMultiplier
  const initialLocalPrice = Number(product.bronxLocalPrice ?? product.globalPrice)
  const initialProposedOtd = initialLocalPrice * postTaxMultiplier
  const initialPostPromoOtd = initialLocalPrice * (1 - initialDiscountFraction) * postTaxMultiplier
  const span = domain.max - domain.min
  const toPct = (priceOtd) => {
    if (!Number.isFinite(priceOtd) || span <= 0) return null
    return ((priceOtd - domain.min) / span) * 100
  }

  // Sort diamonds so eligible-for-pricing ones (near/mid) draw on top
  // of background statewide far-comp diamonds.
  const sortedListings = [...matchedListings].sort((a, b) => {
    const orderBand = (band) => {
      switch (band) {
        case 'near':
          return 4
        case 'mid':
          return 3
        case 'far':
          return 2
        case 'very_far':
          return 1
        default:
          return 0
      }
    }
    return orderBand(a.distanceBand) - orderBand(b.distanceBand)
  })

  const listingDiamonds = sortedListings
    .map((listing) => {
      const left = toPct(Number(listing.postTaxPrice))
      if (left === null) return ''
      const clamped = Math.max(-2, Math.min(102, left))
      const offAxis = clamped !== left
      const color = bandColor(listing.distanceBand)
      const titleParts = [
        listing.dispensaryName ?? '—',
        listing.listingName ?? '',
        listing.distanceMiles != null ? `${Number(listing.distanceMiles).toFixed(1)} mi (${listing.distanceBand})` : `band: ${listing.distanceBand ?? 'unknown'}`,
        `post-tax ${fmtMoney(listing.postTaxPrice)}`,
        listing.preTaxPrice != null ? `pre-tax ${fmtMoney(listing.preTaxPrice)}` : '',
        listing.eligibleForPricing ? '' : '(display-only)',
      ].filter(Boolean).join(' · ')
      const linkAttr = listing.url ? `data-url="${escapeHtml(listing.url)}"` : ''
      return `<div class="diamond${listing.eligibleForPricing ? '' : ' display-only'}${offAxis ? ' off-axis' : ''}"
          style="left:${clamped.toFixed(2)}%;background:${color};border-color:${color};"
          title="${escapeHtml(titleParts)}" ${linkAttr}></div>`
    })
    .join('')

  const market = product.market ?? {}
  const avgPct = market.averagePostTaxPrice != null ? toPct(Number(market.averagePostTaxPrice)) : null
  const medPct = market.medianPostTaxPrice != null ? toPct(Number(market.medianPostTaxPrice)) : null
  const marketAvgMarker = avgPct !== null
    ? `<div class="marker market-avg" style="left:${avgPct.toFixed(2)}%;"
        title="Market average (eligible) post-tax ${fmtMoney(market.averagePostTaxPrice)}">
        <span class="pip"></span><span class="lbl">avg ${escapeHtml(fmtMoney(market.averagePostTaxPrice))}</span></div>`
    : ''
  const marketMedMarker = medPct !== null
    ? `<div class="marker market-median" style="left:${medPct.toFixed(2)}%;"
        title="Market median (eligible) post-tax ${fmtMoney(market.medianPostTaxPrice)}">
        <span class="pip"></span><span class="lbl">med ${escapeHtml(fmtMoney(market.medianPostTaxPrice))}</span></div>`
    : ''

  const liveLeft = toPct(liveOtd)
  const proposedLeft = toPct(initialProposedOtd)
  const postPromoLeft = toPct(initialPostPromoOtd)

  const liveMarker = liveLeft !== null
    ? `<div class="marker live" style="left:${Math.max(0, Math.min(100, liveLeft)).toFixed(2)}%;"
         title="Current chain-price OTD ${fmtMoney(liveOtd)}">
         <span class="pip"></span><span class="pin"></span>
         <span class="lbl">chain OTD ${escapeHtml(fmtMoney(liveOtd))}</span></div>`
    : ''
  // Proposed-OTD marker (without promo) — moves only when per-row
  // input changes.
  const proposedMarker = `<div class="marker proposed" data-marker="proposed"
       style="left:${(proposedLeft ?? 0).toFixed(2)}%;"
       title="Proposed local-price OTD"></div>`
  // Post-promo OTD diamond — the diamond the operator cares about.
  const postPromoMarker = `<div class="marker post-promo" data-marker="post-promo"
       style="left:${(postPromoLeft ?? 0).toFixed(2)}%;"
       title="Post-promo OTD"><span class="diamond-pip"></span>
       <span class="pin"></span>
       <span class="lbl"><span data-bind="post-promo-otd">${escapeHtml(fmtMoney(initialPostPromoOtd))}</span></span></div>`

  const minLabel = `<div class="axis axis-min">${escapeHtml(fmtMoney(domain.min))}</div>`
  const maxLabel = `<div class="axis axis-max">${escapeHtml(fmtMoney(domain.max))}</div>`

  return `<div class="ladder" data-domain-min="${domain.min}" data-domain-max="${domain.max}">
    <div class="track">
      ${listingDiamonds}
      ${marketAvgMarker}
      ${marketMedMarker}
      ${liveMarker}
      ${proposedMarker}
      ${postPromoMarker}
      ${minLabel}
      ${maxLabel}
    </div>
  </div>`
}

async function main() {
  const data = JSON.parse(await readFile(DATA_PATH, 'utf8'))
  const initialDiscountFraction = (Number(data.currentPromoDiscountPercent) || 20) / 100
  const postTax = Number(data.postTaxMultiplier) || 1.13

  // Group products by brand, then by group within brand. Sort brands
  // alphabetically; sort groups inside a brand alphabetically.
  const byBrand = new Map()
  for (const product of data.products) {
    if (!byBrand.has(product.brandName)) byBrand.set(product.brandName, new Map())
    const byGroup = byBrand.get(product.brandName)
    if (!byGroup.has(product.groupId)) byGroup.set(product.groupId, [])
    byGroup.get(product.groupId).push(product)
  }
  const brandNames = [...byBrand.keys()].sort((a, b) => a.localeCompare(b))

  // Aggregate metrics for the header.
  const totalProducts = data.products.length
  const productsWithListings = data.products.filter((p) => (p.market?.listingCount ?? 0) > 0).length
  const productsWithoutCost = data.products.filter((p) => !(Number(p.wholesaleCost) > 0)).length
  const productsWithLocalOverride = data.products.filter((p) => p.bronxLocalPrice != null).length

  const chunks = []
  chunks.push(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>1Off Bronx OTD scratchpad — campaign ${data.campaignId} / action ${data.actionId}</title>
<style>
:root{
  --bg:#f4efe4; --card:#fffaf0; --ink:#1f1b17; --muted:#6d665b;
  --line:#d9ceb7; --rule:#e9dec2;
  --live:#27417e; --proposed:#1f5d42; --post-promo:#5b3aa6;
  --avg:#8b5e11; --median:#a23f6c;
  --warn:#8b5e11; --up:#1f5d42; --down:#8d2f52;
}
*{box-sizing:border-box}
body{margin:0;padding:24px;font:14px/1.5 -apple-system,system-ui,sans-serif;
     background:var(--bg);color:var(--ink)}
.wrap{max-width:1500px;margin:0 auto}
h1{margin:0 0 6px}
.sub{color:var(--muted);margin:0 0 18px;font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;
      padding:18px;margin:14px 0;box-shadow:0 4px 16px rgba(31,27,23,0.05)}
.controls{display:flex;align-items:center;gap:24px;flex-wrap:wrap;
          padding:18px;background:var(--card);border:1px solid var(--line);
          border-radius:14px;position:sticky;top:8px;z-index:50;
          box-shadow:0 4px 12px rgba(31,27,23,0.07)}
.controls label{display:flex;align-items:center;gap:8px;font-weight:600}
.controls input[type=number]{font:inherit;font-weight:700;font-size:18px;
       padding:6px 10px;border:1px solid var(--line);border-radius:8px;width:90px;
       background:#fff;color:var(--post-promo);text-align:right}
.controls .meta{color:var(--muted);font-size:12px;line-height:1.4}
.controls button{font:inherit;padding:6px 12px;border:1px solid var(--line);
       background:#fff;border-radius:8px;cursor:pointer}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
       gap:10px;margin-top:10px}
.stat{padding:10px 12px;background:#fff;border:1px solid var(--line);
      border-radius:10px}
.stat .v{font-size:22px;font-weight:600}
.stat .l{font-size:11px;color:var(--muted);text-transform:uppercase;
         letter-spacing:0.04em;margin-bottom:4px}
.brand-h{margin:24px 0 8px;font-size:20px;display:flex;align-items:baseline;gap:12px}
.brand-h .count{color:var(--muted);font-size:13px;font-weight:400}
.group-h{margin:14px 0 4px;font-size:14px;color:var(--muted);font-weight:600}
.row{display:grid;
     grid-template-columns:minmax(260px,1.6fr) minmax(160px,0.8fr) minmax(160px,0.8fr) minmax(420px,3fr);
     gap:14px;align-items:start;padding:12px 0;border-top:1px dashed var(--rule)}
.row:first-child{border-top:none}
.row .name{font-weight:700;font-size:14px}
.row .image{width:32px;height:32px;border-radius:6px;background:#eee;
     background-size:cover;background-position:center;flex-shrink:0;border:1px solid var(--line)}
.row .name-line{display:flex;align-items:center;gap:8px}
.row .meta{color:var(--muted);font-size:11px;margin-top:2px}
.row .meta code{font-family:'SFMono-Regular',Menlo,monospace;font-size:10px}
.row .input-cell{display:flex;flex-direction:column;gap:4px}
.row input[type=number]{font:inherit;font-weight:700;font-size:15px;
     padding:5px 8px;border:1px solid var(--line);border-radius:6px;width:100px;
     background:#fff;text-align:right}
.row .input-cell .l{font-size:10px;color:var(--muted);text-transform:uppercase;
     letter-spacing:0.04em}
.row .gm-cell{display:grid;grid-template-columns:auto auto;gap:2px 8px;
     font-size:12px;align-items:baseline}
.row .gm-cell .lbl{color:var(--muted);font-size:11px}
.row .gm-cell .v{font-weight:700;font-variant-numeric:tabular-nums;text-align:right}
.row .gm-cell .v.proposed{color:var(--proposed)}
.row .gm-cell .v.post-promo{color:var(--post-promo)}
.row .gm-cell .v.warn{color:var(--down)}
.row.no-cost{opacity:0.55}
.ladder{position:relative;height:60px;margin:6px 0 14px}
.track{position:relative;height:24px;border-bottom:2px solid var(--ink);
       margin-top:24px;background:repeating-linear-gradient(to right,
       rgba(0,0,0,0.04) 0,rgba(0,0,0,0.04) 1px,transparent 1px,transparent 25%)}
.axis{position:absolute;top:30px;font-size:10px;color:var(--muted);font-variant-numeric:tabular-nums}
.axis-min{left:0}
.axis-max{right:0}
.diamond{position:absolute;top:6px;width:10px;height:10px;margin-left:-5px;
       background:#86827c;border:1px solid #86827c;transform:rotate(45deg);
       opacity:0.85;cursor:default;box-shadow:0 1px 1px rgba(0,0,0,0.1);
       border-radius:1px;z-index:1}
.diamond.display-only{opacity:0.5;width:8px;height:8px;margin-left:-4px;top:8px}
.diamond.off-axis{opacity:0.35}
.marker{position:absolute;top:-22px;height:46px;width:0;z-index:5;
       display:flex;flex-direction:column;align-items:center;pointer-events:none}
.marker .pin{position:absolute;top:18px;width:2px;height:30px;background:currentColor}
.marker .pip{width:8px;height:8px;border-radius:50%;background:currentColor;margin-top:14px;
       border:2px solid #fff;box-shadow:0 1px 2px rgba(0,0,0,0.2)}
.marker .lbl{position:absolute;top:-16px;left:0;transform:translateX(-50%);
       font-size:10px;font-weight:700;color:currentColor;white-space:nowrap;
       background:rgba(255,250,240,0.92);padding:1px 5px;border-radius:4px;border:1px solid rgba(0,0,0,0.05);font-variant-numeric:tabular-nums}
.marker.live{color:var(--live)}
.marker.proposed{color:var(--proposed)}
.marker.market-avg{color:var(--avg)}
.marker.market-median{color:var(--median)}
.marker.post-promo{color:var(--post-promo);z-index:10}
.marker.post-promo .diamond-pip{width:16px;height:16px;background:currentColor;
       transform:rotate(45deg);margin-top:14px;border:2px solid #fff;
       box-shadow:0 2px 4px rgba(0,0,0,0.25);border-radius:2px}
.marker.post-promo .pin{height:32px;width:3px;top:22px}
.marker.post-promo .lbl{font-size:11px;font-weight:800;top:-18px;padding:2px 6px;
       background:#fff;border:1px solid var(--post-promo)}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--muted);
       margin:4px 0 0;align-items:center}
.legend .swatch{display:inline-block;width:12px;height:12px;margin-right:4px;vertical-align:middle;border-radius:2px}
.legend .diamond-swatch{display:inline-block;width:10px;height:10px;margin-right:4px;vertical-align:middle;transform:rotate(45deg)}
.note{font-size:11px;color:var(--muted);margin-top:4px}
.market-meta{font-size:11px;color:var(--muted);margin-top:2px}
.market-meta .badge{display:inline-block;padding:1px 6px;border-radius:999px;
       background:#efe3cf;font-weight:600;font-size:10px;color:var(--ink);margin-right:4px}
.market-meta .badge.fresh{background:#dfeae2;color:var(--up)}
.market-meta .badge.stale{background:#f0e1c2;color:var(--warn)}
.market-meta .badge.absent{background:#f3dde4;color:var(--down)}
.warn-banner{background:#fffaee;border:1px solid #f0e1c2;border-radius:10px;
       padding:10px 14px;color:#5d4214;margin:10px 0;font-weight:600}
.brand-summary{display:flex;flex-wrap:wrap;gap:6px;font-size:11px;color:var(--muted);margin-top:6px}
.brand-summary .pill{display:inline-block;padding:1px 8px;border-radius:999px;
       background:#efe3cf;color:var(--ink);font-weight:600}
</style>
</head>
<body>
<div class="wrap">
  <h1>1Off Bronx OTD scratchpad</h1>
  <p class="sub">
    Bronx site dealer ${data.bronxDealerId} ·
    campaign <strong>${escapeHtml(data.campaignName)}</strong> (id ${data.campaignId}) ·
    action <strong>${escapeHtml(data.actionName)}</strong> (id ${data.actionId}, currently <strong>${fmtPct(data.currentPromoDiscountPercent)}</strong>) ·
    9 brands · ${totalProducts} products ·
    generated ${escapeHtml(data.generatedAt)}
  </p>

  <div class="controls">
    <label>
      Target discount %:
      <input id="globalDiscount" type="number" min="0" max="80" step="0.5" value="${data.currentPromoDiscountPercent}">
    </label>
    <div class="meta">
      Changes every row's <span style="color:var(--post-promo)"><strong>post-promo OTD</strong> diamond</span>
      <br>and the post-promo GM% beside each row. <strong>Read-only</strong> — nothing is written back.
    </div>
    <button id="resetDiscount" type="button">reset to current promo (${fmtPct(data.currentPromoDiscountPercent)})</button>
    <button id="resetAllLocal" type="button">reset all proposed local → chain price</button>
    <div class="legend">
      <span><span class="swatch" style="background:var(--live)"></span>chain OTD</span>
      <span><span class="swatch" style="background:var(--proposed)"></span>proposed OTD</span>
      <span><span class="swatch" style="background:var(--post-promo)"></span>post-promo OTD diamond</span>
      <span><span class="swatch" style="background:var(--avg)"></span>market avg</span>
      <span><span class="swatch" style="background:var(--median)"></span>market median</span>
      <span><span class="diamond-swatch" style="background:#1f5d42"></span>near comp</span>
      <span><span class="diamond-swatch" style="background:#3565a8"></span>mid comp</span>
      <span><span class="diamond-swatch" style="background:#8e6b1a"></span>far comp</span>
      <span><span class="diamond-swatch" style="background:#86827c;opacity:0.5"></span>statewide / display-only</span>
    </div>
  </div>

  <div class="stats">
    <div class="stat"><div class="l">Products in scope</div><div class="v">${totalProducts}</div></div>
    <div class="stat"><div class="l">With competitor listings</div><div class="v">${productsWithListings}</div></div>
    <div class="stat"><div class="l">No wholesale cost</div><div class="v">${productsWithoutCost}</div></div>
    <div class="stat"><div class="l">Currently override at Bronx</div><div class="v">${productsWithLocalOverride}</div></div>
    <div class="stat"><div class="l">Post-tax multiplier</div><div class="v">${postTax.toFixed(2)}×</div></div>
    <div class="stat"><div class="l">Selector productCount (live)</div><div class="v">${totalProducts}</div></div>
  </div>

  ${productsWithoutCost > 0 ? `<div class="warn-banner">${productsWithoutCost} of the ${totalProducts} products have no wholesale cost on file at the state dealer (${data.stateDealerId}). For those rows the GM% columns will read "—".</div>` : ''}
`)

  for (const brandName of brandNames) {
    const groupMap = byBrand.get(brandName)
    const allProducts = [...groupMap.values()].flat()
    chunks.push(`<h2 class="brand-h">${escapeHtml(brandName)}
      <span class="count">${allProducts.length} product${allProducts.length === 1 ? '' : 's'} · ${[...groupMap.keys()].length} groups</span>
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
      chunks.push(`<div class="group-h">${escapeHtml(groupName)} <span style="font-weight:400">· ${escapeHtml(category)}${sub ? ` / ${escapeHtml(sub)}` : ''} · group ${gid}</span></div>`)
      for (const product of products.sort((a, b) => (a.tab ?? '').localeCompare(b.tab ?? ''))) {
        const domain = deriveDomainForProduct(product, postTax, initialDiscountFraction)
        const cost = Number(product.wholesaleCost) || 0
        const globalPrice = Number(product.globalPrice) || 0
        const initialLocal = product.bronxLocalPrice ?? product.globalPrice
        const initialPostPromo = Number(initialLocal) * (1 - initialDiscountFraction)
        // GM% on proposed catalog price (without promo).
        const proposedGm = cost > 0 && initialLocal > 0 ? (1 - (postTax * cost) / Number(initialLocal)) * 100 : null
        // GM% on post-promo subtotal.
        const postPromoGm = cost > 0 && initialPostPromo > 0 ? (1 - (postTax * cost) / initialPostPromo) * 100 : null

        const ladderHtml = renderLadder(product, domain, initialDiscountFraction, postTax)
        const status = product.market?.status ?? '—'
        const statusBadge = status === 'matched'
          ? `<span class="badge fresh">matched</span>`
          : status === 'display_only'
            ? `<span class="badge stale">display-only</span>`
            : status === 'absent' || status === 'disabled' || status === 'no_brand' || status === 'unresolved_brand' || status === 'no_data' || status === 'no_catalog_group' || status === 'no_family_matches' || status === 'no_safe_matches'
              ? `<span class="badge absent">${escapeHtml(status)}</span>`
              : `<span class="badge">${escapeHtml(status)}</span>`
        const listingMeta = `${product.market?.pricingEligibleListingCount ?? 0} eligible · ${product.market?.listingCount ?? 0} total`
        const searchMeta = product.market?.searchTerm ? `· <code>${escapeHtml(product.market.searchTerm)}</code>` : ''

        chunks.push(`<div class="row${cost > 0 ? '' : ' no-cost'}"
            data-product-id="${product.productId}"
            data-cost="${cost}"
            data-global-price="${globalPrice}"
            data-post-tax="${postTax}">
  <div>
    <div class="name-line">
      ${product.imageUrl ? `<div class="image" style="background-image:url('${escapeHtml(product.imageUrl)}')"></div>` : `<div class="image"></div>`}
      <div>
        <div class="name">${escapeHtml(product.name ?? '')}</div>
        <div class="meta">prod ${product.productId} · tab ${escapeHtml(product.tab ?? '—')} · cost ${escapeHtml(fmtMoney(product.wholesaleCost))}</div>
      </div>
    </div>
    <div class="market-meta">${statusBadge}${listingMeta} ${searchMeta}</div>
  </div>
  <div class="input-cell">
    <div class="l">Chain (global) price (pre-tax)</div>
    <div style="font-weight:700;color:var(--live);font-size:15px;font-variant-numeric:tabular-nums">${escapeHtml(fmtMoney(globalPrice))}
      <span style="font-weight:400;color:var(--muted);font-size:11px">(OTD ${escapeHtml(fmtMoney(globalPrice * postTax))})</span>
    </div>
    <div class="l" style="margin-top:6px">Proposed Bronx local (pre-tax)</div>
    <input type="number" min="0" step="0.25" value="${Number(initialLocal).toFixed(2)}"
        data-product-id="${product.productId}" data-input="local-price">
    ${product.bronxLocalPrice != null ? `<div class="note" style="color:var(--warn)">currently overridden at Bronx: ${escapeHtml(fmtMoney(product.bronxLocalPrice))}</div>` : `<div class="note">no current Bronx local override (uses chain)</div>`}
  </div>
  <div class="gm-cell">
    <span class="lbl">Proposed OTD:</span>
    <span class="v" data-bind="proposed-otd">${escapeHtml(fmtMoney(Number(initialLocal) * postTax))}</span>
    <span class="lbl">GM% (no promo):</span>
    <span class="v proposed" data-bind="proposed-gm">${escapeHtml(fmtPct(proposedGm))}</span>
    <span class="lbl">Post-promo OTD:</span>
    <span class="v post-promo" data-bind="post-promo-otd-cell">${escapeHtml(fmtMoney(initialPostPromo * postTax))}</span>
    <span class="lbl">GM% with promo:</span>
    <span class="v post-promo" data-bind="post-promo-gm">${escapeHtml(fmtPct(postPromoGm))}</span>
  </div>
  ${ladderHtml}
</div>`)
      }
    }
    chunks.push(`</div>`)
  }

  chunks.push(`<div class="card" style="margin-top:30px">
    <strong>How the numbers are computed.</strong>
    <ul style="margin:6px 0 0 18px;padding:0;font-size:13px;line-height:1.5">
      <li>Chain (global) price is read live from the state-dealer catalog (${data.stateDealerId}).</li>
      <li>Proposed Bronx local is whatever you type — it never gets written; this page is a scratchpad only.</li>
      <li>OTD = price × ${postTax.toFixed(2)} (NY combined sales tax).</li>
      <li>Post-promo subtotal = proposed local × (1 − target discount %). Post-promo OTD = that × ${postTax.toFixed(2)}.</li>
      <li>GM% = 1 − (${postTax.toFixed(2)} × cost) / price — matches <code>reprice.py</code>'s convention for this org.</li>
      <li>Competitor diamonds and market avg/median were refreshed live from the Lit Alerts partner API at gather time (above). Diamonds outside the visible price axis are pulled to the edge at low opacity.</li>
      <li>Distance bands: near ≤ ~5 mi · mid ≤ ~15 mi · far / very-far / statewide. Only near/mid count as "eligible" for canonical pricing math.</li>
    </ul>
    <p style="margin:10px 0 0;font-size:12px;color:var(--muted)">
      If you settle on a different discount %, applying it Bronx-only is one RPC call:
      <code>store.promo.action.edit { id: '${data.actionId}', discountPercent: &lt;new&gt; }</code> at dealer ${data.bronxDealerId}.
      Per-row local price tweaks go via <code>store.product.edit { id, price }</code> at dealer ${data.bronxDealerId}.
    </p>
  </div>
</div>

<script>
(function () {
  const POST_TAX = ${postTax}
  const fmtMoney = (v) => (v == null || !isFinite(v)) ? '—' : '$' + Number(v).toFixed(2)
  const fmtPct = (v) => (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(1) + '%'

  const globalDiscountInput = document.getElementById('globalDiscount')
  const resetDiscountBtn = document.getElementById('resetDiscount')
  const resetAllLocalBtn = document.getElementById('resetAllLocal')

  const rows = Array.from(document.querySelectorAll('.row[data-product-id]'))
  const initialDiscount = Number(globalDiscountInput.value)

  function updateRow(row, discountFraction) {
    const cost = Number(row.dataset.cost) || 0
    const globalPrice = Number(row.dataset.globalPrice) || 0
    const localInput = row.querySelector('input[data-input="local-price"]')
    const proposedLocal = Number(localInput.value) || 0
    const proposedOtd = proposedLocal * POST_TAX
    const postPromoLocal = proposedLocal * (1 - discountFraction)
    const postPromoOtd = postPromoLocal * POST_TAX

    const proposedGm = cost > 0 && proposedLocal > 0 ? (1 - (POST_TAX * cost) / proposedLocal) * 100 : null
    const postPromoGm = cost > 0 && postPromoLocal > 0 ? (1 - (POST_TAX * cost) / postPromoLocal) * 100 : null

    const set = (sel, txt, cls) => {
      const el = row.querySelector('[data-bind="' + sel + '"]')
      if (!el) return
      el.textContent = txt
      if (cls !== undefined) {
        el.classList.toggle('warn', cls)
      }
    }
    set('proposed-otd', fmtMoney(proposedOtd))
    set('proposed-gm', fmtPct(proposedGm), proposedGm != null && proposedGm < 0)
    set('post-promo-otd-cell', fmtMoney(postPromoOtd))
    set('post-promo-gm', fmtPct(postPromoGm), postPromoGm != null && postPromoGm < 0)
    // Reposition moving markers along the price axis.
    const ladder = row.querySelector('.ladder')
    if (ladder) {
      const min = Number(ladder.dataset.domainMin)
      const max = Number(ladder.dataset.domainMax)
      const span = max - min
      const placeMarker = (selector, otdValue, labelEl) => {
        const m = row.querySelector(selector)
        if (!m || !(span > 0)) return
        const raw = ((otdValue - min) / span) * 100
        const clamped = Math.max(-2, Math.min(102, raw))
        m.style.left = clamped.toFixed(2) + '%'
        m.classList.toggle('off-axis', raw !== clamped)
        if (labelEl) {
          const lbl = m.querySelector('[data-bind="' + labelEl + '"]')
          if (lbl) lbl.textContent = fmtMoney(otdValue)
        }
      }
      placeMarker('.marker[data-marker="proposed"]', proposedOtd, null)
      placeMarker('.marker[data-marker="post-promo"]', postPromoOtd, 'post-promo-otd')
    }
  }

  function refreshAll() {
    const d = Math.max(0, Math.min(99, Number(globalDiscountInput.value) || 0)) / 100
    rows.forEach((row) => updateRow(row, d))
  }

  document.addEventListener('input', (e) => {
    if (e.target === globalDiscountInput) {
      refreshAll()
    } else if (e.target.matches('input[data-input="local-price"]')) {
      const row = e.target.closest('.row[data-product-id]')
      if (row) updateRow(row, (Number(globalDiscountInput.value) || 0) / 100)
    }
  })

  resetDiscountBtn.addEventListener('click', () => {
    globalDiscountInput.value = String(initialDiscount)
    refreshAll()
  })
  resetAllLocalBtn.addEventListener('click', () => {
    rows.forEach((row) => {
      const localInput = row.querySelector('input[data-input="local-price"]')
      if (!localInput) return
      const globalPrice = Number(row.dataset.globalPrice) || 0
      localInput.value = globalPrice.toFixed(2)
    })
    refreshAll()
  })

  // Make diamond clicks open the listing url.
  document.addEventListener('click', (e) => {
    const d = e.target.closest('.diamond[data-url]')
    if (d) window.open(d.dataset.url, '_blank', 'noopener')
  })

  refreshAll()
})()
</script>
</body>
</html>
`)
  await writeFile(OUT_PATH, chunks.join(''))
  console.log(`Wrote ${OUT_PATH}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
