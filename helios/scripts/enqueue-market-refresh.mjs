#!/usr/bin/env node
/**
 * CLI bridge into worker/litalerts/enqueueMarketRefresh.ts.
 *
 * Lets non-Node callers (the Python repricing scripts under
 * catalog/repricing/, bulk_additions seed scripts, etc.) drop a list of
 * product ids onto the Lit Alerts market-data refresh queue without
 * reimplementing the dedupe / audit / job-enqueue plumbing.
 *
 * Usage:
 *   node helios/scripts/enqueue-market-refresh.mjs \
 *     --productIds 123,456,789 \
 *     --reason proposal-source \
 *     [--proposalLabel "2026-05-16-10ff-brands"] \
 *     [--priority 10] \
 *     [--brandName "Doobie Labs"]   # required for --reason brand-alarm
 *     [--siteDealerId 210249]       # optional for --reason in-stock-alarm
 *     [--pendingPurchaseRowId 42]   # optional for --reason pending-purchase
 *     [--manualReason "spot check"] # optional for --reason manual
 *
 * Exits non-zero (and prints to stderr) if the helper rejects the
 * input or the DB enqueue fails. Best-effort callers (e.g. reprice.py
 * after a dry-run) should swallow non-zero exits so they don't fail
 * the calling task.
 *
 * Built via the on-disk `dist/` tree so this script can run without a
 * tsc compile step in the loop.
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const heliosRoot = resolve(__dirname, '..')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`)
    }
    const key = arg.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`--${key} requires a value`)
    }
    out[key] = value
    i += 1
  }
  return out
}

function parseProductIds(value) {
  const ids = value
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => {
      const n = Number(token)
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`Invalid productId: ${token}`)
      }
      return n
    })
  if (ids.length === 0) {
    throw new Error('No productIds parsed from --productIds')
  }
  return ids
}

function buildTrigger(args) {
  const reason = args.reason
  if (!reason) {
    throw new Error('--reason is required')
  }
  switch (reason) {
    case 'rolling':
      return { kind: 'rolling' }
    case 'proposal-source':
      return { kind: 'proposal-source', proposalLabel: args.proposalLabel ?? undefined }
    case 'pending-purchase':
      return {
        kind: 'pending-purchase',
        pendingPurchaseRowId: args.pendingPurchaseRowId
          ? Number.parseInt(args.pendingPurchaseRowId, 10)
          : undefined,
      }
    case 'brand-alarm':
      if (!args.brandName) {
        throw new Error('--brandName is required when --reason is brand-alarm')
      }
      return { kind: 'brand-alarm', brandName: args.brandName }
    case 'in-stock-alarm':
      return {
        kind: 'in-stock-alarm',
        siteDealerId: args.siteDealerId
          ? Number.parseInt(args.siteDealerId, 10)
          : undefined,
      }
    case 'manual':
      return { kind: 'manual', reason: args.manualReason ?? undefined }
    default:
      throw new Error(`Unknown --reason: ${reason}`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.productIds) {
    throw new Error('--productIds is required (comma-separated, e.g. 123,456)')
  }
  const productIds = parseProductIds(args.productIds)
  const trigger = buildTrigger(args)
  const priority = args.priority ? Number.parseInt(args.priority, 10) : undefined

  // Resolve the compiled helper. We do NOT shell into tsx because this
  // CLI is intended to be cheap to invoke from Python on every dry-run.
  const distEntry = resolve(heliosRoot, 'dist/server/worker/litalerts/enqueueMarketRefresh.js')
  if (!existsSync(distEntry)) {
    throw new Error(
      `Built helper not found at ${distEntry}. Run \`npm run build:server\` in helios/ first.`,
    )
  }

  const { enqueueMarketRefreshForProducts } = await import(distEntry)
  const { closePool } = await import(resolve(heliosRoot, 'dist/server/server/db/pool.js'))
  try {
    const result = await enqueueMarketRefreshForProducts(productIds, {
      trigger,
      priority,
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    await closePool()
  }
}

main().catch((error) => {
  process.stderr.write(`enqueue-market-refresh failed: ${error?.stack ?? error}\n`)
  process.exit(1)
})
