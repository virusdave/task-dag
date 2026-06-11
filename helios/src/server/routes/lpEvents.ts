// Landing-page event ingest route for the unified-landing engine.
//
// Parent epic virusdave/top-level#13 / child FreshlyBakedNYC/automation#42,
// phase P1 ("stand up lp_events + 15-min batch ingest").
//
//   POST /v1/lp-events/batch
//
// Called by the mostly-static-sites landing runtime's durable spool +
// 15-minute batch flusher. The body is a frozen
// `freshlybaked.lp.events-batch.v1` envelope
// (config/landing-pages/schemas/lp-events-batch.schema.json, mirrored
// in src/server/lp/contracts.ts → LpEventsBatchSchema). Events are
// append-only and idempotent by runtime-assigned `event_id` (see
// migration 070 + lpEventsQueries.bulkInsertLpEvents).
//
// Auth mirrors the VeriScan webhook (routes/visitorScans.ts): a
// long-lived bearer token compared constant-time against the
// env-supplied LP_EVENTS_INGEST_TOKEN.
//   - 503 when the server has no token configured (fail-closed, so a
//     half-deployed prod can't silently accept unauthenticated bodies);
//   - 401 (no body) on a missing/malformed/mismatched bearer.
//
// Like the VeriScan webhook this route is allowlisted in authGate.ts so
// it does NOT require the SPA session cookie — it's a service-to-service
// endpoint and does its own bearer check below.

import { timingSafeEqual } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { getServerEnv } from '../config/env.js'
import { getPool } from '../db/pool.js'
import { bulkInsertLpEvents } from '../db/queries/lpEventsQueries.js'
import { LpEventsBatchSchema } from '../lp/contracts.js'

export async function registerLpEventsRoutes(server: FastifyInstance): Promise<void> {
  server.post('/v1/lp-events/batch', handleLpEventsBatch)
}

async function handleLpEventsBatch(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const env = getServerEnv()
  const remoteIp = request.ip

  // ----- AUTH ---------------------------------------------------------
  if (env.lpEventsIngestToken === null) {
    request.log.error(
      { remoteIp },
      'lp-events ingest hit but LP_EVENTS_INGEST_TOKEN is unset; refusing',
    )
    return reply.status(503).send()
  }

  const authHeader = request.headers.authorization
  const bearer = typeof authHeader === 'string' ? parseBearer(authHeader) : null
  if (bearer === null) {
    request.log.warn({ remoteIp }, 'lp-events ingest missing/malformed Authorization header')
    return reply.status(401).send()
  }
  if (!constantTimeEqual(bearer, env.lpEventsIngestToken)) {
    request.log.warn({ remoteIp }, 'lp-events ingest bearer mismatch')
    return reply.status(401).send()
  }

  // ----- BODY VALIDATION ---------------------------------------------
  const rawBody = request.body
  if (rawBody === undefined || rawBody === null || typeof rawBody !== 'object') {
    return reply.status(400).send({ error: 'Expected JSON object body.' })
  }

  const parsed = LpEventsBatchSchema.safeParse(rawBody)
  if (!parsed.success) {
    request.log.warn(
      { remoteIp, issues: parsed.error.issues },
      'lp-events ingest batch validation failed',
    )
    return reply.status(400).send({
      error: 'Invalid lp-events batch.',
      issues: parsed.error.issues,
    })
  }

  const batch = parsed.data

  // ----- INSERT ------------------------------------------------------
  try {
    const result = await bulkInsertLpEvents(getPool(), batch.events)
    request.log.info(
      {
        replicaId: batch.replica_id,
        received: result.received,
        inserted: result.inserted,
        duplicates: result.duplicates,
      },
      'lp-events ingest accepted',
    )
    return reply.status(200).send({
      received: result.received,
      inserted: result.inserted,
      duplicates: result.duplicates,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/relation .*lp_events.* does not exist/i.test(message)) {
      // Migration 070 not applied. 503 (operator-actionable) and do NOT
      // 200, so the runtime keeps the batch in its durable spool and
      // retries rather than dropping it on the floor.
      request.log.error('lp_events table missing — apply migration 070_lp_events.sql')
      return reply
        .status(503)
        .send({ error: 'lp_events table missing. Apply migration 070_lp_events.sql.' })
    }
    request.log.error({ err: error }, 'lp-events ingest insert failed')
    return reply.status(500).send({ error: 'insert failed' })
  }
}

function parseBearer(authHeader: string): string | null {
  const match = /^\s*bearer\s+(\S+)\s*$/i.exec(authHeader)
  if (match === null) return null
  return match[1]
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8')
  const bBuf = Buffer.from(b, 'utf8')
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, aBuf)
    return false
  }
  return timingSafeEqual(aBuf, bBuf)
}
