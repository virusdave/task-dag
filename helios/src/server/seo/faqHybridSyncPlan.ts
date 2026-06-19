// Hybrid FAQ sync / change-detection — the PURE decision core (child
// FreshlyBakedNYC/automation#46, P1). Given a snapshot of each FBUS
// source-keyed FAQ set (its control-plane status, current fingerprint,
// approved fingerprint, currently-published fingerprint) plus the result
// of any source (re)import made this pass, decide WHAT should happen —
// without performing any side effect.
//
// This module is deliberately I/O-free: no DB, no filesystem, no env, no
// job queue, no bundle publish, no page-dave. It only computes the policy.
// The (separately gated) runtime executor consumes this plan and is the
// thing that actually verifies the approval ledger
// (`loadApprovedFaqSetsForBundle`), compiles + publishes the signed bundle,
// and fires `page-dave`. Encoding the policy here lets us exhaustively
// unit-test the highest-risk safety invariants before any operational
// surface exists.
//
// The two hybrid paths (parent EPIC_PLAN §1 Q3, this child #46 P1):
//
//   (a) APPROVAL → PUBLISH. A human approval of FAQ content drives an
//       event-driven publish of the EXACT approved content. The planner
//       marks a source publish-eligible only when it is `approved` AND the
//       approved fingerprint is not already the live/published one.
//
//   (b) SOURCE CHANGE → DRAFT + PAGE. An observed upstream/source change
//       (or a created/modified source) recomputes `content_sha256`,
//       creates/updates a Helios DRAFT, and fires `page-dave` for review.
//       Path (b) NEVER auto-publishes — only path (a)'s human approval
//       does.
//
// GUARD (parent §1 Q3): path (a) may publish ONLY the exact approved
// content. If, in the same pass, a source is BOTH (looks) publish-eligible
// AND a source change was observed for it, the source-change path (b) WINS:
// the source is routed to draft + review (page), and publish is SUPPRESSED
// for it. This makes "an observed source change never auto-publishes"
// structural, not merely a side effect of the import resetting status.
//
// Satisfies: virusdave/top-level#17 · Phase: P1

import { parseFaqSourceKey } from './faqSourceKey.js'

/** Result of an idempotent source (re)import this pass (see seoFaqQueries). */
export type FaqSourceImportOutcome = 'created' | 'updated' | 'unchanged'

/** Control-plane status of an FAQ set (mirrors seo_faq_sets.status). */
export type FaqSetStatus = 'draft' | 'needs_review' | 'approved' | 'rejected'

/**
 * One source-keyed FAQ set's state for a single planning pass. Everything
 * the planner needs to classify the source, with no I/O implied.
 */
export interface FaqSyncSourceObservation {
  /** The set's stable source identity, e.g. `fbus-global-faq`. */
  readonly sourceKey: string
  /** The set's minted public id (echoed into actions for the executor). */
  readonly faqSetId: string
  /** Current control-plane status. */
  readonly status: FaqSetStatus
  /** The set's current content fingerprint (recomputed on every save). */
  readonly contentSha256: string
  /**
   * The fingerprint the approval ledger blessed for this set, or null when
   * the set is not approved. For an `approved` set this is the only
   * content path (a) is ever allowed to publish.
   */
  readonly approvedContentSha256: string | null
  /**
   * The fingerprint currently live in the published bundle for this set,
   * or null if this source has never been published. Used to decide
   * whether an approved set still needs a publish (path a).
   */
  readonly publishedContentSha256: string | null
  /**
   * Outcome of a source (re)import made this pass, or null if no source was
   * observed for this set this pass. `created`/`updated` ⇒ content changed
   * ⇒ path (b); `unchanged`/null ⇒ no source change.
   */
  readonly importOutcome?: FaqSourceImportOutcome | null
}

/**
 * A source whose approved content is not yet (fully) published — path (a).
 * The executor publishes the bundle (which rebuilds from ALL approved sets
 * via the ledger-verifying loader); these candidates are why a publish is
 * warranted this pass and what fingerprint each expects to land.
 */
export interface FaqSyncPublishCandidate {
  readonly sourceKey: string
  readonly faqSetId: string
  /** The approved fingerprint expected to be published (audit / verify). */
  readonly approvedContentSha256: string
}

/** A source that changed and needs a draft + exactly one review page — path (b). */
export interface FaqSyncReviewPage {
  readonly sourceKey: string
  readonly faqSetId: string
  /** The new/changed draft fingerprint to page about (one page per fp). */
  readonly contentSha256: string
  readonly reason: Extract<FaqSourceImportOutcome, 'created' | 'updated'>
}

/** A source the planner intentionally left alone, with a human-readable why. */
export interface FaqSyncNoop {
  readonly sourceKey: string
  readonly faqSetId: string
  readonly reason: string
}

export interface FaqSyncPlan {
  /** Path (a): approved-but-unpublished sources warranting a bundle publish. */
  readonly publishCandidates: readonly FaqSyncPublishCandidate[]
  /** Path (b): changed sources needing a draft + one review page. */
  readonly reviewPages: readonly FaqSyncReviewPage[]
  /** Sources left untouched (already published, unchanged, non-approved, …). */
  readonly noops: readonly FaqSyncNoop[]
  /**
   * True iff the executor should (re)publish the approved bundle this pass.
   * Equivalent to `publishCandidates.length > 0`. The actual bundle still
   * rebuilds from the ledger-verified loader at execution time; this only
   * decides WHETHER to run a publish.
   */
  readonly shouldPublishBundle: boolean
}

function classify(obs: FaqSyncSourceObservation): {
  publish?: FaqSyncPublishCandidate
  page?: FaqSyncReviewPage
  noop?: FaqSyncNoop
} {
  const { sourceKey, faqSetId } = obs

  // A non-FBUS / unrecognized source key has no FBUS sanitized-publish
  // policy here — fail safe by doing nothing (the executor only ever
  // publishes FBUS sets). This also covers a structurally-junk key, which
  // can never have been persisted anyway (migration 083 check constraint).
  const parsed = parseFaqSourceKey(sourceKey)
  if (parsed === null || !parsed.isFbus) {
    return { noop: { sourceKey, faqSetId, reason: 'non-FBUS or unrecognized source key; skipped' } }
  }

  const changed = obs.importOutcome === 'created' || obs.importOutcome === 'updated'

  // GUARD (parent §1 Q3): an observed source change always routes to draft +
  // review and SUPPRESSES any publish for that source this pass — even if
  // the row snapshot still looks approved/publishable (e.g. a stale read
  // racing the import that reset it to draft). Path (b) never auto-publishes.
  if (changed) {
    return {
      page: {
        sourceKey,
        faqSetId,
        contentSha256: obs.contentSha256,
        reason: obs.importOutcome as 'created' | 'updated',
      },
    }
  }

  // No source change this pass. Path (a): publish iff the set is approved
  // and its approved fingerprint is not already the live/published one.
  if (obs.status === 'approved' && obs.approvedContentSha256 !== null) {
    if (obs.approvedContentSha256 === obs.publishedContentSha256) {
      return {
        noop: { sourceKey, faqSetId, reason: 'approved content already published; nothing to do' },
      }
    }
    return {
      publish: { sourceKey, faqSetId, approvedContentSha256: obs.approvedContentSha256 },
    }
  }

  // Not approved and no source change → nothing to publish or page about.
  return {
    noop: { sourceKey, faqSetId, reason: `status=${obs.status}, no source change; nothing to do` },
  }
}

/**
 * Compute the hybrid sync plan for a set of FBUS source-keyed FAQ sets.
 * Pure: same inputs always yield the same plan; performs no side effects.
 *
 * For each observation it emits exactly one of: a publish candidate
 * (path a), a review page (path b), or a noop — applying the guard that a
 * same-pass source change always wins over publish for that source.
 */
export function planFaqHybridSync(
  observations: readonly FaqSyncSourceObservation[],
): FaqSyncPlan {
  const publishCandidates: FaqSyncPublishCandidate[] = []
  const reviewPages: FaqSyncReviewPage[] = []
  const noops: FaqSyncNoop[] = []

  for (const obs of observations) {
    const { publish, page, noop } = classify(obs)
    if (publish) {
      publishCandidates.push(publish)
    }
    if (page) {
      reviewPages.push(page)
    }
    if (noop) {
      noops.push(noop)
    }
  }

  return {
    publishCandidates,
    reviewPages,
    noops,
    shouldPublishBundle: publishCandidates.length > 0,
  }
}
