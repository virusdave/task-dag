// Customer-Sentiment Capture (issue #13, A3 phase) — pipeline tests.
//
// Pure-function tests: verdict→bucket mapping, recipient resolution,
// template variable substitution. No DB / network / filesystem.

import { describe, expect, it } from 'vitest'

import {
  buildTemplateVars,
  pickTemplateKind,
  renderMustacheLite,
  resolveRecipients,
} from './emailPipeline.js'

describe('pickTemplateKind', () => {
  it('maps negative → negative', () => {
    expect(pickTemplateKind('negative', null)).toBe('negative')
  })

  it('maps lukewarm → lukewarm', () => {
    expect(pickTemplateKind('lukewarm', null)).toBe('lukewarm')
  })

  it('maps strong-with-text → strong_with_text', () => {
    expect(pickTemplateKind('strong-with-text', null)).toBe('strong_with_text')
  })

  it('maps strong-no-text → null (no email per A3 spec)', () => {
    expect(pickTemplateKind('strong-no-text', null)).toBeNull()
  })

  it('maps error + degraded_pass=true → lukewarm (operator-settled fallback)', () => {
    expect(pickTemplateKind('error', true)).toBe('lukewarm')
  })

  it('maps error + degraded_pass=false → negative (operator-settled fallback)', () => {
    expect(pickTemplateKind('error', false)).toBe('negative')
  })

  it('maps null verdict → null (no email)', () => {
    expect(pickTemplateKind(null, null)).toBeNull()
  })
})

describe('resolveRecipients', () => {
  const settings = {
    review_email_dave: 'dave@example.com',
    review_email_support: 'support@example.com',
    review_email_ops: 'ops@example.com',
  }

  it('negative → dave + ops', () => {
    expect(resolveRecipients('negative', settings)).toEqual([
      'dave@example.com',
      'ops@example.com',
    ])
  })

  it('lukewarm → dave + support', () => {
    expect(resolveRecipients('lukewarm', settings)).toEqual([
      'dave@example.com',
      'support@example.com',
    ])
  })

  it('strong_with_text → dave + ops', () => {
    expect(resolveRecipients('strong_with_text', settings)).toEqual([
      'dave@example.com',
      'ops@example.com',
    ])
  })

  it('deduplicates if dave and ops are the same address', () => {
    expect(
      resolveRecipients('strong_with_text', {
        ...settings,
        review_email_ops: 'dave@example.com',
      }),
    ).toEqual(['dave@example.com'])
  })

  it('drops nulls and empty strings cleanly', () => {
    expect(
      resolveRecipients('negative', {
        review_email_dave: 'dave@example.com',
        review_email_support: null,
        review_email_ops: '   ',
      }),
    ).toEqual(['dave@example.com'])
  })

  it('returns [] when no recipients configured', () => {
    expect(
      resolveRecipients('lukewarm', {
        review_email_dave: null,
        review_email_support: null,
        review_email_ops: null,
      }),
    ).toEqual([])
  })

  it("returns [] for 'other' (no recipients defined)", () => {
    expect(resolveRecipients('other', settings)).toEqual([])
  })
})

describe('renderMustacheLite', () => {
  it('substitutes {{var}} tokens', () => {
    expect(renderMustacheLite('Hello {{name}}!', { name: 'world' })).toBe('Hello world!')
  })

  it('tolerates whitespace inside the braces', () => {
    expect(renderMustacheLite('{{ a }} {{b}}', { a: 'one', b: 'two' })).toBe('one two')
  })

  it('renders unknown variables as the empty string', () => {
    expect(renderMustacheLite('{{missing}}done', {})).toBe('done')
  })

  it('handles repeated occurrences of the same variable', () => {
    expect(renderMustacheLite('{{x}}-{{x}}', { x: 'A' })).toBe('A-A')
  })
})

describe('buildTemplateVars', () => {
  const baseInput = {
    submissionId: '11111111-2222-3333-4444-555555555555',
    dealerId: 210705,
    siteLabel: 'Midtown',
    starRating: 4,
    reviewText: 'Great vibes & friendly staff',
    contacts: [
      { kind: 'email' as const, value: 'cust@example.com' },
      { kind: 'phone' as const, value: '212-555-0100' },
    ],
    llmVerdict: 'lukewarm' as const,
    degradedPass: null,
    llmRationale: 'Mixed sentiment.',
    providerReviewUrl: null,
    createdAt: new Date('2026-05-22T12:00:00Z'),
    adminBaseUrl: 'https://helios.freshlybaked.us/',
  }

  it('produces all the expected substitution keys', () => {
    const vars = buildTemplateVars(baseInput)
    expect(vars.submission_id).toBe(baseInput.submissionId)
    expect(vars.dealer_id).toBe('210705')
    expect(vars.site_label).toBe('Midtown')
    expect(vars.star_rating).toBe('4')
    expect(vars.created_at).toBe('2026-05-22T12:00:00.000Z')
    expect(vars.llm_verdict).toBe('lukewarm')
    expect(vars.llm_rationale).toBe('Mixed sentiment.')
    expect(vars.degraded_pass_suffix).toBe('')
    expect(vars.admin_url).toBe('https://helios.freshlybaked.us/reviews/' + baseInput.submissionId)
    expect(vars.review_text_block).toContain('Great vibes')
    expect(vars.contacts_block).toContain('email: cust@example.com')
    expect(vars.contacts_block).toContain('phone: 212-555-0100')
  })

  it('escapes html-special characters in the html review-text variant', () => {
    const vars = buildTemplateVars({
      ...baseInput,
      reviewText: '<script>alert("xss")</script>',
    })
    expect(vars.review_text_html).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    )
  })

  it('falls back to placeholders when review text / rationale are missing', () => {
    const vars = buildTemplateVars({
      ...baseInput,
      reviewText: null,
      llmRationale: null,
      contacts: [],
    })
    expect(vars.review_text_block).toContain('(no text provided)')
    expect(vars.contacts_block).toContain('(no contact info provided)')
    expect(vars.llm_rationale).toBe('(no rationale captured)')
  })

  it('appends the degraded-pass suffix on error verdicts', () => {
    expect(
      buildTemplateVars({ ...baseInput, llmVerdict: 'error', degradedPass: true })
        .degraded_pass_suffix,
    ).toBe(' (degraded-pass)')
    expect(
      buildTemplateVars({ ...baseInput, llmVerdict: 'error', degradedPass: false })
        .degraded_pass_suffix,
    ).toBe(' (no degraded-pass)')
  })

  it('renders star-rating placeholder when starRating is null', () => {
    const vars = buildTemplateVars({ ...baseInput, starRating: null })
    expect(vars.star_rating).toBe('—')
  })
})
