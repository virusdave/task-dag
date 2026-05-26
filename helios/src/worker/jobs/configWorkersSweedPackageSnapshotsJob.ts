import { createHash } from 'node:crypto'

import { z } from 'zod'

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type ConfigWorkersSweedPackageSnapshotsJobPayload,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import { callSweedRpcForDealer } from '../sweed/client.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

// ============================================================================
// Sweed per-package snapshot worker (FreshlyBakedNYC/automation#24,
// sibling/unblocker for #21 — Business & Performance Metrics page tree).
//
// Every 5 min during 08:00–02:00 ET (operator-directed cadence — see
// `SWEED_PACKAGE_SNAPSHOTS_DEFAULT_SCHEDULE_WINDOWS`), one job per
// dealer pages through Sweed's `store.inventory.item.list.grouped`
// with `isOnStock: false` (so already-sold-through packages remain
// visible — we need their historical cost for COGS joins).
//
// For each (dealer, inventoryItemId) we compute a stable
// `shape_fingerprint` over the normalised columns. If the most-recent
// row in `sweed_package_snapshots` for that (dealer, inventory_item_id)
// has the SAME fingerprint we just bump its `observed_at_max`.
// Otherwise we INSERT a fresh row whose `observed_at_min` is now and
// whose contents reflect the new shape — this is the per-package
// version history the operator asked for.
//
// No highwater/cursor: the grouped feed is full-scan per tick, and we
// don't have a reliable "modified since" signal on the RPC. The
// fingerprint dedupe + 02:00–08:00 quiet window keeps storage growth
// linear in *change events*, not in *polls*.
//
// Why this matters: Sweed's invoice envelope returns
// `wholesaleCost: 0` on every line item (verified across 1,252 items
// 2026-05-26), so the only source of truth for COGS is this snapshot
// table. The pinned `sweed_package_cost_as_of(dealer, inv, ts)`
// function in the schema gives metric queries the wholesale cost as
// it was on the order date — important when a restock changes cost
// after the fact.
// ============================================================================

const PAGE_SIZE = 50  // matches the operator's example RPC

/**
 * Loose schema for the grouped inventory feed. `.passthrough()`
 * everywhere so unknown fields ride along into `raw_json` for later
 * back-derivation. Field shapes confirmed against the existing
 * `configWorkersStockRefreshJob` schema + the operator's sample RPC.
 */
const InventoryItemPackageSchema = z
  .object({
    id: z.coerce.string().optional(),                    // inventoryItemId
    inventoryItemId: z.coerce.string().optional(),       // some builds use this key
    currentQty: z.coerce.number().nullable().optional(),
    holdQty: z.coerce.number().nullable().optional(),
    availableQty: z.coerce.number().nullable().optional(),

    // Cost — operator-confirmed per-PACKAGE. Field name varies by
    // build; check all of them.
    wholesaleCost: z.coerce.number().nullable().optional(),
    cost: z.coerce.number().nullable().optional(),
    unitWholesaleCost: z.coerce.number().nullable().optional(),

    // Lab data — Sweed nests these under various paths; capture the
    // common ones and fall back to `raw_json` for the rest.
    labResults: z
      .object({
        thc: z.coerce.number().nullable().optional(),
        cbd: z.coerce.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    labData: z.array(z.any()).optional(),

    expirationDate: z.string().nullable().optional(),
    receivedAt: z.string().nullable().optional(),
    receivedDate: z.string().nullable().optional(),

    externalTrackCode: z.string().nullable().optional(),
    internalTrackCode: z.string().nullable().optional(),
    metrcTag: z.string().nullable().optional(),
    metrcPackageTag: z.string().nullable().optional(),

    stockLocation: z
      .object({ id: z.coerce.number().int().optional(), name: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    distributor: z
      .object({ id: z.coerce.number().int().optional(), name: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    distributorName: z.string().nullable().optional(),
  })
  .passthrough()

const InventoryGroupedRowSchema = z
  .object({
    product: z
      .object({
        id: z.coerce.number().int().optional(),
        name: z.string().nullable().optional(),
        shortName: z.string().nullable().optional(),
        sku: z.string().nullable().optional(),
        productCategory: z
          .object({ id: z.coerce.number().int().optional(), name: z.string().nullable().optional() })
          .passthrough()
          .nullable()
          .optional(),
        productSubcategory: z
          .object({ id: z.coerce.number().int().optional(), name: z.string().nullable().optional() })
          .passthrough()
          .nullable()
          .optional(),
        productBrand: z
          .object({ id: z.coerce.number().int().optional(), name: z.string().nullable().optional() })
          .passthrough()
          .nullable()
          .optional(),
        size: z
          .object({ name: z.string().nullable().optional() })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .optional(),
    items: z.array(InventoryItemPackageSchema).default([]),
  })
  .passthrough()

const InventoryGroupedResponseSchema = z
  .object({
    data: z.array(InventoryGroupedRowSchema).default([]),
    totalCount: z.coerce.number().int().min(0).optional(),
  })
  .passthrough()

interface NormalisedSnapshot {
  inventory_item_id: string

  product_id: number | null
  product_name: string | null
  product_short_name: string | null
  product_sku: string | null
  category_id: number | null
  category_name: string | null
  subcategory_id: number | null
  subcategory_name: string | null
  brand_id: number | null
  brand_name: string | null
  size_label: string | null

  current_qty: number | null
  hold_qty: number | null
  available_qty: number | null
  is_on_stock: boolean

  wholesale_cost_dollars: number | null

  metrc_tag: string | null
  internal_track_code: string | null
  lab_thc_pct: number | null
  lab_cbd_pct: number | null
  expiration_date: string | null
  received_at: string | null
  stock_location: string | null
  distributor_name: string | null

  raw_json: unknown
}

function pickNumber(...values: Array<number | null | undefined>): number | null {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v
    }
  }
  return null
}

function pickString(...values: Array<string | null | undefined>): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim().length > 0) {
      return v
    }
  }
  return null
}

function normaliseSnapshot(
  product: z.infer<typeof InventoryGroupedRowSchema>['product'],
  item: z.infer<typeof InventoryItemPackageSchema>,
): NormalisedSnapshot | null {
  const inventoryItemId = pickString(item.inventoryItemId, item.id)
  if (!inventoryItemId) {
    return null
  }

  const currentQty = pickNumber(item.currentQty)
  const availableQty = pickNumber(item.availableQty)
  const holdQty = pickNumber(item.holdQty)
  const isOnStock = (currentQty ?? 0) > 0 || (availableQty ?? 0) > 0

  const expirationRaw = pickString(item.expirationDate)
  const receivedRaw = pickString(item.receivedAt, item.receivedDate)

  return {
    inventory_item_id: inventoryItemId,

    product_id: product?.id ?? null,
    product_name: product?.name ?? null,
    product_short_name: product?.shortName ?? null,
    product_sku: product?.sku ?? null,
    category_id: product?.productCategory?.id ?? null,
    category_name: product?.productCategory?.name ?? null,
    subcategory_id: product?.productSubcategory?.id ?? null,
    subcategory_name: product?.productSubcategory?.name ?? null,
    brand_id: product?.productBrand?.id ?? null,
    brand_name: product?.productBrand?.name ?? null,
    size_label: product?.size?.name ?? null,

    current_qty: currentQty,
    hold_qty: holdQty,
    available_qty: availableQty,
    is_on_stock: isOnStock,

    wholesale_cost_dollars: pickNumber(item.wholesaleCost, item.cost, item.unitWholesaleCost),

    metrc_tag: pickString(item.externalTrackCode, item.metrcTag, item.metrcPackageTag),
    internal_track_code: pickString(item.internalTrackCode),
    lab_thc_pct: pickNumber(item.labResults?.thc),
    lab_cbd_pct: pickNumber(item.labResults?.cbd),
    expiration_date: expirationRaw ? expirationRaw.slice(0, 10) : null,
    received_at: receivedRaw,
    stock_location: pickString(item.stockLocation?.name),
    distributor_name: pickString(item.distributor?.name, item.distributorName),

    raw_json: item,
  }
}

/**
 * Stable fingerprint over the snapshot's "shape" — the columns whose
 * change should produce a new row. Deliberately excludes the raw_json
 * itself (which may add cosmetic fields between polls without any
 * material change).
 */
function computeShapeFingerprint(s: NormalisedSnapshot): string {
  const parts = [
    s.product_id ?? '',
    s.category_id ?? '',
    s.subcategory_id ?? '',
    s.brand_id ?? '',
    s.product_sku ?? '',
    s.size_label ?? '',
    s.current_qty ?? '',
    s.available_qty ?? '',
    s.hold_qty ?? '',
    s.is_on_stock ? '1' : '0',
    s.wholesale_cost_dollars ?? '',
    s.metrc_tag ?? '',
    s.internal_track_code ?? '',
    s.lab_thc_pct ?? '',
    s.lab_cbd_pct ?? '',
    s.expiration_date ?? '',
    s.received_at ?? '',
    s.stock_location ?? '',
    s.distributor_name ?? '',
  ]
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)
}

async function fetchAllPackagesForDealer(
  dealerId: number,
): Promise<NormalisedSnapshot[]> {
  const all: NormalisedSnapshot[] = []
  let page = 1
  // Cap pages defensively — at PAGE_SIZE=50 and a typical store
  // catalog of a few thousand active + sold-through packages, we
  // expect well under 200 pages. The cap is a circuit-breaker so a
  // misbehaving Sweed response can't pin the worker for hours.
  const MAX_PAGES = 400

  while (page <= MAX_PAGES) {
    const raw = await callSweedRpcForDealer(dealerId, 'store.inventory.item.list.grouped', {
      page,
      pageSize: PAGE_SIZE,
      isOnStock: false,  // include sold-through packages
    })
    const parsed = InventoryGroupedResponseSchema.parse(raw)

    for (const row of parsed.data) {
      for (const item of row.items) {
        const snapshot = normaliseSnapshot(row.product, item)
        if (snapshot !== null) {
          all.push(snapshot)
        }
      }
    }

    if (parsed.data.length < PAGE_SIZE) {
      break
    }
    page += 1
  }

  return all
}

interface PersistOutcome {
  itemsSeen: number
  rowsInserted: number
  rowsUpdated: number
  pagesScanned: number
}

async function persistSnapshotsForDealer(
  context: JobHandlerContext,
  dealerId: number,
  snapshots: NormalisedSnapshot[],
  pagesScanned: number,
): Promise<PersistOutcome> {
  let rowsInserted = 0
  let rowsUpdated = 0

  for (const s of snapshots) {
    const fingerprint = computeShapeFingerprint(s)

    await withTransaction(async (db) => {
      // Find the most-recent prior row for this (dealer, item).
      const prior = await db.query<{ observed_at_min: Date; shape_fingerprint: string }>(
        `
          select observed_at_min, shape_fingerprint
          from sweed_package_snapshots
          where dealer_id = $1 and inventory_item_id = $2
          order by observed_at_max desc
          limit 1
        `,
        [dealerId, s.inventory_item_id],
      )

      if (prior.rows[0] && prior.rows[0].shape_fingerprint === fingerprint) {
        // Same shape — bump observed_at_max on the existing row.
        await db.query(
          `
            update sweed_package_snapshots
            set observed_at_max = now()
            where dealer_id = $1
              and inventory_item_id = $2
              and observed_at_min = $3
          `,
          [dealerId, s.inventory_item_id, prior.rows[0].observed_at_min],
        )
        rowsUpdated += 1
      } else {
        // First sighting OR shape changed — insert a new version row.
        await db.query(
          `
            insert into sweed_package_snapshots (
              dealer_id, inventory_item_id, observed_at_min, observed_at_max,
              product_id, product_name, product_short_name, product_sku,
              category_id, category_name, subcategory_id, subcategory_name,
              brand_id, brand_name, size_label,
              current_qty, hold_qty, available_qty, is_on_stock,
              wholesale_cost_dollars,
              metrc_tag, internal_track_code, lab_thc_pct, lab_cbd_pct,
              expiration_date, received_at, stock_location, distributor_name,
              raw_json, shape_fingerprint
            ) values (
              $1, $2, now(), now(),
              $3, $4, $5, $6,
              $7, $8, $9, $10,
              $11, $12, $13,
              $14, $15, $16, $17,
              $18,
              $19, $20, $21, $22,
              $23, $24, $25, $26,
              $27::jsonb, $28
            )
          `,
          [
            dealerId, s.inventory_item_id,
            s.product_id, s.product_name, s.product_short_name, s.product_sku,
            s.category_id, s.category_name, s.subcategory_id, s.subcategory_name,
            s.brand_id, s.brand_name, s.size_label,
            s.current_qty, s.hold_qty, s.available_qty, s.is_on_stock,
            s.wholesale_cost_dollars,
            s.metrc_tag, s.internal_track_code, s.lab_thc_pct, s.lab_cbd_pct,
            s.expiration_date, s.received_at, s.stock_location, s.distributor_name,
            JSON.stringify(s.raw_json), fingerprint,
          ],
        )
        rowsInserted += 1
      }
    })
  }

  // Update the per-dealer ingest state breadcrumb.
  await withTransaction(async (db) => {
    await db.query(
      `
        insert into sweed_package_snapshots_ingest_state (
          dealer_id, last_polled_at, last_pages_scanned, last_items_seen,
          last_rows_inserted, last_rows_updated, consecutive_empty_polls
        ) values ($1, now(), $2, $3, $4, $5, $6)
        on conflict (dealer_id) do update set
          last_polled_at = excluded.last_polled_at,
          last_pages_scanned = excluded.last_pages_scanned,
          last_items_seen = excluded.last_items_seen,
          last_rows_inserted = excluded.last_rows_inserted,
          last_rows_updated = excluded.last_rows_updated,
          consecutive_empty_polls = case
            when excluded.last_items_seen = 0
              then sweed_package_snapshots_ingest_state.consecutive_empty_polls + 1
            else 0
          end
      `,
      [
        dealerId,
        pagesScanned,
        snapshots.length,
        rowsInserted,
        rowsUpdated,
        snapshots.length === 0 ? 1 : 0,
      ],
    )

    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(dealerId),
      entityType: 'job',
      eventType: 'config.workers.sweed_package_snapshots.completed',
      module: 'config',
      payload: {
        dealerId,
        jobId: context.id,
        itemsSeen: snapshots.length,
        rowsInserted,
        rowsUpdated,
        pagesScanned,
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })

  return {
    itemsSeen: snapshots.length,
    rowsInserted,
    rowsUpdated,
    pagesScanned,
  }
}

function resolveTargetDealerIds(payload: ConfigWorkersSweedPackageSnapshotsJobPayload): number[] {
  if (payload.siteDealerIds.length > 0) {
    return [...payload.siteDealerIds]
  }
  return HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) => site.dealerId)
}

export async function runConfigWorkersSweedPackageSnapshotsJob(
  context: JobHandlerContext,
  payload: ConfigWorkersSweedPackageSnapshotsJobPayload,
): Promise<void> {
  const dealerIds = resolveTargetDealerIds(payload)

  for (const dealerId of dealerIds) {
    try {
      const snapshots = await fetchAllPackagesForDealer(dealerId)
      // Page count = ceil(items / pageSize); we don't track it
      // exactly through the helper but the magnitude is enough for
      // the operator-facing freshness badge.
      const pagesScanned = Math.max(1, Math.ceil(snapshots.length / PAGE_SIZE))
      await persistSnapshotsForDealer(context, dealerId, snapshots, pagesScanned)
    } catch (error) {
      // Per AGENTS.md skip-and-continue rule: one sick dealer must
      // not kill the whole batch. Log + bump ingest state notes,
      // then continue.
      const message = error instanceof Error ? error.message : 'Unknown package-snapshot error.'
      // eslint-disable-next-line no-console
      console.warn(
        `[sweed_package_snapshots] dealer ${dealerId} failed; continuing with next dealer: ${message}`,
      )
      await withTransaction(async (db) => {
        await db.query(
          `
            insert into sweed_package_snapshots_ingest_state (dealer_id, last_polled_at, notes)
            values ($1, now(), $2)
            on conflict (dealer_id) do update set
              last_polled_at = excluded.last_polled_at,
              notes = excluded.notes
          `,
          [dealerId, `error: ${message.slice(0, 500)}`],
        )
      })
    }
  }
}
