import { describe, expect, it } from 'vitest'

import { shouldAttemptFreePreroll } from './segmentOrchestrator.js'

describe('shouldAttemptFreePreroll (issue #13, A4 gating)', () => {
  it('skips when per-site free_preroll segment id is NULL', () => {
    expect(
      shouldAttemptFreePreroll({
        freePrerollSegmentId: null,
        freePrerollEligibleByVerdict: true,
        acceptedPasteOffer: true,
      }),
    ).toBe(false)
  })

  it('skips when verdict is not eligible (lukewarm/negative/strong-no-text)', () => {
    expect(
      shouldAttemptFreePreroll({
        freePrerollSegmentId: 8666,
        freePrerollEligibleByVerdict: false,
        acceptedPasteOffer: true,
      }),
    ).toBe(false)
  })

  it('skips when customer did NOT accept the paste-text offer', () => {
    expect(
      shouldAttemptFreePreroll({
        freePrerollSegmentId: 8666,
        freePrerollEligibleByVerdict: true,
        acceptedPasteOffer: false,
      }),
    ).toBe(false)
  })

  it('attempts when all three preconditions are met', () => {
    expect(
      shouldAttemptFreePreroll({
        freePrerollSegmentId: 8666,
        freePrerollEligibleByVerdict: true,
        acceptedPasteOffer: true,
      }),
    ).toBe(true)
  })
})
