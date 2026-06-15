// Ads-policy lint for the SEO FAQ control plane (CI gate 9).
//
// Google Ads landing-page / cannabis policy forbids a handful of claim
// *kinds* in destination content: medical/therapeutic claims, overbroad
// legality claims, recreational-effect ("get you high") claims,
// competitor disparagement, and unsourced price/availability promises.
// Surfacing these in a FAQ answer (raw OR sanitized — both render on a
// public ad landing page) risks an Ads disapproval, so this scanner is
// the deterministic half of CI gate 9: it flags the highest-risk phrasings
// for the human approver / the governance review page.
//
// Design mirrors the FBUS leak detector in faqContent.ts: a deliberately
// conservative, TRANSPARENT denylist of high-signal phrases — NOT a full
// compliance engine. A human approver still reads every word; this only
// blocks the most likely accidental policy claims (e.g. the LLM inventing
// "treats anxiety" or "100% legal"). False-positive risk is kept low by
// matching whole tokens/phrases only and excluding everyday words that
// would fire constantly in legitimate retail copy ("treat yourself",
// "buzz about", and crucially the brand word "baked").
//
// Pure (no I/O), so it is exhaustively unit-tested and can be reused by
// the route, the governance review page, and the approval gate.
//
// parent EPIC_PLAN §5/§7 (gate 9) · child FreshlyBakedNYC/automation#46 ·
// Satisfies: virusdave/top-level#17 · Phase: P5

import type { FaqItemInput } from './faqContent.js'

export type AdsPolicyCategory =
  | 'medical'
  | 'legal'
  | 'effect'
  | 'disparagement'
  | 'price_availability'

export interface AdsPolicyFinding {
  /** Which forbidden claim kind matched. */
  readonly category: AdsPolicyCategory
  /** The canonical denylist phrase that matched (lowercase). */
  readonly phrase: string
}

// ── denylists (high-signal, conservative) ─────────────────────────────
//
// Each entry is a lowercase phrase. Internal spaces match one-or-more
// whitespace OR hyphen separators (so "mind altering" also catches
// "mind-altering"); single-word entries match a whole alphanumeric token
// only (so "cure" does not match "manicure"/"secure"/"procedure"). Tune
// here if the operator wants a stricter or looser rule.

// Medical / therapeutic claims. Single ambiguous words ("treat",
// "treatment") are intentionally EXCLUDED — they fire constantly in
// retail copy ("treat yourself", "a sweet treat"). We only flag the
// claim-shaped multi-word phrases plus a couple of unambiguous markers.
const MEDICAL_TERMS: readonly string[] = [
  'cures',
  'cure',
  'cured',
  'heals',
  'heal',
  'fda approved',
  'clinically proven',
  'medically proven',
  'doctor recommended',
  'doctor approved',
  'health benefits',
  'medical benefits',
  'therapeutic',
  'treats anxiety',
  'treats pain',
  'treats insomnia',
  'treatment for',
  'relieves pain',
  'relieves anxiety',
  'relieves stress',
  'pain relief',
  'anxiety relief',
  'stress relief',
  'helps with anxiety',
  'helps with pain',
  'helps with insomnia',
]

// Overbroad legality claims.
const LEGAL_TERMS: readonly string[] = [
  '100% legal',
  'fully legal',
  'completely legal',
  'totally legal',
  'federally legal',
  'legal in all states',
  'legal in all 50 states',
  'legal loophole',
  'no prescription needed',
  'no prescription required',
]

// Recreational / intoxication effect claims. NB: the brand word "baked"
// and the everyday word "buzz" are deliberately NOT here.
const EFFECT_TERMS: readonly string[] = [
  'get you high',
  'gets you high',
  'getting you high',
  'feel high',
  'feeling high',
  'intoxicating',
  'psychoactive',
  'mind altering',
  'euphoric high',
  'guaranteed high',
  'potent high',
]

// Competitor disparagement — comparative-claim phrasings only.
const DISPARAGEMENT_TERMS: readonly string[] = [
  'better than our competitors',
  'better than the competition',
  'beat our competitors',
  'beat the competition',
  'unlike our competitors',
  'unlike other dispensaries',
  'unlike other stores',
  "competitors can't",
  'the only legit',
  'the only legitimate',
]

// Unsourced price / availability promises.
const PRICE_AVAILABILITY_TERMS: readonly string[] = [
  'lowest price',
  'lowest prices',
  'guaranteed lowest',
  'best price',
  'best prices',
  'unbeatable price',
  'unbeatable prices',
  'price match',
  'price-match guarantee',
  'cheapest',
  'guaranteed in stock',
  'always in stock',
  'never out of stock',
  'always available',
  'guaranteed delivery',
]

const DENYLISTS: readonly { category: AdsPolicyCategory; terms: readonly string[] }[] = [
  { category: 'medical', terms: MEDICAL_TERMS },
  { category: 'legal', terms: LEGAL_TERMS },
  { category: 'effect', terms: EFFECT_TERMS },
  { category: 'disparagement', terms: DISPARAGEMENT_TERMS },
  { category: 'price_availability', terms: PRICE_AVAILABILITY_TERMS },
]

/**
 * Build a case-insensitive regex for a denylist phrase. Each run of
 * whitespace in the phrase becomes `[\s-]+` (so a space also matches a
 * hyphen and vice versa), and the whole phrase is bounded by
 * non-alphanumerics so a single-word term matches a whole token only.
 */
function phraseToRegex(phrase: string): RegExp {
  const tokens = phrase
    .trim()
    .split(/\s+/)
    .map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const body = tokens.join('[\\s-]+')
  return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, 'i')
}

// Compile once at module load.
const COMPILED: readonly { category: AdsPolicyCategory; phrase: string; re: RegExp }[] =
  DENYLISTS.flatMap(({ category, terms }) =>
    terms.map((phrase) => ({ category, phrase, re: phraseToRegex(phrase) })),
  )

/**
 * Return every distinct ads-policy claim found in `text`, categorized.
 * Empty array = clean. Findings are stable-ordered by category then by
 * denylist order so output is deterministic for tests / CI assertions.
 */
export function findAdsPolicyViolations(text: string): AdsPolicyFinding[] {
  if (!text) {
    return []
  }
  const found: AdsPolicyFinding[] = []
  const seen = new Set<string>()
  for (const { category, phrase, re } of COMPILED) {
    const key = `${category}:${phrase}`
    if (!seen.has(key) && re.test(text)) {
      seen.add(key)
      found.push({ category, phrase })
    }
  }
  return found
}

/** True iff `text` contains any ads-policy claim. */
export function hasAdsPolicyViolation(text: string): boolean {
  return findAdsPolicyViolations(text).length > 0
}

/**
 * Human-readable markers (`<category>:<phrase>`) for `text`, suitable for
 * an approval-rejection message or a CI assertion. Empty array = clean.
 */
export function describeAdsPolicyViolations(text: string): string[] {
  return findAdsPolicyViolations(text).map((f) => `${f.category}:${f.phrase}`)
}

export interface AdsPolicyItemProblem {
  readonly itemIndex: number
  readonly field: 'question' | 'answer_raw' | 'answer_sanitized'
  readonly category: AdsPolicyCategory
  readonly phrase: string
}

/**
 * Scan every public field of every FAQ item for ads-policy claims. The
 * shared question and BOTH answer variants render on a public ad landing
 * page (raw → `.nyc`, sanitized → `.us`), so all three are linted.
 * Returns a flat, deterministic list of per-item/per-field problems;
 * empty = clean.
 */
export function findFaqAdsPolicyProblems(
  items: readonly FaqItemInput[],
): AdsPolicyItemProblem[] {
  const problems: AdsPolicyItemProblem[] = []
  const fields: AdsPolicyItemProblem['field'][] = [
    'question',
    'answer_raw',
    'answer_sanitized',
  ]
  items.forEach((item, itemIndex) => {
    for (const field of fields) {
      for (const { category, phrase } of findAdsPolicyViolations(item[field] ?? '')) {
        problems.push({ itemIndex, field, category, phrase })
      }
    }
  })
  return problems
}
