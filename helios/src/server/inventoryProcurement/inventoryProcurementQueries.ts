import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  getHeliosPendingPurchaseSiteDealer,
  type InventoryAction,
  type InventoryCategoryOverhang,
  type InventoryDistributorStat,
  type InventoryProcurementResponse,
  type InventoryProcurementSummary,
  type InventoryScoreFactor,
  type InventorySkuHistoryResponse,
  type InventorySkuRow,
} from '../../shared/contracts/index.js'
import { getPool } from '../db/pool.js'
import { bucketLocalExpr } from '../metrics/bucketSelectSql.js'

// ============================================================================
// Inventory / Procurement analytics SQL + scoring
//
// One endpoint, two queries:
//   1. SKU facts  — latest snapshot per package (distinct-on observed_at_max
//      desc), summed to product grain, LEFT JOINed to trailing sell-through
//      from sweed_order_items_flat (mapped package -> product via the same
//      latest-snapshot dimension).
//   2. Distributor stats — lead time + reorder cadence per (dealer,
//      distributor) from sweed_purchases delivery_date gaps.
//
// All derived scalars (velocity, days-supply, recommended qty, lost
// margin/day, deadweight + reorder-priority scores, confidence) are
// computed in TS AFTER the query, where we have the whole set in memory
// for p95 normalization. The query stays a cheap aggregation pass.
//
// Cost basis: per-SKU weighted-average current wholesale cost
// (sum(current_qty*cost)/sum(current_qty)). Margin uses
// avg_unit_price - unit_cost_current; we do NOT join per-sale package
// cost on the hot path (negligible accuracy gain, big cost). Revenue is
// pre-discount list (sweed_order_items_flat.revenue) — order-level
// discounts are tiny and unallocated; noted in methodology.
//
// Lead time from PO line received_at is unavailable (NULL in prod), so
// lead time degrades to a configurable default; cadence still derives
// from delivery_date gaps. See oracle design T-019e6edf (2026-06-04).
// ============================================================================

export const INVENTORY_PROCUREMENT_DEFAULT_WINDOW_DAYS = 28
export const INVENTORY_PROCUREMENT_DEFAULT_LEAD_DAYS = 7
const DAY_MS = 86_400_000

function resolveDealerIds(sites: readonly string[]): number[] {
  if (sites.length === 0) {
    return HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((d) => d.dealerId)
  }
  const wanted = new Set(sites.map((s) => s.toLowerCase()))
  return HELIOS_PENDING_PURCHASE_SITE_DEALERS.filter((d) =>
    wanted.has(d.siteKey.toLowerCase()),
  ).map((d) => d.dealerId)
}

function asNum(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
function num(v: unknown): number {
  return asNum(v) ?? 0
}
function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

interface FactRow {
  dealer_id: string | number
  product_id: string | number | null
  product_name: string | null
  product_sku: string | null
  category_name: string | null
  subcategory_name: string | null
  brand_name: string | null
  list_price_dollars: string | number | null
  distributor_name: string | null
  physical_units: string | number | null
  held_units: string | number | null
  sellable_units: string | number | null
  on_hand_cost: string | number | null
  unit_cost_current: string | number | null
  pkg_count: string | number | null
  first_received_at: string | Date | null
  avg_inventory_age_days: string | number | null
  nearest_expiration: string | Date | null
  expiring_units_60: string | number | null
  expiring_cost_60: string | number | null
  snapshot_age_hours: string | number | null
  units_7: string | number | null
  units_w: string | number | null
  units_90: string | number | null
  revenue_w: string | number | null
  sale_days_w: string | number | null
  last_sale_at: string | Date | null
}

interface DistRow {
  dealer_id: string | number
  distributor_name: string
  cadence_days: string | number | null
  last_delivery_date: string | Date | null
  po_count: string | number | null
}

const FACTS_SQL = `
WITH params AS (
  SELECT now() AS as_of, ($2::int) AS window_days
),
pkg_latest AS (
  SELECT DISTINCT ON (s.dealer_id, s.inventory_item_id)
    s.dealer_id, s.inventory_item_id, s.product_id, s.product_name, s.product_sku,
    s.category_name, s.subcategory_name, s.brand_name, s.distributor_name,
    s.current_qty, s.hold_qty, s.available_qty, s.wholesale_cost_dollars,
    s.expiration_date, s.received_at, s.observed_at_max
  FROM sweed_package_snapshots s
  WHERE s.dealer_id = ANY($1::bigint[])
  ORDER BY s.dealer_id, s.inventory_item_id, s.observed_at_max DESC
),
pkg_clean AS (
  SELECT * FROM pkg_latest
  WHERE coalesce(product_name,'') !~* '^\\s*(DEAD|DELETED|RETIRED)\\b'
    AND coalesce(brand_name,'')   !~* '^\\s*(DEAD|DELETED|RETIRED)\\b'
),
pkg_dim AS (
  -- package -> product map for mapping order line items
  SELECT dealer_id, inventory_item_id, product_id FROM pkg_clean WHERE product_id IS NOT NULL
),
pkg_first_seen AS (
  -- Upstream received_at is NULL in prod, and pkg_latest only carries
  -- the LATEST snapshot per package -- so coalescing age to
  -- observed_at_max (the latest obs) makes inventory age ~ 0 and the
  -- 60-day "we have already paid for it" concern never fires. Recover a
  -- usable lower-bound age from the FIRST time we ever observed the
  -- package on hand (qty > 0) across all snapshots.
  SELECT
    s.dealer_id,
    s.inventory_item_id,
    min(s.observed_at_max) FILTER (WHERE s.current_qty > 0) AS first_observed_on_hand_at
  FROM sweed_package_snapshots s
  WHERE s.dealer_id = ANY($1::bigint[])
  GROUP BY s.dealer_id, s.inventory_item_id
),
taxonomy AS (
  -- Brand / category / subcategory live on catalog_groups, NOT on the
  -- snapshot row (those snapshot columns ship NULL from the grouped
  -- inventory feed). Resolve per product_id via
  -- live_state_json->'products'[](productId match), same as catalog
  -- analytics. distinct-on keeps one taxonomy row per product even if a
  -- product appears in more than one catalog group. ~99% coverage.
  SELECT DISTINCT ON ((prod->>'productId')::bigint)
    (prod->>'productId')::bigint AS product_id,
    cg.brand_name, cg.category_name, cg.subcategory_name,
    -- Current shelf/menu price (effective actualPrice, else list price).
    -- Used as the breakeven-discount base so it's available even for SKUs
    -- with zero sales (no avg-sale-price to lean on).
    coalesce(
      nullif(prod->'priceInfo'->>'actualPrice', '')::numeric,
      nullif(prod->>'price', '')::numeric
    ) AS list_price_dollars
  FROM catalog_groups cg,
       jsonb_array_elements(cg.live_state_json->'products') AS prod
  WHERE cg.deleted_at IS NULL AND prod->>'productId' IS NOT NULL
  ORDER BY (prod->>'productId')::bigint, cg.updated_at DESC NULLS LAST
),
inv AS (
  SELECT
    pl.dealer_id, pl.product_id,
    max(pl.product_name)     AS product_name,
    max(pl.product_sku)      AS product_sku,
    max(pl.distributor_name) AS distributor_name,
    sum(greatest(pl.current_qty,0))   AS physical_units,
    sum(greatest(pl.hold_qty,0))      AS held_units,
    sum(greatest(pl.available_qty,0)) AS sellable_units,
    sum(greatest(pl.current_qty,0) * coalesce(pl.wholesale_cost_dollars,0)) AS on_hand_cost,
    CASE WHEN sum(greatest(pl.current_qty,0)) > 0
      THEN sum(greatest(pl.current_qty,0) * coalesce(pl.wholesale_cost_dollars,0)) / sum(greatest(pl.current_qty,0))
      ELSE max(pl.wholesale_cost_dollars) END AS unit_cost_current,
    count(*) AS pkg_count,
    min(coalesce(pl.received_at, fs.first_observed_on_hand_at)) AS first_received_at,
    CASE WHEN sum(greatest(pl.current_qty,0)) > 0
      THEN sum(greatest(pl.current_qty,0) *
             (EXTRACT(EPOCH FROM ((SELECT as_of FROM params) - coalesce(pl.received_at, fs.first_observed_on_hand_at, pl.observed_at_max))) / 86400.0))
           / sum(greatest(pl.current_qty,0))
      ELSE NULL END AS avg_inventory_age_days,
    min(pl.expiration_date) FILTER (WHERE pl.current_qty > 0) AS nearest_expiration,
    sum(greatest(pl.current_qty,0)) FILTER (WHERE pl.expiration_date IS NOT NULL AND pl.expiration_date <= ((SELECT as_of FROM params)::date + 60)) AS expiring_units_60,
    sum(greatest(pl.current_qty,0) * coalesce(pl.wholesale_cost_dollars,0)) FILTER (WHERE pl.expiration_date IS NOT NULL AND pl.expiration_date <= ((SELECT as_of FROM params)::date + 60)) AS expiring_cost_60,
    EXTRACT(EPOCH FROM ((SELECT as_of FROM params) - max(pl.observed_at_max))) / 3600.0 AS snapshot_age_hours
  FROM pkg_clean pl
  LEFT JOIN pkg_first_seen fs
    ON fs.dealer_id = pl.dealer_id AND fs.inventory_item_id = pl.inventory_item_id
  GROUP BY pl.dealer_id, pl.product_id
),
sales AS (
  SELECT
    d.dealer_id, d.product_id,
    sum(f.qty) FILTER (WHERE f.pay_time >= (SELECT as_of FROM params) - interval '7 days')  AS units_7,
    sum(f.qty) FILTER (WHERE f.pay_time >= (SELECT as_of FROM params) - ((SELECT window_days FROM params) || ' days')::interval) AS units_w,
    sum(f.qty) AS units_90,
    sum(f.revenue) FILTER (WHERE f.pay_time >= (SELECT as_of FROM params) - ((SELECT window_days FROM params) || ' days')::interval) AS revenue_w,
    count(DISTINCT ${bucketLocalExpr('day', 'f.pay_time')})
      FILTER (WHERE f.pay_time >= (SELECT as_of FROM params) - ((SELECT window_days FROM params) || ' days')::interval) AS sale_days_w,
    max(f.pay_time) AS last_sale_at
  FROM sweed_order_items_flat f
  JOIN pkg_dim d ON d.dealer_id = f.dealer_id AND d.inventory_item_id = f.inventory_item_id
  WHERE f.dealer_id = ANY($1::bigint[])
    AND f.pay_time >= (SELECT as_of FROM params) - interval '90 days'
    -- Canceled (voided) lines are not real sales; exclude from units /
    -- revenue / selling-day velocity. (Line status spelled 'Canceled'.)
    AND lower(coalesce(f.raw_item->'invoiceItemStatus'->>'name', '')) <> 'canceled'
  GROUP BY d.dealer_id, d.product_id
)
SELECT
  inv.dealer_id, inv.product_id, inv.product_name, inv.product_sku,
  tx.category_name, tx.subcategory_name, tx.brand_name, tx.list_price_dollars, inv.distributor_name,
  inv.physical_units, inv.held_units, inv.sellable_units, inv.on_hand_cost,
  inv.unit_cost_current, inv.pkg_count, inv.first_received_at, inv.avg_inventory_age_days,
  inv.nearest_expiration, inv.expiring_units_60, inv.expiring_cost_60, inv.snapshot_age_hours,
  coalesce(s.units_7,0) AS units_7, coalesce(s.units_w,0) AS units_w, coalesce(s.units_90,0) AS units_90,
  coalesce(s.revenue_w,0) AS revenue_w, coalesce(s.sale_days_w,0) AS sale_days_w, s.last_sale_at
FROM inv
LEFT JOIN sales s ON s.dealer_id = inv.dealer_id AND s.product_id = inv.product_id
LEFT JOIN taxonomy tx ON tx.product_id = inv.product_id
WHERE inv.product_id IS NOT NULL
`

const DIST_SQL = `
WITH po AS (
  SELECT dealer_id, distributor_name, delivery_date,
    lag(delivery_date) OVER (PARTITION BY dealer_id, distributor_name ORDER BY delivery_date) AS prev_delivery
  FROM sweed_purchases
  WHERE dealer_id = ANY($1::bigint[]) AND distributor_name IS NOT NULL AND delivery_date IS NOT NULL
)
SELECT dealer_id, distributor_name,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY (delivery_date - prev_delivery))
    FILTER (WHERE prev_delivery IS NOT NULL) AS cadence_days,
  max(delivery_date) AS last_delivery_date,
  count(DISTINCT delivery_date) AS po_count
FROM po
GROUP BY dealer_id, distributor_name
`

// Supplier case-sizing knobs (uniform approximation until we record true
// per-SKU case sizes / MOQs).
const ORDER_MULTIPLE_UNITS = 5
const MIN_ORDER_UNITS = 10
// A case-rounded order may exceed the target coverage window, but not by
// more than this multiple, and never push a SKU past an absolute day cap.
// Beyond that, the minimum case overstocks the SKU and recommending it is
// misleading — suppress the recommendation (see skip_min_order_overshoots).
const MAX_CASE_OVERSHOOT_MULTIPLE = 2
const MAX_CASE_COVER_DAYS = 60

// Inventory-turn framing (operator policy). We want every dollar of
// inventory to sell through within ~3 weeks; by 60 days the buy has
// effectively been paid for whether or not it sold, so anything that
// won't clear by then is stranded capital we should actively exit rather
// than let auto-discount into oblivion.
const IDEAL_TURN_DAYS = 21
const HARD_TURN_DAYS = 60
// Minimum on-hand $ for a dead SKU to warrant an active "liquidate now"
// push vs simply burning it down; below this the dollars don't justify a
// promo/markdown effort.
const LIQUIDATE_MIN_CAPITAL = 50

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}
function pctile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = clamp(Math.floor(p * (sorted.length - 1)), 0, sorted.length - 1)
  return sorted[idx]
}
function normLog(x: number, p95: number): number {
  if (p95 <= 0) return 0
  return clamp(Math.log1p(Math.max(0, x)) / Math.log1p(p95), 0, 1)
}

export interface InventoryProcurementParams {
  windowDays: number
  defaultLeadDays: number
  sites: readonly string[]
}

export async function getInventoryProcurement(
  p: InventoryProcurementParams,
): Promise<InventoryProcurementResponse> {
  const pool = getPool()
  const dealerIds = resolveDealerIds(p.sites)
  const asOf = new Date()

  const [factsRes, distRes] = await Promise.all([
    pool.query<FactRow>(FACTS_SQL, [dealerIds, p.windowDays]),
    pool.query<DistRow>(DIST_SQL, [dealerIds]),
  ])

  // Distributor stats keyed by dealer|name.
  const distByKey = new Map<string, InventoryDistributorStat>()
  for (const r of distRes.rows) {
    const dealerId = num(r.dealer_id)
    const dealer = getHeliosPendingPurchaseSiteDealer(dealerId)
    const cadence = clamp(asNum(r.cadence_days) ?? 14, 7, 45)
    distByKey.set(`${dealerId}|${r.distributor_name}`, {
      dealerId,
      siteKey: dealer?.siteKey ?? String(dealerId),
      distributorName: r.distributor_name,
      leadTimeDays: p.defaultLeadDays,
      cadenceDays: cadence,
      lastDeliveryDate: isoOrNull(r.last_delivery_date),
      poCount: num(r.po_count),
    })
  }

  const windowDays = p.windowDays
  const asOfMs = asOf.getTime()

  // First pass: raw + intermediate facts.
  interface Mid {
    row: InventorySkuRow
    lostMarginPerDay: number
    expectedLoss: number
    slowScore: number
    ageScore: number
    expiryScore: number
    marginWeakness: number
  }
  const mids: Mid[] = []

  for (const r of factsRes.rows) {
    const dealerId = num(r.dealer_id)
    const dealer = getHeliosPendingPurchaseSiteDealer(dealerId)
    const siteKey = dealer?.siteKey ?? String(dealerId)
    const siteLabel = dealer?.siteLabel ?? String(dealerId)
    const distributorName = r.distributor_name

    const physicalUnits = num(r.physical_units)
    const heldUnits = num(r.held_units)
    const sellableUnits = num(r.sellable_units)
    const onHandCost = num(r.on_hand_cost)
    const unitCostCurrent = asNum(r.unit_cost_current)
    const units7 = num(r.units_7)
    const unitsW = num(r.units_w)
    const units90 = num(r.units_90)
    const revenueW = num(r.revenue_w)
    const saleDaysW = num(r.sale_days_w)
    const lastSaleAt = isoOrNull(r.last_sale_at)

    // Velocity (availability-adjusted-lite): divide by effective selling
    // days = max(saleDays, windowDays) only when we saw NO sales (avoid
    // div by 0); when we have sales use the demand window length so a
    // brief stockout doesn't inflate velocity unrealistically.
    const velocityW = unitsW > 0 ? unitsW / windowDays : 0
    const velocity7 = units7 > 0 ? units7 / 7 : 0
    const forecastDailyUnits =
      unitsW === 0
        ? 0
        : Math.min(3 * velocityW, Math.max(velocityW, 0.6 * velocity7 + 0.4 * velocityW))

    const avgUnitPrice = unitsW > 0 ? revenueW / unitsW : null
    const unitMargin =
      avgUnitPrice !== null ? avgUnitPrice - (unitCostCurrent ?? 0) : null
    const gmPct =
      avgUnitPrice !== null && avgUnitPrice > 0 && unitMargin !== null
        ? unitMargin / avgUnitPrice
        : null

    const daysSupply = forecastDailyUnits > 0 ? sellableUnits / forecastDailyUnits : null
    const projectedStockoutAt =
      daysSupply !== null ? new Date(asOfMs + daysSupply * DAY_MS).toISOString() : null

    // Distributor lead/cadence.
    const dist = distributorName ? distByKey.get(`${dealerId}|${distributorName}`) : undefined
    const leadTimeDays = dist?.leadTimeDays ?? p.defaultLeadDays
    const cadenceDays = dist?.cadenceDays ?? 14
    const safetyDays = Math.max(2, Math.ceil(0.25 * leadTimeDays))
    const reorderPointDays = leadTimeDays + safetyDays
    const targetCoverDays = clamp(leadTimeDays + cadenceDays + safetyDays, 10, 45)

    const rawRecommendedQty =
      forecastDailyUnits <= 0
        ? 0
        : Math.max(0, Math.ceil(forecastDailyUnits * targetCoverDays - sellableUnits))
    // Supplier orders are snapped to case sizes (almost always multiples
    // of 5). We don't yet record true per-SKU case sizing, so until we can
    // infer/record it, round any nonzero recommendation UP to the nearest
    // multiple of 5 with a 10-unit minimum.
    const snappedRecommendedQty =
      rawRecommendedQty > 0
        ? Math.max(MIN_ORDER_UNITS, Math.ceil(rawRecommendedQty / ORDER_MULTIPLE_UNITS) * ORDER_MULTIPLE_UNITS)
        : 0
    // Days of supply the SKU would carry AFTER the snapped order lands.
    const coverageAfterSnappedOrderDays =
      forecastDailyUnits > 0 && snappedRecommendedQty > 0
        ? (sellableUnits + snappedRecommendedQty) / forecastDailyUnits
        : null
    // The snap (esp. the 10-unit floor) can overstock a slow mover far past
    // its target window. When it does, recommending the order is actively
    // misleading, so suppress it: there IS demand, but the minimum case is
    // economically wrong. (No brand/category variety exception exists yet.)
    const maxCaseCoverDays = Math.min(MAX_CASE_COVER_DAYS, MAX_CASE_OVERSHOOT_MULTIPLE * targetCoverDays)
    const minOrderOvershootsTarget =
      rawRecommendedQty > 0 &&
      snappedRecommendedQty > rawRecommendedQty &&
      coverageAfterSnappedOrderDays !== null &&
      coverageAfterSnappedOrderDays > maxCaseCoverDays
    const recommendedQty = minOrderOvershootsTarget ? 0 : snappedRecommendedQty
    const suppressedRecommendedQty = minOrderOvershootsTarget ? snappedRecommendedQty : null
    const recommendedCost = recommendedQty * (unitCostCurrent ?? 0)
    const orderByDate =
      recommendedQty > 0 && projectedStockoutAt !== null
        ? new Date(new Date(projectedStockoutAt).getTime() - reorderPointDays * DAY_MS).toISOString()
        : null

    const lostMarginPerDay = Math.max(0, forecastDailyUnits * (unitMargin ?? 0))
    const reorderGapDays = daysSupply !== null ? Math.max(0, reorderPointDays - daysSupply) : reorderPointDays
    const expectedLoss = lostMarginPerDay * reorderGapDays

    const recentSeller = unitsW >= 2 || (lastSaleAt !== null && asOfMs - new Date(lastSaleAt).getTime() <= 14 * DAY_MS)
    const hiddenStock = sellableUnits === 0 && physicalUnits > 0
    const outRegretted = sellableUnits === 0 && recentSeller && lostMarginPerDay > 0

    const avgAge = asNum(r.avg_inventory_age_days)
    const nearestExp = isoOrNull(r.nearest_expiration)
    const daysToNearestExp =
      nearestExp !== null ? Math.round((new Date(nearestExp).getTime() - asOfMs) / DAY_MS) : null
    const snapshotAgeHours = asNum(r.snapshot_age_hours)

    // Deadweight score components, framed around the inventory-turn policy.
    // Slow score ramps over the 21→60-day turn window: an item that will
    // clear by the ideal 21-day mark scores 0; one that won't clear before
    // the 60-day "already paid for it" mark scores 1. No-sale stock pegs at
    // 1 (it never turns). This replaces the old, far-too-forgiving
    // daysSupply/120 ramp, under which a 60-day-supply item only scored 0.5.
    const slowScore =
      unitsW === 0 && units90 === 0
        ? 1
        : daysSupply !== null
          ? clamp((daysSupply - IDEAL_TURN_DAYS) / (HARD_TURN_DAYS - IDEAL_TURN_DAYS), 0, 1)
          : unitsW === 0
            ? 1
            : 0
    // Age ramps to full by the 60-day hard-turn mark (was /120). Age is a
    // lower bound recovered from first-observed-on-hand (received_at is NULL
    // upstream), so it only ever understates true age.
    const ageScore = avgAge !== null ? clamp(avgAge / HARD_TURN_DAYS, 0, 1) : 0
    const expiryScore = daysToNearestExp !== null ? clamp((60 - daysToNearestExp) / 60, 0, 1) : 0
    const marginWeakness = gmPct !== null ? clamp((0.45 - gmPct) / 0.45, 0, 1) : 0.5

    // Confidence.
    const salesConfidence = clamp(saleDaysW / 4, 0, 1)
    const costConfidence = unitCostCurrent !== null && unitCostCurrent > 0 ? 1 : 0.3
    const snapshotConfidence =
      snapshotAgeHours === null
        ? 0.5
        : snapshotAgeHours <= 24
          ? 1
          : Math.max(0, 1 - (snapshotAgeHours - 24) / 72)
    const supplierConfidence = dist ? 1 : distributorName ? 0.7 : 0.4
    const confidenceScore = clamp(
      0.35 * salesConfidence + 0.25 * costConfidence + 0.2 * snapshotConfidence + 0.2 * supplierConfidence,
      0,
      1,
    )

    const row: InventorySkuRow = {
      dealerId,
      siteKey,
      siteLabel,
      productId: asNum(r.product_id),
      productName: r.product_name ?? '(unnamed product)',
      productSku: r.product_sku,
      categoryName: r.category_name,
      subcategoryName: r.subcategory_name,
      brandName: r.brand_name,
      listPrice: asNum(r.list_price_dollars),
      distributorName,
      physicalUnits,
      heldUnits,
      sellableUnits,
      onHandCost,
      unitCostCurrent,
      packageCount: num(r.pkg_count),
      hiddenStock,
      firstReceivedAt: isoOrNull(r.first_received_at),
      avgInventoryAgeDays: avgAge,
      nearestExpiration: nearestExp,
      daysToNearestExpiration: daysToNearestExp,
      expiringUnits60: num(r.expiring_units_60),
      expiringCost60: num(r.expiring_cost_60),
      snapshotAgeHours,
      units7,
      units28: unitsW,
      units90,
      revenueWindow: revenueW,
      marginWindow: unitMargin !== null ? unitMargin * unitsW : 0,
      avgUnitPrice,
      unitMargin,
      gmPct,
      lastSaleAt,
      velocity: velocityW,
      forecastDailyUnits,
      daysSupply,
      projectedStockoutAt,
      leadTimeDays,
      cadenceDays,
      reorderPointDays,
      targetCoverDays,
      recommendedQty,
      recommendedCost,
      orderByDate,
      coverageAfterSnappedOrderDays,
      minOrderOvershootsTarget,
      suppressedRecommendedQty,
      lostMarginPerDay,
      expectedMarginLossBeforeReplenishment: expectedLoss,
      reorderPriorityScore: 0, // filled in pass 2
      deadweightScore: 0, // filled in pass 2 (needs capital p95)
      reorderFactors: [], // filled in pass 2
      deadweightFactors: [], // filled in pass 2
      confidenceScore,
      recentSeller,
      outRegretted,
      doNotReorder: false, // filled in pass 2
      action: 'hold',
    }

    mids.push({ row, lostMarginPerDay, expectedLoss, slowScore, ageScore, expiryScore, marginWeakness })
  }

  // p95 normalizers across the set.
  const lossSorted = mids.map((m) => m.expectedLoss).filter((x) => x > 0).sort((a, b) => a - b)
  const lostSorted = mids.map((m) => m.lostMarginPerDay).filter((x) => x > 0).sort((a, b) => a - b)
  const capitalSorted = mids.map((m) => m.row.onHandCost).filter((x) => x > 0).sort((a, b) => a - b)
  const p95Loss = pctile(lossSorted, 0.95)
  const p95Lost = pctile(lostSorted, 0.95)
  const p95Capital = pctile(capitalSorted, 0.95)

  // Pass 2: scores + actions.
  for (const m of mids) {
    const row = m.row

    // --- Deadweight score, decomposed into its weighted terms. We build
    // the factor list from raw (unrounded) point contributions and derive
    // the displayed score as clamp(round(Σ contribution), 0, 100) so the
    // justification bars in the UI always sum to the number shown. ---
    const capitalScore = normLog(row.onHandCost, p95Capital)
    const deadweightFactors: InventoryScoreFactor[] = [
      { key: 'slow', label: 'Slow velocity', weight: 0.3, norm: m.slowScore, contribution: 30 * m.slowScore },
      { key: 'capital', label: 'Capital tied up', weight: 0.25, norm: capitalScore, contribution: 25 * capitalScore },
      { key: 'age', label: 'Inventory age', weight: 0.2, norm: m.ageScore, contribution: 20 * m.ageScore },
      { key: 'expiry', label: 'Expiry proximity', weight: 0.15, norm: m.expiryScore, contribution: 15 * m.expiryScore },
      { key: 'margin_weakness', label: 'Weak margin', weight: 0.1, norm: m.marginWeakness, contribution: 10 * m.marginWeakness },
    ]
    row.deadweightScore = clamp(
      Math.round(sum(deadweightFactors.map((f) => f.contribution))),
      0,
      100,
    )
    row.deadweightFactors = deadweightFactors

    // --- Reorder priority score, likewise decomposed. The deadweight
    // penalty is a NEGATIVE term (we deprioritise reordering things we're
    // simultaneously trying to exit). ---
    const reorderGapDays =
      row.daysSupply !== null ? Math.max(0, row.reorderPointDays - row.daysSupply) : row.reorderPointDays
    const expectedLossNorm = normLog(m.expectedLoss, p95Loss)
    const reorderGapNorm = clamp(reorderGapDays / 14, 0, 1)
    const lostMarginNorm = normLog(m.lostMarginPerDay, p95Lost)
    const penaltyNorm = row.deadweightScore >= 70 ? 1 : 0
    const reorderFactors: InventoryScoreFactor[] = [
      { key: 'expected_loss', label: 'Margin loss before restock', weight: 0.5, norm: expectedLossNorm, contribution: 50 * expectedLossNorm },
      { key: 'reorder_gap', label: 'Below reorder point', weight: 0.25, norm: reorderGapNorm, contribution: 25 * reorderGapNorm },
      { key: 'lost_margin', label: 'Lost margin / day', weight: 0.15, norm: lostMarginNorm, contribution: 15 * lostMarginNorm },
      { key: 'confidence', label: 'Confidence', weight: 0.1, norm: row.confidenceScore, contribution: 10 * row.confidenceScore },
      { key: 'deadweight_penalty', label: 'Deadweight penalty', weight: -0.2, norm: penaltyNorm, contribution: -20 * penaltyNorm },
    ]
    row.reorderPriorityScore = clamp(
      Math.round(sum(reorderFactors.map((f) => f.contribution))),
      0,
      100,
    )
    row.reorderFactors = reorderFactors

    // do_not_reorder
    row.doNotReorder =
      row.deadweightScore >= 70 ||
      (row.units28 === 0 && (row.avgInventoryAgeDays ?? 0) >= 60 && row.onHandCost >= 50)

    row.action = classifyAction(row)
  }

  const skus = mids.map((m) => m.row)

  // Summary.
  const summary: InventoryProcurementSummary = {
    skuCount: skus.length,
    totalOnHandCost: round2(sum(skus.map((s) => s.onHandCost))),
    outRegrettedCount: skus.filter((s) => s.outRegretted).length,
    outRegrettedLostMarginPerDay: round2(sum(skus.filter((s) => s.outRegretted).map((s) => s.lostMarginPerDay))),
    soonOutCount: skus.filter((s) => s.forecastDailyUnits > 0 && s.daysSupply !== null && s.daysSupply <= s.reorderPointDays).length,
    recommendedOrderCostTotal: round2(sum(skus.filter((s) => !s.doNotReorder).map((s) => s.recommendedCost))),
    deadweightCapital: round2(sum(skus.filter((s) => s.deadweightScore >= 70).map((s) => s.onHandCost))),
    zeroVelocityCapital: round2(sum(skus.filter((s) => s.units90 === 0 && s.physicalUnits > 0).map((s) => s.onHandCost))),
    expiringSoonCost: round2(sum(skus.map((s) => s.expiringCost60))),
    lowConfidenceCount: skus.filter((s) => s.confidenceScore < 0.6).length,
  }

  const distributors = Array.from(distByKey.values()).sort((a, b) =>
    a.distributorName.localeCompare(b.distributorName),
  )

  const categoryOverhang = computeCategoryOverhang(skus)

  return {
    asOf: asOf.toISOString(),
    generatedAt: asOf.toISOString(),
    params: { windowDays: p.windowDays, defaultLeadDays: p.defaultLeadDays, sites: [...p.sites] },
    summary,
    skus,
    distributors,
    categoryOverhang,
    methodology: METHODOLOGY,
  }
}

// ============================================================================
// Category overhang — roll capital-tied-up vs realized demand up to category
// grain so the operator can see structural overstacking (e.g. "Flower is
// carrying 35% of capital but earning 18% of margin") that no single SKU row
// reveals. Worst overhang first; only categories with real capital surface.
// ============================================================================
function computeCategoryOverhang(
  skus: readonly InventorySkuRow[],
): InventoryCategoryOverhang[] {
  interface Acc {
    onHandCost: number
    windowMargin: number
    skuCount: number
    deadweightCapital: number
  }
  const byCat = new Map<string, Acc>()
  for (const s of skus) {
    if (s.onHandCost <= 0 && s.marginWindow <= 0) continue
    const key = s.categoryName ?? 'Uncategorized'
    let a = byCat.get(key)
    if (!a) {
      a = { onHandCost: 0, windowMargin: 0, skuCount: 0, deadweightCapital: 0 }
      byCat.set(key, a)
    }
    a.onHandCost += Math.max(0, s.onHandCost)
    a.windowMargin += Math.max(0, s.marginWindow)
    a.skuCount += 1
    if (s.deadweightScore >= 70) a.deadweightCapital += Math.max(0, s.onHandCost)
  }
  const totalCost = sum([...byCat.values()].map((a) => a.onHandCost))
  const totalMargin = sum([...byCat.values()].map((a) => a.windowMargin))

  const rows: InventoryCategoryOverhang[] = []
  for (const [categoryName, a] of byCat) {
    const onHandCostShare = totalCost > 0 ? a.onHandCost / totalCost : 0
    const marginShare = totalMargin > 0 ? a.windowMargin / totalMargin : 0
    // Capital we're carrying above a demand-proportional level. If a category
    // earns 18% of margin it has no business holding 35% of capital; the gap
    // is the freeable dollars.
    const excessCapital = Math.max(0, a.onHandCost - marginShare * totalCost)
    // Ratio of capital share to demand share. marginShare→0 with capital on
    // hand means "all capital, no demand" — represent as a large finite ratio.
    const overhangRatio =
      marginShare > 0 ? onHandCostShare / marginShare : onHandCostShare > 0 ? 99 : 0
    rows.push({
      categoryName,
      skuCount: a.skuCount,
      onHandCost: round2(a.onHandCost),
      onHandCostShare: round4(onHandCostShare),
      windowMargin: round2(a.windowMargin),
      marginShare: round4(marginShare),
      overhangRatio: round2(overhangRatio),
      excessCapital: round2(excessCapital),
      deadweightCapital: round2(a.deadweightCapital),
    })
  }
  // Worst overhang first, breaking ties by freeable dollars.
  rows.sort((x, y) => y.overhangRatio - x.overhangRatio || y.excessCapital - x.excessCapital)
  return rows
}

// ============================================================================
// On-demand per-SKU daily sales history (powers the insight-panel sparkline).
// Maps order lines to product via the SAME latest-snapshot package dimension
// the velocity calc uses, so the sparkline total reconciles with the row's
// displayed units. NY-local business-day buckets; canceled lines excluded.
// ============================================================================

const SKU_HISTORY_SQL = `
WITH pkg_dim AS (
  SELECT DISTINCT ON (s.dealer_id, s.inventory_item_id)
    s.dealer_id, s.inventory_item_id, s.product_id
  FROM sweed_package_snapshots s
  WHERE s.dealer_id = $1::bigint AND s.product_id = $2::bigint
  ORDER BY s.dealer_id, s.inventory_item_id, s.observed_at_max DESC
)
SELECT
  (${bucketLocalExpr('day', 'f.pay_time')})::date AS d,
  sum(f.qty)     AS units,
  sum(f.revenue) AS revenue
FROM sweed_order_items_flat f
JOIN pkg_dim pd ON pd.dealer_id = f.dealer_id AND pd.inventory_item_id = f.inventory_item_id
WHERE f.dealer_id = $1::bigint
  AND f.pay_time >= now() - ($3::int || ' days')::interval
  AND lower(coalesce(f.raw_item->'invoiceItemStatus'->>'name', '')) <> 'canceled'
GROUP BY 1
ORDER BY 1
`

interface SkuHistoryRow {
  d: string | Date
  units: string | number | null
  revenue: string | number | null
}

export async function getInventorySkuHistory(args: {
  dealerId: number
  productId: number
  days: number
}): Promise<InventorySkuHistoryResponse> {
  const pool = getPool()
  const res = await pool.query<SkuHistoryRow>(SKU_HISTORY_SQL, [
    args.dealerId,
    args.productId,
    args.days,
  ])

  // Index observed days, then zero-fill the whole window so the chart is
  // honest about no-sale days. Keys are NY-local business-day ISO dates.
  const byDate = new Map<string, { units: number; revenue: number }>()
  for (const r of res.rows) {
    const key = r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10)
    byDate.set(key, { units: num(r.units), revenue: num(r.revenue) })
  }

  const series: InventorySkuHistoryResponse['series'] = []
  let totalUnits = 0
  let totalRevenue = 0
  // Walk day-by-day from (days-1) ago to today in NY-local business-day
  // space, zero-filling. Dedupe keys (a DST-boundary day can otherwise
  // repeat when stepping by a fixed 24h) so totals can't double-count.
  const SHIFT_MS = 8 * 3600_000
  const seen = new Set<string>()
  for (let i = args.days - 1; i >= 0; i--) {
    const key = nyBusinessDayKey(Date.now() - i * DAY_MS, SHIFT_MS)
    if (seen.has(key)) continue
    seen.add(key)
    const hit = byDate.get(key)
    const units = hit?.units ?? 0
    const revenue = hit?.revenue ?? 0
    series.push({ date: key, units, revenue })
    totalUnits += units
    totalRevenue += revenue
  }

  return {
    dealerId: args.dealerId,
    productId: args.productId,
    days: args.days,
    totalUnits: round2(totalUnits),
    totalRevenue: round2(totalRevenue),
    series,
  }
}

// NY-local business-day key (YYYY-MM-DD) for a UTC ms instant: shift back
// 8h so pre-08:00 sales fall on the prior business day, then format in the
// America/New_York wall-clock — mirrors bucketLocalExpr('day', …).
function nyBusinessDayKey(ms: number, shiftMs: number): string {
  const shifted = new Date(ms - shiftMs)
  // en-CA gives YYYY-MM-DD; timeZone renders NY wall-clock.
  return shifted.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

function classifyAction(row: InventorySkuRow): InventoryAction {
  const hasStock = row.physicalUnits > 0
  const turnDays = row.daysSupply // days to clear sellable stock at current velocity; null = no demand forecast
  const age = row.avgInventoryAgeDays
  const matured = age !== null && age >= HARD_TURN_DAYS // we've effectively paid for it

  // --- Exit / liquidate (capital recovery) takes precedence. Driven by the
  // inventory-turn policy, NOT by an arbitrary deadweight-score threshold:
  // we want to surface every genuinely slow / aged / no-sale capital trap,
  // not just the handful that happen to clear 70/80. ---

  // Nothing sold in 90 days while stock sits on hand: the capital is
  // stranded. Actively liquidate if the dollars justify a markdown effort;
  // otherwise just stop carrying and let it draw down.
  if (hasStock && row.units90 === 0) {
    return row.onHandCost >= LIQUIDATE_MIN_CAPITAL ? 'liquidate_now' : 'burn_down_stop_carry'
  }

  // Won't clear before the 60-day "already paid for it" mark (or has already
  // sat that long) AND it's a weak holding — stop carrying it. We don't burn
  // down an otherwise-healthy seller that's merely overstocked; that falls
  // through to "reduce future orders" below.
  if (hasStock) {
    const wontTurnByHard = (turnDays !== null && turnDays > HARD_TURN_DAYS) || matured
    const weakHolding =
      row.units28 === 0 ||
      matured ||
      (turnDays !== null && turnDays > 2 * HARD_TURN_DAYS) ||
      (row.gmPct !== null && row.gmPct < 0.35)
    if (wontTurnByHard && weakHolding) return 'burn_down_stop_carry'
  }

  // Hidden stock is worth surfacing even before the overshoot check.
  if (row.sellableUnits === 0 && row.hiddenStock) return 'check_hidden_stock'

  // There's demand, but the case-rounded minimum order would overstock the
  // SKU past its target window — don't recommend it (distinct from no-demand
  // do_not_reorder, and applies even to out-of-stock recent sellers).
  if (row.minOrderOvershootsTarget) return 'skip_min_order_overshoots'

  // Out / reorder.
  if (row.sellableUnits === 0) {
    if (row.recommendedQty > 0 && row.distributorName) return 'order_now'
    if (row.recommendedQty > 0) return 'order_now_supplier_unknown'
    if (row.recentSeller) return 'accept_stockout'
    return 'do_not_reorder'
  }
  if (row.recommendedQty > 0 && row.daysSupply !== null && row.daysSupply <= row.reorderPointDays) {
    return row.distributorName ? 'order_now' : 'order_now_supplier_unknown'
  }
  if (row.recommendedQty > 0) return 'reorder_soon'

  // Expiry / overstock.
  if (row.daysToNearestExpiration !== null && row.daysToNearestExpiration <= 45 && row.physicalUnits > 0)
    return 'reprice_before_expiry'
  // Healthy seller, but overstocked past the 60-day hard-turn mark — don't
  // reorder; let it draw down. (Weak/aged overstock was already exited above.)
  if (row.daysSupply !== null && row.daysSupply > HARD_TURN_DAYS) return 'reduce_future_orders'
  return 'hold'
}

function sum(xs: number[]): number {
  let t = 0
  for (const x of xs) t += x
  return t
}
function round2(x: number): number {
  return Math.round(x * 100) / 100
}
function round4(x: number): number {
  return Math.round(x * 10000) / 10000
}

const METHODOLOGY: string[] = [
  'SKU grain = (store, product_id), aggregated over the latest snapshot of each package (distinct-on observed_at_max desc).',
  'Sell-through (velocity) comes from sweed_order_items_flat over a trailing window (default 28d), mapped package→product via the latest snapshot. Revenue is pre-discount list price (order-level discounts are tiny and unallocated).',
  'Unit cost = current-quantity-weighted average wholesale cost across the SKU\'s on-hand packages. Unit margin = avg unit price − unit cost. COGS is not joined per-sale.',
  'Forecast daily units blends 7d and window velocity (0.6·v7 + 0.4·vW), capped at 3× the window velocity to damp spikes.',
  'Days supply = sellable units ÷ forecast daily units. Reorder point = lead time + safety (¼ lead, min 2d). Target cover = clamp(lead + cadence + safety, 10..45). Recommended qty = ceil(forecast·targetCover − sellable units), floored at 0.',
  'Recommended quantities are snapped to supplier case sizing: any nonzero recommendation is rounded UP to the nearest multiple of 5, with a 10-unit minimum per SKU. (True per-SKU case sizes are not yet recorded; this is a uniform approximation.)',
  'When the case-rounded minimum order would overstock a slow mover — pushing post-order days-of-supply past min(2× target cover, 60 days) — the recommendation is SUPPRESSED (recommendedQty = 0, action "skip_min_order_overshoots") rather than misleading the operator into an uneconomic buy. There is real demand, but the minimum case is too chunky; the qty we declined is shown as suppressedRecommendedQty. No brand/category variety exception exists yet, so these are not auto-ordered.',
  'Lead time defaults to a configurable constant (PO line received-at is not populated in source data); reorder cadence is the median gap between distributor delivery dates, clamped 7..45 days.',
  'Package received-at is not populated upstream, so inventory age is recovered from the FIRST snapshot in which we observed the package on hand (qty > 0); it is a lower bound on true age (coalesce(received_at, first-observed-on-hand, latest snapshot time)).',
  'Inventory-turn policy: we target a ~21-day turn and treat 60 days as the "already paid for it" mark. Slow-velocity and age deadweight terms ramp to full over the 21→60-day window (no-sale stock pegs at 1). Exit advice is driven by this turn framing, not by an arbitrary deadweight-score cutoff: any SKU with stock and zero 90-day sales is flagged liquidate/burn-down, and weak or aged holdings that won\'t clear by 60 days are flagged stop-carry.',
  'Reorder priority blends expected margin loss before replenishment (50%), reorder gap (25%), lost margin/day (15%), confidence (10%), minus a deadweight penalty. Deadweight score blends slow velocity, capital tied up, age, expiry proximity, and weak margin.',
  'Category overhang rolls each category\'s on-hand capital share up against its share of realized window margin; overhang ratio = capital share ÷ margin share (>1 means it carries more capital than its demand earns), and excess capital = on-hand cost − demand-proportional cost — the dollars that could be freed by drawing the category down.',
  'All time windows and day boundaries use America/New_York per repo convention.',
]
