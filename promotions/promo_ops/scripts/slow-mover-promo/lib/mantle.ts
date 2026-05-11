/**
 * Bedrock Mantle (OpenAI-compatible) helper for the slow-mover packet.
 *
 * Use case (registry):
 *   `slow-mover-promo-group-ranking-and-rationale` (limited-trial)
 *
 * The LLM is responsible for ONLY:
 *   - re-ranking the deterministic candidate group list (`reorderGroups`)
 *   - producing one-sentence reviewer-facing rationale per group (`writeRationales`)
 *   - producing the executive summary header copy (`writeExecutiveSummary`)
 *
 * The LLM is NOT responsible for:
 *   - choosing a discount level or promo lever
 *   - deciding whether to ship a promo
 *   - writing HTML structure
 *   - inventing facts beyond the supplied numbers
 *
 * Every call returns deterministic JSON via `response_format: { type: 'json_object' }`.
 * If Mantle is unavailable, callers should fall back to the deterministic
 * ordering and an empty rationale set rather than block packet generation.
 */
import { readFileSync } from 'node:fs'

const DEFAULT_ENDPOINT = 'https://bedrock-mantle.us-east-2.api.aws/v1'
const DEFAULT_MODEL = 'google.gemma-3-27b-it'
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_TOKEN_PATHS = [
  '/Users/amp-local/.secret/bedrock/mantle-bearer-token',
  `${process.env.HOME ?? ''}/.secret/bedrock/mantle-bearer-token`,
]

export interface MantleConfig {
  endpoint: string
  model: string
  bearerToken: string
  timeoutMs: number
}

export function loadMantleConfig(): MantleConfig | null {
  const token =
    process.env.BEDROCK_MANTLE_BEARER_TOKEN?.trim() || readFirstReadableFile(DEFAULT_TOKEN_PATHS)
  if (!token) return null
  return {
    endpoint: process.env.BEDROCK_MANTLE_ENDPOINT?.trim() || DEFAULT_ENDPOINT,
    model: process.env.BEDROCK_MANTLE_MODEL?.trim() || DEFAULT_MODEL,
    bearerToken: token,
    timeoutMs: Number.parseInt(
      process.env.BEDROCK_MANTLE_TIMEOUT_MS ?? `${DEFAULT_TIMEOUT_MS}`,
      10,
    ),
  }
}

interface MantleChatRequest {
  model: string
  messages: Array<{ role: 'system' | 'user'; content: string }>
  max_tokens?: number
  temperature?: number
  response_format?: { type: 'json_object' }
}

interface MantleChatResponse {
  choices?: Array<{ message?: { content?: string } }>
}

async function callMantle(
  config: MantleConfig,
  messages: MantleChatRequest['messages'],
  options: { maxTokens?: number; temperature?: number; jsonObject?: boolean } = {},
): Promise<string> {
  const body: MantleChatRequest = {
    model: config.model,
    messages,
    max_tokens: options.maxTokens ?? 800,
    temperature: options.temperature ?? 0.2,
    ...(options.jsonObject ? { response_format: { type: 'json_object' } } : {}),
  }
  const response = await fetch(`${config.endpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.bearerToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Mantle ${response.status}: ${truncate(text)}`)
  }
  let payload: MantleChatResponse
  try {
    payload = JSON.parse(text) as MantleChatResponse
  } catch {
    throw new Error(`Mantle returned non-JSON: ${truncate(text)}`)
  }
  const content = payload.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error(`Mantle returned empty content: ${truncate(text)}`)
  }
  return content.trim()
}

function extractJsonObject(content: string): unknown {
  // Strict JSON first.
  try {
    return JSON.parse(content)
  } catch {
    // ignore
  }
  // Strip markdown code fences if any.
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) {
    try {
      return JSON.parse(fence[1])
    } catch {
      // ignore
    }
  }
  // Find first {...} block.
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(content.slice(start, end + 1))
    } catch {
      // ignore
    }
  }
  throw new Error('Could not parse JSON object from Mantle content')
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export interface GroupSummaryForLlm {
  slug: string
  label: string
  scope: 'category' | 'category-brand'
  category: string
  brand: string | null
  productCount: number
  onHandQty: number
  inventoryRetailValueUsd: number
  windowUnitsSold: number
  windowNetSalesUsd: number
  blendedGrossMarginPct: number | null
  daysOfSupply: number | null
  sellThroughPct: number | null
  daysSinceOldestReceived: number | null
  signalSummary: string[]
}

export interface LlmRanking {
  rankedSlugs: string[]
  rationaleBySlug: Record<string, string>
  executiveSummary: string
}

export async function llmRankAndRationalize(
  config: MantleConfig,
  windowDays: number,
  siteLabel: string,
  groups: GroupSummaryForLlm[],
): Promise<LlmRanking> {
  if (groups.length === 0) {
    return { rankedSlugs: [], rationaleBySlug: {}, executiveSummary: '' }
  }

  const system = [
    'You are a retail merchandising analyst at a New York cannabis dispensary chain.',
    'You help operators decide which CATEGORIES or CATEGORY x BRAND groups should',
    'get an aggressive promotional discount because their inventory is moving too',
    'slowly relative to its on-hand value.',
    '',
    'Hard rules:',
    '- Operate ONLY on the numeric facts the user provides. Do NOT invent units,',
    '  prices, brands, or categories that are not in the input.',
    '- Never recommend a single SKU; the proposal scope is always the category or',
    '  category x brand group given to you.',
    '- Do NOT propose a specific discount percentage or promo lever; that is the',
    '  reviewer\'s job.',
    '- Output strict JSON only.',
  ].join('\n')

  const user = [
    `Site: ${siteLabel}`,
    `Sales window: trailing ${windowDays} days`,
    '',
    'CANDIDATE GROUPS (already pre-filtered by deterministic rules; you are',
    'judging trade-offs across them, not deciding eligibility):',
    JSON.stringify(groups, null, 2),
    '',
    'TASK:',
    '1. Rank the groups from most-deserving to least-deserving of an aggressive',
    '   promo, weighing days-of-supply, sell-through, on-hand $ exposure, blended',
    '   gross margin (room to discount), and inventory age. Use judgment for',
    '   trade-offs the deterministic score may have missed (e.g., very old stock',
    '   with low on-hand $ may still be urgent if margin cushion is large).',
    '2. For each group, write a SINGLE-SENTENCE reviewer-facing rationale (max 28',
    '   words) that names the dominant signal driving the recommendation. The',
    '   sentence MUST cite at least one number from the input.',
    '3. Write a 2-3 sentence executive summary for the packet header that names',
    '   the top 1-2 categories at risk and the dollar exposure at stake.',
    '',
    'Return strict JSON with this exact shape:',
    '{',
    '  "ranked_slugs": ["slug-most-urgent", "..."],',
    '  "rationale_by_slug": { "slug": "single sentence rationale", "..." },',
    '  "executive_summary": "2-3 sentences."',
    '}',
  ].join('\n')

  const content = await callMantle(
    config,
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { maxTokens: 1500, temperature: 0.15, jsonObject: true },
  )
  const parsed = extractJsonObject(content) as {
    ranked_slugs?: unknown
    rationale_by_slug?: unknown
    executive_summary?: unknown
  }

  const rankedSlugs = Array.isArray(parsed.ranked_slugs)
    ? (parsed.ranked_slugs as unknown[])
        .filter((s): s is string => typeof s === 'string')
        .filter((slug) => groups.some((g) => g.slug === slug))
    : []
  const rationaleBySlug: Record<string, string> = {}
  if (parsed.rationale_by_slug && typeof parsed.rationale_by_slug === 'object') {
    for (const [slug, value] of Object.entries(parsed.rationale_by_slug as Record<string, unknown>)) {
      if (typeof value === 'string' && groups.some((g) => g.slug === slug)) {
        rationaleBySlug[slug] = value.trim()
      }
    }
  }
  const executiveSummary =
    typeof parsed.executive_summary === 'string' ? parsed.executive_summary.trim() : ''

  return { rankedSlugs, rationaleBySlug, executiveSummary }
}

function readFirstReadableFile(paths: string[]): string | null {
  for (const path of paths) {
    if (!path) continue
    try {
      const value = readFileSync(path, 'utf8').trim()
      if (value) return value
    } catch {
      continue
    }
  }
  return null
}

function truncate(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 239)}…`
}
