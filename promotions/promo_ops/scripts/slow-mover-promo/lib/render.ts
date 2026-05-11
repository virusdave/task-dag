/**
 * Static HTML reviewer-packet renderer for the slow-mover promo proposal.
 *
 * Output layout (matches reviewer-packet conventions used by other Helios
 * packets, see `docs/ui/reviewer-packet-guidelines.md`):
 *
 *   out/
 *     index.html              -- summary + ranked candidate group table
 *     groups/<slug>.html      -- per-group detail with price ladder
 *     products/<id>.html      -- per-product detail with full ladder + comp table
 *
 * Each row in the index links to the matching detail page using
 * `target="_blank" rel="noopener"` so the user gets a NEW PANE/TAB per the
 * spec.
 *
 * The price-ladder UI is the canonical control extracted to
 * `helios/src/shared/ui/pricing-ladder/`; this renderer uses it via its
 * HTML-string entry point (renderPricingLadderFromGeometry) and its
 * canonical CSS (PRICING_LADDER_STYLE).
 *
 * Self-contained CSS in <style>; no external assets so the packet survives
 * being copied to a different host or attached to email.
 */
import {
  PRICING_LADDER_STYLE,
  renderPricingLadderFromGeometry,
  type LadderGeometry,
} from '../../../../../helios/src/shared/ui/pricing-ladder/index.js'
import type { AggregateResult, GroupRollup, ProductRollup } from './aggregate.js'
import type { SiteScope } from './data.js'
import type { ProductMarketData } from './enrich.js'
import type { CompetitorListing } from './litalerts.js'

const STYLE_BLOCK = `
:root {
  --fg: #1f2933;
  --fg-muted: #52606d;
  --fg-soft: #7b8794;
  --bg: #f5f7fa;
  --panel: #ffffff;
  --border: #d2d6dc;
  --accent: #b35900;
  --accent-strong: #8a3e00;
  --good: #2f7a3e;
  --warn: #b35900;
  --bad: #b00020;
  --code-bg: #f1f3f5;
  --row-alt: #fafbfc;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--fg);
  line-height: 1.5;
  font-size: 14px;
}
header.packet, header.detail {
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  padding: 24px 32px 20px 32px;
}
header.packet h1, header.detail h1 {
  margin: 0 0 6px 0;
  font-size: 22px;
  letter-spacing: -0.01em;
}
header .subtitle {
  color: var(--fg-muted);
  font-size: 13px;
}
header .meta {
  margin-top: 10px;
  color: var(--fg-soft);
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
main { padding: 24px 32px 64px 32px; }
section { margin-bottom: 32px; }
h2 { font-size: 16px; margin: 0 0 12px 0; letter-spacing: -0.01em; }
h3 { font-size: 13px; margin: 18px 0 8px 0; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.05em; }
.exec {
  background: var(--panel);
  border: 1px solid var(--border);
  border-left: 4px solid var(--accent);
  padding: 14px 18px;
  border-radius: 4px;
  font-size: 14px;
  color: var(--fg);
}
.exec .source { color: var(--fg-soft); font-size: 11px; margin-top: 8px; font-family: ui-monospace, monospace; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 12px 14px;
}
.card .label { font-size: 11px; color: var(--fg-soft); text-transform: uppercase; letter-spacing: 0.05em; }
.card .value { font-size: 18px; font-weight: 600; margin-top: 4px; }
.card .sub { font-size: 11px; color: var(--fg-soft); margin-top: 2px; }
table {
  width: 100%;
  border-collapse: collapse;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
  font-size: 13px;
}
th, td { padding: 8px 10px; text-align: left; vertical-align: top; }
th { background: #eef1f4; font-weight: 600; font-size: 12px; color: var(--fg-muted); border-bottom: 1px solid var(--border); }
tbody tr:nth-child(even) { background: var(--row-alt); }
tbody tr:hover { background: #eef4fb; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  background: #eef1f4;
  color: var(--fg-muted);
  border: 1px solid var(--border);
}
.badge.scope-category { background: #fff3e6; color: var(--accent-strong); border-color: #f1c597; }
.badge.scope-category-brand { background: #e8eef9; color: #1c3d6f; border-color: #b6c4e1; }
.badge.signal { margin-right: 4px; }
.signal-days-of-supply { background: #ffe8e8; color: var(--bad); border-color: #f3b8b8; }
.signal-sell-through { background: #fff3e6; color: var(--accent-strong); border-color: #f1c597; }
.signal-inventory-value { background: #e8f6ee; color: var(--good); border-color: #b3dec3; }
.signal-age { background: #f7e9ff; color: #5b1d99; border-color: #d8b8f1; }
.signal-low-velocity { background: #ffe8e8; color: var(--bad); border-color: #f3b8b8; }
.signal-gm-cushion { background: #eef9f7; color: #185f53; border-color: #a8d6cd; }
a.row-link { color: var(--accent-strong); text-decoration: none; font-weight: 600; }
a.row-link:hover { text-decoration: underline; }
.rationale {
  background: var(--panel);
  border: 1px solid var(--border);
  border-left: 4px solid #6b9a36;
  padding: 10px 14px;
  border-radius: 4px;
  margin-bottom: 14px;
  color: var(--fg);
}
.rationale .source {
  display: block;
  margin-top: 6px;
  color: var(--fg-soft);
  font-size: 11px;
  font-family: ui-monospace, monospace;
}
.back-link { font-size: 12px; color: var(--fg-muted); text-decoration: none; }
.back-link::before { content: "← "; }
.back-link:hover { color: var(--fg); text-decoration: underline; }
.empty {
  padding: 24px;
  background: var(--panel);
  border: 1px dashed var(--border);
  text-align: center;
  color: var(--fg-muted);
  border-radius: 4px;
}
.footer-note {
  margin-top: 28px;
  font-size: 11px;
  color: var(--fg-soft);
  font-family: ui-monospace, monospace;
}
/* compact ladder when embedded inside the per-SKU table row */
table.skus { table-layout: fixed; }
table.skus td.ladder-cell { padding: 6px 10px; min-width: 360px; }
table.skus td.ladder-cell .canonical-pricing-ladder { margin: 0; }
table.skus tbody tr:hover { cursor: pointer; }
table.skus a.sku-link { color: var(--accent-strong); text-decoration: none; font-weight: 600; }
table.skus a.sku-link:hover { text-decoration: underline; }
.no-ladder {
  font-size: 11px;
  color: var(--fg-soft);
  padding: 8px 10px;
  border: 1px dashed var(--border);
  border-radius: 4px;
  background: #fafbfc;
}
table.market-table { font-size: 12px; }
table.market-table th, table.market-table td { padding: 6px 10px; }
table.market-table td.price { font-weight: 600; font-variant-numeric: tabular-nums; font-family: ui-monospace, monospace; }
.market-row.source-statewide { color: var(--fg-muted); font-style: italic; }
.market-row.source-statewide td { background: #fafafa; }
.distance-band-chip {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  border: 1px solid rgba(31, 27, 23, 0.18);
  color: #fff;
}
.distance-band-chip.band-very-near { background: #1d7a4f; }
.distance-band-chip.band-near      { background: #3aa269; }
.distance-band-chip.band-mid       { background: #caa53a; color: #1f1b17; border-color: #a8862b; }
.distance-band-chip.band-far       { background: #c87132; }
.distance-band-chip.band-statewide { background: #7d7569; }
${PRICING_LADDER_STYLE}
`

export interface RenderPlan {
  generatedAt: string
  site: SiteScope
  aggregate: AggregateResult
  llm: {
    rankedSlugs: string[]
    rationaleBySlug: Record<string, string>
    executiveSummary: string
    used: boolean
    note: string
  }
  /** Site-wide sales totals over the same window (independent of inventory join). */
  siteWideSales: {
    windowNetSales: number
    windowUnits: number
  }
  /** Per-productId ladder + competitor evidence for the per-product detail pages. */
  marketByProductId: Map<number, ProductMarketData>
}

export interface RenderedFile {
  path: string
  html: string
}

export function renderPacket(plan: RenderPlan): RenderedFile[] {
  const orderedGroups = orderGroups(plan.aggregate.candidateGroups, plan.llm.rankedSlugs)
  const files: RenderedFile[] = []
  files.push({ path: 'index.html', html: renderIndex(plan, orderedGroups) })
  for (const group of orderedGroups) {
    files.push({
      path: `groups/${group.slug}.html`,
      html: renderGroupDetail(plan, group),
    })
  }
  // Per-product detail pages: render once per unique productId across all
  // candidate groups so cross-group navigation deduplicates naturally.
  const seen = new Set<number>()
  for (const group of orderedGroups) {
    for (const product of group.products) {
      if (seen.has(product.productId)) continue
      seen.add(product.productId)
      files.push({
        path: `products/${product.productId}.html`,
        html: renderProductDetail(plan, group, product),
      })
    }
  }
  return files
}

function orderGroups(groups: GroupRollup[], rankedSlugs: string[]): GroupRollup[] {
  if (rankedSlugs.length === 0) return groups
  const orderIndex = new Map(rankedSlugs.map((slug, index) => [slug, index]))
  return [...groups].sort((a, b) => {
    const ai = orderIndex.has(a.slug) ? (orderIndex.get(a.slug) as number) : Number.POSITIVE_INFINITY
    const bi = orderIndex.has(b.slug) ? (orderIndex.get(b.slug) as number) : Number.POSITIVE_INFINITY
    if (ai !== bi) return ai - bi
    return b.opportunityScore - a.opportunityScore
  })
}

function renderIndex(plan: RenderPlan, groups: GroupRollup[]): string {
  const exec = plan.llm.executiveSummary
    ? `<div class="exec">${escapeHtml(plan.llm.executiveSummary)}<div class="source">Source: Bedrock Mantle (${escapeHtml(plan.llm.note)})</div></div>`
    : `<div class="exec"><strong>Slow-mover review:</strong> ${groups.length} candidate group(s) at ${escapeHtml(plan.site.label)} flagged for aggressive promo across the trailing ${plan.aggregate.window.days}-day window. Total inventory exposure across these groups: ${formatUsd(sum(groups.map((g) => g.inventoryRetailValue)))}.<div class="source">Source: deterministic fallback (LLM disabled or unavailable)</div></div>`

  const totals = plan.aggregate.totals
  const cards = [
    {
      label: 'Window',
      value: `${plan.aggregate.window.days} days`,
      sub: `${plan.aggregate.window.startDate} → ${plan.aggregate.window.endDate}`,
    },
    {
      label: 'Net sales (window)',
      value: formatUsd(plan.siteWideSales.windowNetSales),
      sub: `${formatNumber(plan.siteWideSales.windowUnits)} units site-wide`,
    },
    {
      label: 'Inventory on hand',
      value: formatNumber(totals.onHandQty),
      sub: `${formatUsd(totals.inventoryRetailValue)} retail · ${formatUsd(totals.windowNetSales)} sold from current SKUs`,
    },
    {
      label: 'Candidate groups',
      value: String(groups.length),
      sub: 'category or category × brand',
    },
    {
      label: 'Group exposure',
      value: formatUsd(sum(groups.map((g) => g.inventoryRetailValue))),
      sub: 'retail $ across candidates',
    },
  ]

  const tableRows =
    groups.length === 0
      ? `<tr><td colspan="9" class="empty">No slow-mover groups crossed the scoring thresholds in this window.</td></tr>`
      : groups
          .map((group, index) => {
            const detailHref = `groups/${encodeURIComponent(group.slug)}.html`
            const signals = group.signals
              .map((sig) => `<span class="badge signal signal-${sig.kind}">${escapeHtml(sig.kind)}</span>`)
              .join('')
            const llmRationale = plan.llm.rationaleBySlug[group.slug]
            const rationale = llmRationale
              ? `<div style="font-size:12px;color:var(--fg-muted);margin-top:4px;">${escapeHtml(llmRationale)}</div>`
              : ''
            return `
              <tr>
                <td class="num">${index + 1}</td>
                <td>
                  <a class="row-link" href="${detailHref}" target="_blank" rel="noopener">${escapeHtml(group.label)}</a>
                  <div style="margin-top:4px;">
                    <span class="badge scope-${group.scope}">${escapeHtml(group.scope)}</span>
                    ${signals}
                  </div>
                  ${rationale}
                </td>
                <td class="num">${formatNumber(group.products.length)}</td>
                <td class="num">${formatUsd(group.inventoryRetailValue)}</td>
                <td class="num">${formatNumber(group.onHandQty)}</td>
                <td class="num">${formatUsd(group.windowNetSales)}</td>
                <td class="num">${formatNumber(group.windowUnitsSold)}</td>
                <td class="num">${group.daysOfSupply === null ? '—' : formatNumber(group.daysOfSupply)}</td>
                <td class="num">${group.blendedGrossMarginPct === null ? '—' : `${group.blendedGrossMarginPct}%`}</td>
              </tr>
            `
          })
          .join('')

  return baseTemplate({
    title: `Slow-mover promo proposals — ${plan.site.label}`,
    bodyClass: 'index',
    body: `
      <header class="packet">
        <h1>Slow-mover promo proposals</h1>
        <div class="subtitle">${escapeHtml(plan.site.label)} · trailing ${plan.aggregate.window.days}-day window (${plan.aggregate.window.startDate} → ${plan.aggregate.window.endDate})</div>
        <div class="meta">Generated ${escapeHtml(plan.generatedAt)} · inventory snapshot ${escapeHtml(plan.aggregate.inventoryFetchedAt)} · sales snapshot ${escapeHtml(plan.aggregate.salesFetchedAt)}</div>
      </header>
      <main>
        <section>${exec}</section>
        <section>
          <h2>Window snapshot</h2>
          <div class="cards">
            ${cards.map((card) => `<div class="card"><div class="label">${escapeHtml(card.label)}</div><div class="value">${escapeHtml(card.value)}</div><div class="sub">${escapeHtml(card.sub)}</div></div>`).join('')}
          </div>
        </section>
        <section>
          <h2>Candidate promo groups (sorted: ${plan.llm.used ? 'LLM-ranked' : 'deterministic score'})</h2>
          <table>
            <thead>
              <tr>
                <th class="num">#</th>
                <th>Group</th>
                <th class="num">SKUs</th>
                <th class="num">Retail $ on hand</th>
                <th class="num">Units on hand</th>
                <th class="num">Net sales (window)</th>
                <th class="num">Units (window)</th>
                <th class="num">Days of supply</th>
                <th class="num">Blended GM %</th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
          <div class="footer-note">Click a group label to open its per-SKU canonical price ladder in a new tab. Promo decisions are reviewer-confirmed; this packet is a proposal, not an apply.</div>
        </section>
      </main>
    `,
  })
}

function renderGroupDetail(plan: RenderPlan, group: GroupRollup): string {
  const llmRationale = plan.llm.rationaleBySlug[group.slug]
  const rationaleBlock = llmRationale
    ? `<div class="rationale">${escapeHtml(llmRationale)}<span class="source">Source: Bedrock Mantle (${escapeHtml(plan.llm.note)})</span></div>`
    : `<div class="rationale">Deterministic flags only: ${escapeHtml(group.signals.map((s) => s.kind).join(', ') || '—')}.<span class="source">Source: deterministic scoring</span></div>`

  const cards = [
    {
      label: 'Scope',
      value: group.scope === 'category' ? 'Whole category' : 'Brand within category',
      sub: group.scope === 'category' ? 'No single-brand fence' : `Limited to ${group.brand ?? '—'}`,
    },
    {
      label: 'SKU count',
      value: String(group.products.length),
      sub: `${formatNumber(group.onHandQty)} units on hand`,
    },
    {
      label: 'Inventory at retail',
      value: formatUsd(group.inventoryRetailValue),
      sub: `${formatUsd(group.inventoryCostValue)} at cost`,
    },
    {
      label: 'Window net sales',
      value: formatUsd(group.windowNetSales),
      sub: `${formatNumber(group.windowUnitsSold)} units / ${formatNumber(group.windowSellingPerDay)} per day`,
    },
    {
      label: 'Days of supply',
      value: group.daysOfSupply === null ? '∞ (no sales)' : String(group.daysOfSupply),
      sub: `${group.sellThroughPct === null ? '—' : `${group.sellThroughPct}% sell-through`}`,
    },
    {
      label: 'Blended GM',
      value: group.blendedGrossMarginPct === null ? '—' : `${group.blendedGrossMarginPct}%`,
      sub: `${formatUsd(group.windowGrossMargin)} gross margin in window`,
    },
    {
      label: 'Oldest stock',
      value:
        group.oldestReceivedAt === null
          ? '—'
          : `${group.daysSinceOldestReceived ?? '—'} days`,
      sub: group.oldestReceivedAt ? `received ${group.oldestReceivedAt.slice(0, 10)}` : '',
    },
    {
      label: 'Promo discount in window',
      value: formatUsd(group.windowPromoDiscount),
      sub: 'amount already discounted via existing promos',
    },
  ]

  const ladder = renderGroupSkuTable(plan, group)

  const signals = group.signals
    .map(
      (signal) => `
        <li>
          <span class="badge signal signal-${signal.kind}">${escapeHtml(signal.kind)} (+${signal.weight})</span>
          ${escapeHtml(signal.detail)}
        </li>
      `,
    )
    .join('')

  return baseTemplate({
    title: `${group.label} — slow-mover detail`,
    bodyClass: 'detail',
    body: `
      <header class="detail">
        <a class="back-link" href="../index.html">Back to packet index</a>
        <h1 style="margin-top:8px;">${escapeHtml(group.label)}</h1>
        <div class="subtitle">${escapeHtml(plan.site.label)} · ${plan.aggregate.window.days}-day window (${plan.aggregate.window.startDate} → ${plan.aggregate.window.endDate}) · opportunity score ${group.opportunityScore}</div>
        <div class="meta">Generated ${escapeHtml(plan.generatedAt)}</div>
      </header>
      <main>
        <section>${rationaleBlock}</section>
        <section>
          <h2>Group snapshot</h2>
          <div class="cards">
            ${cards.map((card) => `<div class="card"><div class="label">${escapeHtml(card.label)}</div><div class="value">${escapeHtml(card.value)}</div><div class="sub">${escapeHtml(card.sub)}</div></div>`).join('')}
          </div>
        </section>
        <section>
          <h2>Why this group flagged</h2>
          <ul>${signals || '<li>No deterministic signals (LLM-only flag).</li>'}</ul>
        </section>
        <section>
          <h2>Per-SKU canonical price ladder</h2>
          ${ladder}
          <div class="footer-note">Cost is the on-hand-weighted average wholesale cost across receiving lots. GM% uses the workspace pricing-rules formula <code>1 − 1.13 × cost / price</code>. Days of supply uses each SKU\u2019s own ${plan.aggregate.window.days}-day pace.</div>
        </section>
      </main>
    `,
  })
}

function renderGroupSkuTable(plan: RenderPlan, group: GroupRollup): string {
  if (group.products.length === 0) {
    return `<div class="empty">No products in this group.</div>`
  }
  const rows = [...group.products]
    .sort((a, b) => b.inventoryRetailValue - a.inventoryRetailValue)
    .map((product) => {
      const market = plan.marketByProductId.get(product.productId)
      if (!market) {
        throw new Error(
          `renderGroupSkuTable: product ${product.productId} (${product.productName}) is missing market enrichment; every candidate-group SKU must be enriched before rendering.`,
        )
      }
      const dosLabel =
        product.daysOfSupply === null
          ? '∞'
          : product.daysOfSupply >= 999
          ? '> 999'
          : String(product.daysOfSupply)
      const stLabel = product.sellThroughPct === null ? '—' : `${product.sellThroughPct}%`
      const ageLabel =
        product.daysSinceOldestReceived === null
          ? '—'
          : `${product.daysSinceOldestReceived}d`
      const productHref = `../products/${product.productId}.html`
      const ladderCell = market.unavailableReason
        ? renderLadderUnavailable(market.unavailableReason)
        : renderCanonicalLadder(market.ladder, product, 'compact')

      // The "data-href" + onclick pattern lets the entire row open the
      // product detail in a new tab without hijacking explicit anchors
      // (e.g. competitor dots) inside the row.
      return `
        <tr data-href="${productHref}" onclick="if(event.target.closest('a'))return; window.open('${productHref}','_blank','noopener');">
          <td>
            <div><a class="sku-link" href="${productHref}" target="_blank" rel="noopener">${escapeHtml(product.productName)}</a></div>
            <div style="font-size:11px;color:var(--fg-soft);">${escapeHtml(product.brand)} · #${product.productId}${product.subcategory ? ` · ${escapeHtml(product.subcategory)}` : ''}</div>
          </td>
          <td class="num">${product.retailPrice === null ? '—' : formatUsd(product.retailPrice)}</td>
          <td class="num">${product.cost === null ? '—' : formatUsd(product.cost)}</td>
          <td class="num">${product.grossMarginPct === null ? '—' : `${product.grossMarginPct}%`}</td>
          <td class="num">${formatNumber(product.onHandQty)}</td>
          <td class="num">${formatUsd(product.inventoryRetailValue)}</td>
          <td class="num">${formatNumber(product.windowUnitsSold)}</td>
          <td class="num">${dosLabel} / ${stLabel} / ${ageLabel}</td>
          <td class="ladder-cell">${ladderCell}</td>
        </tr>
      `
    })
    .join('')
  return `
    <table class="skus">
      <thead>
        <tr>
          <th style="width:18%;">Product</th>
          <th class="num" style="width:7%;">Current</th>
          <th class="num" style="width:6%;">Cost</th>
          <th class="num" style="width:6%;">GM %</th>
          <th class="num" style="width:6%;">On hand</th>
          <th class="num" style="width:8%;">Retail $</th>
          <th class="num" style="width:6%;">Units (win)</th>
          <th class="num" style="width:11%;">DOS / ST / Age</th>
          <th>Canonical price ladder (post-tax, NYC market)</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `
}

function renderProductDetail(
  plan: RenderPlan,
  group: GroupRollup,
  product: ProductRollup,
): string {
  const market = plan.marketByProductId.get(product.productId)
  if (!market) {
    throw new Error(
      `renderProductDetail: product ${product.productId} (${product.productName}) is missing market enrichment; every candidate-group SKU must be enriched before rendering.`,
    )
  }
  const ladderHtml = market.unavailableReason
    ? renderLadderUnavailable(market.unavailableReason)
    : renderCanonicalLadder(market.ladder, product, 'detail')
  const enumerated = renderMarketTable(market.competitorListings)
  const groupHref = `../groups/${encodeURIComponent(group.slug)}.html`

  const stats = market.ladder.stats
  const cards = [
    {
      label: 'Current price',
      value: product.retailPrice === null ? '—' : formatUsd(product.retailPrice),
      sub: product.cost === null ? '' : `cost ${formatUsd(product.cost)} · GM ${product.grossMarginPct ?? '—'}%`,
    },
    {
      label: 'Market median',
      value: stats.medianPostTax !== null ? formatUsd(stats.medianPostTax) : '—',
      sub: 'post-tax median across selected competitor listings',
    },
    {
      label: 'IQR (Q1–Q3)',
      value:
        stats.q1PostTax !== null && stats.q3PostTax !== null
          ? `${formatUsd(stats.q1PostTax)} – ${formatUsd(stats.q3PostTax)}`
          : '—',
      sub:
        stats.minPostTax !== null && stats.maxPostTax !== null
          ? `range ${formatUsd(stats.minPostTax)} – ${formatUsd(stats.maxPostTax)}`
          : '',
    },
    {
      label: 'Coverage',
      value: `${stats.totalCompCount} listing(s)`,
      sub: bandCountSummary(stats.bandCounts),
    },
    {
      label: 'On hand at Midtown',
      value: `${formatNumber(product.onHandQty)} units`,
      sub: `${formatUsd(product.inventoryRetailValue)} retail · oldest lot ${
        product.daysSinceOldestReceived ?? '—'
      }d`,
    },
    {
      label: 'Window pace',
      value: `${product.unitsPerDay}/day`,
      sub: `${formatNumber(product.windowUnitsSold)} units · ${formatUsd(product.windowNetSales)} net`,
    },
  ]

  const groupNote = `
    <div class="rationale">
      This SKU is part of the <a class="row-link" href="${groupHref}" target="_blank" rel="noopener">${escapeHtml(group.label)}</a>
      slow-mover proposal — the recommended action is a <strong>${group.scope === 'category' ? 'whole-category' : 'category × brand'}</strong>
      promo, not a single-SKU price change. The canonical ladder below is reviewer evidence that the proposed group-level discount sits cleanly inside the local market.
      <span class="source">Group opportunity score: ${group.opportunityScore} · ${group.signals.map((s) => s.kind).join(', ') || 'no deterministic signals'}</span>
    </div>
  `

  return baseTemplate({
    title: `${product.productName} — competitor ladder`,
    bodyClass: 'product-detail',
    body: `
      <header class="detail">
        <a class="back-link" href="${groupHref}">Back to ${escapeHtml(group.label)}</a>
        <h1 style="margin-top:8px;">${escapeHtml(product.productName)}</h1>
        <div class="subtitle">${escapeHtml(product.brand)} · ${escapeHtml(product.category)}${product.subcategory ? ` · ${escapeHtml(product.subcategory)}` : ''} · Sweed product #${product.productId}</div>
        <div class="meta">${escapeHtml(plan.site.label)} · generated ${escapeHtml(plan.generatedAt)}${
          market.searchTerm ? ` · Lit Alerts search "${escapeHtml(market.searchTerm)}"` : ''
        }</div>
      </header>
      <main>
        <section>${groupNote}</section>
        <section>
          <h2>Snapshot</h2>
          <div class="cards">
            ${cards.map((card) => `<div class="card"><div class="label">${escapeHtml(card.label)}</div><div class="value">${escapeHtml(card.value)}</div><div class="sub">${escapeHtml(card.sub)}</div></div>`).join('')}
          </div>
        </section>
        <section>
          <h2>Canonical price ladder (post-tax, NYC market)</h2>
          ${ladderHtml}
        </section>
        <section>
          <h2>Enumerated market prices</h2>
          ${enumerated}
        </section>
      </main>
    `,
  })
}

function renderCanonicalLadder(
  ladder: LadderGeometry,
  product: ProductRollup,
  variant: 'compact' | 'detail',
): string {
  // Build the head row (current price + GM) so the ladder shows context
  // without forcing the renderer to know domain-specific metrics.
  const currentBit =
    product.retailPrice !== null
      ? `<span class="metric">Current ${formatUsd(product.retailPrice)}<span class="metric-detail"> (${product.grossMarginPct ?? '—'}% GM)</span></span>`
      : ''
  const headHtml = currentBit ? currentBit : undefined
  // The geometry's productId is set by the enrich step; pass through the
  // pre-built geometry so we don't recompute or override anchors.
  return renderPricingLadderFromGeometry(
    ladder,
    {
      productId: ladder.productId,
      livePrice: product.retailPrice,
      proposedPrice: null,
      marketAveragePostTax: null,
      marketMedianPostTax: ladder.stats.medianPostTax,
      competitorListings: [],
    },
    {
      variant,
      headHtml,
      productLabel: product.productName,
      includeLegend: true,
      includeMeta: variant === 'detail',
    },
  )
}

function renderLadderUnavailable(reason: string): string {
  return `<div class="no-ladder">${escapeHtml(reason)}</div>`
}

function bandCountSummary(bandCounts: Record<string, number>): string {
  const order: Array<[string, string]> = [
    ['very-near', '≤2 mi'],
    ['near', '2–5 mi'],
    ['mid', '5–15 mi'],
    ['far', '15–50 mi'],
    ['statewide', '>50 mi'],
  ]
  const parts = order
    .filter(([key]) => (bandCounts[key] ?? 0) > 0)
    .map(([key, label]) => `${bandCounts[key]} ${label}`)
  return parts.join(' · ') || 'no banded listings'
}

function renderMarketTable(listings: CompetitorListing[]): string {
  if (listings.length === 0) {
    return `<div class="no-ladder">No competitor listings to enumerate.</div>`
  }
  const rows = [...listings]
    .sort((a, b) => a.postPrice - b.postPrice)
    .map((listing) => {
      const bandClass = canonicalBandClassFor(listing.distanceMiles)
      const distanceText =
        listing.distanceMiles !== null ? `${listing.distanceMiles.toFixed(2)}mi` : '—'
      const url = listing.url
      const linkCell = url
        ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open listing</a>`
        : '—'
      return `
        <tr class="market-row source-${listing.source}">
          <td class="price">${formatUsd(listing.postPrice)}</td>
          <td>${escapeHtml(listing.productName)}</td>
          <td>${escapeHtml(listing.dispensaryName ?? '—')}</td>
          <td>${escapeHtml(listing.dispensaryAddress ?? '—')}</td>
          <td><span class="distance-band-chip ${bandClass}">${escapeHtml(distanceText)}</span></td>
          <td>${escapeHtml(listing.source)}</td>
          <td>${linkCell}</td>
        </tr>
      `
    })
    .join('')
  return `
    <table class="market-table">
      <thead>
        <tr>
          <th>Post-tax</th>
          <th>Competitor product</th>
          <th>Dispensary</th>
          <th>Address</th>
          <th>Distance</th>
          <th>Source</th>
          <th>Listing</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `
}

function canonicalBandClassFor(miles: number | null): string {
  if (miles === null || !Number.isFinite(miles)) return 'band-statewide'
  if (miles <= 2) return 'band-very-near'
  if (miles <= 5) return 'band-near'
  if (miles <= 15) return 'band-mid'
  if (miles <= 50) return 'band-far'
  return 'band-statewide'
}

function baseTemplate(input: { title: string; bodyClass: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(input.title)}</title>
  <style>${STYLE_BLOCK}</style>
</head>
<body class="${escapeHtml(input.bodyClass)}">
${input.body}
</body>
</html>
`
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0)
}

function formatUsd(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 })
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
