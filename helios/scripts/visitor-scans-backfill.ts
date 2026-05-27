// Operator-run backfill for the visitor_scans table.
//
// virusdave/top-level#9 / FreshlyBakedNYC/automation#31, phase A2.
//
// Ingests the historical VeriScan export the operator hands over
// (originally fetched from Drive and placed on vps-nixos-3) into the
// same `visitor_scans` table the live webhook handler writes to. The
// insert path is shared: both the webhook handler
// (helios/src/server/routes/visitorScans.ts) and this script call
// `insertVisitorScan` so a backfilled row and a webhook-delivered
// row for the same VeriScan check-in collapse to one row via the
// `(provider, hash_id)` unique constraint.
//
// The backfill file is a flat row dump (one VeriScan `Data` shape
// per row), not a wire envelope; this script synthesises an
// envelope around each row with:
//
//   - Type='CreateCard'
//   - WebHookId=0
//   - EventId=<stable hash of HashId>     (so re-runs are
//     byte-identical in raw_envelope, not merely no-op via the
//     unique constraint)
//   - Created=Sent=<file mtime ISO>       (so all rows in a single
//     backfill file share an envelope timestamp, distinguishing the
//     historical pass from per-event webhook arrivals)
//
// Usage:
//
//   DATABASE_URL=postgres://... \
//     npx tsx scripts/visitor-scans-backfill.ts \
//         --site=bx --provider=veriscan \
//         --file=/var/lib/helios/backfill/veriscan-2026-05-27.json
//
//   add --dry-run to print the would-be inserts as JSON Lines without
//   writing to the database.
//
// Accepts JSON-array, NDJSON, or CSV input (sniffed from extension +
// content). Reports `inserted=`, `skipped_duplicate=`, `errored=`
// counts at the end. A malformed individual row is counted under
// `errored=` and does NOT abort the run — the rest of the file
// continues to be processed (matches the spec in
// FreshlyBakedNYC/automation#31 A2).

import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'

import { closePool, getPool } from '../src/server/db/pool.js'
import { insertVisitorScan } from '../src/server/db/queries/visitorScansQueries.js'
import {
  VeriScanDataSchema,
  envelopeToRowInput,
  type VeriScanEnvelope,
} from '../src/server/visitorScans/envelope.js'
import {
  parseBackfillFile,
  reshapeFlatRowToData,
  type BackfillSourceFormat,
} from '../src/server/visitorScans/backfill.js'

interface BackfillCliOptions {
  site: string
  provider: string
  file: string
  dryRun: boolean
}

function parseArgs(argv: readonly string[]): BackfillCliOptions {
  let site: string | null = null
  let provider: string | null = null
  let file: string | null = null
  let dryRun = false

  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true
    } else if (arg.startsWith('--site=')) {
      site = arg.slice('--site='.length)
    } else if (arg.startsWith('--provider=')) {
      provider = arg.slice('--provider='.length)
    } else if (arg.startsWith('--file=')) {
      file = arg.slice('--file='.length)
    } else if (arg === '--help' || arg === '-h') {
      printUsageAndExit(0)
    } else {
      console.error(`unknown argument: ${arg}`)
      printUsageAndExit(2)
    }
  }

  if (site === null || site.length === 0) {
    console.error('--site=<bx|mh> is required')
    printUsageAndExit(2)
  }
  if (provider === null || provider.length === 0) {
    console.error('--provider=veriscan is required')
    printUsageAndExit(2)
  }
  if (file === null || file.length === 0) {
    console.error('--file=<path> is required')
    printUsageAndExit(2)
  }

  return { site: site as string, provider: provider as string, file: file as string, dryRun }
}

function printUsageAndExit(code: number): never {
  console.error(
    [
      'Usage:',
      '  visitor-scans-backfill --site=<bx|mh> --provider=veriscan --file=<path> [--dry-run]',
      '',
      'Accepted file shapes:',
      '  *.json    a JSON array of flat VeriScan-`Data`-shaped objects',
      '  *.ndjson  one flat VeriScan-`Data`-shaped object per line',
      '  *.csv     header row + comma-separated VeriScan-`Data` columns',
      '',
      'The script reshapes each row into a synthesised VeriScan envelope',
      '(Type=CreateCard, WebHookId=0, EventId=stable-hash-of-HashId) and',
      'feeds it through the same insert helper the live webhook handler',
      'uses, with ON CONFLICT (provider, hash_id) DO NOTHING.',
    ].join('\n'),
  )
  process.exit(code)
}

interface Counters {
  inserted: number
  skippedDuplicate: number
  errored: number
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))

  const filePath = path.resolve(opts.file)
  const stat = await fs.stat(filePath)
  const mtimeIso = stat.mtime.toISOString()
  const buffer = await fs.readFile(filePath)

  const detectedFormat: BackfillSourceFormat = detectFormat(filePath, buffer)
  console.log(
    `[visitor-scans-backfill] file=${filePath} format=${detectedFormat} bytes=${buffer.length}`,
  )

  const rows = parseBackfillFile(buffer, detectedFormat)
  console.log(`[visitor-scans-backfill] parsed ${rows.length} row(s); dryRun=${opts.dryRun}`)

  const counters: Counters = { inserted: 0, skippedDuplicate: 0, errored: 0 }

  const pool = opts.dryRun ? null : getPool()

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]
    try {
      const data = VeriScanDataSchema.parse(reshapeFlatRowToData(raw))
      const envelope = synthesiseBackfillEnvelope(data, mtimeIso)
      const rowInput = envelopeToRowInput({
        envelope,
        ingestSource: 'backfill',
        siteSlug: opts.site,
        provider: opts.provider,
        rawEnvelope: envelope,
      })
      if (pool === null) {
        // Dry-run: print the would-be insert as JSON Lines so the
        // operator can pipe to `jq` / `wc -l` for sanity.
        process.stdout.write(JSON.stringify({ index: i, envelope }) + '\n')
        continue
      }
      const result = await insertVisitorScan(pool, rowInput)
      if (result.inserted) {
        counters.inserted += 1
      } else {
        counters.skippedDuplicate += 1
      }
    } catch (err) {
      counters.errored += 1
      const message = err instanceof Error ? err.message : String(err)
      console.warn(
        `[visitor-scans-backfill] row ${i} errored: ${message} (raw=${JSON.stringify(raw).slice(0, 240)}…)`,
      )
    }
  }

  console.log(
    `[visitor-scans-backfill] done: inserted=${counters.inserted} skipped_duplicate=${counters.skippedDuplicate} errored=${counters.errored}`,
  )

  if (pool !== null) {
    await closePool()
  }
}

function detectFormat(filePath: string, buffer: Buffer): BackfillSourceFormat {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.json') return 'json-array'
  if (ext === '.ndjson' || ext === '.jsonl') return 'ndjson'
  if (ext === '.csv') return 'csv'
  // Fallback: sniff content. If the first non-whitespace character
  // is `[` it's a JSON array; `{` it's NDJSON (or a single-object
  // JSON we degrade to NDJSON of length 1); otherwise CSV.
  const head = buffer.subarray(0, Math.min(4096, buffer.length)).toString('utf8').trimStart()
  if (head.startsWith('[')) return 'json-array'
  if (head.startsWith('{')) return 'ndjson'
  return 'csv'
}

function synthesiseBackfillEnvelope(
  data: ReturnType<typeof VeriScanDataSchema.parse>,
  mtimeIso: string,
): VeriScanEnvelope {
  // Stable, content-derived EventId: first 8 hex chars of
  // SHA-256(HashId), parsed as a 32-bit unsigned int. Fits in a
  // bigint comfortably, deterministic across re-runs.
  const digest = createHash('sha256').update(data.HashId).digest('hex').slice(0, 8)
  const eventId = Number.parseInt(digest, 16)
  return {
    Type: 'CreateCard',
    EventId: eventId,
    WebHookId: 0,
    WebHookTypeId: null,
    Created: mtimeIso,
    Sent: mtimeIso,
    Data: data,
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[visitor-scans-backfill] fatal:', err)
    process.exit(1)
  })
