/**
 * Slow-mover promo packet generator.
 *
 * Pulls the trailing N-day live sales history and live grouped inventory
 * for the chosen Sweed site, identifies category and category x brand groups
 * that are not moving, and emits a static reviewer HTML packet.
 *
 * Usage:
 *   npx tsx scripts/slow-mover-promo/index.ts \
 *     [--site=midtown] [--days=14] [--out=out/slow-mover-promo] [--no-llm]
 *
 * Auth:
 *   - Sweed:  reads $SWEED_AUTH_TOKEN or /Users/amp-local/.secret/sweed/auth-token
 *   - Mantle: reads $BEDROCK_MANTLE_BEARER_TOKEN or
 *             /Users/amp-local/.secret/bedrock/mantle-bearer-token
 *
 * The packet is intentionally self-contained (single CSS block, no external
 * assets) so it can be served by Helios later without rewriting markup.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import {
  DEFAULT_SCORING,
  aggregateSlowMovers,
  type GroupRollup,
} from './lib/aggregate.js'
import {
  MIDTOWN_SITE,
  buildSalesWindow,
  loadLiveInventory,
  loadSiteSales,
  type SiteScope,
} from './lib/data.js'
import { enrichGroupsWithCompetitors } from './lib/enrich.js'
import { llmRankAndRationalize, loadMantleConfig, type GroupSummaryForLlm } from './lib/mantle.js'
import { renderPacket } from './lib/render.js'
import { loadSweedClientConfig } from './lib/sweed.js'

interface CliOptions {
  site: SiteScope
  days: number
  outDir: string
  useLlm: boolean
  enrichCompetitors: boolean
  todayIso: string | undefined
}

function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = {
    site: MIDTOWN_SITE,
    days: 14,
    outDir: 'out/slow-mover-promo',
    useLlm: true,
    enrichCompetitors: true,
    todayIso: undefined,
  }
  for (const arg of argv) {
    if (arg.startsWith('--site=')) {
      const value = arg.slice('--site='.length)
      if (value === 'midtown') opts.site = MIDTOWN_SITE
      else throw new Error(`Unknown --site value: ${value}. Supported: midtown.`)
    } else if (arg.startsWith('--days=')) {
      const value = Number.parseInt(arg.slice('--days='.length), 10)
      if (!Number.isFinite(value) || value < 1 || value > 90) {
        throw new Error(`--days must be 1..90 (got: ${arg})`)
      }
      opts.days = value
    } else if (arg.startsWith('--out=')) {
      opts.outDir = arg.slice('--out='.length)
    } else if (arg === '--no-llm') {
      opts.useLlm = false
    } else if (arg === '--no-enrich') {
      opts.enrichCompetitors = false
    } else if (arg.startsWith('--today=')) {
      opts.todayIso = arg.slice('--today='.length)
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        `Usage: npx tsx scripts/slow-mover-promo/index.ts [--site=midtown] [--days=14] [--out=out/slow-mover-promo] [--no-llm] [--no-enrich] [--today=YYYY-MM-DD]`,
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return opts
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2))
  const sweedConfig = loadSweedClientConfig()
  const window = buildSalesWindow(cli.days, cli.todayIso)

  console.log(
    `[slow-mover-promo] site=${cli.site.label} (dealer ${cli.site.dealerId}) days=${cli.days} window=${window.startDate}..${window.endDate}`,
  )

  // 1) Pull both data sources. Inventory + sales pull through the same dealer
  //    session lock so they can't race; this also keeps the BI JWT fetch tied
  //    to the site context.
  console.log('[slow-mover-promo] pulling live grouped inventory ...')
  const inventory = await loadLiveInventory(sweedConfig, cli.site)
  console.log(`[slow-mover-promo]   ${inventory.totalProducts} on-hand products`)

  console.log('[slow-mover-promo] pulling Cube sales for the window ...')
  const sales = await loadSiteSales(sweedConfig, cli.site, window)
  console.log(
    `[slow-mover-promo]   ${sales.byCategory.length} categories / ${sales.byCategoryBrand.length} category-brand rows / ${sales.byProduct.length} product rows`,
  )

  // 2) Deterministic aggregation + scoring.
  const aggregate = aggregateSlowMovers({ inventory, sales }, DEFAULT_SCORING)
  console.log(
    `[slow-mover-promo] candidate groups (deterministic): ${aggregate.candidateGroups.length}`,
  )

  // 3) Optional LLM re-rank + rationale + executive summary.
  let llm = {
    rankedSlugs: [] as string[],
    rationaleBySlug: {} as Record<string, string>,
    executiveSummary: '',
    used: false,
    note: 'disabled',
  }
  const mantle = cli.useLlm ? loadMantleConfig() : null
  if (cli.useLlm && mantle) {
    try {
      console.log('[slow-mover-promo] calling Mantle for rank + rationale + summary ...')
      const summaries = aggregate.candidateGroups.map(toLlmSummary)
      const result = await llmRankAndRationalize(
        mantle,
        window.days,
        cli.site.label,
        summaries,
      )
      llm = {
        rankedSlugs: result.rankedSlugs,
        rationaleBySlug: result.rationaleBySlug,
        executiveSummary: result.executiveSummary,
        used: true,
        note: `${mantle.model} via Bedrock Mantle (slow-mover-promo-group-ranking-and-rationale, limited-trial)`,
      }
      console.log(
        `[slow-mover-promo]   LLM ranked ${result.rankedSlugs.length}, wrote ${Object.keys(result.rationaleBySlug).length} rationales, ${result.executiveSummary ? 'and an executive summary' : 'no executive summary'}`,
      )
    } catch (error) {
      console.warn(
        `[slow-mover-promo] LLM step failed; falling back to deterministic ordering: ${error instanceof Error ? error.message : String(error)}`,
      )
      llm.note = `Mantle unavailable: ${error instanceof Error ? error.message : String(error)}`
    }
  } else if (!cli.useLlm) {
    llm.note = 'disabled by --no-llm'
  } else {
    llm.note = 'BEDROCK_MANTLE_BEARER_TOKEN not configured'
    console.log('[slow-mover-promo] Mantle disabled (token not configured); using deterministic ordering only.')
  }

  // 4) Optional Lit Alerts competitor enrichment for each candidate group's
  //    SKUs. Used for the canonical price-ladder UI on group/product pages.
  const enrichment = await enrichGroupsWithCompetitors(aggregate.candidateGroups, {
    enabled: cli.enrichCompetitors,
    log: (line) => console.log(`[slow-mover-promo][enrich] ${line}`),
  })
  console.log(
    `[slow-mover-promo] competitor enrichment: used=${enrichment.used} (${enrichment.note}); ${enrichment.byProductId.size} product(s) enriched`,
  )

  // 5) Render and write the packet.
  const generatedAt = new Date().toISOString()
  const siteWideSales = {
    windowNetSales: sales.byCategory.reduce((sum, row) => sum + row.netSales, 0),
    windowUnits: sales.byCategory.reduce((sum, row) => sum + row.units, 0),
  }
  const renderedFiles = renderPacket({
    generatedAt,
    site: cli.site,
    aggregate,
    llm,
    siteWideSales,
    marketByProductId: enrichment.byProductId,
  })
  const outDir = resolve(cli.outDir)
  for (const file of renderedFiles) {
    const fullPath = resolve(outDir, file.path)
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, file.html, 'utf8')
  }

  // 5) Persist the JSON so a future Helios route can consume the same data
  //    without re-pulling. This is also useful for diff'ing runs.
  const dataPath = resolve(outDir, 'data.json')
  writeFileSync(
    dataPath,
    JSON.stringify(
      {
        generatedAt,
        site: cli.site,
        window,
        scoring: DEFAULT_SCORING,
        llm,
        siteWideSales: {
          windowNetSales: sales.byCategory.reduce((sum, row) => sum + row.netSales, 0),
          windowUnits: sales.byCategory.reduce((sum, row) => sum + row.units, 0),
          windowGrossMargin: sales.byCategory.reduce((sum, row) => sum + row.grossMargin, 0),
          windowPromoDiscount: sales.byCategory.reduce((sum, row) => sum + row.promoDiscount, 0),
        },
        aggregate,
      },
      null,
      2,
    ),
    'utf8',
  )

  console.log(`[slow-mover-promo] wrote ${renderedFiles.length} HTML file(s) and data.json under ${outDir}`)
  console.log(`[slow-mover-promo] open: ${resolve(outDir, 'index.html')}`)
}

function toLlmSummary(group: GroupRollup): GroupSummaryForLlm {
  return {
    slug: group.slug,
    label: group.label,
    scope: group.scope,
    category: group.category,
    brand: group.brand,
    productCount: group.products.length,
    onHandQty: group.onHandQty,
    inventoryRetailValueUsd: group.inventoryRetailValue,
    windowUnitsSold: group.windowUnitsSold,
    windowNetSalesUsd: group.windowNetSales,
    blendedGrossMarginPct: group.blendedGrossMarginPct,
    daysOfSupply: group.daysOfSupply,
    sellThroughPct: group.sellThroughPct,
    daysSinceOldestReceived: group.daysSinceOldestReceived,
    signalSummary: group.signals.map((s) => `${s.kind}(+${s.weight}): ${s.detail}`),
  }
}

main().catch((error) => {
  console.error('[slow-mover-promo] FATAL:', error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})
