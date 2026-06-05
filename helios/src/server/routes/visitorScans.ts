// VeriScan webhook + admin-page routes for the visitor_scans table.
//
// virusdave/top-level#9 / FreshlyBakedNYC/automation#31, phase A1
// + A3.
//
// Two POST endpoints mounted at the absolute server root (NOT under
// the appBasePath — VeriScan's webhook configuration points at fixed
// absolute paths and must not require Helios's session cookie):
//
//   POST /wh/bx/veriscan/checkin
//   POST /wh/mh/veriscan/checkin
//
// Both routes share a single handler and pass the literal site_slug
// ('bx' or 'mh') by route binding. Future sites are added as
// additional route bindings in registerVisitorScansWebhookRoutes
// below — there is intentionally no runtime slug whitelist.
//
// Auth: a long-lived bearer token via `Authorization: Bearer <token>`,
// compared constant-time against the env-supplied
// `VERISCAN_WEBHOOK_TOKEN` (see config/env.ts and the agenix wiring
// in Nicponskis/nixos-sbc#4). 401 with no body on mismatch. 503
// when the server itself has no token configured (fail-closed, so a
// half-deployed prod can't accept unauthenticated bodies).
//
// Plus one GET endpoint mounted *inside* the appBasePath so it sits
// behind the existing oauth-reverse-proxy session gate, backing the
// /admin/visitors/scans operator page (A3):
//
//   GET /api/visitors/scans          — paginated JSON list + filter
//   GET /api/visitors/scans.csv      — CSV export of the same filter

import { timingSafeEqual } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { getServerEnv } from '../config/env.js'
import { requireCashierDisplayUser, requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { SITE_PINS, getVisitorScansMaxId } from '../db/queries/customersMapQueries.js'
import {
  insertVisitorScan,
  listCashierVisitorScans,
  listVisitorScans,
  type VisitorScanListItem,
} from '../db/queries/visitorScansQueries.js'
import { withTransaction } from '../db/tx.js'
import {
  enqueueJob,
  JOB_PRIORITY_BACKFILL,
  JOB_PRIORITY_URGENT,
} from '../jobs/enqueueJob.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import {
  getCustomerVisitorDetails,
  getCustomerVisitorInvoiceItems,
} from '../db/queries/customerVisitorDetailsQueries.js'
import { markCustomerSegmentsRefreshPending } from '../db/queries/sweedCustomerSegmentsQueries.js'
import {
  VeriScanEnvelopeSchema,
  envelopeToRowInput,
} from '../visitorScans/envelope.js'
import {
  CashierVisitorScansResponseSchema,
  CustomerVisitorDetailsResponseSchema,
  CustomerVisitorInvoiceItemsResponseSchema,
  VisitorScansHighwaterResponseSchema,
  VisitorScansQuerySchema,
  VisitorScansResponseSchema,
} from '../../shared/contracts/index.js'

// Sites we accept webhooks for. Adding a new site is a code change
// (a new route binding below), NOT a runtime config — keeping the
// whitelist hard-coded means an unknown slug is impossible by
// construction.
const SUPPORTED_SITES = ['bx', 'mh'] as const
type SupportedSite = (typeof SUPPORTED_SITES)[number]

// 500 ft in meters. The user's spec for "is this lat/lng really the
// scanner kiosk?" — if a scan's reported lat/lng falls within 500ft
// of EITHER store, we treat it as the kiosk and trigger the
// background geocode job for the customer's home address text.
// Site centroids come from the canonical SITE_PINS export in
// customersMapQueries.ts (single source of truth across the
// webhook handler, the per-scan details map, and the customer-
// origin map page).
const STORE_KIOSK_RADIUS_M = 500 * 0.3048

/**
 * True if the (lat, lng) pair is "near the scanner kiosk", meaning
 * the VeriScan envelope's reported geocode is almost certainly the
 * store and NOT a real customer-home geocode. Used by the webhook
 * handler to decide whether to enqueue a follow-up backfill job
 * for this scan's address text.
 *
 * Returns true when lat/lng is missing too — a null geocode is also
 * a reason to queue the worker.
 */
function isStoreOrUnknownGeocode(lat: number | null, lng: number | null): boolean {
  if (lat === null || lng === null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return true
  }
  for (const store of SITE_PINS) {
    const meters = haversineMeters(lat, lng, store.lat, store.lng)
    if (meters <= STORE_KIOSK_RADIUS_M) return true
  }
  return false
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  // Equirectangular approximation is plenty accurate at the
  // sub-mile scale of this check and avoids the trig cost.
  const R = 6_371_000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const meanLat = ((lat1 + lat2) * Math.PI) / 360
  const x = dLng * Math.cos(meanLat)
  const y = dLat
  return Math.sqrt(x * x + y * y) * R
}

/**
 * Webhook routes at the absolute server root. Mounted from
 * `buildServer.ts` *outside* the appBasePath registration so the
 * canonical URLs (`https://helios.freshlybaked.us/wh/...`) are
 * stable regardless of any future appBasePath changes, and exempt
 * from the SPA's session-cookie auth gate (see authGate.ts).
 */
export function registerVisitorScansWebhookRoutes(server: FastifyInstance): void {
  for (const slug of SUPPORTED_SITES) {
    server.post(`/wh/${slug}/veriscan/checkin`, async (request, reply) =>
      handleVeriScanCheckin(request, reply, slug),
    )
  }
}

async function handleVeriScanCheckin(
  request: FastifyRequest,
  reply: FastifyReply,
  siteSlug: SupportedSite,
): Promise<FastifyReply> {
  const env = getServerEnv()
  const remoteIp = request.ip
  const path = request.url

  // ----- AUTH ---------------------------------------------------------
  if (env.veriscanWebhookToken === null) {
    // Fail-closed: the env var is missing. Don't accept anything; let
    // the operator see a 503 in the access log and fix the env wiring
    // (Nicponskis/nixos-sbc N1).
    request.log.error(
      { siteSlug, remoteIp, path },
      'veriscan webhook hit but VERISCAN_WEBHOOK_TOKEN is unset; refusing',
    )
    return reply.status(503).send()
  }

  const authHeader = request.headers.authorization
  if (typeof authHeader !== 'string' || authHeader.length === 0) {
    request.log.warn({ siteSlug, remoteIp, path }, 'veriscan webhook missing Authorization header')
    return reply.status(401).send()
  }

  const bearer = parseBearer(authHeader)
  if (bearer === null) {
    request.log.warn({ siteSlug, remoteIp, path }, 'veriscan webhook malformed Authorization header')
    return reply.status(401).send()
  }

  if (!constantTimeEqual(bearer, env.veriscanWebhookToken)) {
    request.log.warn({ siteSlug, remoteIp, path }, 'veriscan webhook bearer mismatch')
    return reply.status(401).send()
  }

  // ----- BODY VALIDATION ---------------------------------------------
  const rawBody = request.body
  if (rawBody === undefined || rawBody === null || typeof rawBody !== 'object') {
    request.log.warn({ siteSlug, remoteIp, path }, 'veriscan webhook empty / non-object body')
    return reply.status(400).send({ error: 'Expected JSON object body.' })
  }

  const parsed = VeriScanEnvelopeSchema.safeParse(rawBody)
  if (!parsed.success) {
    request.log.warn(
      { siteSlug, remoteIp, issues: parsed.error.issues },
      'veriscan webhook envelope validation failed',
    )
    return reply.status(400).send({
      error: 'Invalid VeriScan envelope.',
      issues: parsed.error.issues,
    })
  }

  const envelope = parsed.data
  const rowInput = envelopeToRowInput({
    envelope,
    ingestSource: 'webhook',
    siteSlug,
    provider: 'veriscan',
    rawEnvelope: rawBody,
  })

  // ----- AUDIT LOG (BEFORE INSERT) -----------------------------------
  // info-level so we have a full audit trail outside the DB even if
  // the insert later fails. Key by hash_id so an operator can
  // grep-correlate to the DB row.
  request.log.info(
    {
      siteSlug,
      provider: 'veriscan',
      hashId: rowInput.hashId,
      eventId: rowInput.eventId === null ? null : rowInput.eventId.toString(),
      webhookId: rowInput.webhookId === null ? null : rowInput.webhookId.toString(),
      webhookType: rowInput.webhookType,
      scannedAt: rowInput.scannedAt,
    },
    'veriscan webhook accepted',
  )

  // ----- INSERT ------------------------------------------------------
  try {
    const result = await insertVisitorScan(getPool(), rowInput)
    if (!result.inserted) {
      request.log.info(
        { siteSlug, hashId: rowInput.hashId },
        'veriscan webhook duplicate (provider, hash_id) — no-op',
      )
    } else {
      // ----- LIVE SWEED CRM LINK PROBE -------------------------------
      // Enqueue a per-scan link job at URGENT priority so the
      // fast-lane worker picks it up within ~1s of the webhook
      // (NOTIFY wakes it from idle immediately on commit). The job
      // calls Sweed's `store.customer.list` by documentNumber and
      // writes the resolved customer_id into visitor_scan_links —
      // which the operator-facing /admin/customers/check-ins page
      // surfaces (purchase summary, lifetime spend, etc.) without
      // any extra read-path query. Per-scan dedupe key keeps
      // duplicate-delivery from doubling Sweed calls.
      //
      // Cost: 1 INSERT into job_queue + 1 NOTIFY per scan. The
      // probe itself is a single Sweed RPC (no DB read cost). See
      // docs/canon/AGENTS_CANON.md re: "thoughtful attention to
      // DB performance and cost minimization is an absolute hard
      // requirement".
      if (result.scanId !== null) {
        try {
          await withTransaction(async (db) => {
            await enqueueJob(db, {
              jobType: 'config.workers.link_visitor_scan_to_sweed',
              module: 'config',
              payload: {
                scanId: result.scanId!,
                retryAttempt: 0,
                trigger: 'webhook_followup',
              },
              priority: JOB_PRIORITY_URGENT,
              dedupeKey: `config.workers.link_visitor_scan_to_sweed:${result.scanId}:0`,
              requestedByUserId: null,
              runAt: new Date(),
              scope: null,
            })
          })
        } catch (cause) {
          // Best-effort: a missed enqueue means the slower
          // safety-net job (eventually) catches the row.
          request.log.warn(
            {
              siteSlug,
              hashId: rowInput.hashId,
              scanId: result.scanId,
              cause: cause instanceof Error ? cause.message : String(cause),
            },
            'veriscan webhook sweed-link probe enqueue failed (will fall through to safety-net)',
          )
        }
      }
    }
    if (result.inserted && isStoreOrUnknownGeocode(rowInput.latitude, rowInput.longitude)) {
      // Webhook arrived with NO usable home geocode (either lat/lng
      // is null, or it's the scanner kiosk's location within 500ft
      // of one of our stores). Queue a backfill-priority batch job
      // to geocode this scan's address text through the shared
      // Census pipeline. Dedupe to 1 enqueue per minute so a busy
      // shift doesn't pile up dozens of redundant jobs — the worker
      // is batch-sized (5000) so one job per minute is plenty.
      try {
        const bucketIso = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString()
        await withTransaction(async (db) => {
          const jobId = await enqueueJob(db, {
            priority: JOB_PRIORITY_BACKFILL,
            concurrencyKey: null,
            dedupeKey: `config.workers.enrich_visitor_scan_address:webhook:${bucketIso}`,
            jobType: 'config.workers.enrich_visitor_scan_address',
            module: 'config',
            payload: {
              trigger: 'webhook_followup',
              batchSize: 5000,
            },
            requestedByUserId: null,
            runAt: new Date(),
            scope: null,
          })
          await appendAuditEvent(db, {
            actorType: 'system',
            actorUserId: null,
            entityId: String(jobId),
            entityType: 'job',
            eventType: 'config.workers.enrich_visitor_scan_address.requested',
            module: 'config',
            payload: {
              trigger: 'webhook_followup',
              siteSlug,
              hashId: rowInput.hashId,
              hadLatLng: rowInput.latitude !== null && rowInput.longitude !== null,
              batchSize: 5000,
            },
            requestId: null,
            scope: null,
            undoPayload: null,
          })
        })
      } catch (cause) {
        // Best-effort: a missed enqueue is harmless; the scheduled
        // worker will pick this row up on its next tick.
        request.log.warn(
          {
            siteSlug,
            hashId: rowInput.hashId,
            cause: cause instanceof Error ? cause.message : String(cause),
          },
          'veriscan webhook geocode-followup enqueue failed (will fall through to scheduled worker)',
        )
      }
    }
    return reply.status(200).send()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/relation .*visitor_scans.* does not exist/i.test(message)) {
      // Migration 039 not yet applied. Return 503 (operator-actionable),
      // not 500 — and DON'T 200 OK, otherwise VeriScan's retry would
      // drop the body on the floor.
      request.log.error(
        { siteSlug, hashId: rowInput.hashId },
        'visitor_scans table missing — apply migration 039_visitor_scans.sql',
      )
      return reply
        .status(503)
        .send({ error: 'visitor_scans table missing. Apply migration 039_visitor_scans.sql.' })
    }
    request.log.error({ err: error, siteSlug, hashId: rowInput.hashId }, 'veriscan webhook insert failed')
    return reply.status(500).send({ error: 'insert failed' })
  }
}

function parseBearer(authHeader: string): string | null {
  // Case-insensitive scheme match; the value after the first run of
  // whitespace is the token. Anything that doesn't start with
  // `bearer` is rejected as malformed.
  const match = /^\s*bearer\s+(\S+)\s*$/i.exec(authHeader)
  if (match === null) return null
  return match[1]
}

function constantTimeEqual(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers. We use SHA-256-style
  // padding via byte length compare first (which is itself constant-time
  // because Buffer.byteLength is O(1) on a string with a known encoding).
  const aBuf = Buffer.from(a, 'utf8')
  const bBuf = Buffer.from(b, 'utf8')
  if (aBuf.length !== bBuf.length) {
    // Still do a dummy compare so the path doesn't short-circuit on
    // length alone (the length itself is a side channel either way,
    // but doing the compare avoids leaking *which* byte was the
    // first to differ on equal-length inputs).
    timingSafeEqual(aBuf, aBuf)
    return false
  }
  return timingSafeEqual(aBuf, bBuf)
}

// ---------------------------------------------------------------------
// Admin / SPA-facing routes (mounted under appBasePath, gated by the
// existing session cookie via registerAuthGate).
// ---------------------------------------------------------------------

export async function registerVisitorScansAdminRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/visitors/scans', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) return

    const query = VisitorScansQuerySchema.parse(request.query)
    try {
      const result = await listVisitorScans(getPool(), {
        siteSlugs: query.siteSlugs ?? null,
        ingestSources: query.ingestSources ?? null,
        states: query.states ?? null,
        postalPrefix: query.postalPrefix ?? null,
        documentType: query.documentType ?? null,
        authenticationStatus: query.authenticationStatus ?? null,
        scanStatus: query.scanStatus ?? null,
        scannedAfter: query.scannedAfter ?? null,
        scannedBefore: query.scannedBefore ?? null,
        beforeId: query.beforeId ?? null,
        limit: query.limit,
      })
      return reply.send(VisitorScansResponseSchema.parse(result))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/relation .*visitor_scans.* does not exist/i.test(message)) {
        return reply
          .status(503)
          .send({ error: 'visitor_scans table missing. Apply migration 039_visitor_scans.sql.' })
      }
      throw error
    }
  })

  server.get('/api/admin/customers/visitors/:scanId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) return

    const params = request.params as { scanId?: string }
    const scanId = Number(params.scanId)
    if (!Number.isFinite(scanId) || scanId <= 0 || !Number.isInteger(scanId)) {
      return reply.status(400).send({ error: 'Invalid scanId.' })
    }
    try {
      const details = await getCustomerVisitorDetails(getPool(), scanId)
      if (details === null) {
        return reply.status(404).send({ error: 'Visitor scan not found.' })
      }
      return reply.send(CustomerVisitorDetailsResponseSchema.parse(details))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/relation .*visitor_scans.* does not exist/i.test(message)) {
        return reply
          .status(503)
          .send({ error: 'visitor_scans table missing. Apply migration 039_visitor_scans.sql.' })
      }
      if (/relation .*visitor_scan_links.* does not exist/i.test(message)) {
        return reply
          .status(503)
          .send({ error: 'visitor_scan_links table missing. Apply migration 040_visitor_scan_links.sql.' })
      }
      throw error
    }
  })

  // -----------------------------------------------------------------
  // Lazy per-invoice line items for the details page. Fetched on
  // demand when the operator expands an invoice row, so the main
  // details payload stays header-only. Reads the materialised
  // sweed_order_items_flat table (phase D1) via an indexed
  // (dealer_id, invoice_id) lookup; the invoice must belong to the
  // Sweed customer this scan is linked to.
  // -----------------------------------------------------------------
  server.get(
    '/api/admin/customers/visitors/:scanId/invoices/:invoiceId/items',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'admin')
      if (!user) return

      const params = request.params as { scanId?: string; invoiceId?: string }
      const scanId = Number(params.scanId)
      const invoiceId = (params.invoiceId ?? '').trim()
      if (!Number.isFinite(scanId) || scanId <= 0 || !Number.isInteger(scanId)) {
        return reply.status(400).send({ error: 'Invalid scanId.' })
      }
      if (invoiceId.length === 0) {
        return reply.status(400).send({ error: 'Invalid invoiceId.' })
      }
      try {
        const items = await getCustomerVisitorInvoiceItems(getPool(), scanId, invoiceId)
        if (items === null) {
          return reply.status(404).send({ error: 'Invoice not found for this visitor.' })
        }
        return reply.send(CustomerVisitorInvoiceItemsResponseSchema.parse(items))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/relation .*sweed_order_items_flat.* does not exist/i.test(message)) {
          return reply.status(503).send({
            error:
              'sweed_order_items_flat table missing. Apply migration 048_sweed_order_items_flat.sql.',
          })
        }
        throw error
      }
    },
  )

  // -----------------------------------------------------------------
  // Manual "Refresh segments" for the details page
  // (virusdave/top-level#12). Enqueues a Sweed-pool job to re-pull the
  // linked customer's segment membership. Cheap + deduped: at most one
  // pending refresh per customer. No live Sweed call on this request.
  // -----------------------------------------------------------------
  server.post('/api/admin/customers/visitors/:scanId/refresh-segments', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) return

    const params = request.params as { scanId?: string }
    const scanId = Number(params.scanId)
    if (!Number.isFinite(scanId) || scanId <= 0 || !Number.isInteger(scanId)) {
      return reply.status(400).send({ error: 'Invalid scanId.' })
    }

    // Resolve the linked Sweed customer for this scan.
    const linkRes = await getPool().query<{ sweed_customer_id: string | number | null; link_status: string | null }>(
      `select sweed_customer_id, link_status
         from visitor_scan_links where scan_id = $1`,
      [scanId],
    )
    const row = linkRes.rows[0]
    const sweedCustomerId =
      row && row.sweed_customer_id !== null && row.link_status === 'linked'
        ? Number(row.sweed_customer_id)
        : null
    if (sweedCustomerId === null || !Number.isFinite(sweedCustomerId) || sweedCustomerId <= 0) {
      return reply
        .status(409)
        .send({ error: 'This scan is not linked to a Sweed customer yet.' })
    }

    try {
      await markCustomerSegmentsRefreshPending(getPool(), sweedCustomerId)
      await withTransaction(async (db) => {
        await enqueueJob(db, {
          jobType: 'config.workers.refresh_sweed_customer_segments',
          module: 'config',
          payload: { sweedCustomerId, trigger: 'manual_refresh' },
          priority: JOB_PRIORITY_URGENT,
          // One pending refresh per customer; duplicate clicks collapse.
          dedupeKey: `config.workers.refresh_sweed_customer_segments:${sweedCustomerId}`,
          requestedByUserId: user.id,
          runAt: new Date(),
          scope: null,
        })
      })
      return reply.send({ enqueued: true, sweedCustomerId, status: 'pending' as const })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/relation .*sweed_customer_segments_refresh.* does not exist/i.test(message)) {
        return reply
          .status(503)
          .send({ error: 'sweed_customer_segments tables missing. Apply migration 059_sweed_customer_segments.sql.' })
      }
      throw error
    }
  })

  // -----------------------------------------------------------------
  // Cashier-tablet live check-ins
  // (virusdave/top-level#12 / FreshlyBakedNYC/automation#40, phase D1).
  //
  // Two endpoints, both gated by `requireCashierDisplayUser`
  // (admin role OR the cashier-display email allowlist):
  //
  //   GET /api/admin/customers/check-ins/cashier
  //     Bounded top-N (max 100) of the latest visitor_scans rows in
  //     a privacy-redacted shape (no PII fields, server-side name
  //     redaction). Same query the tablet UI re-fetches when its
  //     highwater poll detects a new scan.
  //
  //   GET /api/admin/customers/check-ins/cashier/highwater
  //     Single indexed MAX(id) — sub-millisecond — for the tablet's
  //     live-update polling loop. The tablet polls this every few
  //     seconds; only on a maxScanId bump does it trigger the full
  //     re-fetch. This keeps DB cost flat regardless of tab
  //     concurrency.
  // -----------------------------------------------------------------
  server.get('/api/admin/customers/check-ins/cashier', async (request, reply) => {
    const user = await requireCashierDisplayUser(request, reply)
    if (!user) return
    const querySchema = VisitorScansQuerySchema.pick({ siteSlugs: true, limit: true })
    const query = querySchema.parse(request.query)
    try {
      const result = await listCashierVisitorScans(getPool(), {
        siteSlugs: query.siteSlugs ?? null,
        limit: query.limit,
      })
      return reply.send(CashierVisitorScansResponseSchema.parse(result))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/relation .*visitor_scans.* does not exist/i.test(message)) {
        return reply.status(503).send({
          error: 'visitor_scans table missing. Apply migration 039_visitor_scans.sql.',
        })
      }
      throw error
    }
  })

  server.get(
    '/api/admin/customers/check-ins/cashier/highwater',
    async (request, reply) => {
      const user = await requireCashierDisplayUser(request, reply)
      if (!user) return
      try {
        const maxScanId = await getVisitorScansMaxId(getPool())
        return reply.send(VisitorScansHighwaterResponseSchema.parse({ maxScanId }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/relation .*visitor_scans.* does not exist/i.test(message)) {
          return reply.status(503).send({
            error: 'visitor_scans table missing. Apply migration 039_visitor_scans.sql.',
          })
        }
        throw error
      }
    },
  )

  server.get('/api/visitors/scans.csv', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) return

    const query = VisitorScansQuerySchema.parse(request.query)
    // CSV export of the *current filter view* uses the same query
    // path as the table (single source of truth) but with a higher
    // ceiling so an operator can grab a meaningful window in one
    // pull. We cap at 10_000 so a runaway filter doesn't tie up the
    // server.
    const exportLimit = Math.min(10_000, Math.max(query.limit, 5_000))
    try {
      const result = await listVisitorScans(getPool(), {
        siteSlugs: query.siteSlugs ?? null,
        ingestSources: query.ingestSources ?? null,
        states: query.states ?? null,
        postalPrefix: query.postalPrefix ?? null,
        documentType: query.documentType ?? null,
        authenticationStatus: query.authenticationStatus ?? null,
        scanStatus: query.scanStatus ?? null,
        scannedAfter: query.scannedAfter ?? null,
        scannedBefore: query.scannedBefore ?? null,
        beforeId: query.beforeId ?? null,
        limit: exportLimit,
      })
      const csv = renderCsv(result.items)
      const filename = `visitor-scans-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .send(csv)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/relation .*visitor_scans.* does not exist/i.test(message)) {
        return reply
          .status(503)
          .send({ error: 'visitor_scans table missing. Apply migration 039_visitor_scans.sql.' })
      }
      throw error
    }
  })
}

function renderCsv(items: readonly VisitorScanListItem[]): string {
  const header = [
    'id',
    'ingested_at',
    'ingest_source',
    'site_slug',
    'provider',
    'scanned_at',
    'webhook_type',
    'hash_id',
    'first_name',
    'middle_name',
    'last_name',
    'state',
    'postal_code',
    'city',
    'address',
    'country',
    'document_type',
    'authentication_status',
    'scan_status',
    'latitude',
    'longitude',
    'scan_latitude',
    'scan_longitude',
  ]
  const lines = [header.join(',')]
  for (const item of items) {
    lines.push(
      [
        item.id,
        item.ingestedAt,
        item.ingestSource,
        item.siteSlug,
        item.provider,
        item.scannedAt ?? '',
        item.webhookType ?? '',
        item.hashId,
        item.firstName ?? '',
        item.middleName ?? '',
        item.lastName ?? '',
        item.state ?? '',
        item.postalCode ?? '',
        item.city ?? '',
        item.address ?? '',
        item.country ?? '',
        item.documentType ?? '',
        item.authenticationStatus ?? '',
        item.scanStatus ?? '',
        item.latitude ?? '',
        item.longitude ?? '',
        item.scanLatitude ?? '',
        item.scanLongitude ?? '',
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return lines.join('\n') + '\n'
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const str = String(value)
  // Quote when the cell contains comma, quote, CR, or LF; escape any
  // embedded `"` by doubling per RFC 4180.
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}
