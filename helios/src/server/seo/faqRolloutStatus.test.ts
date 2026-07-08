// Unit tests for the pure FAQ rollout status / rollback / alert core
// (child FreshlyBakedNYC/automation#46, P6). These pin the highest-risk
// rollout-safety invariants BEFORE any operator-gated executor exists:
//
//   1. invalid live bundle → fail-closed (unknown, one page, rollback blocked)
//   2. absent live bundle  → approved=pending-publish, others=*_not_live
//   3. approved & live at approved fp → approved_live, no alert
//   4. approved & no live fp → approved_pending_publish, report-only
//   5. approved & live drift → approved_live_drifted, page-worthy
//   6. approved with null approved fp → invariant_violation, page-worthy
//   7. rejected but still live → rejected_still_live, page-worthy
//   8. rollback of an approved-live source → reject → republish → page
//   9. rollback of unknown source → alert, no destructive action
//  10. live lint only pages when the row content IS what is live
//  11. duplicate source keys → deterministic blocker/alert, no silent pick
//
// Satisfies: virusdave/top-level#17 · Phase: P6

import { describe, expect, it } from 'vitest'

import type { FaqItemInput } from './faqContent.js'
import { FBUS_GLOBAL_FAQ_SOURCE_KEY, fbusFaqSourceKey } from './faqSourceKey.js'
import {
  computeFaqRolloutStatus,
  planFaqRollback,
  type FaqRolloutObservation,
  type PublishedBundleState,
} from './faqRolloutStatus.js'

const GLOBAL = FBUS_GLOBAL_FAQ_SOURCE_KEY
const DELIVERANCE = fbusFaqSourceKey('deliverance')

// A clean FAQ item that passes the strict FBUS approvable check (no cannabis
// meta-terms / `.nyc` / brand phrase / ads-policy claims), with distinct raw
// vs sanitized variants.
const CLEAN_ITEMS: readonly FaqItemInput[] = [
  {
    question: 'What time do you open?',
    answer_raw: 'We open at 9am every day in our shop.',
    answer_sanitized: 'We open at 9am every day.',
  },
]

// An item that trips the ads-policy lint (and thus the compliance check too).
const DIRTY_ITEMS: readonly FaqItemInput[] = [
  {
    question: 'Does this cure anything?',
    answer_raw: 'It is 100% legal and cures pain.',
    answer_sanitized: 'It is 100% legal and cures pain.',
  },
]

function obs(over: Partial<FaqRolloutObservation> = {}): FaqRolloutObservation {
  return {
    sourceKey: GLOBAL,
    faqSetId: 'faq_global_1',
    status: 'approved',
    contentSha256: 'a'.repeat(64),
    approvedContentSha256: 'a'.repeat(64),
    items: CLEAN_ITEMS,
    ...over,
  }
}

function ok(shas: Record<string, string>): PublishedBundleState {
  return { status: 'ok', shaByFaqSetId: new Map(Object.entries(shas)) }
}

describe('computeFaqRolloutStatus', () => {
  it('fails closed on an invalid live bundle (one bundle page, unknown per source)', () => {
    const report = computeFaqRolloutStatus({
      observations: [obs()],
      publishedState: { status: 'invalid' },
    })
    expect(report.publishedState).toBe('invalid')
    expect(report.sources).toHaveLength(1)
    expect(report.sources[0]!.state).toBe('published_state_invalid')
    // Never claimed "not live" via the empty-map trap.
    expect(report.sources[0]!.isLive).toBe(false)
    expect(report.sources[0]!.pageWorthy).toBe(false)
    // Exactly one bundle-level page.
    expect(report.alerts).toHaveLength(1)
    expect(report.alerts[0]!).toMatchObject({
      reason: 'published_state_invalid',
      sourceKey: null,
      faqSetId: null,
    })
  })

  it('absent bundle: approved=pending-publish, others=*_not_live', () => {
    const report = computeFaqRolloutStatus({
      observations: [
        obs({ sourceKey: GLOBAL, faqSetId: 'a', status: 'approved' }),
        obs({ sourceKey: DELIVERANCE, faqSetId: 'b', status: 'draft', approvedContentSha256: null }),
      ],
      publishedState: { status: 'absent' },
    })
    expect(report.sources.map((s) => s.state)).toEqual([
      'approved_pending_publish',
      'draft_not_live',
    ])
    expect(report.alerts).toHaveLength(0)
  })

  it('approved + live at the approved fingerprint → approved_live, no alert', () => {
    const sha = 'c'.repeat(64)
    const report = computeFaqRolloutStatus({
      observations: [obs({ faqSetId: 'x', contentSha256: sha, approvedContentSha256: sha })],
      publishedState: ok({ x: sha }),
    })
    expect(report.sources[0]!.state).toBe('approved_live')
    expect(report.sources[0]!.isLive).toBe(true)
    expect(report.sources[0]!.pageWorthy).toBe(false)
    expect(report.alerts).toHaveLength(0)
  })

  it('approved + live at a different fingerprint → approved_live_drifted, page-worthy', () => {
    const report = computeFaqRolloutStatus({
      observations: [
        obs({ faqSetId: 'x', contentSha256: 'b'.repeat(64), approvedContentSha256: 'b'.repeat(64) }),
      ],
      publishedState: ok({ x: 'd'.repeat(64) }),
    })
    expect(report.sources[0]!.state).toBe('approved_live_drifted')
    expect(report.sources[0]!.pageWorthy).toBe(true)
    expect(report.alerts.map((a) => a.reason)).toContain('approved_live_drifted')
  })

  it('approved row with a null approved fingerprint → invariant_violation, page-worthy', () => {
    const report = computeFaqRolloutStatus({
      observations: [obs({ faqSetId: 'x', status: 'approved', approvedContentSha256: null })],
      publishedState: { status: 'absent' },
    })
    expect(report.sources[0]!.state).toBe('invariant_violation')
    expect(report.sources[0]!.pageWorthy).toBe(true)
    expect(report.alerts.map((a) => a.reason)).toContain('invariant_violation')
  })

  it('rejected but still live → rejected_still_live, page-worthy', () => {
    const report = computeFaqRolloutStatus({
      observations: [
        obs({ faqSetId: 'x', status: 'rejected', approvedContentSha256: null, contentSha256: 'e'.repeat(64) }),
      ],
      publishedState: ok({ x: 'f'.repeat(64) }),
    })
    expect(report.sources[0]!.state).toBe('rejected_still_live')
    expect(report.sources[0]!.pageWorthy).toBe(true)
    expect(report.alerts.map((a) => a.reason)).toContain('rejected_still_live')
  })

  it('rejected and not live → rejected_not_live, report-only', () => {
    const report = computeFaqRolloutStatus({
      observations: [obs({ faqSetId: 'x', status: 'rejected', approvedContentSha256: null })],
      publishedState: ok({ other: 'f'.repeat(64) }),
    })
    expect(report.sources[0]!.state).toBe('rejected_not_live')
    expect(report.sources[0]!.pageWorthy).toBe(false)
    expect(report.alerts).toHaveLength(0)
  })

  it('lint fires as a live policy alert ONLY when the row content is what is live', () => {
    const dirtySha = 'ab'.repeat(32)
    // Row content is live → live policy violation page.
    const live = computeFaqRolloutStatus({
      observations: [
        obs({
          faqSetId: 'x',
          status: 'approved',
          items: DIRTY_ITEMS,
          contentSha256: dirtySha,
          approvedContentSha256: dirtySha,
        }),
      ],
      publishedState: ok({ x: dirtySha }),
    })
    expect(live.sources[0]!.signals.adsPolicyFindingCount).toBeGreaterThan(0)
    expect(live.sources[0]!.pageWorthy).toBe(true)
    expect(live.alerts.map((a) => a.reason)).toContain('live_content_policy_violation')

    // Same dirty row content, but the live fingerprint differs (stale draft):
    // report the findings but do NOT page a live violation.
    const stale = computeFaqRolloutStatus({
      observations: [
        obs({
          faqSetId: 'x',
          status: 'draft',
          items: DIRTY_ITEMS,
          contentSha256: dirtySha,
          approvedContentSha256: null,
        }),
      ],
      publishedState: ok({ x: 'cd'.repeat(32) }),
    })
    expect(stale.sources[0]!.signals.adsPolicyFindingCount).toBeGreaterThan(0)
    expect(stale.sources[0]!.state).toBe('draft_still_live')
    expect(stale.alerts.map((a) => a.reason)).not.toContain('live_content_policy_violation')
  })

  it('duplicate source keys → invariant_violation + a single dup alert, no silent pick', () => {
    const report = computeFaqRolloutStatus({
      observations: [
        obs({ sourceKey: GLOBAL, faqSetId: 'a' }),
        obs({ sourceKey: GLOBAL, faqSetId: 'b' }),
      ],
      publishedState: { status: 'absent' },
    })
    expect(report.sources.map((s) => s.state)).toEqual([
      'invariant_violation',
      'invariant_violation',
    ])
    const dupAlerts = report.alerts.filter((a) => a.reason === 'duplicate_source_key')
    expect(dupAlerts).toHaveLength(1)
    expect(dupAlerts[0]!.sourceKey).toBe(GLOBAL)
  })
})

describe('planFaqRollback', () => {
  it('rolls back an approved-live source: reject → republish → page (ordered)', () => {
    const sha = 'c'.repeat(64)
    const plan = planFaqRollback({
      observations: [obs({ faqSetId: 'x', contentSha256: sha, approvedContentSha256: sha })],
      publishedState: ok({ x: sha }),
      requestedDisabledSourceKeys: [GLOBAL],
    })
    expect(plan.blocked).toBe(false)
    expect(plan.actions.map((a) => a.kind)).toEqual([
      'set_faq_status_rejected',
      'publish_approved_faq_bundle',
      'page_dave',
    ])
    const publish = plan.actions.find((a) => a.kind === 'publish_approved_faq_bundle')
    expect(publish).toMatchObject({ forSourceKeys: [GLOBAL] })
  })

  it('approved but not live: reject only, no republish needed', () => {
    const plan = planFaqRollback({
      observations: [obs({ faqSetId: 'x' })],
      publishedState: ok({ other: 'f'.repeat(64) }),
      requestedDisabledSourceKeys: [GLOBAL],
    })
    expect(plan.blocked).toBe(false)
    expect(plan.actions.map((a) => a.kind)).toEqual(['set_faq_status_rejected', 'page_dave'])
  })

  it('already rejected and not live → noop, no reject/publish', () => {
    const plan = planFaqRollback({
      observations: [obs({ faqSetId: 'x', status: 'rejected', approvedContentSha256: null })],
      publishedState: ok({ other: 'f'.repeat(64) }),
      requestedDisabledSourceKeys: [GLOBAL],
    })
    expect(plan.actions.map((a) => a.kind)).toEqual(['noop'])
  })

  it('invalid live bundle blocks the republish (never publish over an unvalidated bundle)', () => {
    const plan = planFaqRollback({
      observations: [obs({ faqSetId: 'x' })],
      publishedState: { status: 'invalid' },
      requestedDisabledSourceKeys: [GLOBAL],
    })
    expect(plan.blocked).toBe(true)
    expect(plan.blockers).toContain('published_state_invalid')
    // The reject is still planned (harmless, clears approval); no publish.
    expect(plan.actions.map((a) => a.kind)).not.toContain('publish_approved_faq_bundle')
    expect(plan.actions.map((a) => a.kind)).toContain('set_faq_status_rejected')
  })

  it('unknown requested source key → alert, no destructive action', () => {
    const plan = planFaqRollback({
      observations: [obs({ faqSetId: 'x' })],
      publishedState: ok({ x: 'a'.repeat(64) }),
      requestedDisabledSourceKeys: ['fbus-nope-faq'],
    })
    expect(plan.actions).toHaveLength(0)
    expect(plan.alerts.map((a) => a.reason)).toEqual(['rollback_unknown_source_key'])
  })

  it('duplicate requested key → single republish, deterministic', () => {
    const sha = 'c'.repeat(64)
    const plan = planFaqRollback({
      observations: [obs({ faqSetId: 'x', contentSha256: sha, approvedContentSha256: sha })],
      publishedState: ok({ x: sha }),
      requestedDisabledSourceKeys: [GLOBAL, GLOBAL],
    })
    expect(plan.actions.filter((a) => a.kind === 'publish_approved_faq_bundle')).toHaveLength(1)
    expect(plan.actions.filter((a) => a.kind === 'set_faq_status_rejected')).toHaveLength(1)
  })

  it('ambiguous (duplicated) source key → refuse to roll back', () => {
    const plan = planFaqRollback({
      observations: [
        obs({ sourceKey: GLOBAL, faqSetId: 'a' }),
        obs({ sourceKey: GLOBAL, faqSetId: 'b' }),
      ],
      publishedState: ok({ a: 'a'.repeat(64) }),
      requestedDisabledSourceKeys: [GLOBAL],
    })
    expect(plan.actions).toHaveLength(0)
    expect(plan.alerts.map((a) => a.reason)).toContain('duplicate_source_key')
  })
})
