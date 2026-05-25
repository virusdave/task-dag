import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type ConfigWorkersEdibleThcClampJobPayload,
  type HeliosPendingPurchaseSiteDealer,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import { callSweedRpc, ensureDealerContext } from '../sweed/rpc.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

/**
 * Periodic edible THC clamp sweep. Walks Bronx + Midtown for category 7459
 * ("Edibles"), parses each in-stock variant's product name for an advertised
 * total mg, and rewrites the Total THC (`labDataAttributeId=1`) lab data so
 * the per-package figure is clamped at 100 mg/package (and per-piece scales
 * accordingly). Cheap noop when the lab data already matches the target.
 *
 * This is the worker-side port of `helios/scripts/cap-edible-thc-per-package.ts`.
 * Behaviour intentionally mirrors that script verbatim:
 *   - category 7459 only
 *   - HELIOS_PENDING_PURCHASE_SITE_DEALERS only (Bronx + Midtown)
 *   - zero-stock lots skipped (Sweed returns "Barcode not found" on
 *     depleted items, and they have no live daily-limit impact)
 *   - if Total THC entry is missing, add one
 *   - keep `contentPercent` and all other extendedLabData entries verbatim
 */

const EDIBLES_CATEGORY_ID = 7459
const TOTAL_THC_ATTR_ID = 1
const MG_UOM_ID = 16
const CAP_MG_PER_PACKAGE = 100
const PAGE_SIZE = 200
const THROTTLE_MS = 100 // gentle on Sweed; ~10 RPCs/s peak per worker

interface ParsedName {
  pieces: number
  mgPerPiece: number
  totalMg: number
  pattern: string
}

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
  const m2 = name.match(/\b(\d*\.\d+)\s*g\b/i)
  if (m2) {
    const totalMg = Number(m2[1]) * 1000
    const pieces = Math.max(1, packOfSize ?? 1)
    if (totalMg > 0) {
      return { pieces, mgPerPiece: totalMg / pieces, totalMg, pattern: '0.Ng' }
    }
  }
  // 3) "Nmg" — bare total at the end.
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
  labDataAttribute?: { id?: number; name?: string } | null
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

interface SiteEdibleRow {
  product: { id?: string; name?: string }
  items: Array<{ id?: string; currentQty?: number }>
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function resolveTargetSites(
  requestedDealerIds: number[],
): HeliosPendingPurchaseSiteDealer[] {
  if (requestedDealerIds.length === 0) {
    return [...HELIOS_PENDING_PURCHASE_SITE_DEALERS]
  }
  const requested = new Set(requestedDealerIds)
  return HELIOS_PENDING_PURCHASE_SITE_DEALERS.filter((site) => requested.has(site.dealerId))
}

async function fetchSiteEdibleRows(
  site: HeliosPendingPurchaseSiteDealer,
): Promise<SiteEdibleRow[]> {
  await ensureDealerContext(site.dealerId)
  const out: SiteEdibleRow[] = []
  let page = 1
  while (true) {
    const resp = (await callSweedRpc<{ data?: unknown[] }>(
      site.dealerId,
      'store.inventory.item.list.grouped',
      { page, pageSize: PAGE_SIZE },
    )) as { data?: Array<Record<string, unknown>> }
    const rows = resp.data ?? []
    for (const r of rows) {
      const category = (r as { category?: { id?: number } }).category
      if (category?.id === EDIBLES_CATEGORY_ID) {
        const product = (r as { product?: { id?: string; name?: string } }).product ?? {}
        const items = ((r as { items?: Array<{ id?: string; currentQty?: number }> }).items ?? [])
        out.push({ product, items })
      }
    }
    if (rows.length < PAGE_SIZE) break
    page += 1
    if (page > 500) break
  }
  return out
}

function buildPayload(
  existing: LabEntry[],
  target: { perProduct: number; perUnit: number },
): UpdatePayloadEntry[] {
  const preserved = existing
    .filter((e) => e.labDataAttribute?.id != null)
    .filter(
      (e) => e.contentPercent != null || e.contentPerUnit != null || e.contentPerProduct != null,
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
        base.contentPerProduct = round3(target.perProduct)
        base.contentPerUnit = round3(target.perUnit)
      }
      return base
    })

  const hasThc = preserved.some((p) => p.labDataAttributeId === TOTAL_THC_ATTR_ID)
  if (hasThc) return preserved
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

interface ClampSummary {
  considered: number
  updated: number
  noop: number
  skippedZeroStock: number
  skippedUnparsedName: number
  errored: number
  perSite: Array<{
    siteKey: string
    siteLabel: string
    considered: number
    updated: number
    errors: number
  }>
}

export async function runConfigWorkersEdibleThcClampJob(
  context: JobHandlerContext,
  payload: ConfigWorkersEdibleThcClampJobPayload,
): Promise<void> {
  const sites = resolveTargetSites(payload.siteDealerIds)
  const summary: ClampSummary = {
    considered: 0,
    updated: 0,
    noop: 0,
    skippedZeroStock: 0,
    skippedUnparsedName: 0,
    errored: 0,
    perSite: [],
  }

  for (const site of sites) {
    const siteCounts = { considered: 0, updated: 0, errors: 0 }
    const rows = await fetchSiteEdibleRows(site)
    for (const row of rows) {
      const productName = row.product.name ?? ''
      for (const it of row.items) {
        const itemId = it.id
        if (!itemId) continue
        summary.considered += 1
        siteCounts.considered += 1

        const qty = typeof it.currentQty === 'number' ? it.currentQty : 0
        if (qty <= 0) {
          summary.skippedZeroStock += 1
          continue
        }

        await sleep(THROTTLE_MS)
        let detail: Record<string, unknown>
        try {
          detail = (await callSweedRpc<Record<string, unknown>>(
            site.dealerId,
            'store.inventory.item.get',
            { inventoryItemId: itemId },
          )) as Record<string, unknown>
        } catch (e) {
          summary.errored += 1
          siteCounts.errors += 1
          console.warn(
            `[edible-thc-clamp] [${site.siteLabel}] item=${itemId} get FAILED: ${
              e instanceof Error ? e.message : String(e)
            }`,
          )
          continue
        }

        const packOfSize: number | null =
          typeof detail.packOfSize === 'number' ? (detail.packOfSize as number) : null
        const existing = ((detail.extendedLabData as LabEntry[] | undefined) ?? []) as LabEntry[]
        const thcEntry = existing.find((e) => e.labDataAttribute?.id === TOTAL_THC_ATTR_ID)

        const parsed = parseProductNameMg(productName, packOfSize)
        if (!parsed) {
          summary.skippedUnparsedName += 1
          continue
        }
        const piecesEffective = packOfSize && packOfSize > 0 ? packOfSize : parsed.pieces
        const targetPerProduct = Math.min(CAP_MG_PER_PACKAGE, parsed.totalMg)
        const targetPerUnit = targetPerProduct / piecesEffective

        const already =
          thcEntry?.contentPerProduct != null &&
          Math.abs(thcEntry.contentPerProduct - targetPerProduct) < 0.05 &&
          thcEntry.contentPerUnit != null &&
          Math.abs(thcEntry.contentPerUnit - targetPerUnit) < 0.05
        if (already) {
          summary.noop += 1
          continue
        }

        const updatePayload = buildPayload(existing, {
          perProduct: targetPerProduct,
          perUnit: targetPerUnit,
        })
        try {
          await sleep(THROTTLE_MS)
          await callSweedRpc(site.dealerId, 'store.inventory.item.update.labtest', {
            inventoryItemId: itemId,
            inventoryExtendedLabData: updatePayload,
          })
          summary.updated += 1
          siteCounts.updated += 1
          console.log(
            `[edible-thc-clamp] [${site.siteLabel}] ${productName} (item=${itemId}) → ${targetPerProduct}mg/pkg, ${round3(
              targetPerUnit,
            )}mg/pc (was ${thcEntry?.contentPerProduct ?? '∅'}mg/pkg)`,
          )
        } catch (e) {
          summary.errored += 1
          siteCounts.errors += 1
          console.warn(
            `[edible-thc-clamp] [${site.siteLabel}] ${productName} (item=${itemId}) update FAILED: ${
              e instanceof Error ? e.message : String(e)
            }`,
          )
        }
      }
    }
    summary.perSite.push({
      siteKey: site.siteKey,
      siteLabel: site.siteLabel,
      considered: siteCounts.considered,
      updated: siteCounts.updated,
      errors: siteCounts.errors,
    })
  }

  await withTransaction(async (db) => {
    await appendAuditEvent(db, {
      actorType: payload.requestedByUserId ? 'user' : 'system',
      actorUserId: payload.requestedByUserId ?? null,
      entityId: String(context.id),
      entityType: 'job',
      eventType: 'config.workers.edible_thc_clamp.completed',
      module: 'config',
      payload: {
        trigger: payload.trigger,
        summary: JSON.parse(JSON.stringify(summary)),
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })

}
