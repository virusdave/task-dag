// One-off backfill: replicate a valid warehouse location code to live Midtown
// packages that a single scan would resolve to alongside an already-located
// sibling, but which were left unlocated.
//
// Why: before the 1-to-many bugfix, scanning a barcode/METRC tag that matched
// several co-located packages (e.g. a STIIIZY lot split "4 in one package, 1
// in another" — both carry the SAME METRC tag) forced the operator to pick ONE
// package, so the siblings never got the location written. This backfills them
// instead of re-scanning everything.
//
// Target set (computed live each run, never from a stale dump):
//   * Midtown (dealer 210705), in-stock, available_qty > 0, stock_location
//     ILIKE 'FOR SALE%', not trade-sample, not not-for-sale — the exact
//     "live" filter the warehouse-locations feature uses.
//   * A package P is a target iff P has NO valid location code AND, among the
//     live packages sharing P's METRC tag OR P's inventory barcode (the scan
//     keys), there is EXACTLY ONE distinct valid location code. P inherits it.
//   * Groups whose located siblings disagree (>1 distinct code) are skipped as
//     ambiguous and reported — never guessed.
//
// "Valid location code" mirrors effectiveCode in src/server/warehouse:
// Helios's own wla.location_code if format-valid, else the package's Sweed
// internal_track_code if format-valid.
//
// Each write reuses assignWarehouseLocation() — the SAME live-verify → per-
// package advisory lock → Sweed internalTrackCode write → wla upsert → audit
// path the UI uses — so semantics, locking, and rollback are identical to a
// manual re-scan. allowReassign stays false: a target has no valid code, so a
// real conflict (the package moved to a different valid code since we read it)
// is surfaced and skipped, not clobbered.
//
// Usage:
//   npx tsx scripts/backfill-warehouse-location-siblings.ts          # dry run
//   npx tsx scripts/backfill-warehouse-location-siblings.ts --apply  # writes
//
// Requires DATABASE_URL pointing at the helios Tiger Cloud DB (the Sweed
// session-token pool is read from it; the worker harness handles the rest).

import { getPool } from '../src/server/db/pool.js'
import { assignWarehouseLocation } from '../src/server/warehouse/locations.js'

const MIDTOWN_DEALER_ID = 210705
const THROTTLE_MS = 150 // gentle on Sweed

// Single source of truth for the location-code grammar, kept identical to
// WAREHOUSE_LOCATION_CODE_SQL_REGEX in the contracts.
const CODE_RE = `^(EDI|PRE|FLO|BEV|VAP|CON|TOP|TIN|ACC)-[A-Z]-[1-9][0-9]*(-[a-z])?$`

interface TargetRow {
  inventory_item_id: string
  target_code: string
  product_name: string | null
  metrc_tag: string | null
  available_qty: string | number | null
}

async function loadTargets(): Promise<TargetRow[]> {
  const db = getPool()
  const result = await db.query<TargetRow>(
    `
    with cur as (
      select c.inventory_item_id, c.product_name,
             nullif(trim(c.metrc_tag), '') as metrc_tag,
             nullif(trim(c.raw_json->>'inventoryBarcode'), '') as inv_barcode,
             c.available_qty, c.internal_track_code,
             wla.location_code as assigned_location_code
      from sweed_package_current c
      left join warehouse_location_assignments wla
        on wla.dealer_id = $1 and wla.inventory_item_id = c.inventory_item_id
      where c.dealer_id = $1 and c.is_on_stock = true
        and c.available_qty is not null and c.available_qty > 0
        and c.stock_location ilike 'FOR SALE%'
        and coalesce(lower(c.raw_json->>'isTradeSample') = 'true', false) = false
        and coalesce(lower(c.raw_json->>'isNotForSale') = 'true', false) = false
    ),
    eff as (
      select *, coalesce(
          case when assigned_location_code ~ $2 then assigned_location_code end,
          case when trim(coalesce(internal_track_code, '')) ~ $2
               then trim(internal_track_code) end
        ) as eff_code
      from cur
    ),
    targets as (
      select p.inventory_item_id, p.product_name, p.metrc_tag, p.available_qty,
        (select array_agg(distinct q.eff_code) from eff q
           where q.eff_code is not null
             and q.inventory_item_id <> p.inventory_item_id
             and ( (p.metrc_tag is not null and q.metrc_tag = p.metrc_tag)
                or (p.inv_barcode is not null and q.inv_barcode = p.inv_barcode) )
        ) as sibling_codes
      from eff p
      where p.eff_code is null
    )
    select inventory_item_id, sibling_codes[1] as target_code, product_name,
           metrc_tag, available_qty
    from targets
    where sibling_codes is not null and array_length(sibling_codes, 1) = 1
    order by sibling_codes[1], product_name
    `,
    [MIDTOWN_DEALER_ID, CODE_RE],
  )
  return result.rows
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const targets = await loadTargets()

  console.log(
    `Found ${targets.length} live Midtown package(s) to backfill ` +
      `(${apply ? 'APPLY — writing Sweed + wla' : 'DRY RUN — no writes'}):\n`,
  )
  for (const t of targets) {
    console.log(
      `  ${t.inventory_item_id}  →  ${t.target_code}` +
        `   (qty ${t.available_qty}, METRC ${t.metrc_tag ?? '—'}) ${t.product_name ?? ''}`,
    )
  }
  console.log('')

  if (!apply) {
    console.log('Dry run only. Re-run with --apply to write.')
    return
  }

  const counts: Record<string, number> = { assigned: 0, conflict: 0, failed: 0, error: 0 }
  for (const t of targets) {
    await sleep(THROTTLE_MS)
    try {
      const res = await assignWarehouseLocation({
        locationCode: t.target_code,
        source: 'audit',
        inventoryItemId: t.inventory_item_id,
        allowReassign: false,
        requestedByUserId: null,
      })
      if (res.packages.length > 0) {
        counts.assigned += 1
        console.log(`  ✓ ${t.inventory_item_id} → ${t.target_code}`)
      } else if (res.conflicts.length > 0) {
        counts.conflict += 1
        const c = res.conflicts[0]!
        console.log(
          `  ⊘ ${t.inventory_item_id} SKIPPED — already at ${c.currentInternalTrackCode} (changed since read)`,
        )
      } else if (res.failures.length > 0) {
        counts.failed += 1
        console.log(`  ✗ ${t.inventory_item_id} FAILED — ${res.failures[0]!.reason}`)
      }
    } catch (error) {
      counts.error += 1
      console.log(
        `  ✗ ${t.inventory_item_id} ERROR — ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  console.log('\nSummary:', counts)
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(
      'backfill-warehouse-location-siblings FAIL:',
      error instanceof Error ? (error.stack ?? error.message) : error,
    )
    process.exit(1)
  })
