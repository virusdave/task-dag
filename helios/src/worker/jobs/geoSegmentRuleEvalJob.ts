// Per-scan geographic segment-rule evaluation engine.
//
// virusdave/top-level Bronx geo-segment work, phase 2 (the on-scan
// follow-on to the one-shot backfill in
// helios/scripts/backfill-geo-segment-bronx.ts).
//
// Enqueued best-effort, deduped per scan, from BOTH ends of the scan
// pipeline (link completion + address geocode completion), because the
// two prerequisites land in either order. The handler converges on a
// single DB-only evaluation and only touches Sweed when a rule
// actually matches a customer not already recorded as applied.
//
// Flow:
//   1. Load the scan's link + geocode + person context (one indexed read).
//   2. Bail (cheaply, NOT an error) if the scan isn't linked yet or its
//      home address hasn't geocoded `ok` — the other hook re-enqueues
//      when its half completes.
//   3. Load the (tiny) set of enabled `first_scan` rules for the site.
//   4. Keep the rules whose geofence + `since` + "first scan in >= N
//      days" predicate the scan satisfies.
//   5. Claim each matching (rule, customer) slot in the application
//      ledger (idempotent). Open a Sweed session ONLY if at least one
//      slot needs a write, then add the customer to each segment via
//      the operator-verified `store.marketing.segment.result.add`.
//
// Cost shape (docs/canon/AGENTS_CANON.md §3): common path = 1 indexed
// scan read + 1 tiny rules read + (0..k) indexed first-scan EXISTS,
// zero Sweed RPCs. Sweed session + RPCs fire only on a true match,
// gated by the ledger so each customer is added at most once per rule.

import type { ConfigWorkersGeoSegmentRuleEvalJobPayload } from '../../shared/contracts/index.js'
import { getPool } from '../../server/db/pool.js'
import {
  claimRuleApplication,
  loadEnabledRules,
  loadResolvedRuleIds,
  loadScanEvalContext,
  markRuleApplicationApplied,
  markRuleApplicationFailed,
  personHasPriorScanWithin,
} from '../../server/db/queries/geoSegmentRulesQueries.js'
import { ruleGeoMatches, ruleSinceSatisfied, type GeoSegmentRule } from '../sweed/geoSegment.js'
import { addSegmentMembers, listSweedCustomerSegments } from '../sweed/customers.js'
import { ensureDealerContext } from '../sweed/rpc.js'
import { withSweedSession } from '../sweed/session.js'
import { isRetryableWorkerError } from '../runtime/errors.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

function log(context: JobHandlerContext, scanId: number, msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[geo-segment-rule-eval] job=${context.id} scan=${scanId} ${msg}`)
}

export async function runConfigWorkersGeoSegmentRuleEvalJob(
  context: JobHandlerContext,
  payload: ConfigWorkersGeoSegmentRuleEvalJobPayload,
): Promise<void> {
  const pool = getPool()
  const scanId = payload.scanId

  const ctx = await loadScanEvalContext(pool, scanId)
  if (ctx === null) {
    log(context, scanId, 'no scan row — skipping')
    return
  }

  // Prerequisites. Neither is an error: the link hook re-enqueues when
  // the scan links, the geocode hook re-enqueues when the address
  // reaches `ok`.
  if (ctx.sweedCustomerId === null) {
    log(context, scanId, 'not linked to a Sweed customer yet — deferring to link hook')
    return
  }
  if (ctx.geocodeStatus !== 'ok' || ctx.addressLat === null || ctx.addressLng === null) {
    log(context, scanId, `home address not geocoded ok (status=${ctx.geocodeStatus ?? 'none'}) — deferring to geocode hook`)
    return
  }
  if (ctx.personKey === null) {
    log(context, scanId, 'no person_key — cannot evaluate first_scan; skipping')
    return
  }

  const rules = await loadEnabledRules(pool, ctx.siteSlug, 'first_scan')
  if (rules.length === 0) {
    log(context, scanId, `no enabled first_scan rules for site=${ctx.siteSlug}`)
    return
  }

  // Keep the rules this scan satisfies geometrically + temporally, then
  // confirm the "first scan in >= N days" predicate per matching rule.
  const matched: GeoSegmentRule[] = []
  for (const rule of rules) {
    if (!ruleSinceSatisfied(rule, ctx.eventTime)) continue
    if (!ruleGeoMatches(rule, ctx.addressLat, ctx.addressLng)) continue
    const hasPrior = await personHasPriorScanWithin(pool, {
      provider: ctx.provider,
      personKey: ctx.personKey,
      eventTime: ctx.eventTime,
      reactivationDays: rule.reactivationDays,
    })
    if (hasPrior) continue
    matched.push(rule)
  }

  if (matched.length === 0) {
    log(context, scanId, `customer=${ctx.sweedCustomerId} matched no rule predicates`)
    return
  }

  const customerId = ctx.sweedCustomerId

  // Cheap pre-filter: drop rules already terminally resolved for this
  // customer so we don't open a Sweed session in the steady state. One
  // indexed read.
  const resolved = await loadResolvedRuleIds(pool, {
    ruleIds: matched.map((r) => r.id),
    sweedCustomerId: customerId,
  })
  const actionable = matched.filter((r) => !resolved.has(r.id))
  if (actionable.length === 0) {
    log(context, scanId, `customer=${customerId} all matched rules already resolved — skipping`)
    return
  }

  // Open a Sweed session only now that there is potential work. We
  // CLAIM the ledger slot INSIDE the session so a session-acquire
  // failure (pool exhausted) leaves zero claims behind. The claim is
  // the exclusion lease — only 'claimed'/'reattempt' may write.
  let retryableFailure: unknown = null
  await withSweedSession(async () => {
    for (const rule of actionable) {
      const claim = await claimRuleApplication(pool, {
        ruleId: rule.id,
        sweedCustomerId: customerId,
        scanId,
      })
      if (claim === 'skip_done') {
        log(context, scanId, `rule=${rule.id} customer=${customerId} already applied — skipping`)
        continue
      }
      if (claim === 'skip_inflight') {
        log(context, scanId, `rule=${rule.id} customer=${customerId} claimed by another job — skipping`)
        continue
      }
      try {
        await ensureDealerContext(rule.dealerId)
        // Membership check keeps the ledger status accurate and avoids a
        // redundant add when the customer is already in the segment
        // (e.g. added by the backfill). One extra read RPC, only on a
        // real, not-yet-applied match.
        const segs = await listSweedCustomerSegments({
          dealerId: rule.dealerId,
          customerId,
        })
        const alreadyMember = segs.some((row) => row.id === String(rule.segmentId))
        if (!alreadyMember) {
          await addSegmentMembers({
            dealerId: rule.dealerId,
            segmentId: rule.segmentId,
            customerIds: [customerId],
          })
        }
        await markRuleApplicationApplied(pool, {
          ruleId: rule.id,
          sweedCustomerId: customerId,
          scanId,
          status: alreadyMember ? 'already_member' : 'applied',
        })
        log(
          context,
          scanId,
          `rule=${rule.id} customer=${customerId} -> segment=${rule.segmentId} ${alreadyMember ? 'already_member' : 'ADDED'} (dealer=${rule.dealerId})`,
        )
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        await markRuleApplicationFailed(pool, {
          ruleId: rule.id,
          sweedCustomerId: customerId,
          error: message,
        })
        // Remember the first retryable error so we can fail the whole
        // job (and let the queue retry it) rather than silently dropping
        // the assignment when no further scan/geocode trigger may come.
        if (isRetryableWorkerError(cause) && retryableFailure === null) {
          retryableFailure = cause
        }
        // eslint-disable-next-line no-console
        console.error(
          `[geo-segment-rule-eval] job=${context.id} scan=${scanId} rule=${rule.id} customer=${customerId} FAILED: ${message}`,
        )
      }
    }
  })

  // Surface a retryable failure so the worker re-queues this job with
  // backoff; the ledger 'failed'->'pending' reclaim makes the retry
  // idempotent. Non-retryable (deterministic) errors stay recorded as
  // 'failed' without churning the queue.
  if (retryableFailure !== null) {
    throw retryableFailure
  }
}
