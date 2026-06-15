import { describe, expect, it } from 'vitest'

import type { FaqItemInput } from './faqContent.js'
import {
  DEFAULT_FAQ_GOVERNANCE_POLICY,
  type FaqGovernanceCategory,
  type FaqGovernancePolicy,
  answerSimilarity,
  checkFaqSetGovernance,
  describeFaqGovernanceProblems,
  hasFaqGovernanceProblem,
  jaccardSimilarity,
  normalizeForCompare,
  shingles,
  tokenize,
} from './faqGovernance.js'

function item(over: Partial<FaqItemInput>): FaqItemInput {
  return {
    question: 'What are your hours?',
    answer_raw: 'We are open from 9am to 9pm every day of the week.',
    answer_sanitized: 'We are open from 9am to 9pm every day of the week.',
    ...over,
  }
}

function categories(items: readonly FaqItemInput[], policy?: FaqGovernancePolicy): FaqGovernanceCategory[] {
  return [...new Set(checkFaqSetGovernance(items, policy).map((p) => p.category))]
}

// ── text-similarity primitives ────────────────────────────────────────

describe('normalizeForCompare', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalizeForCompare("What's the PRICE?")).toBe('whats the price')
    expect(normalizeForCompare('  a\t\nb   c  ')).toBe('a b c')
    expect(normalizeForCompare('!!!')).toBe('')
  })
})

describe('tokenize', () => {
  it('returns normalized tokens, empty array for empty input', () => {
    expect(tokenize('Open 9am - 9pm!')).toEqual(['open', '9am', '9pm'])
    expect(tokenize('   ')).toEqual([])
    expect(tokenize('')).toEqual([])
  })
})

describe('shingles', () => {
  it('builds k-token shingles', () => {
    expect([...shingles(['a', 'b', 'c', 'd'], 2)]).toEqual(['a b', 'b c', 'c d'])
    expect([...shingles(['a', 'b', 'c'], 3)]).toEqual(['a b c'])
  })

  it('falls back to token set when fewer tokens than k', () => {
    expect([...shingles(['a', 'b'], 3)]).toEqual(['a', 'b'])
  })

  it('clamps size to >= 1 and handles empty input', () => {
    expect([...shingles(['a', 'b'], 0)]).toEqual(['a', 'b'])
    expect([...shingles([], 3)]).toEqual([])
  })

  it('dedups repeated shingles', () => {
    expect([...shingles(['a', 'a', 'a'], 1)]).toEqual(['a'])
  })
})

describe('jaccardSimilarity', () => {
  it('computes intersection over union', () => {
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1)
    expect(jaccardSimilarity(new Set(['a', 'b', 'c', 'd']), new Set(['a', 'b']))).toBe(0.5)
    expect(jaccardSimilarity(new Set(['a']), new Set(['b']))).toBe(0)
  })

  it('treats two empty sets as 0 similarity', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0)
  })
})

describe('answerSimilarity', () => {
  it('is 1 for identical answers and ignores punctuation/case', () => {
    expect(answerSimilarity('We open at 9am sharp daily.', 'we open at 9am SHARP daily', 3)).toBe(1)
  })

  it('is low for unrelated answers', () => {
    expect(
      answerSimilarity(
        'We deliver across the whole metro area every single day.',
        'Returns are accepted within thirty days of purchase only.',
        3,
      ),
    ).toBeLessThan(0.2)
  })
})

// ── item-count cap ────────────────────────────────────────────────────

describe('checkFaqSetGovernance — item-count cap', () => {
  it('flags a set over the cap with a set-level (-1) problem', () => {
    const items = Array.from({ length: 4 }, (_, i) =>
      item({ question: `Question number ${i}?`, answer_raw: `Answer ${i}.`, answer_sanitized: `Answer ${i}.` }),
    )
    const policy = { ...DEFAULT_FAQ_GOVERNANCE_POLICY, maxItems: 3 }
    const problems = checkFaqSetGovernance(items, policy)
    const countProblem = problems.find((p) => p.category === 'item_count')
    expect(countProblem).toBeDefined()
    expect(countProblem?.itemIndex).toBe(-1)
  })

  it('does not flag a set at the cap', () => {
    const items = Array.from({ length: 3 }, (_, i) =>
      item({ question: `Question number ${i}?`, answer_raw: `Answer ${i}.`, answer_sanitized: `Answer ${i}.` }),
    )
    const policy = { ...DEFAULT_FAQ_GOVERNANCE_POLICY, maxItems: 3 }
    expect(categories(items, policy)).not.toContain('item_count')
  })
})

// ── length caps ───────────────────────────────────────────────────────

describe('checkFaqSetGovernance — length caps', () => {
  it('flags an over-long question', () => {
    const policy = { ...DEFAULT_FAQ_GOVERNANCE_POLICY, maxQuestionChars: 10 }
    const problems = checkFaqSetGovernance([item({ question: 'This question is definitely too long?' })], policy)
    const p = problems.find((x) => x.category === 'question_length')
    expect(p?.field).toBe('question')
    expect(p?.itemIndex).toBe(0)
  })

  it('flags an over-long answer in both variants independently', () => {
    const policy = { ...DEFAULT_FAQ_GOVERNANCE_POLICY, maxAnswerChars: 5 }
    const problems = checkFaqSetGovernance(
      [item({ answer_raw: 'way too long', answer_sanitized: 'way too long' })],
      policy,
    )
    const fields = problems.filter((p) => p.category === 'answer_length').map((p) => p.field)
    expect(fields).toContain('answer_raw')
    expect(fields).toContain('answer_sanitized')
  })

  it('does not flag content within caps', () => {
    expect(categories([item({})])).not.toContain('answer_length')
    expect(categories([item({})])).not.toContain('question_length')
  })
})

// ── forbidden-term scan ───────────────────────────────────────────────

describe('checkFaqSetGovernance — forbidden-term scan', () => {
  it('flags LLM refusal / meta phrasing', () => {
    expect(categories([item({ answer_raw: 'As an AI language model, I cannot provide that.' })])).toContain(
      'forbidden_term',
    )
  })

  it('flags refusal phrasing that carries apostrophes / commas (matched on normalized text)', () => {
    expect(categories([item({ answer_raw: "I'm sorry, but I am unable to help with that." })])).toContain(
      'forbidden_term',
    )
    expect(categories([item({ answer_sanitized: 'I am sorry, but that is out of scope.' })])).toContain(
      'forbidden_term',
    )
  })

  it('flags placeholder copy', () => {
    expect(categories([item({ answer_sanitized: 'Lorem ipsum dolor sit amet. TODO: fill in.' })])).toContain(
      'forbidden_term',
    )
  })

  it('flags unfilled template markers (literal substrings)', () => {
    expect(categories([item({ answer_raw: 'Open {{hours}} daily.' })])).toContain('forbidden_term')
    expect(categories([item({ question: 'How do I reach [insert store name]?' })])).toContain('forbidden_term')
  })

  it('does not false-positive on legitimate retail copy', () => {
    const items = [
      item({
        question: 'Do you offer same-day delivery?',
        answer_raw: 'Yes, we deliver across the metro area within a few hours of ordering.',
        answer_sanitized: 'Yes, we deliver across the metro area within a few hours of ordering.',
      }),
    ]
    expect(categories(items)).not.toContain('forbidden_term')
  })

  it('matches whole tokens only (no substring false positives)', () => {
    // "placeholder" is forbidden but "placeholders" inside an unrelated
    // word context should still match the token via boundaries; ensure a
    // benign word containing "tbd"-like fragments does not match.
    expect(categories([item({ answer_raw: 'Our subdivision has dedicated parking.' })])).not.toContain(
      'forbidden_term',
    )
  })
})

// ── duplicate question ────────────────────────────────────────────────

describe('checkFaqSetGovernance — duplicate question', () => {
  it('flags two questions that normalize equal, pointing at the earlier item', () => {
    const items = [
      item({ question: 'What are your hours?' }),
      item({ question: '  What ARE your Hours?? ' }),
    ]
    const dup = checkFaqSetGovernance(items).find((p) => p.category === 'duplicate_question')
    expect(dup?.itemIndex).toBe(1)
    expect(dup?.relatedItemIndex).toBe(0)
  })

  it('does not flag distinct questions', () => {
    const items = [item({ question: 'What are your hours?' }), item({ question: 'Where are you located?' })]
    expect(categories(items)).not.toContain('duplicate_question')
  })
})

// ── near-duplicate answer ─────────────────────────────────────────────

describe('checkFaqSetGovernance — near-duplicate answer', () => {
  it('flags two answers that are nearly identical', () => {
    const items = [
      item({
        question: 'What are your hours?',
        answer_raw: 'We are open from nine in the morning until nine at night, seven days a week.',
        answer_sanitized: 'We are open from nine in the morning until nine at night, seven days a week.',
      }),
      item({
        question: 'When are you open?',
        answer_raw: 'We are open from nine in the morning until nine at night, seven days every week.',
        answer_sanitized: 'We are open from nine in the morning until nine at night, seven days every week.',
      }),
    ]
    const dup = checkFaqSetGovernance(items).find((p) => p.category === 'near_duplicate_answer')
    expect(dup?.itemIndex).toBe(1)
    expect(dup?.relatedItemIndex).toBe(0)
  })

  it('does not flag distinct answers', () => {
    const items = [
      item({
        question: 'What are your hours?',
        answer_raw: 'We are open from nine in the morning until nine at night, seven days a week.',
        answer_sanitized: 'We are open from nine in the morning until nine at night, seven days a week.',
      }),
      item({
        question: 'Do you deliver?',
        answer_raw: 'Yes, delivery is available to most neighborhoods within about an hour of ordering online.',
        answer_sanitized: 'Yes, delivery is available to most neighborhoods within about an hour of ordering online.',
      }),
    ]
    expect(categories(items)).not.toContain('near_duplicate_answer')
  })

  it('respects the configured threshold', () => {
    const items = [
      item({ answer_raw: 'alpha beta gamma delta epsilon', answer_sanitized: 'alpha beta gamma delta epsilon' }),
      item({ answer_raw: 'alpha beta gamma delta zeta', answer_sanitized: 'alpha beta gamma delta zeta' }),
    ]
    expect(categories(items, { ...DEFAULT_FAQ_GOVERNANCE_POLICY, nearDuplicateThreshold: 0.99 })).not.toContain(
      'near_duplicate_answer',
    )
    expect(categories(items, { ...DEFAULT_FAQ_GOVERNANCE_POLICY, nearDuplicateThreshold: 0.1 })).toContain(
      'near_duplicate_answer',
    )
  })
})

// ── aggregate helpers ─────────────────────────────────────────────────

describe('hasFaqGovernanceProblem / describeFaqGovernanceProblems', () => {
  it('hasFaqGovernanceProblem is false for a clean set', () => {
    const items = [
      item({ question: 'What are your hours?' }),
      item({ question: 'Where are you located?', answer_raw: 'Downtown, on Main Street near the park.', answer_sanitized: 'Downtown, on Main Street near the park.' }),
    ]
    expect(hasFaqGovernanceProblem(items)).toBe(false)
    expect(describeFaqGovernanceProblems(items)).toEqual([])
  })

  it('describe produces readable, deterministic markers', () => {
    const items = [item({ question: 'What are your hours?' }), item({ question: 'what ARE your hours?' })]
    const desc = describeFaqGovernanceProblems(items)
    expect(desc.some((d) => d.startsWith('duplicate_question@item1~item0:'))).toBe(true)
  })

  it('an empty set is clean', () => {
    expect(checkFaqSetGovernance([])).toEqual([])
  })
})
