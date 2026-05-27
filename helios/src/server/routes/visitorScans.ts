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
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import {
  insertVisitorScan,
  listVisitorScans,
  type VisitorScanListItem,
} from '../db/queries/visitorScansQueries.js'
import {
  VeriScanEnvelopeSchema,
  envelopeToRowInput,
} from '../visitorScans/envelope.js'
import {
  VisitorScansQuerySchema,
  VisitorScansResponseSchema,
} from '../../shared/contracts/index.js'

// Sites we accept webhooks for. Adding a new site is a code change
// (a new route binding below), NOT a runtime config — keeping the
// whitelist hard-coded means an unknown slug is impossible by
// construction.
const SUPPORTED_SITES = ['bx', 'mh'] as const
type SupportedSite = (typeof SUPPORTED_SITES)[number]

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
    const user = await requireSessionUser(request, reply, 'viewer')
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

  server.get('/api/visitors/scans.csv', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
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
