#!/usr/bin/env -S npx tsx
/**
 * One-off HTML sanity check for the catalog-brand ↔ LitAlerts-brand
 * mapping (issue #20).
 *
 * For every distinct `brand_name` we carry in `catalog_groups`, find
 * the best matching row in `litalerts_brands` and render:
 *   - the catalog name + group count
 *   - the matched LitAlerts brand id + name + state(s) + observed
 *     product/config volume from `litalerts_products`
 *   - a confidence band (exact / case-insensitive / token-overlap / none)
 *
 * Writes the report to a local HTML file. Upload via:
 *   scripts/upload-to-mss <html-path> "litalerts brand mapping sanity check" 86400
 */

import { writeFileSync } from 'node:fs'

import { Pool } from 'pg'
import { readRequiredReadOnlyDatabaseUrl } from '../src/shared/config/runtimeEnv.js'

interface CatalogBrand {
  brandName: string
  groupCount: number
}

interface LitalertsBrand {
  brandId: number
  name: string
  statesCsv: string | null
  lastSeenAt: string
  productCount: number
  configCount: number
}

type Confidence = 'exact' | 'case-insensitive' | 'normalized' | 'token-overlap' | 'none'

interface MappingRow {
  catalog: CatalogBrand
  match: LitalertsBrand | null
  alternates: LitalertsBrand[]
  confidence: Confidence
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(co|company|cannabis|brands?|llc|inc|corp)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function tokenSet(s: string): Set<string> {
  return new Set(normalize(s).split(/\s+/).filter((t) => t.length >= 3))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const x of a) if (b.has(x)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

async function main(): Promise<void> {
  const databaseUrl = readRequiredReadOnlyDatabaseUrl()
  const outPath = process.argv[2] ?? '/tmp/litalerts-brand-mapping-sanity.html'
  const pool = new Pool({ connectionString: databaseUrl })

  console.log('loading catalog brands…')
  const catalogResult = await pool.query<{ brand_name: string; group_count: string }>(
    `select brand_name, count(*)::text as group_count
       from catalog_groups
       where brand_name is not null and length(trim(brand_name)) > 0
       group by brand_name
       order by count(*) desc, brand_name asc`,
  )
  const catalog: CatalogBrand[] = catalogResult.rows.map((r) => ({
    brandName: r.brand_name,
    groupCount: Number(r.group_count),
  }))
  console.log(`  catalog: ${catalog.length} distinct brands`)

  console.log('loading LitAlerts brand directory + product volumes…')
  const lbResult = await pool.query<{
    brand_id: string
    name: string
    states_csv: string | null
    last_seen_at: string
    product_count: string
    config_count: string
  }>(
    `select lb.brand_id::text as brand_id,
            lb.name,
            lb.states_csv,
            lb.last_seen_at::text as last_seen_at,
            coalesce(p.product_count, 0)::text as product_count,
            coalesce(p.config_count, 0)::text as config_count
       from litalerts_brands lb
       left join (
         select brand_id,
                count(distinct product_id) as product_count,
                count(*) as config_count
           from litalerts_products
           where state_code = 'NY'
           group by brand_id
       ) p on p.brand_id = lb.brand_id
       where lb.state_code = 'NY'
       order by lb.name asc`,
  )
  const litalerts: LitalertsBrand[] = lbResult.rows.map((r) => ({
    brandId: Number(r.brand_id),
    name: r.name,
    statesCsv: r.states_csv,
    lastSeenAt: r.last_seen_at,
    productCount: Number(r.product_count),
    configCount: Number(r.config_count),
  }))
  console.log(`  litalerts: ${litalerts.length} brand rows in NY`)

  // Build matching indexes
  const lbByExact = new Map<string, LitalertsBrand>()
  const lbByLower = new Map<string, LitalertsBrand>()
  const lbByNorm = new Map<string, LitalertsBrand>()
  for (const lb of litalerts) {
    lbByExact.set(lb.name, lb)
    lbByLower.set(lb.name.toLowerCase().trim(), lb)
    lbByNorm.set(normalize(lb.name), lb)
  }

  const rows: MappingRow[] = catalog.map((c) => {
    const exact = lbByExact.get(c.brandName)
    if (exact) return { catalog: c, match: exact, alternates: [], confidence: 'exact' }
    const lower = lbByLower.get(c.brandName.toLowerCase().trim())
    if (lower) return { catalog: c, match: lower, alternates: [], confidence: 'case-insensitive' }
    const norm = lbByNorm.get(normalize(c.brandName))
    if (norm) return { catalog: c, match: norm, alternates: [], confidence: 'normalized' }
    // token-overlap fallback
    const cTokens = tokenSet(c.brandName)
    if (cTokens.size === 0) return { catalog: c, match: null, alternates: [], confidence: 'none' }
    const scored = litalerts
      .map((lb) => ({ lb, score: jaccard(cTokens, tokenSet(lb.name)) }))
      .filter((s) => s.score >= 0.5)
      .sort((a, b) => b.score - a.score)
    if (scored.length > 0) {
      return {
        catalog: c,
        match: scored[0].lb,
        alternates: scored.slice(1, 4).map((s) => s.lb),
        confidence: 'token-overlap',
      }
    }
    return { catalog: c, match: null, alternates: [], confidence: 'none' }
  })

  const conf = (k: Confidence): number => rows.filter((r) => r.confidence === k).length
  const totals = {
    catalog: rows.length,
    exact: conf('exact'),
    caseInsensitive: conf('case-insensitive'),
    normalized: conf('normalized'),
    tokenOverlap: conf('token-overlap'),
    none: conf('none'),
  }
  const matchedRate = ((rows.length - totals.none) / Math.max(1, rows.length)) * 100

  // Reverse direction: top LitAlerts NY brands by product volume that
  // we do NOT carry — useful for "brands we may want to add".
  const matchedLbIds = new Set(rows.map((r) => r.match?.brandId).filter((x): x is number => x != null))
  const orphans = litalerts
    .filter((lb) => !matchedLbIds.has(lb.brandId) && lb.productCount > 0)
    .sort((a, b) => b.productCount - a.productCount)
    .slice(0, 100)

  const html = renderHtml({ rows, totals, matchedRate, orphans })
  writeFileSync(outPath, html, 'utf8')
  console.log(`wrote ${outPath} (${(html.length / 1024).toFixed(1)} KiB)`)
  console.log(
    `summary: catalog=${totals.catalog} exact=${totals.exact} case=${totals.caseInsensitive} ` +
      `norm=${totals.normalized} token=${totals.tokenOverlap} none=${totals.none} ` +
      `match-rate=${matchedRate.toFixed(1)}%`,
  )

  await pool.end()
}

function escapeHtml(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function confBadge(c: Confidence): string {
  const color = c === 'exact' ? '#1e7a1e'
    : c === 'case-insensitive' ? '#3a8c3a'
    : c === 'normalized' ? '#937700'
    : c === 'token-overlap' ? '#a55300'
    : '#a01818'
  return `<span style="background:${color};color:white;padding:1px 6px;border-radius:3px;font-size:0.75rem">${c}</span>`
}

function renderHtml(args: {
  rows: MappingRow[]
  totals: { catalog: number; exact: number; caseInsensitive: number; normalized: number; tokenOverlap: number; none: number }
  matchedRate: number
  orphans: LitalertsBrand[]
}): string {
  const { rows, totals, matchedRate, orphans } = args
  const rowsHtml = rows
    .map((r) => {
      const match = r.match
      const alt = r.alternates.length > 0
        ? `<details><summary>${r.alternates.length} alt</summary><ul>${r.alternates
            .map((a) => `<li>#${a.brandId} ${escapeHtml(a.name)} (${a.productCount} prod)</li>`)
            .join('')}</ul></details>`
        : ''
      return `<tr>
        <td>${escapeHtml(r.catalog.brandName)}</td>
        <td style="text-align:right">${r.catalog.groupCount}</td>
        <td>${confBadge(r.confidence)}</td>
        <td>${match ? `#${match.brandId} <strong>${escapeHtml(match.name)}</strong>` : '<em style="color:#a01818">— no match —</em>'}</td>
        <td style="text-align:right">${match?.productCount ?? '—'}</td>
        <td style="text-align:right">${match?.configCount ?? '—'}</td>
        <td>${alt}</td>
      </tr>`
    })
    .join('\n')

  const orphansHtml = orphans
    .map(
      (o) => `<tr>
        <td>#${o.brandId}</td>
        <td>${escapeHtml(o.name)}</td>
        <td style="text-align:right">${o.productCount}</td>
        <td style="text-align:right">${o.configCount}</td>
      </tr>`,
    )
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>LitAlerts brand mapping sanity check</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 1rem 2rem; color: #222; }
  h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }
  .summary { background: #f4f4f4; padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 1rem; font-size: 0.95rem; }
  .summary strong { font-size: 1.1rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  th, td { border-bottom: 1px solid #eee; padding: 0.35rem 0.5rem; vertical-align: top; }
  th { background: #fafafa; text-align: left; position: sticky; top: 0; }
  tr:nth-child(odd) td { background: #fcfcfc; }
  details summary { cursor: pointer; color: #555; }
  details ul { margin: 0.25rem 0 0.25rem 1rem; padding: 0; }
  section { margin-top: 1.5rem; }
</style>
</head>
<body>
  <h1>LitAlerts brand mapping sanity check</h1>
  <div class="summary">
    <strong>${matchedRate.toFixed(1)}%</strong> of ${totals.catalog} catalog brands matched a LitAlerts NY brand.
    &nbsp;exact: <strong>${totals.exact}</strong>
    &nbsp;case-insensitive: <strong>${totals.caseInsensitive}</strong>
    &nbsp;normalized: <strong>${totals.normalized}</strong>
    &nbsp;token-overlap: <strong>${totals.tokenOverlap}</strong>
    &nbsp;<span style="color:#a01818">none: <strong>${totals.none}</strong></span>
  </div>

  <details open>
    <summary><strong>About this page</strong></summary>
    <p style="font-size:0.9rem;color:#555;max-width:60rem">
      Auto-generated from <code>catalog_groups.brand_name</code> joined against
      <code>litalerts_brands</code> (state_code=NY) and aggregated
      <code>litalerts_products</code> counts. Match tiers (in priority order):
      <em>exact</em> string equality;
      <em>case-insensitive</em> trimmed lowercase equality;
      <em>normalized</em> strips noise words (Cannabis, Co, LLC, …) plus non-alnum;
      <em>token-overlap</em> Jaccard similarity ≥ 0.5 on tokens of length ≥ 3.
      A "none" row is the explicit ask to either (a) tell us the LitAlerts brand id
      this catalog brand maps to, or (b) confirm we should leave it unmapped.
    </p>
  </details>

  <section>
    <h2 style="font-size:1.1rem">Catalog → LitAlerts mapping</h2>
    <table>
      <thead>
        <tr>
          <th>Catalog brand</th>
          <th style="text-align:right">groups</th>
          <th>match tier</th>
          <th>LitAlerts brand</th>
          <th style="text-align:right">prods</th>
          <th style="text-align:right">configs</th>
          <th>alternates</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
  </section>

  <section>
    <h2 style="font-size:1.1rem">Top 100 LitAlerts NY brands we do <em>not</em> carry</h2>
    <p style="font-size:0.9rem;color:#555">Ordered by NY product volume — candidates for catalog expansion (or evidence that our matcher missed a real overlap).</p>
    <table>
      <thead>
        <tr>
          <th style="width:6rem">brandId</th>
          <th>LitAlerts brand</th>
          <th style="text-align:right">products</th>
          <th style="text-align:right">configs</th>
        </tr>
      </thead>
      <tbody>
        ${orphansHtml}
      </tbody>
    </table>
  </section>
</body>
</html>`
}

void main()
