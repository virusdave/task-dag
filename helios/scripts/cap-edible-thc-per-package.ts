// Cap every edible inventory item's Total THC (labDataAttributeId=1)
// at 100 mg/package, picking the per-piece and per-package figures
// from the product name (e.g. "10x 10mg" → 100 mg/package, 10 mg/piece;
// "0.1g" → 100 mg/package; "Lollipop 10mg" → 10 mg/package, 10 mg/piece).
// Any product whose name parses to >100 mg/package is hard-capped to
// 100 mg/package (and the per-piece figure is scaled accordingly so the
// arithmetic stays internally consistent).
//
// Why: Sweed's daily-purchase-limit calc reads
// `extendedLabData[labDataAttribute.id=1].contentPerProduct` when it
// is explicitly set on the inventory item; leaving it implicit lets
// the calc fall back to `contentPercent * netWeight`, which routinely
// rounds over 100 mg for lab-tested gummies and trips the limit
// guard incorrectly.
//
// What we touch:
//   - Sites: Bronx (210249) + Midtown (210705) — HELIOS_PENDING_PURCHASE_SITE_DEALERS.
//   - Category: id=7459 ("Edibles"). Beverages (6521) and the
//     state-only "EdiblesCB" (1086) are NOT included by default.
//   - All inventory items on each row, regardless of stock qty.
//
// What we send (per item):
//   - `store.inventory.item.update.labtest`, with the FULL set of the
//     item's existing extendedLabData entries that carry an
//     `labDataAttribute.id` (so we don't drop CBD/CBG/Net Weight/etc.),
//     mutating ONLY the Total THC (id=1) entry to the capped numbers.
//   - We leave each preserved entry's contentPercent / contentPerUnit /
//     contentPerProduct exactly as Sweed returned them — Sweed accepts
//     this round-trip and (per a live test against item 1079027) stores
//     the new contentPerProduct=100 / contentPerUnit=10 verbatim.
//
// Skipping:
//   - Items whose product name doesn't match any of our 3 patterns
//     get logged into `skipped[]` and left untouched.
//   - Items whose currentQty <= 0 are skipped: their lab data has no
//     effect on the daily-purchase-limit calc (the lot is depleted)
//     and Sweed routinely returns "Barcode not found" on them.
//   - Items whose Total THC entry is missing (no attrId=1) get a new
//     entry added, NOT skipped.
//   - Items whose Total THC contentPerProduct is already within 0.05 mg
//     of the target get a `noop` log and we skip the write.
//
// Non-fatal failures: Sweed's "Barcode not found" response is logged
// (outcome=error) but does NOT abort the run.
//
// Usage:
//   npx tsx scripts/cap-edible-thc-per-package.ts            # dry run, no writes
//   npx tsx scripts/cap-edible-thc-per-package.ts --apply    # writes
//   npx tsx scripts/cap-edible-thc-per-package.ts --apply --max=5
//                                                            # writes first 5 only
//
// Requires DATABASE_URL pointing at the helios Tiger Cloud DB so the
// session-token pool is reachable; the worker harness handles the rest.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { callSweedRpc, ensureDealerContext } from '../src/worker/sweed/rpc.js'
import { withSweedSession } from '../src/worker/sweed/session.js'
import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type HeliosPendingPurchaseSiteDealer,
} from '../src/shared/contracts/index.js'

const EDIBLES_CATEGORY_ID = 7459
const TOTAL_THC_ATTR_ID = 1
const MG_UOM_ID = 16
const CAP_MG_PER_PACKAGE = 100
const PAGE_SIZE = 200
const THROTTLE_MS = 100 // gentle on Sweed; ~10 RPCs/s peak

interface ParsedName {
  pieces: number
  mgPerPiece: number
  totalMg: number
  pattern: string
}

// Returns the THC content the product name advertises, or null if no
// pattern matches. `packOfSize` is the per-item count Sweed reports;
// it lets us back-fill the per-piece figure on patterns that only
// specify a total.
export function parseProductNameMg(name: string, packOfSize: number | null): ParsedName | null {
  // 1) "Nx Ymg" — most common (e.g. "10x 10mg", "20 x 5mg").
  const m1 = name.match(/(\d+)\s*[xX]\s*(\d+(?:\.\d+)?)\s*mg\b/)
  if (m1) {
    const pieces = Number(m1[1])
    const mgEach = Number(m1[2])
    if (pieces > 0 && mgEach > 0) {
      return { pieces, mgPerPiece: mgEach, totalMg: pieces * mgEach, pattern: 'NxYmg' }
    }
  }
  // 2) "0.Ng" — THC weight as a fractional gram (1g = 1000 mg).
  //    e.g. "Cannatella …0.1g" / "Nanticoke …Bar 0.1g".
  const m2 = name.match(/\b(\d*\.\d+)\s*g\b/i)
  if (m2) {
    const totalMg = Number(m2[1]) * 1000
    const pieces = Math.max(1, packOfSize ?? 1)
    if (totalMg > 0) {
      return { pieces, mgPerPiece: totalMg / pieces, totalMg, pattern: '0.Ng' }
    }
  }
  // 3) "Nmg" — bare total at the end (e.g. "Mega Lemonade 100mg",
  //    "Mountain High Lollipop 10mg", "Beezy Beez Infused Honey 240mg").
  const m3 = name.match(/\b(\d+(?:\.\d+)?)\s*mg\b/)
  if (m3) {
    const totalMg = Number(m3[1])
    const pieces = Math.max(1, packOfSize ?? 1)
    if (totalMg > 0) {
      return { pieces, mgPerPiece: totalMg / pieces, totalMg, pattern: 'Nmg' }
    }
  }
  return null
}

interface LabEntry {
  labDataAttribute?: { id?: number; name?: string; type?: { id?: number; name?: string } } | null
  contentUom?: { id?: number; name?: string } | null
  contentPercent?: number | null
  contentPerUnit?: number | null
  contentPerProduct?: number | null
}

interface UpdatePayloadEntry {
  labDataAttributeId: number
  contentUomId: number
  contentPercent: number | null
  contentPerUnit: number | null
  contentPerProduct: number | null
}

interface RowLog {
  site: string
  productId: string
  productName: string
  inventoryItemId: string
  currentQty: number | null
  packOfSize: number | null
  netWeightG: number | null
  parsed: ParsedName | null
  beforeContentPerProduct: number | null
  beforeContentPerUnit: number | null
  beforeContentPercent: number | null
  targetContentPerProduct: number | null
  targetContentPerUnit: number | null
  targetContentPercent: number | null
  outcome: 'updated' | 'noop' | 'skipped' | 'error'
  reason?: string
  errorMessage?: string
}

interface SiteEdibleRow {
  product: { id?: string; name?: string }
  items: Array<{ id?: string; currentQty?: number; netWeight?: number }>
}

async function fetchSiteEdibleRows(site: HeliosPendingPurchaseSiteDealer): Promise<SiteEdibleRow[]> {
  await ensureDealerContext(site.dealerId)
  const out: SiteEdibleRow[] = []
  let page = 1
  while (true) {
    const resp = (await callSweedRpc<any>(site.dealerId, 'store.inventory.item.list.grouped', {
      page,
      pageSize: PAGE_SIZE,
    })) as { data?: any[] }
    const rows = resp.data ?? []
    for (const r of rows) {
      if (r?.category?.id === EDIBLES_CATEGORY_ID) {
        out.push({ product: r.product ?? {}, items: r.items ?? [] })
      }
    }
    if (rows.length < PAGE_SIZE) break
    page += 1
    if (page > 500) break
  }
  return out
}

function buildPayload(existing: LabEntry[], target: {
  perProduct: number
  perUnit: number
}): UpdatePayloadEntry[] {
  const preserved = existing
    .filter((e) => e.labDataAttribute?.id != null)
    .filter(
      (e) =>
        e.contentPercent != null || e.contentPerUnit != null || e.contentPerProduct != null,
    )
    .map((e) => {
      const attrId = e.labDataAttribute!.id!
      const base: UpdatePayloadEntry = {
        labDataAttributeId: attrId,
        contentUomId: e.contentUom?.id ?? MG_UOM_ID,
        contentPercent: e.contentPercent ?? null,
        contentPerUnit: e.contentPerUnit ?? null,
        contentPerProduct: e.contentPerProduct ?? null,
      }
      if (attrId === TOTAL_THC_ATTR_ID) {
        // Keep the lab-reported contentPercent verbatim so we don't
        // perturb the cannabinoid-derivation chain Sweed maintains
        // between D9/THCA/Total. Only override the per-package and
        // per-unit numerics, which are what the daily-purchase-limit
        // calc actually reads when explicitly set.
        base.contentPerProduct = round3(target.perProduct)
        base.contentPerUnit = round3(target.perUnit)
      }
      return base
    })

  const hasThc = preserved.some((p) => p.labDataAttributeId === TOTAL_THC_ATTR_ID)
  if (hasThc) return preserved
  // Item has no existing Total THC entry — add one. Leave
  // contentPercent null so Sweed keeps whatever it derives from any
  // sibling cannabinoid entries (D9, THCA, etc.); we only assert the
  // per-package + per-unit override the limit calc needs.
  return [
    ...preserved,
    {
      labDataAttributeId: TOTAL_THC_ATTR_ID,
      contentUomId: MG_UOM_ID,
      contentPercent: null,
      contentPerUnit: round3(target.perUnit),
      contentPerProduct: round3(target.perProduct),
    },
  ]
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const maxArg = process.argv.find((a) => a.startsWith('--max='))
  const maxUpdates = maxArg ? Number(maxArg.slice('--max='.length)) : Number.POSITIVE_INFINITY
  const logs: RowLog[] = []

  await withSweedSession(async () => {
    let updates = 0
    for (const site of HELIOS_PENDING_PURCHASE_SITE_DEALERS) {
      const rows = await fetchSiteEdibleRows(site)
      console.log(`[${site.siteLabel}] ${rows.length} edible rows (cat=${EDIBLES_CATEGORY_ID})`)
      for (const row of rows) {
        const productId = row.product.id ?? '?'
        const productName = row.product.name ?? '?'
        for (const it of row.items) {
          const itemId = it.id
          if (!itemId) continue
          const qty = typeof it.currentQty === 'number' ? it.currentQty : 0
          if (qty <= 0) {
            // Depleted lot — Sweed routinely returns "Barcode not found"
            // here, and its lab data has no live daily-limit impact.
            logs.push({
              site: site.siteLabel,
              productId,
              productName,
              inventoryItemId: itemId,
              currentQty: qty,
              packOfSize: null,
              netWeightG: null,
              parsed: null,
              beforeContentPerProduct: null,
              beforeContentPerUnit: null,
              beforeContentPercent: null,
              targetContentPerProduct: null,
              targetContentPerUnit: null,
              targetContentPercent: null,
              outcome: 'skipped',
              reason: 'zero-stock',
            })
            continue
          }

          // Fetch item to get extendedLabData + packOfSize + productSize.
          await sleep(THROTTLE_MS)
          const detail = (await callSweedRpc<any>(site.dealerId, 'store.inventory.item.get', {
            inventoryItemId: itemId,
          })) as any
          const packOfSize: number | null = typeof detail?.packOfSize === 'number' ? detail.packOfSize : null
          const existing = (detail?.extendedLabData ?? []) as LabEntry[]
          const thcEntry = existing.find(
            (e) => e.labDataAttribute?.id === TOTAL_THC_ATTR_ID,
          )
          const netWeightAttr = existing.find((e) => e.labDataAttribute?.id === 300)
          const netWeightG =
            typeof netWeightAttr?.contentPerProduct === 'number'
              ? netWeightAttr.contentPerProduct
              : typeof detail?.productSize?.uomNumber === 'number' && packOfSize
                ? detail.productSize.uomNumber * packOfSize
                : null

          const parsed = parseProductNameMg(productName, packOfSize)
          const log: RowLog = {
            site: site.siteLabel,
            productId,
            productName,
            inventoryItemId: itemId,
            currentQty: typeof it.currentQty === 'number' ? it.currentQty : null,
            packOfSize,
            netWeightG,
            parsed,
            beforeContentPerProduct: thcEntry?.contentPerProduct ?? null,
            beforeContentPerUnit: thcEntry?.contentPerUnit ?? null,
            beforeContentPercent: thcEntry?.contentPercent ?? null,
            targetContentPerProduct: null,
            targetContentPerUnit: null,
            targetContentPercent: null,
            outcome: 'skipped',
          }

          if (!parsed) {
            log.reason = 'name-not-parsed'
            logs.push(log)
            continue
          }
          const piecesEffective = packOfSize && packOfSize > 0 ? packOfSize : parsed.pieces
          const targetPerProduct = Math.min(CAP_MG_PER_PACKAGE, parsed.totalMg)
          const targetPerUnit = targetPerProduct / piecesEffective
          log.targetContentPerProduct = round3(targetPerProduct)
          log.targetContentPerUnit = round3(targetPerUnit)

          const already =
            thcEntry?.contentPerProduct != null &&
            Math.abs(thcEntry.contentPerProduct - targetPerProduct) < 0.05 &&
            thcEntry.contentPerUnit != null &&
            Math.abs(thcEntry.contentPerUnit - targetPerUnit) < 0.05
          if (already) {
            log.outcome = 'noop'
            log.reason = 'already-at-target'
            logs.push(log)
            continue
          }

          if (!apply) {
            log.outcome = 'skipped'
            log.reason = 'dry-run'
            logs.push(log)
            continue
          }
          if (updates >= maxUpdates) {
            log.reason = 'max-updates-reached'
            logs.push(log)
            continue
          }

          const payload = buildPayload(existing, {
            perProduct: targetPerProduct,
            perUnit: targetPerUnit,
          })
          try {
            await sleep(THROTTLE_MS)
            await callSweedRpc<any>(site.dealerId, 'store.inventory.item.update.labtest', {
              inventoryItemId: itemId,
              inventoryExtendedLabData: payload,
            })
            log.outcome = 'updated'
            updates += 1
            console.log(
              `  [${site.siteLabel}] ${productName} (item=${itemId}) → ${targetPerProduct}mg/pkg, ${round3(targetPerUnit)}mg/pc (was ${thcEntry?.contentPerProduct ?? '∅'}mg/pkg)`,
            )
          } catch (e) {
            log.outcome = 'error'
            log.errorMessage = e instanceof Error ? e.message : String(e)
            console.warn(
              `  [${site.siteLabel}] !! ${productName} (item=${itemId}) FAILED: ${log.errorMessage}`,
            )
          }
          logs.push(log)
        }
      }
    }
  })

  const here = dirname(fileURLToPath(import.meta.url))
  const outDir = resolve(here, '.cache')
  mkdirSync(outDir, { recursive: true })
  const outPath = resolve(outDir, `thc-cap-${apply ? 'apply' : 'dryrun'}-${Date.now()}.json`)
  writeFileSync(outPath, JSON.stringify({ apply, logs }, null, 2))

  const counts: Record<string, number> = {}
  for (const l of logs) counts[l.outcome] = (counts[l.outcome] ?? 0) + 1
  console.log('\nSummary:', counts)
  console.log('Report:', outPath)
}

main().catch((error: unknown) => {
  console.error('cap-edible-thc-per-package FAIL:', error instanceof Error ? error.stack ?? error.message : error)
  process.exit(1)
})
