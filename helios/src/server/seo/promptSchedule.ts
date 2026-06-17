// Pure helpers for the auto-blog PROMPT-SCHEDULE + TOPIC-MIX config (P4 —
// parent EPIC_PLAN §7.2). No I/O, so these are exhaustively unit-tested and
// reused by the queries layer + routes.
//
// This is operator CONFIG, not approval-gated public content: it does NOT
// reach a signed bundle and is NOT bound to the seo_approvals ledger, so
// there is no content fingerprint here. It captures the cadence (posts/
// week), the topic mix (weighted content categories), the generation mode
// (raw / sanitized / dual), and the reusable prompt templates that the
// (later) Bedrock draft-generation loop will consult. NOTHING in this slice
// runs a background generator — it is config + an operator/API CRUD path
// only (mirrors the operator-approved scope on #44).
//
// child FreshlyBakedNYC/automation#44 (P4) · Satisfies: virusdave/top-level#15

import { randomBytes } from 'node:crypto'

// ── id minting ────────────────────────────────────────────────────────

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

export const PROMPT_SCHEDULE_ID_RE =
  /^seopsch_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[0-9a-f]{6}$/

/** Mint a fresh, sortable prompt-schedule id `seopsch_YYYY-MM-DD_HHMMSS_<6hex>` (UTC). */
export function newPromptScheduleId(now: Date = new Date()): string {
  const y = pad(now.getUTCFullYear(), 4)
  const mo = pad(now.getUTCMonth() + 1, 2)
  const d = pad(now.getUTCDate(), 2)
  const h = pad(now.getUTCHours(), 2)
  const mi = pad(now.getUTCMinutes(), 2)
  const s = pad(now.getUTCSeconds(), 2)
  const suffix = randomBytes(3).toString('hex')
  const id = `seopsch_${y}-${mo}-${d}_${h}${mi}${s}_${suffix}`
  /* istanbul ignore next — defensive; the format above always matches */
  if (!PROMPT_SCHEDULE_ID_RE.test(id)) {
    throw new Error(`newPromptScheduleId produced an invalid id: ${id}`)
  }
  return id
}

/** Lower-kebab schedule key (e.g. 'weekly-nyc-mix'); matches the SQL CHECK. */
export const SCHEDULE_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

export function isValidScheduleKey(value: string): boolean {
  return SCHEDULE_KEY_RE.test(value)
}

// ── config vocabulary ─────────────────────────────────────────────────

/**
 * The content categories the topic mix can draw from (parent §7.1/§7.2).
 * A schedule's topic mix is a weighting over (a subset of) these.
 */
export const TOPIC_CATEGORIES = [
  'local_culture',
  'industry_news',
  'fb_news',
  'nyc_events',
  'gsc_opportunities',
  'social_opportunities',
] as const
export type TopicCategory = (typeof TOPIC_CATEGORIES)[number]

export function isTopicCategory(value: string): value is TopicCategory {
  return (TOPIC_CATEGORIES as readonly string[]).includes(value)
}

/** Generation modes — which body variant(s) the draft loop should produce. */
export const GENERATION_MODES = ['raw', 'sanitized', 'dual'] as const
export type GenerationMode = (typeof GENERATION_MODES)[number]

export function isGenerationMode(value: string): value is GenerationMode {
  return (GENERATION_MODES as readonly string[]).includes(value)
}

/** The named prompt templates the draft loop consults (all optional). */
export const PROMPT_TEMPLATE_KEYS = [
  'article_brief',
  'faq_addendum',
  'title_meta',
  'social_caption',
  'image_prompt',
] as const
export type PromptTemplateKey = (typeof PROMPT_TEMPLATE_KEYS)[number]

// Cadence guardrails — 1–3 posts/week is the epic's stated target; cap
// generously at 14 (twice daily) so an operator can't fat-finger a runaway
// cadence that the (later) generation loop would honor.
export const MIN_POSTS_PER_WEEK = 1
export const MAX_POSTS_PER_WEEK = 14

// Self-promotional guardrail (parent §7.2): keep FB-news ≤20% so the blog
// doesn't degrade into thin self-promotion.
export const MAX_FB_NEWS_WEIGHT = 20

// ── validation ────────────────────────────────────────────────────────

export interface TopicMixEntry {
  readonly category: string
  readonly weight: number
}

export interface PromptScheduleConfigInput {
  readonly postsPerWeek: number
  readonly mode: string
  readonly topicMix: readonly TopicMixEntry[]
  readonly promptTemplates: Readonly<Record<string, string>>
}

export interface PromptScheduleProblem {
  readonly field: string
  readonly message: string
}

/**
 * Validate a prompt-schedule config. Returns the list of problems; empty =
 * valid. Enforces:
 *   - cadence within [MIN,MAX] posts/week,
 *   - a known generation mode,
 *   - a non-empty topic mix of KNOWN, UNIQUE categories with integer
 *     weights in [0,100] that SUM to exactly 100,
 *   - the FB-news self-promotion cap,
 *   - prompt-template keys drawn only from the known set.
 */
export function validatePromptScheduleConfig(
  input: PromptScheduleConfigInput,
): PromptScheduleProblem[] {
  const problems: PromptScheduleProblem[] = []

  if (!Number.isInteger(input.postsPerWeek)) {
    problems.push({ field: 'postsPerWeek', message: 'Posts per week must be a whole number.' })
  } else if (
    input.postsPerWeek < MIN_POSTS_PER_WEEK ||
    input.postsPerWeek > MAX_POSTS_PER_WEEK
  ) {
    problems.push({
      field: 'postsPerWeek',
      message: `Posts per week must be between ${MIN_POSTS_PER_WEEK} and ${MAX_POSTS_PER_WEEK}.`,
    })
  }

  if (!isGenerationMode(input.mode)) {
    problems.push({
      field: 'mode',
      message: `Mode must be one of: ${GENERATION_MODES.join(', ')}.`,
    })
  }

  if (input.topicMix.length === 0) {
    problems.push({ field: 'topicMix', message: 'Topic mix must have at least one category.' })
  } else {
    const seen = new Set<string>()
    let total = 0
    for (const entry of input.topicMix) {
      if (!isTopicCategory(entry.category)) {
        problems.push({
          field: 'topicMix',
          message: `Unknown topic category '${entry.category}'.`,
        })
        continue
      }
      if (seen.has(entry.category)) {
        problems.push({
          field: 'topicMix',
          message: `Duplicate topic category '${entry.category}'.`,
        })
        continue
      }
      seen.add(entry.category)
      if (!Number.isInteger(entry.weight) || entry.weight < 0 || entry.weight > 100) {
        problems.push({
          field: 'topicMix',
          message: `Weight for '${entry.category}' must be a whole number between 0 and 100.`,
        })
        continue
      }
      total += entry.weight
      if (entry.category === 'fb_news' && entry.weight > MAX_FB_NEWS_WEIGHT) {
        problems.push({
          field: 'topicMix',
          message: `'fb_news' weight must be ≤ ${MAX_FB_NEWS_WEIGHT}% to avoid thin self-promotional content.`,
        })
      }
    }
    // Only assert the sum once the per-entry shape is otherwise clean, so the
    // operator sees the actionable per-field error first.
    if (problems.length === 0 && total !== 100) {
      problems.push({
        field: 'topicMix',
        message: `Topic-mix weights must sum to 100 (got ${total}).`,
      })
    }
  }

  for (const key of Object.keys(input.promptTemplates)) {
    if (!(PROMPT_TEMPLATE_KEYS as readonly string[]).includes(key)) {
      problems.push({
        field: 'promptTemplates',
        message: `Unknown prompt template '${key}'.`,
      })
    }
  }

  return problems
}
