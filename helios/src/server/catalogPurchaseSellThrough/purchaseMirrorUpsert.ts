import { z } from 'zod'

import { withTransaction } from '../db/tx.js'

// ============================================================================
// Shared Sweed-purchase mirror upsert.
//
// Single source of truth for turning a `store.purchase.order.get`
// (or `store.purchase.order.payment.add`) response into the
// `sweed_purchases` + `sweed_purchase_line_items` mirror rows. Used by:
//   * the ingest worker (configWorkersSweedPurchasesIngestJob), which
//     polls Sweed periodically; and
//   * the interactive payment-record route
//     (routes/catalogPurchaseSellThrough.ts), which writes a payment to
//     Sweed and then re-mirrors the returned PO so the page reflects the
//     new financial status immediately.
//
// Keeping the normalisation + upsert here (rather than in the worker job)
// avoids the Fastify request path importing a worker-job module.
// ============================================================================

// ----- Schemas -----

export const PoPositionSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    distributorProduct: z
      .object({
        id: z.union([z.string(), z.number()]).nullable().optional(),
        name: z.string().nullable().optional(),
        externalTrackCode: z.string().nullable().optional(),
        product: z
          .object({
            id: z.union([z.string(), z.number()]).nullable().optional(),
            name: z.string().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    suggestedProduct: z
      .object({
        id: z.union([z.string(), z.number()]).nullable().optional(),
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    distributorProductQty: z.coerce.number().nullable().optional(),
    orderPositionQty: z.coerce.number().nullable().optional(),
    positionProductQty: z.coerce.number().nullable().optional(),
    extendedAmount: z.coerce.number().nullable().optional(),
    regularAmount: z.coerce.number().nullable().optional(),
    distributorProductPrice: z.coerce.number().nullable().optional(),
    discountProductPrice: z.coerce.number().nullable().optional(),
    productPrice: z.coerce.number().nullable().optional(),
    externalTrackCode: z.string().nullable().optional(),
    packOfSize: z.coerce.number().int().nullable().optional(),
    isTradeSample: z.boolean().nullable().optional(),
    isTestingSample: z.boolean().nullable().optional(),
    orderPositionIntegrationData: z
      .object({
        externalTrackCode: z.string().nullable().optional(),
        sourceTag: z.string().nullable().optional(),
        wholesalePrice: z.coerce.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    productSize: z
      .object({
        uomNumber: z.coerce.number().nullable().optional(),
        uom: z
          .object({ abbr: z.string().nullable().optional(), name: z.string().nullable().optional() })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    catalogProductSize: z
      .object({
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()

export const PoDetailSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    name: z.string().nullable().optional(),
    externalOrderId: z.string().nullable().optional(),
    deliveryDate: z.string().nullable().optional(),
    dueDate: z.string().nullable().optional(),
    orderStatus: z
      .object({ id: z.coerce.number().int().nullable().optional(), name: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    financialStatus: z
      .object({ name: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    distributor: z
      .object({
        id: z.coerce.number().int().nullable().optional(),
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    distributorIntegration: z
      .object({
        id: z.coerce.number().int().nullable().optional(),
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    isCashOnDelivery: z.boolean().nullable().optional(),
    totalPayAmount: z.coerce.number().nullable().optional(),
    totalSubtotalAmount: z.coerce.number().nullable().optional(),
    totalRegularAmount: z.coerce.number().nullable().optional(),
    totalDiscountAmount: z.coerce.number().nullable().optional(),
    totalDeliveryChargesAmount: z.coerce.number().nullable().optional(),
    totalTaxAmount: z.coerce.number().nullable().optional(),
    totalOwedAmount: z.coerce.number().nullable().optional(),
    totalProductQty: z.coerce.number().nullable().optional(),
    totalDistributorProductQty: z.coerce.number().nullable().optional(),
    positions: z.array(PoPositionSchema).default([]),
  })
  .passthrough()

export type PoDetail = z.infer<typeof PoDetailSchema>
export type PoPosition = z.infer<typeof PoPositionSchema>

// ----- Normalisation -----

function deliveryDateOnly(raw: string | null | undefined): string | null {
  if (!raw) return null
  // Sweed `deliveryDate` is an ISO timestamp like "2026-06-01T00:00:00Z".
  return raw.slice(0, 10)
}

export interface NormalisedHeader {
  dealerId: number
  siteKey: string
  poId: string
  poName: string | null
  externalOrderId: string | null
  deliveryDate: string | null
  deliveryAt: Date | null
  paymentDueDate: string | null
  orderStatusId: number | null
  orderStatusName: string | null
  financialStatusName: string | null
  isCashOnDelivery: boolean | null
  distributorId: number | null
  distributorName: string | null
  distributorIntegrationId: number | null
  distributorIntegrationName: string | null
  poTotalDollars: number | null
  poSubtotalDollars: number | null
  poRegularDollars: number | null
  poDiscountDollars: number | null
  poDeliveryChargesDollars: number | null
  poTaxDollars: number | null
  poOwedDollars: number | null
  orderedUnitsTotal: number | null
  distributorProductQtyTotal: number | null
  raw: unknown
}

export interface NormalisedLine {
  lineId: string
  lineIndex: number
  distributorProductId: string | null
  distributorProductName: string | null
  sweedProductId: number | null
  sweedProductName: string | null
  sizeLabel: string | null
  packCount: number | null
  orderedUnits: number
  distributorProductQty: number | null
  extendedCostDollars: number | null
  unitCostDollars: number | null
  unitCostSource: string
  discountProductPriceDollars: number | null
  metrcWholesalePriceDollars: number | null
  listPriceDollarsAtIngest: number | null
  isTradeSample: boolean | null
  isTestingSample: boolean | null
  metrcTag: string | null
  raw: unknown
}

export function normaliseHeader(
  dealerId: number,
  siteKey: string,
  detail: PoDetail,
): NormalisedHeader {
  return {
    dealerId,
    siteKey,
    poId: String(detail.id),
    poName: detail.name ?? null,
    externalOrderId: detail.externalOrderId ?? null,
    deliveryDate: deliveryDateOnly(detail.deliveryDate ?? null),
    deliveryAt: detail.deliveryDate ? new Date(detail.deliveryDate) : null,
    paymentDueDate: deliveryDateOnly(detail.dueDate ?? null),
    orderStatusId: detail.orderStatus?.id ?? null,
    orderStatusName: detail.orderStatus?.name ?? null,
    financialStatusName: detail.financialStatus?.name ?? null,
    isCashOnDelivery: detail.isCashOnDelivery ?? null,
    distributorId: detail.distributor?.id ?? null,
    distributorName: detail.distributor?.name ?? null,
    distributorIntegrationId: detail.distributorIntegration?.id ?? null,
    distributorIntegrationName: detail.distributorIntegration?.name ?? null,
    poTotalDollars: detail.totalPayAmount ?? null,
    poSubtotalDollars: detail.totalSubtotalAmount ?? null,
    poRegularDollars: detail.totalRegularAmount ?? null,
    poDiscountDollars: detail.totalDiscountAmount ?? null,
    poDeliveryChargesDollars: detail.totalDeliveryChargesAmount ?? null,
    poTaxDollars: detail.totalTaxAmount ?? null,
    poOwedDollars: detail.totalOwedAmount ?? null,
    orderedUnitsTotal: detail.totalProductQty ?? null,
    distributorProductQtyTotal: detail.totalDistributorProductQty ?? null,
    raw: detail,
  }
}

export function normaliseLine(index: number, p: PoPosition): NormalisedLine {
  const orderedUnits = p.positionProductQty ?? p.orderPositionQty ?? p.distributorProductQty ?? 0
  const extended = p.extendedAmount ?? null
  let unitCost: number | null = null
  let unitCostSource = 'unknown'
  // Treat a literal 0 in the per-line price fields as "not provided"
  // — some distributors (e.g. HR BOTANICAL) send 0 in
  // distributorProductPrice / discountProductPrice and carry the real
  // amount only in extendedAmount. Without the `> 0` guard the
  // fallback to (extended / orderedUnits) never fires and every line
  // on those POs lands with unit_cost_dollars = 0, which silently
  // zeroes the entire sold-through payment basis on the
  // Catalog → Purchase Sell-Through page family.
  if (
    p.distributorProductPrice !== null &&
    p.distributorProductPrice !== undefined &&
    p.distributorProductPrice > 0
  ) {
    unitCost = p.distributorProductPrice
    unitCostSource = 'distributor_product_price'
  } else if (
    p.discountProductPrice !== null &&
    p.discountProductPrice !== undefined &&
    p.discountProductPrice > 0
  ) {
    unitCost = p.discountProductPrice
    unitCostSource = 'discount_product_price'
  } else if (extended !== null && orderedUnits > 0) {
    unitCost = extended / orderedUnits
    unitCostSource = 'derived_from_extended'
  }
  const metrcTag =
    p.externalTrackCode ??
    p.distributorProduct?.externalTrackCode ??
    p.orderPositionIntegrationData?.externalTrackCode ??
    null
  const wholesale = p.orderPositionIntegrationData?.wholesalePrice ?? null
  const metrcWholesalePerUnit =
    wholesale !== null && orderedUnits > 0 ? wholesale / orderedUnits : null

  const sweedProductRaw =
    p.suggestedProduct?.id ?? p.distributorProduct?.product?.id ?? null
  const sweedProductId =
    sweedProductRaw === null
      ? null
      : typeof sweedProductRaw === 'number'
        ? sweedProductRaw
        : Number(sweedProductRaw)
  const sweedProductName =
    p.suggestedProduct?.name ?? p.distributorProduct?.product?.name ?? null

  const sizeLabel = p.catalogProductSize?.name ?? null
  const packCount = p.packOfSize ?? null

  const distributorProductIdRaw = p.distributorProduct?.id ?? null
  const distributorProductId =
    distributorProductIdRaw === null ? null : String(distributorProductIdRaw)

  return {
    lineId: String(p.id),
    lineIndex: index,
    distributorProductId,
    distributorProductName: p.distributorProduct?.name ?? null,
    sweedProductId: Number.isFinite(sweedProductId ?? NaN) ? sweedProductId : null,
    sweedProductName,
    sizeLabel,
    packCount,
    orderedUnits,
    distributorProductQty: p.distributorProductQty ?? null,
    extendedCostDollars: extended,
    unitCostDollars: unitCost,
    unitCostSource,
    discountProductPriceDollars: p.discountProductPrice ?? null,
    metrcWholesalePriceDollars: metrcWholesalePerUnit,
    listPriceDollarsAtIngest: p.productPrice ?? null,
    isTradeSample: p.isTradeSample ?? null,
    isTestingSample: p.isTestingSample ?? null,
    metrcTag,
    raw: p,
  }
}

export async function upsertPurchase(header: NormalisedHeader, lines: NormalisedLine[]): Promise<void> {
  await withTransaction(async (db) => {
    // ----- Pre-resolve package matches via metrc_tag → snapshot -----
    const metrcTags = lines.map((l) => l.metrcTag).filter((t): t is string => t !== null)
    const metrcToPackages = new Map<string, { inventoryItemIds: string[]; receivedAtMin: Date | null; receivedAtMax: Date | null }>()
    if (metrcTags.length > 0) {
      const res = await db.query<{
        metrc_tag: string
        inventory_item_id: string
        received_at_min: string | Date | null
        received_at_max: string | Date | null
      }>(
        `select sps.metrc_tag,
                sps.inventory_item_id,
                min(sps.received_at) as received_at_min,
                max(sps.observed_at_max) as received_at_max
           from sweed_package_snapshots sps
          where sps.dealer_id = $1
            and sps.metrc_tag = any($2::text[])
          group by sps.metrc_tag, sps.inventory_item_id`,
        [header.dealerId, metrcTags],
      )
      for (const row of res.rows) {
        const prev = metrcToPackages.get(row.metrc_tag) ?? {
          inventoryItemIds: [],
          receivedAtMin: null,
          receivedAtMax: null,
        }
        prev.inventoryItemIds.push(row.inventory_item_id)
        const rmin = row.received_at_min ? new Date(row.received_at_min as string) : null
        const rmax = row.received_at_max ? new Date(row.received_at_max as string) : null
        if (rmin && (!prev.receivedAtMin || rmin < prev.receivedAtMin)) prev.receivedAtMin = rmin
        if (rmax && (!prev.receivedAtMax || rmax > prev.receivedAtMax)) prev.receivedAtMax = rmax
        metrcToPackages.set(row.metrc_tag, prev)
      }
    }

    // ----- Also pull product → catalog denorms from sweed_package_snapshots
    //       so we can fill brand/category/subcategory/size on the line
    //       without a second round-trip per-render. We use the most
    //       recent snapshot keyed off inventory_item_id (the metrc
    //       match) when available, else by sweed_product_id.
    const inventoryItemIds = [...new Set(
      [...metrcToPackages.values()].flatMap((v) => v.inventoryItemIds),
    )]
    const sweedProductIds = [
      ...new Set(lines.map((l) => l.sweedProductId).filter((v): v is number => v !== null)),
    ]
    const productDenormByInv = new Map<
      string,
      { brandName: string | null; brandId: number | null; categoryName: string | null; categoryId: number | null; subcategoryName: string | null; subcategoryId: number | null; sizeLabel: string | null; productName: string | null; productSku: string | null }
    >()
    const productDenormByProductId = new Map<
      number,
      { brandName: string | null; brandId: number | null; categoryName: string | null; categoryId: number | null; subcategoryName: string | null; subcategoryId: number | null; sizeLabel: string | null; productName: string | null; productSku: string | null }
    >()
    if (inventoryItemIds.length > 0) {
      const res = await db.query<{
        inventory_item_id: string
        product_id: number | null
        product_name: string | null
        product_sku: string | null
        brand_id: number | null
        brand_name: string | null
        category_id: number | null
        category_name: string | null
        subcategory_id: number | null
        subcategory_name: string | null
        size_label: string | null
      }>(
        `select inventory_item_id, product_id, product_name, product_sku,
                brand_id, brand_name, category_id, category_name,
                subcategory_id, subcategory_name, size_label
           from sweed_package_current
          where dealer_id = $1
            and inventory_item_id = any($2::text[])`,
        [header.dealerId, inventoryItemIds],
      )
      for (const row of res.rows) {
        productDenormByInv.set(row.inventory_item_id, {
          brandName: row.brand_name,
          brandId: row.brand_id,
          categoryName: row.category_name,
          categoryId: row.category_id,
          subcategoryName: row.subcategory_name,
          subcategoryId: row.subcategory_id,
          sizeLabel: row.size_label,
          productName: row.product_name,
          productSku: row.product_sku,
        })
        if (row.product_id) {
          productDenormByProductId.set(row.product_id, {
            brandName: row.brand_name,
            brandId: row.brand_id,
            categoryName: row.category_name,
            categoryId: row.category_id,
            subcategoryName: row.subcategory_name,
            subcategoryId: row.subcategory_id,
            sizeLabel: row.size_label,
            productName: row.product_name,
            productSku: row.product_sku,
          })
        }
      }
    }
    if (sweedProductIds.length > 0) {
      const res = await db.query<{
        product_id: number
        product_name: string | null
        product_sku: string | null
        brand_id: number | null
        brand_name: string | null
        category_id: number | null
        category_name: string | null
        subcategory_id: number | null
        subcategory_name: string | null
        size_label: string | null
      }>(
        `select distinct on (product_id) product_id, product_name, product_sku,
                brand_id, brand_name, category_id, category_name,
                subcategory_id, subcategory_name, size_label
           from sweed_package_snapshots
          where dealer_id = $1
            and product_id = any($2::bigint[])
          order by product_id, observed_at_max desc`,
        [header.dealerId, sweedProductIds],
      )
      for (const row of res.rows) {
        if (!productDenormByProductId.has(row.product_id)) {
          productDenormByProductId.set(row.product_id, {
            brandName: row.brand_name,
            brandId: row.brand_id,
            categoryName: row.category_name,
            categoryId: row.category_id,
            subcategoryName: row.subcategory_name,
            subcategoryId: row.subcategory_id,
            sizeLabel: row.size_label,
            productName: row.product_name,
            productSku: row.product_sku,
          })
        }
      }
    }

    // ----- Compute line-level denorms + header roll-ups -----
    interface ResolvedLine extends NormalisedLine {
      matchedInventoryItemIds: string[]
      packageMatchMethod: string
      packageMatchConfidence: number | null
      receivedAtMin: Date | null
      receivedAtMax: Date | null
      brandId: number | null
      brandName: string | null
      categoryId: number | null
      categoryName: string | null
      subcategoryId: number | null
      subcategoryName: string | null
      resolvedSizeLabel: string | null
      productName: string | null
      productSku: string | null
    }
    const resolved: ResolvedLine[] = lines.map((l) => {
      const match = l.metrcTag ? metrcToPackages.get(l.metrcTag) : undefined
      const matchedIds = match?.inventoryItemIds ?? []
      const denormFromInv = matchedIds.length > 0 ? productDenormByInv.get(matchedIds[0]!) : undefined
      const denormFromProd =
        l.sweedProductId !== null ? productDenormByProductId.get(l.sweedProductId) : undefined
      const denorm = denormFromInv ?? denormFromProd ?? null
      return {
        ...l,
        matchedInventoryItemIds: matchedIds,
        packageMatchMethod: matchedIds.length > 0 ? 'direct_metrc_tag' : 'unmatched',
        packageMatchConfidence: matchedIds.length > 0 ? 1 : null,
        receivedAtMin: match?.receivedAtMin ?? null,
        receivedAtMax: match?.receivedAtMax ?? null,
        brandId: denorm?.brandId ?? null,
        brandName: denorm?.brandName ?? null,
        categoryId: denorm?.categoryId ?? null,
        categoryName: denorm?.categoryName ?? null,
        subcategoryId: denorm?.subcategoryId ?? null,
        subcategoryName: denorm?.subcategoryName ?? null,
        resolvedSizeLabel: l.sizeLabel ?? denorm?.sizeLabel ?? null,
        productName: denorm?.productName ?? l.sweedProductName ?? null,
        productSku: denorm?.productSku ?? null,
      }
    })

    const productIds = [...new Set(resolved.map((r) => r.sweedProductId).filter((v): v is number => v !== null))]
    const productNames = [...new Set(resolved.map((r) => r.productName ?? r.sweedProductName).filter((v): v is string => !!v))]
    const brandNames = [...new Set(resolved.map((r) => r.brandName).filter((v): v is string => !!v))]
    const categoryNames = [...new Set(resolved.map((r) => r.categoryName).filter((v): v is string => !!v))]
    const subcategoryNames = [...new Set(resolved.map((r) => r.subcategoryName).filter((v): v is string => !!v))]
    const lineCount = resolved.length
    const orderedUnitsTotal =
      header.orderedUnitsTotal ?? resolved.reduce((sum, r) => sum + (r.orderedUnits || 0), 0)
    const extendedTotal = resolved.reduce(
      (sum, r) => sum + (r.extendedCostDollars ?? 0),
      0,
    )

    await db.query(
      `
        insert into sweed_purchases (
          dealer_id, po_id, site_key,
          po_name, external_order_id, delivery_date, delivery_at, payment_due_date,
          order_status_name, financial_status_name, is_cash_on_delivery,
          distributor_id, distributor_name, distributor_integration_id, distributor_integration_name,
          po_total_dollars, po_subtotal_dollars, po_regular_amount_dollars,
          po_discount_amount_dollars, po_delivery_charges_dollars, po_tax_dollars, po_owed_dollars,
          ordered_units_total, distributor_product_qty_total, line_count,
          product_ids, product_names, brand_names, category_names, subcategory_names,
          fetched_at, raw_json
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, $21, $22, $23, $24, $25,
          $26::bigint[], $27::text[], $28::text[], $29::text[], $30::text[],
          now(), $31::jsonb
        )
        on conflict (dealer_id, po_id) do update set
          site_key = excluded.site_key,
          po_name = excluded.po_name,
          external_order_id = excluded.external_order_id,
          delivery_date = excluded.delivery_date,
          delivery_at = excluded.delivery_at,
          payment_due_date = excluded.payment_due_date,
          order_status_name = excluded.order_status_name,
          financial_status_name = excluded.financial_status_name,
          is_cash_on_delivery = excluded.is_cash_on_delivery,
          distributor_id = excluded.distributor_id,
          distributor_name = excluded.distributor_name,
          distributor_integration_id = excluded.distributor_integration_id,
          distributor_integration_name = excluded.distributor_integration_name,
          po_total_dollars = excluded.po_total_dollars,
          po_subtotal_dollars = excluded.po_subtotal_dollars,
          po_regular_amount_dollars = excluded.po_regular_amount_dollars,
          po_discount_amount_dollars = excluded.po_discount_amount_dollars,
          po_delivery_charges_dollars = excluded.po_delivery_charges_dollars,
          po_tax_dollars = excluded.po_tax_dollars,
          po_owed_dollars = excluded.po_owed_dollars,
          ordered_units_total = excluded.ordered_units_total,
          distributor_product_qty_total = excluded.distributor_product_qty_total,
          line_count = excluded.line_count,
          product_ids = excluded.product_ids,
          product_names = excluded.product_names,
          brand_names = excluded.brand_names,
          category_names = excluded.category_names,
          subcategory_names = excluded.subcategory_names,
          fetched_at = now(),
          updated_at = now(),
          raw_json = excluded.raw_json
      `,
      [
        header.dealerId,
        header.poId,
        header.siteKey,
        header.poName,
        header.externalOrderId,
        header.deliveryDate,
        header.deliveryAt ? header.deliveryAt.toISOString() : null,
        header.paymentDueDate,
        header.orderStatusName,
        header.financialStatusName,
        header.isCashOnDelivery,
        header.distributorId,
        header.distributorName,
        header.distributorIntegrationId,
        header.distributorIntegrationName,
        header.poTotalDollars ?? extendedTotal,
        header.poSubtotalDollars,
        header.poRegularDollars,
        header.poDiscountDollars,
        header.poDeliveryChargesDollars,
        header.poTaxDollars,
        header.poOwedDollars,
        orderedUnitsTotal,
        header.distributorProductQtyTotal,
        lineCount,
        productIds,
        productNames,
        brandNames,
        categoryNames,
        subcategoryNames,
        JSON.stringify(header.raw),
      ],
    )

    await db.query(
      `delete from sweed_purchase_line_items where dealer_id = $1 and po_id = $2`,
      [header.dealerId, header.poId],
    )

    for (const r of resolved) {
      await db.query(
        `
          insert into sweed_purchase_line_items (
            dealer_id, po_id, line_id, line_index,
            distributor_product_id, distributor_product_name,
            sweed_product_id, sweed_product_name,
            product_name, product_sku,
            brand_id, brand_name, category_id, category_name,
            subcategory_id, subcategory_name, size_label, pack_count,
            ordered_units, distributor_product_qty,
            extended_cost_dollars, unit_cost_dollars, unit_cost_source,
            discount_product_price_dollars, metrc_wholesale_price_dollars,
            is_trade_sample, is_testing_sample,
            list_price_dollars_at_ingest,
            metrc_tag, matched_inventory_item_ids,
            package_match_method, package_match_confidence,
            received_at_min, received_at_max,
            fetched_at, raw_json
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
            $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28,
            $29, $30::text[], $31, $32, $33, $34, now(), $35::jsonb
          )
        `,
        [
          header.dealerId,
          header.poId,
          r.lineId,
          r.lineIndex,
          r.distributorProductId,
          r.distributorProductName,
          r.sweedProductId,
          r.sweedProductName,
          r.productName,
          r.productSku,
          r.brandId,
          r.brandName,
          r.categoryId,
          r.categoryName,
          r.subcategoryId,
          r.subcategoryName,
          r.resolvedSizeLabel,
          r.packCount,
          r.orderedUnits,
          r.distributorProductQty,
          r.extendedCostDollars,
          r.unitCostDollars,
          r.unitCostSource,
          r.discountProductPriceDollars,
          r.metrcWholesalePriceDollars,
          r.isTradeSample,
          r.isTestingSample,
          r.listPriceDollarsAtIngest,
          r.metrcTag,
          r.matchedInventoryItemIds,
          r.packageMatchMethod,
          r.packageMatchConfidence,
          r.receivedAtMin ? r.receivedAtMin.toISOString() : null,
          r.receivedAtMax ? r.receivedAtMax.toISOString() : null,
          JSON.stringify(r.raw),
        ],
      )
    }
  })
}
