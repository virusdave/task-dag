// Operator-triggered batch importer for Search Console / GA4 export CSVs
// (P5 first slice — parent epic virusdave/top-level#15, child epic
// FreshlyBakedNYC/automation#44).
//
// Imports an OPERATOR-SUPPLIED Google export CSV (no new API credentials —
// epic §0.4) into the seo_gsc_daily / seo_ga4_daily fact tables via the
// idempotent, write-on-change upserts in
// src/server/db/queries/seoMetricsQueries.ts. Re-importing an overlapping
// date range is safe: unchanged rows produce no write; GSC-restated freshest
// days update in place.
//
// Usage:
//   DATABASE_URL=postgres://... \
//     npx tsx scripts/import-seo-metrics.ts \
//       --source=gsc --file=./Performance.csv \
//       --property='sc-domain:freshlybaked.nyc' --site=all \
//       [--timezone=America/Los_Angeles] [--search-type=web] \
//       [--device=all] [--country=all] [--imported-by=dave] [--dry-run]
//
//   DATABASE_URL=postgres://... \
//     npx tsx scripts/import-seo-metrics.ts \
//       --source=ga4 --file=./ga4-pages.csv \
//       --property='properties/123456789' --site=all \
//       [--base-url=https://freshlybaked.nyc] \
//       [--traffic-scope=organic_search] [--timezone=America/New_York]

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

import { closePool, getPool } from '../src/server/db/pool.js'
import {
  bulkUpsertGa4DailyRows,
  bulkUpsertGscDailyRows,
  completeImportBatch,
  createImportBatch,
  failImportBatch,
  type UpsertCounts,
} from '../src/server/db/queries/seoMetricsQueries.js'
import {
  dedupeByRowKey,
  newImportBatchId,
  parseGa4Csv,
  parseGscCsv,
  type Ga4DailyInput,
  type GscDailyInput,
  type MetricSource,
  type ParseResult,
} from '../src/server/seo/metricsImport.js'

function arg(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`
  const hit = args.find((a) => a.startsWith(prefix))
  return hit?.slice(prefix.length)
}

function requireArg(args: string[], name: string): string {
  const v = arg(args, name)
  if (v === undefined || v === '') {
    throw new Error(`missing required --${name}=<value>`)
  }
  return v
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[import-seo-metrics] ${msg}`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const source = requireArg(args, 'source') as MetricSource
  if (source !== 'gsc' && source !== 'ga4') {
    throw new Error(`--source must be 'gsc' or 'ga4', got '${source}'`)
  }
  const file = requireArg(args, 'file')
  const property = requireArg(args, 'property')
  const site = requireArg(args, 'site')
  const dryRun = args.includes('--dry-run')
  const importedBy = arg(args, 'imported-by') ?? process.env.USER ?? null

  const text = readFileSync(file, 'utf8')
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex')
  const tz =
    arg(args, 'timezone') ?? (source === 'gsc' ? 'America/Los_Angeles' : 'America/New_York')

  // Parse + de-dupe (ON CONFLICT can't touch a row twice) per source so the
  // concrete row types stay intact, then hand off to the matching upserter.
  if (source === 'gsc') {
    const parsed = parseGscCsv(text, {
      property,
      site,
      sourceTimezone: arg(args, 'timezone'),
      searchType: arg(args, 'search-type'),
      device: arg(args, 'device'),
      country: arg(args, 'country'),
    })
    const deduped = dedupeByRowKey<GscDailyInput>(parsed.rows)
    reportParse(parsed, deduped.duplicatesCollapsed)
    if (dryRun || deduped.rows.length === 0) {
      log(
        dryRun
          ? `dry-run: would upsert ${deduped.rows.length} row(s); no DB writes`
          : 'nothing to import (0 valid rows); not creating a batch',
      )
      return
    }
    await runImport(parsed, deduped.rows, 'gsc', (db, id, rows) =>
      bulkUpsertGscDailyRows(db, id, rows),
    )
  } else {
    const parsed = parseGa4Csv(text, {
      property,
      site,
      sourceTimezone: arg(args, 'timezone'),
      trafficScope: arg(args, 'traffic-scope'),
      baseUrl: arg(args, 'base-url'),
    })
    const deduped = dedupeByRowKey<Ga4DailyInput>(parsed.rows)
    reportParse(parsed, deduped.duplicatesCollapsed)
    if (dryRun || deduped.rows.length === 0) {
      log(
        dryRun
          ? `dry-run: would upsert ${deduped.rows.length} row(s); no DB writes`
          : 'nothing to import (0 valid rows); not creating a batch',
      )
      return
    }
    await runImport(parsed, deduped.rows, 'ga4', (db, id, rows) =>
      bulkUpsertGa4DailyRows(db, id, rows),
    )
  }

  // ── shared import driver (batch row + upsert + completion bookkeeping) ──
  async function runImport<T>(
    parsed: ParseResult<T>,
    rows: readonly T[],
    src: MetricSource,
    upsert: (db: ReturnType<typeof getPool>, id: string, rows: readonly T[]) => Promise<UpsertCounts>,
  ): Promise<void> {
    const db = getPool()
    const importBatchId = newImportBatchId()
    await createImportBatch(db, {
      import_batch_id: importBatchId,
      source: src,
      property,
      site,
      source_timezone: tz,
      source_file_name: basename(file),
      source_file_sha256: sha256,
      export_start_date: parsed.exportStartDate,
      export_end_date: parsed.exportEndDate,
      imported_by: importedBy,
    })
    try {
      const counts = await upsert(db, importBatchId, rows)
      await completeImportBatch(db, importBatchId, {
        rowsSeen: parsed.rowsSeen,
        inserted: counts.inserted,
        updated: counts.updated,
        unchanged: counts.unchanged,
        rejected: parsed.rowsRejected,
      })
      log(
        `batch ${importBatchId} completed: ` +
          `${counts.inserted} inserted, ${counts.updated} updated, ${counts.unchanged} unchanged`,
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await failImportBatch(db, importBatchId, msg)
      throw e
    }
  }
}

function reportParse<T>(parsed: ParseResult<T>, duplicatesCollapsed: number): void {
  log(
    `parsed ${parsed.rowsSeen} row(s): ${parsed.rows.length} valid, ` +
      `${parsed.rowsRejected} rejected; range ${parsed.exportStartDate ?? '—'}..${parsed.exportEndDate ?? '—'}`,
  )
  for (const r of parsed.rejections.slice(0, 20)) {
    log(`  rejected: ${r}`)
  }
  if (parsed.rejections.length > 20) {
    log(`  …and ${parsed.rejections.length - 20} more rejection(s)`)
  }
  if (duplicatesCollapsed > 0) {
    log(`collapsed ${duplicatesCollapsed} duplicate row_key(s) within the file`)
  }
}

main()
  .then(async () => {
    await closePool()
    process.exit(0)
  })
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error(`[import-seo-metrics] FAILED: ${err instanceof Error ? err.message : err}`)
    await closePool()
    process.exit(1)
  })
