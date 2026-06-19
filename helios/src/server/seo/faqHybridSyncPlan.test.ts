// Unit tests for the pure hybrid FAQ sync decision core (child #46, P1).
// These pin the highest-risk safety invariants of the approval→publish /
// change→draft+page policy BEFORE any operational executor exists:
//
//   1. approval, not yet published          → publish candidate
//   2. approval already published (same fp)  → noop, no publish
//   3. source import `created`               → review page, no publish
//   4. source import `updated`               → review page, no publish
//   5. import `unchanged`, approved+unpub'd  → publish candidate
//   6. import `updated` for an (apparently)  → review page WINS; publish
//      approved+unpublished source              SUPPRESSED (the guard)
//   7. the planner emits only descriptions   → no side effects exercised
//
// Satisfies: virusdave/top-level#17 · Phase: P1

import { describe, expect, it } from 'vitest'

import {
  FBUS_GLOBAL_FAQ_SOURCE_KEY,
  fbusFaqSourceKey,
} from './faqSourceKey.js'
import {
  planFaqHybridSync,
  type FaqSyncSourceObservation,
} from './faqHybridSyncPlan.js'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

function obs(overrides: Partial<FaqSyncSourceObservation> = {}): FaqSyncSourceObservation {
  return {
    sourceKey: FBUS_GLOBAL_FAQ_SOURCE_KEY,
    faqSetId: 'faqset_2026-06-19_000000_abc123',
    status: 'approved',
    contentSha256: SHA_A,
    approvedContentSha256: SHA_A,
    publishedContentSha256: null,
    importOutcome: null,
    ...overrides,
  }
}

describe('planFaqHybridSync — path (a) approval → publish', () => {
  it('approved + not yet published → publish candidate, shouldPublishBundle', () => {
    const plan = planFaqHybridSync([obs({ approvedContentSha256: SHA_A, publishedContentSha256: null })])
    expect(plan.publishCandidates).toEqual([
      {
        sourceKey: FBUS_GLOBAL_FAQ_SOURCE_KEY,
        faqSetId: 'faqset_2026-06-19_000000_abc123',
        approvedContentSha256: SHA_A,
      },
    ])
    expect(plan.reviewPages).toHaveLength(0)
    expect(plan.shouldPublishBundle).toBe(true)
  })

  it('approved but a newer fp than what is live → publish candidate (re-publish)', () => {
    const plan = planFaqHybridSync([
      obs({ approvedContentSha256: SHA_B, publishedContentSha256: SHA_A }),
    ])
    expect(plan.publishCandidates).toHaveLength(1)
    expect(plan.publishCandidates[0]!.approvedContentSha256).toBe(SHA_B)
    expect(plan.shouldPublishBundle).toBe(true)
  })

  it('approved content already published (same fp) → noop, no publish', () => {
    const plan = planFaqHybridSync([
      obs({ approvedContentSha256: SHA_A, publishedContentSha256: SHA_A }),
    ])
    expect(plan.publishCandidates).toHaveLength(0)
    expect(plan.reviewPages).toHaveLength(0)
    expect(plan.noops).toHaveLength(1)
    expect(plan.shouldPublishBundle).toBe(false)
  })

  it('import unchanged + approved + unpublished → still a publish candidate', () => {
    const plan = planFaqHybridSync([
      obs({ importOutcome: 'unchanged', approvedContentSha256: SHA_A, publishedContentSha256: null }),
    ])
    expect(plan.publishCandidates).toHaveLength(1)
    expect(plan.reviewPages).toHaveLength(0)
  })
})

describe('planFaqHybridSync — path (b) source change → draft + page', () => {
  it('import created → review page, never a publish', () => {
    const plan = planFaqHybridSync([
      obs({ status: 'draft', approvedContentSha256: null, importOutcome: 'created', contentSha256: SHA_B }),
    ])
    expect(plan.reviewPages).toEqual([
      {
        sourceKey: FBUS_GLOBAL_FAQ_SOURCE_KEY,
        faqSetId: 'faqset_2026-06-19_000000_abc123',
        contentSha256: SHA_B,
        reason: 'created',
      },
    ])
    expect(plan.publishCandidates).toHaveLength(0)
    expect(plan.shouldPublishBundle).toBe(false)
  })

  it('import updated → review page, never a publish', () => {
    const plan = planFaqHybridSync([
      obs({ status: 'draft', approvedContentSha256: null, importOutcome: 'updated', contentSha256: SHA_B }),
    ])
    expect(plan.reviewPages).toHaveLength(1)
    expect(plan.reviewPages[0]!.reason).toBe('updated')
    expect(plan.publishCandidates).toHaveLength(0)
  })
})

describe('planFaqHybridSync — guard: source change wins over publish', () => {
  it('updated import for an (apparently) approved+unpublished source → page wins, publish suppressed', () => {
    // Defensive race: the row snapshot still reads approved+unpublished, but
    // an `updated` import for the SAME source was observed this pass. Path
    // (b) must win — no auto-publish of content that just changed.
    const plan = planFaqHybridSync([
      obs({
        status: 'approved',
        approvedContentSha256: SHA_A,
        publishedContentSha256: null,
        importOutcome: 'updated',
        contentSha256: SHA_B,
      }),
    ])
    expect(plan.publishCandidates).toHaveLength(0)
    expect(plan.reviewPages).toHaveLength(1)
    expect(plan.reviewPages[0]!.reason).toBe('updated')
    expect(plan.shouldPublishBundle).toBe(false)
  })
})

describe('planFaqHybridSync — non-approved, non-changed', () => {
  it.each(['draft', 'needs_review', 'rejected'] as const)(
    'status=%s with no source change → noop',
    (status) => {
      const plan = planFaqHybridSync([
        obs({ status, approvedContentSha256: null, publishedContentSha256: null, importOutcome: null }),
      ])
      expect(plan.publishCandidates).toHaveLength(0)
      expect(plan.reviewPages).toHaveLength(0)
      expect(plan.noops).toHaveLength(1)
    },
  )
})

describe('planFaqHybridSync — fail-safe on non-FBUS source key', () => {
  it('a non-FBUS / unrecognized key is skipped (noop), never published', () => {
    const plan = planFaqHybridSync([
      obs({ sourceKey: 'not-a-source-key', status: 'approved', approvedContentSha256: SHA_A }),
    ])
    expect(plan.publishCandidates).toHaveLength(0)
    expect(plan.reviewPages).toHaveLength(0)
    expect(plan.noops).toHaveLength(1)
    expect(plan.noops[0]!.reason).toMatch(/non-FBUS/)
  })
})

describe('planFaqHybridSync — multiple sources & independence', () => {
  it('publishes ready source Y while paging changed source X; no cross-contamination', () => {
    const x = fbusFaqSourceKey('deliverance')
    const y = fbusFaqSourceKey('global')
    const plan = planFaqHybridSync([
      // X: changed → page, no publish
      obs({
        sourceKey: x,
        faqSetId: 'faqset_x',
        status: 'draft',
        approvedContentSha256: null,
        importOutcome: 'updated',
        contentSha256: SHA_B,
      }),
      // Y: approved + unpublished, no change → publish candidate
      obs({
        sourceKey: y,
        faqSetId: 'faqset_y',
        status: 'approved',
        approvedContentSha256: SHA_A,
        publishedContentSha256: null,
        importOutcome: 'unchanged',
      }),
    ])
    expect(plan.reviewPages.map((p) => p.sourceKey)).toEqual([x])
    expect(plan.publishCandidates.map((p) => p.sourceKey)).toEqual([y])
    expect(plan.shouldPublishBundle).toBe(true)
  })

  it('empty input → empty plan, no publish', () => {
    const plan = planFaqHybridSync([])
    expect(plan).toEqual({
      publishCandidates: [],
      reviewPages: [],
      noops: [],
      shouldPublishBundle: false,
    })
  })
})

describe('planFaqHybridSync — purity (no side effects, stable output)', () => {
  it('does not mutate its input and is deterministic across calls', () => {
    const input: FaqSyncSourceObservation[] = [obs()]
    const snapshot = JSON.parse(JSON.stringify(input))
    const a = planFaqHybridSync(input)
    const b = planFaqHybridSync(input)
    expect(input).toEqual(snapshot) // unchanged
    expect(a).toEqual(b) // deterministic
  })
})
