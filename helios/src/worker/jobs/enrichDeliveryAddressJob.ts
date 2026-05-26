import type { ConfigWorkersEnrichDeliveryAddressJobPayload } from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { getPool } from '../../server/db/pool.js'
import { withTransaction } from '../../server/db/tx.js'
import {
  applyGeocodeResult,
  geocodeViaCensus,
  queueGeocodePending,
  upsertAddress,
} from '../geocoder/index.js'
import { getSaleInvoice } from '../sweed/sales.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

// ============================================================================
// Delivery-address enrichment worker
// (FreshlyBakedNYC/automation#25, task A4 of the sweed-address-
// enrichment epic).
//
// Two phases per tick:
//
//   1. **Per-invoice address pull.** Walk delivery-typed sweed_orders
//      rows whose `delivery_address_id IS NULL` and whose
//      `invoice_get_status` is not yet a terminal value, call
//      store.sale.invoice.get, upsert the returned address into
//      `addresses`, link the row.
//
//   2. **Geocode drain.** Pull up to `batchSize` rows from
//      `addresses` whose `geocode_status in ('pending','failed')`
//      and call the US Census geocoder (rate-limited to ~1 RPS
//      internally), writing lat/lng + zip5 + city + state_code back.
//
// Both phases share the same `batchSize` so one tick stays bounded
// (worst case: one batchSize of Sweed invoice.get calls + one
// batchSize of Census geocode calls = ~2 minutes of wall clock at
// the default 60 RPS budget for invoice.get + 1 RPS for Census).
//
// The 60-second `ingested_at` grace below ensures we don't fight
// the same-cycle configWorkersSweedOrdersIngestJob for a row that
// it just inserted.
// ============================================================================

const INGEST_GRACE_SECONDS = 60

type DealerEnrichmentResult = {
  dealerId: number
  candidates: number
  enriched: number
  noAddress: number
  failed: number
  customerLinks: number
  error: string | null
}

export async function runConfigWorkersEnrichDeliveryAddressJob(
  context: JobHandlerContext,
  payload: ConfigWorkersEnrichDeliveryAddressJobPayload,
): Promise<void> {
  const batchSize = Math.max(1, Math.min(payload.batchSize, 500))

  // ----- 1. Per-invoice address pull -----
  const candidates = await loadCandidates(batchSize)
  const perDealer = new Map<number, DealerEnrichmentResult>()
  function bucket(dealerId: number): DealerEnrichmentResult {
    let v = perDealer.get(dealerId)
    if (v === undefined) {
      v = {
        dealerId,
        candidates: 0,
        enriched: 0,
        noAddress: 0,
        failed: 0,
        customerLinks: 0,
        error: null,
      }
      perDealer.set(dealerId, v)
    }
    return v
  }

  for (const c of candidates) {
    const b = bucket(c.dealerId)
    b.candidates += 1
    try {
      const detail = await getSaleInvoice({
        dealerId: c.dealerId,
        invoiceId: c.invoiceId,
      })
      if (detail.deliveryAddress === null) {
        await markInvoiceGetStatus(c.dealerId, c.invoiceId, 'no_address', null)
        b.noAddress += 1
        continue
      }
      const linked = await withTransaction(async (db) => {
        const upserted = await upsertAddress(db, {
          line1: detail.deliveryAddress!.line1,
          line2: detail.deliveryAddress!.line2,
          city: detail.deliveryAddress!.city,
          state: detail.deliveryAddress!.state,
          zip: detail.deliveryAddress!.zip,
        })
        if (upserted === null) {
          // Empty parts: caller already filtered, but defend.
          await db.query(
            `update sweed_orders
                set invoice_get_status = 'no_address',
                    invoice_get_polled_at = now()
              where dealer_id = $1 and invoice_id = $2`,
            [c.dealerId, c.invoiceId],
          )
          return { addressId: null as number | null, linkedCustomer: false }
        }
        await db.query(
          `update sweed_orders
              set delivery_address_id = $3,
                  invoice_get_status = 'ok',
                  invoice_get_polled_at = now()
            where dealer_id = $1 and invoice_id = $2`,
          [c.dealerId, c.invoiceId, upserted.addressId],
        )
        let linkedCustomer = false
        if (c.customerId !== null) {
          const linkResult = await db.query(
            `insert into sweed_customer_addresses
               (dealer_id, customer_id, address_id, kind, first_seen_at, last_seen_at)
             values ($1, $2, $3, 'delivery_seen', now(), now())
             on conflict (dealer_id, customer_id, address_id, kind)
             do update set last_seen_at = now()`,
            [c.dealerId, c.customerId, upserted.addressId],
          )
          if ((linkResult.rowCount ?? 0) > 0) {
            linkedCustomer = true
          }
        }
        return { addressId: upserted.addressId, linkedCustomer }
      })
      if (linked.addressId === null) {
        b.noAddress += 1
      } else {
        b.enriched += 1
        if (linked.linkedCustomer) b.customerLinks += 1
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      b.failed += 1
      b.error = msg
      await markInvoiceGetStatus(c.dealerId, c.invoiceId, 'failed', new Date())
    }
  }

  // ----- 2. Geocode drain -----
  let geocodedOk = 0
  let geocodedFailed = 0
  let geocodedNotUs = 0
  // Run each geocode call inside its own short transaction so the
  // FOR UPDATE SKIP LOCKED row lock is released promptly and a
  // sibling worker can pick the next batch up while Census is
  // still rate-limiting us.
  for (let i = 0; i < batchSize; i++) {
    const drained = await withTransaction(async (db) => {
      const rows = await queueGeocodePending(db, 1)
      if (rows.length === 0) return null
      const row = rows[0]!
      const result = await geocodeViaCensus(row.normalized)
      await applyGeocodeResult(db, row.addressId, result)
      return result.status
    })
    if (drained === null) break
    if (drained === 'ok') geocodedOk += 1
    else if (drained === 'not_us') geocodedNotUs += 1
    else geocodedFailed += 1
  }

  // ----- 3. Audit -----
  const perDealerArr = Array.from(perDealer.values())
  await withTransaction(async (db) => {
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(context.id),
      entityType: 'job',
      eventType: 'config.workers.enrich_delivery_address.completed',
      module: 'config',
      payload: {
        jobId: context.id,
        trigger: payload.trigger,
        batchSize,
        candidates: candidates.length,
        perDealer: perDealerArr,
        geocodedOk,
        geocodedFailed,
        geocodedNotUs,
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}

interface CandidateRow {
  dealerId: number
  invoiceId: string
  customerId: number | null
}

async function loadCandidates(batchSize: number): Promise<CandidateRow[]> {
  const pool = getPool()
  const result = await pool.query<{
    dealer_id: string | number
    invoice_id: string
    customer_id: string | number | null
  }>(
    `
      select dealer_id, invoice_id, customer_id
        from sweed_orders
       where fulfillment_type ~* '^delivery'
         and delivery_address_id is null
         and (invoice_get_status is null or invoice_get_status = 'failed')
         and ingested_at < now() - ($1 || ' seconds')::interval
       order by pay_time desc
       limit $2
    `,
    [String(INGEST_GRACE_SECONDS), batchSize],
  )
  return result.rows.map((r) => ({
    dealerId: typeof r.dealer_id === 'string' ? Number(r.dealer_id) : r.dealer_id,
    invoiceId: r.invoice_id,
    customerId:
      r.customer_id === null
        ? null
        : typeof r.customer_id === 'string'
          ? Number(r.customer_id)
          : r.customer_id,
  }))
}

async function markInvoiceGetStatus(
  dealerId: number,
  invoiceId: string,
  status: 'ok' | 'no_address' | 'failed',
  _at: Date | null,
): Promise<void> {
  await withTransaction(async (db) => {
    await db.query(
      `update sweed_orders
          set invoice_get_status = $3,
              invoice_get_polled_at = now()
        where dealer_id = $1 and invoice_id = $2`,
      [dealerId, invoiceId, status],
    )
  })
}
