// FAQ rollout status / rollback / alert derivation — the PURE decision core
// (child FreshlyBakedNYC/automation#46, P6). Given a snapshot of each
// source-keyed FAQ set (its control-plane status + current/approved
// fingerprints + current items) and a summary of the live published bundle
// state, decide:
//
//   (1) approved-content STATUS   — per-source rollout state combining the
//       control-plane status with whether that content is actually live in
//       the signed bundle (live / drifted / pending-publish / still-live /
//       not-live), plus per-source reporting signal counts (ads-policy,
//       leak, compliance, governance);
//   (2) page-dave ALERTS          — which rollout conditions warrant paging
//       a human for a rollout decision (invalid live bundle, live content
//       drifted from its approval, rejected content still serving, known-
//       live content that now trips the ads/leak/compliance lint, and data
//       invariants like an approved row with no approved fingerprint);
//   (3) disabled-content ROLLBACK — a pure `planFaqRollback` that, given the
//       requested source keys to disable, emits the abstract actions to take
//       them out of the next bundle (reject → republish the remaining
//       approved sets → page), with NO side effects.
//
// This module is deliberately I/O-free: no DB, no filesystem, no env, no job
// queue, no bundle publish, no page-dave. It only computes the policy. A
// (separately operator-gated) runtime executor consumes this and is the
// thing that actually flips statuses, rebuilds + publishes the signed
// bundle, and fires page-dave — mirroring how the P1 hybrid-sync planner
// (`faqHybridSyncPlan.ts`) landed its pure core ahead of the operator-gated
// executor.
//
// Two fail-closed safety rails carried from the live-state reader
// (`faqPublishedState.ts`) and the "the DB row is not always what is live"
// reality:
//
//   • An `invalid` live bundle is NEVER treated as "nothing is live". Every
//     source's rollout state becomes `published_state_invalid` (live state
//     unknown), a single bundle-level page is raised, and a rollback plan is
//     BLOCKED from republishing over a bundle we cannot validate.
//   • A source's CURRENT DB content is only asserted to be LIVE (and thus
//     only linted as a live policy violation) when the live fingerprint for
//     that set EQUALS the row's current `content_sha256`. After a source
//     change the row can be a `draft` with new content while the bundle
//     still serves the previously-approved content.
//
// Satisfies: virusdave/top-level#17 · Phase: P6

import { findFaqAdsPolicyProblems } from './adsPolicy.js'
import { checkFaqSetApprovable, describeFbusLeaks, type FaqItemInput } from './faqContent.js'
import { checkFaqSetGovernance } from './faqGovernance.js'

/** Control-plane status of an FAQ set (mirrors seo_faq_sets.status). */
export type FaqSetStatus = 'draft' | 'needs_review' | 'approved' | 'rejected'

/**
 * A pure summary of the live published-bundle state, mirroring the
 * discriminant of `faqPublishedState.ts`'s `PublishedFaqContentState` but
 * carrying only what the rollout policy needs (so this module stays
 * I/O-free). The caller derives this from `readPublishedFaqContentShas`.
 */
export type PublishedBundleState =
  | { readonly status: 'absent' }
  | { readonly status: 'invalid' }
  | { readonly status: 'ok'; readonly shaByFaqSetId: ReadonlyMap<string, string> }

/** One source-keyed FAQ set's state for a rollout-status pass. */
export interface FaqRolloutObservation {
  /** The set's stable source identity, e.g. `fbus-global-faq`. */
  readonly sourceKey: string
  /** The set's minted public id (matches the bundle's faq_set_id). */
  readonly faqSetId: string
  /** Current control-plane status. */
  readonly status: FaqSetStatus
  /** The set's current content fingerprint (recomputed on every save). */
  readonly contentSha256: string
  /**
   * The fingerprint the approval ledger blessed for this set, or null when
   * the set is not approved. For an `approved` set this must be non-null;
   * an approved row with a null approved fingerprint is a data invariant
   * violation (surfaced as such).
   */
  readonly approvedContentSha256: string | null
  /** The set's current items, used for the reporting lint signals. */
  readonly items: readonly FaqItemInput[]
}

/**
 * Per-source rollout state. Combines the control-plane status with whether
 * (and which) content is live in the signed bundle.
 */
export type FaqRolloutState =
  // Live bundle failed validation → live state unknown for every source.
  | 'published_state_invalid'
  // Approved & the approved fingerprint is exactly what is live.
  | 'approved_live'
  // Approved but nothing live for this set yet (awaiting a publish).
  | 'approved_pending_publish'
  // Approved but the live fingerprint differs from the approved one.
  | 'approved_live_drifted'
  // Not approved and not live.
  | 'draft_not_live'
  | 'needs_review_not_live'
  | 'rejected_not_live'
  // Not approved but something is still live for this set (cleanup/risk).
  | 'draft_still_live'
  | 'needs_review_still_live'
  | 'rejected_still_live'
  // Impossible/contradictory input (e.g. approved with no approved sha, or a
  // duplicated source key).
  | 'invariant_violation'

/**
 * Reporting signal counts, always computed over the row's CURRENT content
 * (not necessarily what is live — see the module header). These feed the
 * rollout dashboard and the "known-live content trips the lint" alert.
 */
export interface FaqRolloutSignals {
  /** Structural + sanitized-host + ads-policy approval blockers. */
  readonly complianceProblemCount: number
  /** Google-Ads forbidden-claim lint findings (CI gate 9). */
  readonly adsPolicyFindingCount: number
  /** Advisory governance warnings (caps, dup/near-dup, forbidden terms). */
  readonly governanceProblemCount: number
  /** Sanitized-host (`.us`) leak markers across question + sanitized answer. */
  readonly sanitizedHostLeakCount: number
}

export type FaqRolloutAlertReason =
  | 'published_state_invalid'
  | 'approved_live_drifted'
  | 'rejected_still_live'
  | 'live_content_policy_violation'
  | 'invariant_violation'
  | 'duplicate_source_key'
  | 'rollback_unknown_source_key'

/** A page-worthy rollout condition (alert intent — never sent from here). */
export interface FaqRolloutAlert {
  readonly reason: FaqRolloutAlertReason
  /** The source the alert is about, or null for a bundle-level alert. */
  readonly sourceKey: string | null
  /** The faq set the alert is about, or null when not source-specific. */
  readonly faqSetId: string | null
  readonly message: string
}

export interface FaqRolloutSourceReport {
  readonly sourceKey: string
  readonly faqSetId: string
  readonly status: FaqSetStatus
  readonly state: FaqRolloutState
  /**
   * True iff a fingerprint for this set is live in the (valid) bundle. When
   * the live bundle is `invalid`, liveness is UNKNOWN and this is false —
   * consumers must read `state === 'published_state_invalid'`, not this
   * flag, to distinguish "unknown" from "not live".
   */
  readonly isLive: boolean
  /** The live fingerprint for this set, or null if none / unknown. */
  readonly liveContentSha256: string | null
  /** True iff the live fingerprint equals the row's current content_sha256. */
  readonly liveIsCurrentContent: boolean
  readonly signals: FaqRolloutSignals
  /** True iff this source raised at least one page-worthy alert. */
  readonly pageWorthy: boolean
}

export interface FaqRolloutReport {
  readonly publishedState: 'absent' | 'invalid' | 'ok'
  readonly sources: readonly FaqRolloutSourceReport[]
  readonly alerts: readonly FaqRolloutAlert[]
}

export interface ComputeFaqRolloutStatusInput {
  readonly observations: readonly FaqRolloutObservation[]
  readonly publishedState: PublishedBundleState
}

function computeSignals(obs: FaqRolloutObservation): FaqRolloutSignals {
  const items = obs.items
  let sanitizedHostLeakCount = 0
  for (const item of items) {
    sanitizedHostLeakCount += describeFbusLeaks(item.question).length
    sanitizedHostLeakCount += describeFbusLeaks(item.answer_sanitized).length
  }
  return {
    complianceProblemCount: checkFaqSetApprovable(items, { sourceKey: obs.sourceKey }).length,
    adsPolicyFindingCount: findFaqAdsPolicyProblems(items).length,
    governanceProblemCount: checkFaqSetGovernance(items).length,
    sanitizedHostLeakCount,
  }
}

function hasLiveLint(signals: FaqRolloutSignals): boolean {
  // Governance is deliberately excluded: it is advisory, not a publish
  // blocker, so it must not page for already-live content.
  return (
    signals.complianceProblemCount > 0 ||
    signals.adsPolicyFindingCount > 0 ||
    signals.sanitizedHostLeakCount > 0
  )
}

/** Source keys that appear on more than one observation. */
function duplicatedSourceKeys(observations: readonly FaqRolloutObservation[]): ReadonlySet<string> {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const obs of observations) {
    if (seen.has(obs.sourceKey)) {
      dupes.add(obs.sourceKey)
    }
    seen.add(obs.sourceKey)
  }
  return dupes
}

/**
 * Compute the rollout status report for a set of source-keyed FAQ sets.
 * Pure: same inputs always yield the same report; performs no side effects.
 */
export function computeFaqRolloutStatus(input: ComputeFaqRolloutStatusInput): FaqRolloutReport {
  const { observations, publishedState } = input
  const dupes = duplicatedSourceKeys(observations)
  const sources: FaqRolloutSourceReport[] = []
  const alerts: FaqRolloutAlert[] = []

  if (publishedState.status === 'invalid') {
    // Fail-closed: a live bundle we cannot validate means liveness is unknown
    // for EVERY source. Raise exactly one bundle-level page (never one per
    // source) and mark each source's state unknown.
    alerts.push({
      reason: 'published_state_invalid',
      sourceKey: null,
      faqSetId: null,
      message:
        'Live SEO bundle failed validation; FAQ rollout state is unknown until the bundle is repaired. ' +
        'Do not publish or roll back over an unvalidated bundle.',
    })
  }

  for (const obs of observations) {
    const signals = computeSignals(obs)

    // Duplicated source key: never silently pick a row. Report the invariant
    // and page once per duplicated key (on its first occurrence).
    if (dupes.has(obs.sourceKey)) {
      const isFirst = !sources.some((s) => s.sourceKey === obs.sourceKey)
      if (isFirst) {
        alerts.push({
          reason: 'duplicate_source_key',
          sourceKey: obs.sourceKey,
          faqSetId: null,
          message: `Source key ${JSON.stringify(obs.sourceKey)} appears on multiple FAQ sets; refusing to classify.`,
        })
      }
      sources.push({
        sourceKey: obs.sourceKey,
        faqSetId: obs.faqSetId,
        status: obs.status,
        state: 'invariant_violation',
        isLive: false,
        liveContentSha256: null,
        liveIsCurrentContent: false,
        signals,
        pageWorthy: true,
      })
      continue
    }

    if (publishedState.status === 'invalid') {
      sources.push({
        sourceKey: obs.sourceKey,
        faqSetId: obs.faqSetId,
        status: obs.status,
        state: 'published_state_invalid',
        isLive: false,
        liveContentSha256: null,
        liveIsCurrentContent: false,
        signals,
        // The single bundle-level alert above covers this; do not spam a
        // page per source.
        pageWorthy: false,
      })
      continue
    }

    const liveContentSha256 =
      publishedState.status === 'ok' ? (publishedState.shaByFaqSetId.get(obs.faqSetId) ?? null) : null
    const isLive = liveContentSha256 !== null
    const liveIsCurrentContent = isLive && liveContentSha256 === obs.contentSha256

    // Data invariant: an approved row must carry an approved fingerprint.
    if (obs.status === 'approved' && obs.approvedContentSha256 === null) {
      alerts.push({
        reason: 'invariant_violation',
        sourceKey: obs.sourceKey,
        faqSetId: obs.faqSetId,
        message: `FAQ set ${obs.faqSetId} (${obs.sourceKey}) is approved but has no approved fingerprint.`,
      })
      sources.push({
        sourceKey: obs.sourceKey,
        faqSetId: obs.faqSetId,
        status: obs.status,
        state: 'invariant_violation',
        isLive,
        liveContentSha256,
        liveIsCurrentContent,
        signals,
        pageWorthy: true,
      })
      continue
    }

    let state: FaqRolloutState
    let pageWorthy = false

    switch (obs.status) {
      case 'approved': {
        const approvedSha = obs.approvedContentSha256
        if (!isLive) {
          state = 'approved_pending_publish'
        } else if (liveContentSha256 === approvedSha) {
          state = 'approved_live'
        } else {
          state = 'approved_live_drifted'
          pageWorthy = true
          alerts.push({
            reason: 'approved_live_drifted',
            sourceKey: obs.sourceKey,
            faqSetId: obs.faqSetId,
            message:
              `FAQ set ${obs.faqSetId} (${obs.sourceKey}) is approved at ${approvedSha?.slice(0, 12)} ` +
              `but the live bundle serves ${liveContentSha256?.slice(0, 12)}.`,
          })
        }
        break
      }
      case 'draft':
        state = isLive ? 'draft_still_live' : 'draft_not_live'
        break
      case 'needs_review':
        state = isLive ? 'needs_review_still_live' : 'needs_review_not_live'
        break
      case 'rejected':
        if (isLive) {
          state = 'rejected_still_live'
          pageWorthy = true
          alerts.push({
            reason: 'rejected_still_live',
            sourceKey: obs.sourceKey,
            faqSetId: obs.faqSetId,
            message:
              `FAQ set ${obs.faqSetId} (${obs.sourceKey}) is rejected but still live in the bundle ` +
              `(${liveContentSha256?.slice(0, 12)}); it needs a rollback republish.`,
          })
        } else {
          state = 'rejected_not_live'
        }
        break
    }

    // Known-live content that now trips the ads/leak/compliance lint is a
    // page-worthy rollout risk. Only assert this when the CURRENT row content
    // is exactly what is live (otherwise the row is a stale draft and the
    // live copy is a different, previously-approved fingerprint).
    if (liveIsCurrentContent && hasLiveLint(signals)) {
      pageWorthy = true
      alerts.push({
        reason: 'live_content_policy_violation',
        sourceKey: obs.sourceKey,
        faqSetId: obs.faqSetId,
        message:
          `Live FAQ content for ${obs.faqSetId} (${obs.sourceKey}) trips the lint ` +
          `(compliance=${signals.complianceProblemCount}, ads=${signals.adsPolicyFindingCount}, ` +
          `leak=${signals.sanitizedHostLeakCount}); consider rollback.`,
      })
    }

    sources.push({
      sourceKey: obs.sourceKey,
      faqSetId: obs.faqSetId,
      status: obs.status,
      state,
      isLive,
      liveContentSha256,
      liveIsCurrentContent,
      signals,
      pageWorthy,
    })
  }

  return {
    publishedState: publishedState.status,
    sources,
    alerts,
  }
}

// ── disabled-content rollback (pure plan) ──────────────────────────────

export type FaqRollbackActionKind =
  | 'set_faq_status_rejected'
  | 'publish_approved_faq_bundle'
  | 'page_dave'
  | 'noop'

/**
 * An abstract rollback step for a future (operator-gated) executor. The
 * executor is the thing that actually flips the status, rebuilds + publishes
 * the ledger-verified approved bundle, and fires page-dave; this module only
 * decides WHAT should happen and in what order.
 */
export type FaqRollbackAction =
  | {
      readonly kind: 'set_faq_status_rejected'
      readonly sourceKey: string
      readonly faqSetId: string
    }
  | {
      readonly kind: 'publish_approved_faq_bundle'
      /** The source keys whose removal warrants the republish. */
      readonly forSourceKeys: readonly string[]
    }
  | {
      readonly kind: 'page_dave'
      readonly sourceKey: string
      readonly faqSetId: string
      readonly message: string
    }
  | {
      readonly kind: 'noop'
      readonly sourceKey: string
      readonly faqSetId: string
      readonly reason: string
    }

export interface FaqRollbackPlan {
  /**
   * True iff the rollback CANNOT be safely executed as-is. When blocked, no
   * republish action is emitted (we never publish over a bundle we cannot
   * validate). A future executor MUST stop before side effects when blocked.
   */
  readonly blocked: boolean
  readonly blockers: readonly string[]
  /** Ordered abstract actions: rejections, then one republish, then pages. */
  readonly actions: readonly FaqRollbackAction[]
  /** Page-worthy conditions that are not part of the executable steps. */
  readonly alerts: readonly FaqRolloutAlert[]
}

export interface PlanFaqRollbackInput {
  readonly observations: readonly FaqRolloutObservation[]
  readonly publishedState: PublishedBundleState
  /** The source keys the operator wants taken out of the live bundle. */
  readonly requestedDisabledSourceKeys: readonly string[]
}

/**
 * Plan the rollback ("disable") of one or more source-keyed FAQ sets. Pure:
 * emits abstract actions with NO side effects. The rollback model uses the
 * existing `rejected` status (which clears approval and drops the set from
 * `loadApprovedFaqSetsForBundle`) followed by a republish of the remaining
 * approved sets — there is deliberately no new durable `disabled` status
 * (that would be a schema/product change requiring separate operator sign-off;
 * note a future re-import of a changed source can reset it back to `draft`).
 *
 * Fail-closed: an `invalid` live bundle blocks the republish entirely (we
 * cannot validate what we would be overwriting).
 */
export function planFaqRollback(input: PlanFaqRollbackInput): FaqRollbackPlan {
  const { observations, publishedState, requestedDisabledSourceKeys } = input
  const bySourceKey = new Map<string, FaqRolloutObservation>()
  const dupes = duplicatedSourceKeys(observations)
  for (const obs of observations) {
    if (!bySourceKey.has(obs.sourceKey)) {
      bySourceKey.set(obs.sourceKey, obs)
    }
  }

  const blockers: string[] = []
  if (publishedState.status === 'invalid') {
    blockers.push('published_state_invalid')
  }

  const rejectActions: FaqRollbackAction[] = []
  const pageActions: FaqRollbackAction[] = []
  const noopActions: FaqRollbackAction[] = []
  const alerts: FaqRolloutAlert[] = []
  const liveSourceKeysToRemove: string[] = []

  // Dedupe requested keys while preserving order.
  const requested: string[] = []
  const requestedSeen = new Set<string>()
  for (const key of requestedDisabledSourceKeys) {
    if (!requestedSeen.has(key)) {
      requestedSeen.add(key)
      requested.push(key)
    }
  }

  for (const sourceKey of requested) {
    const obs = bySourceKey.get(sourceKey)
    if (!obs) {
      alerts.push({
        reason: 'rollback_unknown_source_key',
        sourceKey,
        faqSetId: null,
        message: `Rollback requested for unknown source key ${JSON.stringify(sourceKey)}; no action taken.`,
      })
      continue
    }
    if (dupes.has(sourceKey)) {
      alerts.push({
        reason: 'duplicate_source_key',
        sourceKey,
        faqSetId: null,
        message: `Source key ${JSON.stringify(sourceKey)} is ambiguous (multiple sets); refusing to roll back.`,
      })
      continue
    }

    // Liveness: only knowable from a valid bundle. When invalid we still plan
    // the reject (harmless, clears approval) but the republish is blocked.
    const liveContentSha256 =
      publishedState.status === 'ok' ? (publishedState.shaByFaqSetId.get(obs.faqSetId) ?? null) : null
    const isLive = liveContentSha256 !== null
    const alreadyRejected = obs.status === 'rejected'

    if (alreadyRejected && !isLive && publishedState.status !== 'invalid') {
      noopActions.push({
        kind: 'noop',
        sourceKey,
        faqSetId: obs.faqSetId,
        reason: 'already rejected and not live; nothing to roll back',
      })
      continue
    }

    if (!alreadyRejected) {
      rejectActions.push({ kind: 'set_faq_status_rejected', sourceKey, faqSetId: obs.faqSetId })
    }

    // A republish is warranted when this source is live (to remove it) or,
    // under an invalid bundle, unknown — in which case the blocker prevents
    // the republish from being emitted anyway.
    if (isLive || publishedState.status === 'invalid') {
      liveSourceKeysToRemove.push(sourceKey)
    }

    pageActions.push({
      kind: 'page_dave',
      sourceKey,
      faqSetId: obs.faqSetId,
      message:
        `Rolling back FAQ source ${JSON.stringify(sourceKey)} (set ${obs.faqSetId}): ` +
        `${alreadyRejected ? 'already rejected' : 'rejecting'}${isLive ? ' + republishing to remove it from the live bundle' : ''}.`,
    })
  }

  const actions: FaqRollbackAction[] = [...rejectActions]
  const blocked = blockers.length > 0
  if (liveSourceKeysToRemove.length > 0 && !blocked) {
    actions.push({ kind: 'publish_approved_faq_bundle', forSourceKeys: liveSourceKeysToRemove })
  }
  actions.push(...pageActions, ...noopActions)

  return { blocked, blockers, actions, alerts }
}
