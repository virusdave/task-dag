#!/usr/bin/env node
/**
 * Render the 67.7%-GM repricing dry-run proposal as a self-contained HTML
 * review page using the canonical Helios pricing-ladder UI control
 * (`helios/src/shared/ui/pricing-ladder/`). Output is `review.html` next
 * to this script, suitable for upload via mss-one-offs.
 *
 * Per `helios/src/shared/ui/pricing-ladder/README.md` this module is the
 * single canonical implementation; older per-packet ladder generators
 * have been deprecated in favor of it. This driver consumes the compiled
 * module from `helios/dist/server/shared/ui/pricing-ladder/` so it runs
 * without a TS build step.
 *
 * We have no live market evidence here (repricing is purely cost-driven),
 * so each ladder is rendered with an empty competitor set and just the
 * live + proposed markers. The geometry module will auto-derive an axis
 * span around those two markers.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  PRICING_LADDER_STYLE,
  renderPricingLadder,
} from '../../../helios/dist/server/shared/ui/pricing-ladder/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENRICHED_PROPOSAL_PATH = resolve(HERE, 'proposal_with_evidence.json')
const BASE_PROPOSAL_PATH = resolve(HERE, 'reprice_proposal_dryrun.json')
const SUMMARY_PATH = resolve(HERE, 'reprice_summary_dryrun.json')
const OUT_PATH = resolve(HERE, 'review.html')

const BIG_SWING_USD = 5.0
// Operator-set: the catalog price is intentionally above the canonical
// 55-65% non-MSO band; an active promo on top absorbs the spread. 20%
// off the proposed post-tax price lands at the customer's effective
// post-promo price. Render that as a separate marker so reviewers can
// see at a glance where the customer-facing price will sit.
const PROMO_DISCOUNT_FRACTION = 0.20
const POST_TAX_MULTIPLIER = 1.13 // matches reprice.py

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
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '—'
  }
  return `$${Number(value).toFixed(2)}`
}

function fmtPct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '—'
  }
  return `${Number(value).toFixed(2)}%`
}

function fmtDelta(current, proposed) {
  if (current === null || proposed === null || current === undefined || proposed === undefined) {
    return { text: '—', cls: 'delta-zero' }
  }
  const delta = Number(proposed) - Number(current)
  if (Math.abs(delta) < 0.005) return { text: '0.00', cls: 'delta-zero' }
  if (delta > 0) return { text: `+${delta.toFixed(2)}`, cls: 'delta-up' }
  return { text: delta.toFixed(2), cls: 'delta-down' }
}

function renderLadderForProduct(product) {
  const current = product.currentPrice
  const proposed = product.proposedPrice
  if (current === null && proposed === null) return ''
  const delta = fmtDelta(current, proposed)

  // Map cached evidence into the canonical CompetitorListingInput shape.
  const evidence = product.marketEvidence
  const matchedListings = evidence?.matchedListings ?? []
  const competitorListings = matchedListings.map((listing, index) => ({
    listingId: `${product.productId}:${index}`,
    postTaxPrice: Number(listing.postTaxPrice),
    distanceMiles: listing.distanceMiles ?? null,
    dispensaryName: listing.dispensaryName ?? null,
    dispensaryAddress: null,
    listingName: listing.listingName ?? null,
    url: listing.url ?? null,
    eligibleForPricing: listing.eligibleForPricing !== false,
  })).filter((l) => Number.isFinite(l.postTaxPrice) && l.postTaxPrice > 0)

  // Where would a 20% promo land? Only meaningful when we have a
  // proposed price; cost is needed for the GM annotation.
  const postPromoPrice = proposed != null && Number.isFinite(Number(proposed))
    ? Number(proposed) * (1 - PROMO_DISCOUNT_FRACTION)
    : null
  const cost = product.wholesaleCost != null ? Number(product.wholesaleCost) : null
  const postPromoGm = postPromoPrice != null && cost != null && cost > 0
    ? (1 - (POST_TAX_MULTIPLIER * cost) / postPromoPrice) * 100
    : null
  const promoChip = postPromoPrice != null
    ? `<span class="ladder-head-promo">@-${Math.round(PROMO_DISCOUNT_FRACTION * 100)}% promo → <strong>${escapeHtml(fmtMoney(postPromoPrice))}</strong>${postPromoGm != null ? ` (${escapeHtml(fmtPct(postPromoGm))} GM)` : ''}</span>`
    : ''

  // Widen the ladder domain to guarantee the post-promo marker is
  // visible (it sits 20% below proposed, which is usually the natural
  // domain min). Replicates the 8% padding used by the canonical
  // geometry so the inferred axis labels stay sensible.
  const anchors = [
    current,
    proposed,
    postPromoPrice,
    evidence?.averagePostTaxPrice ?? null,
    evidence?.medianPostTaxPrice ?? null,
    ...competitorListings.map((l) => l.postTaxPrice),
  ]
    .map((v) => (v == null ? null : Number(v)))
    .filter((v) => v !== null && Number.isFinite(v))
  let domainMinOverride
  let domainMaxOverride
  if (anchors.length > 0) {
    const rawMin = Math.min(...anchors)
    const rawMax = Math.max(...anchors)
    const padding = Math.max((rawMax - rawMin) * 0.08, 1)
    domainMinOverride = Math.max(0, rawMin - padding)
    domainMaxOverride = rawMax + padding
  }

  const headHtml = `<span class="ladder-head-metric">
    Current ${escapeHtml(fmtMoney(current))} (${escapeHtml(fmtPct(product.currentGmPercent))} GM)
    →
    <strong>Proposed ${escapeHtml(fmtMoney(proposed))}</strong>
    (${escapeHtml(fmtPct(product.proposedGmPercent))} GM)
    <span class="ladder-head-delta ${delta.cls}">${delta.text}</span>
    ${promoChip}
  </span>`
  // Translate the packet's legacy freshness label ('very_stale' shape)
  // into the canonical renderer's freshness enum and surface it via
  // the chip the renderer now emits.
  const canonicalFreshness = (() => {
    switch (product.marketCacheStatus) {
      case 'fresh':
      case 'stale':
      case 'very_stale':
      case 'expired':
      case 'absent':
        return product.marketCacheStatus
      default:
        return undefined
    }
  })()
  const canonicalFreshnessAgeDays = product.marketCacheAgeDays != null
    ? Number(product.marketCacheAgeDays)
    : null
  let html = renderPricingLadder(
    {
      productId: product.productId,
      livePrice: current ?? null,
      proposedPrice: proposed ?? null,
      marketAveragePostTax: evidence?.averagePostTaxPrice ?? null,
      marketMedianPostTax: evidence?.medianPostTaxPrice ?? null,
      competitorListings,
      domainMin: domainMinOverride,
      domainMax: domainMaxOverride,
    },
    {
      variant: 'compact',
      headHtml,
      includeLegend: false,
      includeMeta: competitorListings.length > 0,
      productLabel: product.name ?? `Product ${product.productId}`,
      freshness: canonicalFreshness,
      freshnessAgeDays: canonicalFreshnessAgeDays,
    },
  )

  // Inject the post-promo marker into the canonical track using the
  // same domain math the canonical geometry used (we pinned the
  // domain above, so this just re-derives the position).
  if (postPromoPrice != null && domainMinOverride != null && domainMaxOverride != null && domainMaxOverride > domainMinOverride) {
    const ratio = (postPromoPrice - domainMinOverride) / (domainMaxOverride - domainMinOverride)
    const leftPct = Math.max(0, Math.min(100, ratio * 100))
    const title = escapeHtml(`${Math.round(PROMO_DISCOUNT_FRACTION * 100)}% promo → ${fmtMoney(postPromoPrice)}${postPromoGm != null ? ` (${fmtPct(postPromoGm)} GM)` : ''}`)
    const markerHtml = `<div class="canonical-ladder-marker post-promo" data-canonical-pricing-ladder-marker="post-promo" style="left:${leftPct.toFixed(2)}%;" title="${title}">
<span class="pip"></span>
<span class="pin"></span>
<span class="label">−${Math.round(PROMO_DISCOUNT_FRACTION * 100)}% promo ${escapeHtml(fmtMoney(postPromoPrice))}</span>
</div>`
    // Insert just before the axis-min label, which is the last node
    // inside the canonical track div.
    html = html.replace('<div class="canonical-ladder-axis axis-min">', `${markerHtml}\n<div class="canonical-ladder-axis axis-min">`)
  }
  return html
}

async function main() {
  let proposalPath = ENRICHED_PROPOSAL_PATH
  try {
    await readFile(ENRICHED_PROPOSAL_PATH)
  } catch {
    proposalPath = BASE_PROPOSAL_PATH
    console.warn(`No enriched proposal at ${ENRICHED_PROPOSAL_PATH}; falling back to ${BASE_PROPOSAL_PATH}`)
  }
  const [proposal, summary] = await Promise.all([
    readFile(proposalPath, 'utf8').then(JSON.parse),
    readFile(SUMMARY_PATH, 'utf8').then(JSON.parse),
  ])

  let totalCurrent = 0
  let totalProposed = 0
  let productsWithDiamonds = 0
  let totalDiamonds = 0
  let productsStale = 0
  let productsVeryStale = 0
  let productsExpired = 0
  let productsAbsent = 0
  let productsFresh = 0
  for (const group of proposal.groups) {
    for (const product of group.products) {
      if (product.action === 'edit' && product.currentPrice != null && product.proposedPrice != null) {
        totalCurrent += Number(product.currentPrice)
        totalProposed += Number(product.proposedPrice)
      }
      const n = product.marketEvidence?.matchedListings?.length ?? 0
      if (n > 0) {
        productsWithDiamonds += 1
        totalDiamonds += n
      }
      switch (product.marketCacheStatus) {
        case 'fresh': productsFresh += 1; break
        case 'stale': productsStale += 1; break
        case 'very_stale': productsVeryStale += 1; break
        case 'expired': productsExpired += 1; break
        case 'absent': productsAbsent += 1; break
        default: break
      }
    }
  }

  const byBrand = new Map()
  for (const group of proposal.groups) {
    if (!byBrand.has(group.brandName)) byBrand.set(group.brandName, [])
    byBrand.get(group.brandName).push(group)
  }
  const brandNames = [...byBrand.keys()].sort()

  const counts = summary.counts ?? {}

  const chunks = []
  chunks.push(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>67.7% GM Reprice Review — 2026-05-15 10FF brands</title>
<style>${PRICING_LADDER_STYLE}</style>
<style>
  :root {
    --bg:#f4efe4; --card:#fffaf0; --ink:#1f1b17; --muted:#6d665b;
    --line:#d9ceb7; --edit:#27417e; --keep:#1f5d42; --skip:#8d2f52;
    --warn:#8b5e11; --up:#1f5d42; --down:#8d2f52;
  }
  *{box-sizing:border-box}
  body{margin:0;padding:24px;font:14px/1.5 -apple-system,system-ui,sans-serif;
        background:var(--bg);color:var(--ink)}
  .wrap{max-width:1400px;margin:0 auto}
  h1{margin:0 0 6px}
  .sub{color:var(--muted);margin:0 0 18px}
  .card{background:var(--card);border:1px solid var(--line);
         border-radius:14px;padding:18px;margin:14px 0;
         box-shadow:0 4px 16px rgba(31,27,23,0.05)}
  table.summary{border-collapse:collapse;width:100%}
  table.summary th,table.summary td{padding:6px 8px;text-align:left;
        border-bottom:1px solid var(--line)}
  table.summary th{background:#efe3cf;font-weight:600;font-size:12px;
        text-transform:uppercase;letter-spacing:0.04em;color:var(--muted)}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .pill{display:inline-block;padding:1px 8px;border-radius:999px;
        font-size:11px;font-weight:600;text-transform:uppercase;
        letter-spacing:0.04em}
  .pill.edit{background:#e2eaf5;color:var(--edit)}
  .pill.keep{background:#dfeae2;color:var(--keep)}
  .pill.skip{background:#f3dde4;color:var(--skip)}
  .pill.big{background:#f0e1c2;color:var(--warn)}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
          gap:10px;margin-top:10px}
  .stat{padding:10px 12px;background:#fff;border:1px solid var(--line);
        border-radius:10px}
  .stat .v{font-size:22px;font-weight:600}
  .stat .l{font-size:11px;color:var(--muted);text-transform:uppercase;
           letter-spacing:0.04em;margin-bottom:4px}
  .brand-h{margin:24px 0 8px;font-size:18px}
  .group-block .group-meta{display:flex;justify-content:space-between;
        align-items:center;flex-wrap:wrap;gap:8px}
  .variant-row{display:grid;grid-template-columns:minmax(220px,1.2fr) minmax(420px,3fr);
        gap:14px;align-items:center;padding:10px 0;
        border-top:1px dashed var(--line)}
  .variant-row:first-child{border-top:none}
  .variant-row.keep{opacity:0.55}
  .variant-name{font-weight:600}
  .variant-meta{font-size:11px;color:var(--muted);margin-top:2px}
  .ladder-head-metric{font-size:13px}
  .ladder-head-metric strong{color:var(--edit)}
  .ladder-head-delta{margin-left:6px;font-weight:600}
  .apply-block-banner{background:#f3dde4;border:1px solid #e0a3ba;
        color:#8d2f52;border-radius:10px;padding:10px 14px;
        margin:8px 0 14px;font-weight:600;letter-spacing:0.02em}
  .ladder-head-promo{display:inline-block;margin-left:8px;padding:1px 6px;
        border-radius:6px;font-size:11px;font-weight:600;letter-spacing:0.02em;
        background:#efe6ff;color:#5b3aa6;border:1px solid #d6c4f7}
  .ladder-head-promo strong{color:#3d228f}
  /* Custom marker color for the post-promo overlay (the canonical
     control only styles live/proposed/market-average/market-median). */
  .canonical-ladder-marker.post-promo{color:#5b3aa6}
  .canonical-ladder-marker.post-promo .pin{background:#5b3aa6}
  .canonical-ladder-marker.post-promo .pip{background:#5b3aa6}
  .canonical-ladder-marker.post-promo .label{color:#3d228f;font-weight:600}
  .delta-up{color:var(--up)}
  .delta-down{color:var(--down)}
  .delta-zero{color:var(--muted)}
  .note{background:#fffaee;border:1px solid #f0e1c2;border-radius:10px;
        padding:12px 14px;color:#5d4214;margin:10px 0}
  code{font-family:'SFMono-Regular',Menlo,monospace;font-size:12px}
  /* Tame the compact ladder height in row context. */
  .variant-row .canonical-pricing-ladder.is-compact{margin:0}
</style>
</head>
<body>
<div class="wrap">
  <h1>67.7% GM Reprice Review</h1>
  <p class="sub">Brands from the 2026-05-15 midtown 10FF manifest ·
    State dealer ${proposal.stateDealerId} (${escapeHtml(proposal.stateDealerName)}) ·
    Generated ${escapeHtml(proposal.generatedAt)} (dry-run) ·
    UI: <code>helios/src/shared/ui/pricing-ladder</code></p>
  ${productsExpired > 0 ? `<div class="apply-block-banner" data-market-evidence-apply-block="true">Apply is blocked — ${productsExpired} variant${productsExpired === 1 ? '' : 's'} have expired competitor evidence.</div>` : ''}

  <div class="card">
    <strong>What this is.</strong> A proposal to rewrite the per-variant
    catalog <code>price</code> on every active variant for the nine
    brands that appeared on the 2026-05-15 midtown 10FF order,
    targeting a <strong>67.7% gross margin</strong> on the most-recent
    distributor cost, rounded to the nearest $0.25 with a mild pull
    toward .00 and .50 endings (max push ±$0.15).
    <br><br>
    The 67.7% target is intentionally above the canonical Helios
    55–65% non-MSO band; the spread is absorbed by active promos per
    vendor agreement. This proposal does <em>not</em> touch promos,
    per-site overrides, or any non-price fields.
    <br><br>
    Formula: <code>price = 1.13 × cost / (1 − 0.677)</code>
    ≈ <code>3.4985 × cost</code>. Cost source: most recent
    <code>pricesLists</code> entry across every linked
    <code>store.distributor.product</code> row at the state dealer.
    <br><br>
    Each variant below renders the canonical
    <code>renderPricingLadder()</code> control: live price marker,
    proposed price marker, an additional <span class="ladder-head-promo"
    style="margin:0">−${Math.round(PROMO_DISCOUNT_FRACTION * 100)}% promo</span>
    marker showing where the customer's effective post-promo price would
    land (and its resulting GM%), and (when available) cached competitor
    menu listings as diamonds positioned by post-tax price and colored
    by distance band. The ladder domain has been widened to keep the
    post-promo marker on-axis.
    <br><br>
    <strong>Market-evidence caveat.</strong> Diamonds are sourced from
    <code>helios.litalerts_competitor_observations</code> and are
    typically <em>11 days stale</em> right now — the legacy
    brands-console bearer at <code>~/.secret/litalerts/bearer-token</code>
    has expired and its Cognito refresh token has been revoked, so a
    live refresh can't run. The proposal&apos;s 67.7% target is purely
    cost-driven so the diamonds are context, not input to the math.
    Replacing this cached-evidence path with a live partner-API +
    geocoding sweep is design item (B), being scheduled separately.
  </div>

  <div class="stats">
    <div class="stat"><div class="l">Products in scope</div>
        <div class="v">${(counts.edit ?? 0) + (counts.keep ?? 0) + (counts.skip ?? 0)}</div></div>
    <div class="stat"><div class="l">Edits queued</div>
        <div class="v" style="color:var(--edit)">${counts.edit ?? 0}</div></div>
    <div class="stat"><div class="l">Already correct</div>
        <div class="v" style="color:var(--keep)">${counts.keep ?? 0}</div></div>
    <div class="stat"><div class="l">Skipped (no cost)</div>
        <div class="v" style="color:var(--skip)">${counts.skip ?? 0}</div></div>
    <div class="stat"><div class="l">∑ current price (edits)</div>
        <div class="v">$${totalCurrent.toFixed(2)}</div></div>
    <div class="stat"><div class="l">∑ proposed price (edits)</div>
        <div class="v">$${totalProposed.toFixed(2)}</div></div>
    <div class="stat"><div class="l">Net change (edits)</div>
        <div class="v" style="color:${totalProposed >= totalCurrent ? 'var(--up)' : 'var(--down)'}">
            ${totalProposed >= totalCurrent ? '+' : ''}$${(totalProposed - totalCurrent).toFixed(2)}</div></div>
  </div>

  <div class="card">
    <strong>By brand</strong>
    <table class="summary" style="margin-top:8px">
      <thead><tr><th>Brand</th><th class="num">Edit</th>
        <th class="num">Keep</th><th class="num">Skip</th>
        <th class="num">Total</th></tr></thead>
      <tbody>
`)

  for (const brand of Object.keys(summary.byBrand ?? {}).sort()) {
    const per = summary.byBrand[brand]
    const total = (per.edit ?? 0) + (per.keep ?? 0) + (per.skip ?? 0)
    chunks.push(
      `<tr><td>${escapeHtml(brand)}</td>` +
      `<td class="num">${per.edit ?? 0}</td>` +
      `<td class="num">${per.keep ?? 0}</td>` +
      `<td class="num">${per.skip ?? 0}</td>` +
      `<td class="num"><strong>${total}</strong></td></tr>`,
    )
  }
  chunks.push('</tbody></table></div>')

  for (const brand of brandNames) {
    chunks.push(`<h2 class="brand-h">${escapeHtml(brand)}</h2>`)
    for (const group of byBrand.get(brand)) {
      const nEdit = group.products.filter((p) => p.action === 'edit').length
      const nKeep = group.products.filter((p) => p.action === 'keep').length
      const nSkip = group.products.filter((p) => p.action === 'skip').length
      const catLabel = [group.category, group.subcategory]
        .filter(Boolean).join(' / ')
      chunks.push(`<div class="card group-block">
  <div class="group-meta">
    <div>
      <strong>${escapeHtml(group.fullName ?? group.groupName ?? '')}</strong>
      <span style="color:var(--muted);font-size:12px">
        · group ${group.groupId} · ${escapeHtml(catLabel)}
      </span>
    </div>
    <div>
      <span class="pill edit">edit ${nEdit}</span>
      <span class="pill keep">keep ${nKeep}</span>
      ${nSkip ? `<span class="pill skip">skip ${nSkip}</span>` : ''}
    </div>
  </div>
`)
      for (const product of group.products) {
        const action = product.action
        const cls = action === 'keep' ? 'keep' : ''
        const big = action === 'edit' && product.currentPrice != null
          && product.proposedPrice != null
          && Math.abs(Number(product.proposedPrice) - Number(product.currentPrice)) >= BIG_SWING_USD
        const costMeta = product.costSource
          ? `${escapeHtml(product.costSource.distributorName ?? '')} · ${escapeHtml(product.costSource.distributorProductName ?? '')} · from ${escapeHtml(product.costSource.fromDate ?? '—')}`
          : ''
        const skipMeta = action === 'skip'
          ? `<div class="variant-meta" style="color:var(--skip)">skip reason: ${escapeHtml(product.skipReason ?? '')}</div>`
          : ''
        chunks.push(`<div class="variant-row ${cls}">
  <div>
    <div class="variant-name">${escapeHtml(product.name ?? '')}
      <span class="pill ${action}" style="margin-left:6px">${action}</span>
      ${big ? '<span class="pill big" style="margin-left:4px">big swing</span>' : ''}
    </div>
    <div class="variant-meta">tab ${escapeHtml(product.tab ?? '')} · prod ${product.productId} · cost ${escapeHtml(fmtMoney(product.wholesaleCost))}</div>
    <div class="variant-meta">${costMeta}</div>
    ${skipMeta}
  </div>
  <div>${renderLadderForProduct(product)}</div>
</div>
`)
      }
      chunks.push('</div>')
    }
  }

  chunks.push('</div></body></html>')

  await writeFile(OUT_PATH, chunks.join(''))
  console.log(`Wrote ${OUT_PATH}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
