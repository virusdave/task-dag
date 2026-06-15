// Per-scan Sweed CRM linking job.
//
// virusdave/top-level#12 / FreshlyBakedNYC/automation#40, phase B1.
//
// One job per visitor_scans row, enqueued at JOB_PRIORITY_URGENT
// from the VeriScan webhook handler immediately after a successful
// insert. The fast-lane worker loop picks it up within ~1s of the
// NOTIFY wake-up, claims a private Sweed session token (via
// `SWEED_BACKED_JOB_TYPES`), and:
//
//   1. Loads the link row + the source scan's id_num / name.
//   2. If the scan has no id_num, marks the link 'insufficient_data'
//      (the worker can't probe Sweed by name+DOB on the
//      `store.customer.list` surface; that's a phase-B2 enhancement).
//   3. Calls `store.customer.list { documentNumber, page, pageSize }`
//      against the dealer pinned to the scan's site_slug.
//   4. On exact match: writes `sweed_customer_id` + `linked_at`,
//      flipping `link_status` to 'linked'. The
//      `/admin/customers/check-ins` list and visitor-details page
//      auto-surface the linked customer's `sweed_orders` summary
//      via the existing read-path joins, so no UI work is needed.
//   5. On 0 rows: marks 'no_match'.
//   6. On >1 rows without an exact documentNumber match: marks
//      'ambiguous' so an operator can confirm one from the details
//      page's candidates list (phase-B3 surface).
//   7. On transport/RPC failure: marks 'failed', bumps
//      `probe_failed_count`, pushes `next_probe_at` out by 5s ×
//      2^retryAttempt, and self-re-enqueues another job at the
//      backed-off `runAt`. After `MAX_RETRY_ATTEMPTS` we stop
//      self-re-enqueuing — the row remains 'failed' for the
//      slower periodic safety-net to pick up.
//
// Cost shape (deliberately tiny — DB-cost is a hard requirement
// per docs/canon/AGENTS_CANON.md):
//   - One SELECT (loadLinkForJob) + one UPDATE (mark*) per scan.
//   - One Sweed RPC per scan (zero DB cost beyond the writes).
//   - No table scans, no batch joins; the per-scan flow does NOT
//     read or rewrite any aggregate. The summary surface lights up
//     from the existing list-query joins.

import type { ConfigWorkersLinkVisitorScanToSweedJobPayload } from '../../shared/contracts/index.js'
import { getPool } from '../../server/db/pool.js'
import { withTransaction } from '../../server/db/tx.js'
import { enqueueJob, JOB_PRIORITY_BACKFILL, JOB_PRIORITY_URGENT } from '../../server/jobs/enqueueJob.js'
import {
  loadLinkForJob,
  markLinkFailed,
  markLinkLinked,
  markLinkTerminal,
} from '../../server/db/queries/visitorScanLinkQueries.js'
import { findSweedCustomerByDocumentNumber } from '../sweed/customers.js'
import {
  refreshCustomerSegmentMembership,
  refreshMarketingCatalogIfStale,
} from '../sweed/segmentRefresh.js'
import { getWorkerEnv } from '../config/env.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

// Self-re-enqueue cap. After this many in-job retries we leave the
// row 'failed' for the periodic safety-net (a future ticker that
// walks `visitor_scan_links where link_status='failed' and
// next_probe_at <= now()`). 4 retries = 5s + 10s + 20s + 40s ≈ 75s
// of fast-lane retry budget per scan, which is comfortably above
// our observed Sweed transient-failure windows.
const MAX_RETRY_ATTEMPTS = 4
const BASE_RETRY_DELAY_SECONDS = 5

function classifySweedError(cause: unknown): {
  message: string
  isTransient: boolean
} {
  const message = cause instanceof Error ? cause.message : String(cause)
  // Sweed's `Action is not available` / `Parameters validation
  // error` are deterministic; retrying won't help. Anything else
  // (HTTP 5xx, timeouts, JSON-RPC envelope shape errors) we treat
  // as transient and retry.
  const isDeterministic =
    /Action (is not available|does not exist|is unavailable)/i.test(message) ||
    /Parameters validation error/i.test(message) ||
    /Invalid (auth|token|session)/i.test(message)
  return { message, isTransient: !isDeterministic }
}

export async function runConfigWorkersLinkVisitorScanToSweedJob(
  context: JobHandlerContext,
  payload: ConfigWorkersLinkVisitorScanToSweedJobPayload,
): Promise<void> {
  const pool = getPool()
  const scanId = payload.scanId
  const retryAttempt = payload.retryAttempt

  const link = await loadLinkForJob(pool, scanId)
  if (link === null) {
    // Scan deleted between enqueue + run; nothing to do.
    // eslint-disable-next-line no-console
    console.log(
      `[link-visitor-scan-to-sweed] job=${context.id} scan=${scanId} no link row — skipping`,
    )
    return
  }

  // Idempotency guard: if a parallel probe already linked this row
  // (or operator manually confirmed/rejected), don't re-probe.
  if (
    link.linkStatus === 'linked' ||
    link.linkStatus === 'rejected' ||
    link.linkStatus === 'no_match' ||
    link.linkStatus === 'ambiguous'
  ) {
    // eslint-disable-next-line no-console
    console.log(
      `[link-visitor-scan-to-sweed] job=${context.id} scan=${scanId} already terminal=${link.linkStatus} — skipping`,
    )
    return
  }

  const documentNumber = link.idNum === null ? null : link.idNum.trim()
  if (documentNumber === null || documentNumber.length === 0) {
    await markLinkTerminal(pool, {
      scanId,
      status: 'insufficient_data',
      lookupTerms: { reason: 'missing id_num', retryAttempt, trigger: payload.trigger },
    })
    // eslint-disable-next-line no-console
    console.log(
      `[link-visitor-scan-to-sweed] job=${context.id} scan=${scanId} insufficient_data (no id_num)`,
    )
    return
  }

  // Probe Sweed.
  let result: Awaited<ReturnType<typeof findSweedCustomerByDocumentNumber>>
  try {
    result = await findSweedCustomerByDocumentNumber({
      dealerId: link.dealerId,
      documentNumber,
    })
  } catch (cause) {
    const { message, isTransient } = classifySweedError(cause)
    if (isTransient && retryAttempt < MAX_RETRY_ATTEMPTS) {
      const delaySec = BASE_RETRY_DELAY_SECONDS * Math.pow(2, retryAttempt)
      await markLinkFailed(pool, {
        scanId,
        errorMessage: message,
        retryDelaySeconds: delaySec,
        lookupTerms: {
          documentNumber,
          retryAttempt,
          trigger: payload.trigger,
          error: message,
        },
      })
      // Self-re-enqueue at `now() + delaySec`. Dedup-keyed by
      // (scanId, nextRetryAttempt) so duplicate-delivery doesn't
      // pile up. Fast-lane priority so the retry beats best-effort
      // backlog when it finally fires.
      await withTransaction(async (db) => {
        await enqueueJob(db, {
          jobType: 'config.workers.link_visitor_scan_to_sweed',
          module: 'config',
          payload: {
            scanId,
            retryAttempt: retryAttempt + 1,
            trigger: payload.trigger,
          },
          priority: JOB_PRIORITY_URGENT,
          runAt: new Date(Date.now() + delaySec * 1000),
          dedupeKey: `config.workers.link_visitor_scan_to_sweed:${scanId}:${retryAttempt + 1}`,
          requestedByUserId: null,
        })
      })
      // eslint-disable-next-line no-console
      console.warn(
        `[link-visitor-scan-to-sweed] job=${context.id} scan=${scanId} transient failure, retry in ${delaySec}s (attempt=${retryAttempt + 1}/${MAX_RETRY_ATTEMPTS}): ${message}`,
      )
      return
    }
    // Out of retries or deterministic — record + drop.
    await markLinkFailed(pool, {
      scanId,
      errorMessage: message,
      retryDelaySeconds: BASE_RETRY_DELAY_SECONDS * Math.pow(2, MAX_RETRY_ATTEMPTS),
      lookupTerms: {
        documentNumber,
        retryAttempt,
        trigger: payload.trigger,
        error: message,
        exhausted: !isTransient || retryAttempt >= MAX_RETRY_ATTEMPTS,
      },
    })
    // eslint-disable-next-line no-console
    console.error(
      `[link-visitor-scan-to-sweed] job=${context.id} scan=${scanId} ${isTransient ? 'exhausted retries' : 'deterministic failure'}: ${message}`,
    )
    return
  }

  // Decide final status from RPC result.
  if (result.customerId !== null) {
    await markLinkLinked(pool, {
      scanId,
      sweedCustomerId: result.customerId,
      method: 'sweed.customer.list.document_number',
      // High confidence: Sweed's documentNumber is unique-ish (DL #
      // collisions across jurisdictions exist but are exceedingly
      // rare and operator-overridable from the details page).
      confidence: result.totalCount === 1 ? 0.99 : 0.9,
      lookupTerms: {
        documentNumber,
        page: 1,
        pageSize: 50,
        retryAttempt,
        trigger: payload.trigger,
        totalCount: result.totalCount,
      },
      rawMatch: result.raw,
    })
    // eslint-disable-next-line no-console
    console.log(
      `[link-visitor-scan-to-sweed] job=${context.id} scan=${scanId} linked customer=${result.customerId} (totalCount=${result.totalCount})`,
    )
    // Best-effort: warm the segment-membership cache for the freshly
    // linked customer so the details page has data immediately, plus a
    // highwater-gated catalog refresh. This MUST NOT fail the link —
    // we're already inside the job's withSweedSession, so it's one
    // extra RPC with zero added DB-read cost. Swallow all errors.
    try {
      const count = await refreshCustomerSegmentMembership({
        sweedCustomerId: result.customerId,
        dealerId: link.dealerId,
      })
      await refreshMarketingCatalogIfStale({ stateDealerId: getWorkerEnv().sweedStateDealerId })
      // eslint-disable-next-line no-console
      console.log(
        `[link-visitor-scan-to-sweed] job=${context.id} scan=${scanId} cached ${count} segments for customer=${result.customerId}`,
      )
    } catch (segErr) {
      // eslint-disable-next-line no-console
      console.warn(
        `[link-visitor-scan-to-sweed] job=${context.id} scan=${scanId} segment cache warm failed (non-fatal): ${
          segErr instanceof Error ? segErr.message : String(segErr)
        }`,
      )
    }
    // Best-effort: kick the geographic segment-rule engine now that the
    // scan is linked. It's DB-only unless a rule actually matches, and
    // deduped per scan so the geocode-completion hook collapses onto the
    // same row when both fire. Must never fail the link. See
    // geoSegmentRuleEvalJob.ts + migration 079.
    try {
      const geoConcurrencyKey = `config.workers.geo_segment_rule_eval:${scanId}`
      await withTransaction(async (db) => {
        await enqueueJob(db, {
          jobType: 'config.workers.geo_segment_rule_eval',
          module: 'config',
          payload: { scanId, trigger: 'scan_linked' },
          priority: JOB_PRIORITY_BACKFILL,
          // Per-EDGE dedupe so the geocode-completion edge can never be
          // suppressed by an in-flight scan_linked eval (and vice
          // versa) — that would drop the second prerequisite. The
          // shared concurrencyKey still serialises the two per scan so
          // they never run a Sweed session for the same scan at once.
          dedupeKey: `${geoConcurrencyKey}:scan_linked`,
          concurrencyKey: geoConcurrencyKey,
          requestedByUserId: null,
        })
      })
    } catch (geoErr) {
      // eslint-disable-next-line no-console
      console.warn(
        `[link-visitor-scan-to-sweed] job=${context.id} scan=${scanId} geo-segment eval enqueue failed (non-fatal): ${
          geoErr instanceof Error ? geoErr.message : String(geoErr)
        }`,
      )
    }
    return
  }

  if (result.totalCount === 0) {
    await markLinkTerminal(pool, {
      scanId,
      status: 'no_match',
      lookupTerms: {
        documentNumber,
        retryAttempt,
        trigger: payload.trigger,
        totalCount: 0,
      },
      rawMatch: result.raw,
    })
    // eslint-disable-next-line no-console
    console.log(
      `[link-visitor-scan-to-sweed] job=${context.id} scan=${scanId} no_match`,
    )
    return
  }

  await markLinkTerminal(pool, {
    scanId,
    status: 'ambiguous',
    lookupTerms: {
      documentNumber,
      retryAttempt,
      trigger: payload.trigger,
      totalCount: result.totalCount,
    },
    rawMatch: result.raw,
  })
  // eslint-disable-next-line no-console
  console.log(
    `[link-visitor-scan-to-sweed] job=${context.id} scan=${scanId} ambiguous (totalCount=${result.totalCount})`,
  )
}
