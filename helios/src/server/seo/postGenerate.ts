// Bedrock-backed blog-post draft generator (P4). Produces a DRAFT PROPOSAL
// of a single "What's new" post (slug + title + meta + excerpt + tags +
// raw/sanitized body) from an operator-supplied topic. It NEVER approves or
// publishes anything — the output is saved as a `draft` (source='generated',
// approval_id=null) for a human to review, edit, and approve through the
// IRONCLAD gate (canon §1).
//
// Reuses the same private Bedrock-mantle gateway as the rest of Helios
// (faqGenerate.ts; canon §4 — private inference for our content).
//
// child FreshlyBakedNYC/automation#44 (P4) · Satisfies: virusdave/top-level#15

import { getServerEnv } from '../config/env.js'
import { findPostRawOnlyLeaks } from './postContent.js'
import { isValidSlug } from './routeRegistry.js'

// Same proven-working mantle model as the other Helios callers.
const POST_GEN_MODEL = 'google.gemma-3-27b-it'

// Optional grounding from an ingested source lead (seo_source_items). When
// present the model is told to write an ORIGINAL article INSPIRED by the
// source (summarize-with-attribution, never copy) with a unique local NYC
// angle — wiring the §7.1 source/topic intake into draft generation
// (parent EPIC_PLAN §7 steps 1 + 3). Omitting it preserves the original
// free-text-topic behavior.
export interface PostGenerateSource {
  readonly sourceKey: string
  readonly title: string
  readonly url?: string | null
  readonly summary?: string | null
}

export interface PostGenerateInput {
  readonly topic: string
  readonly source?: PostGenerateSource
}

export interface PostGenerateDraft {
  readonly slug: string
  readonly title: string
  readonly meta_description: string
  readonly excerpt: string
  readonly tags: string[]
  readonly body_raw: string
  readonly body_sanitized: string
}

export interface PostGenerateMeta {
  readonly model: string
  readonly topic: string
  readonly generatedAt: string
  // Fields whose value tripped the raw-only heuristic at generation time
  // (advisory only — the human still reviews + the approve path re-checks).
  readonly sanitizedLeakWarnings: ReadonlyArray<{ field: string; terms: string[] }>
}

export type PostGenerateResult =
  | { kind: 'ok'; draft: PostGenerateDraft; meta: PostGenerateMeta }
  | { kind: 'error'; message: string }

const SYSTEM_PROMPT = [
  'You write SEO blog posts ("What\'s new" articles) for a New York cannabis retailer that runs TWO public sites:',
  'a RAW site (FB.nyc) where cannabis terms are allowed, and a SANITIZED site (FB.us) where NO cannabis-specific terms may appear.',
  'Given a topic, produce a JSON object:',
  '{"slug": string, "title": string, "meta_description": string, "excerpt": string, "tags": [string], "body_raw": string, "body_sanitized": string}.',
  'Rules:',
  '- "slug" is lowercase kebab-case (a-z, 0-9, single hyphens), <= 60 chars, and must NOT contain cannabis-specific terms.',
  '- "title", "meta_description", "excerpt", and every "tags" entry are shown on BOTH sites, so they must NOT contain cannabis-specific terms (cannabis, marijuana, THC, CBD, weed, dispensary, edibles, vape, pre-roll, etc.).',
  '- "body_raw" may use cannabis terms freely and accurately.',
  '- "body_sanitized" must convey the same useful, truthful information WITHOUT any cannabis-specific terms — rephrase generically (e.g. "our products", "wellness items", "in-store").',
  '- The article must have a unique local NYC angle, be genuinely useful and accurate, 2-5 short paragraphs. No keyword stuffing, no medical or legal claims.',
  '- "meta_description" <= 160 chars; "excerpt" <= 300 chars; 2-5 "tags".',
  'Output ONLY the JSON object. No prose, no markdown fences.',
].join(' ')

/**
 * Build the user-message prompt. For a bare topic it is just the topic; for
 * a source-grounded request it additionally hands the model the source's
 * title / URL / summary and instructs an ORIGINAL, attributed rewrite (never
 * a copy). Exported for unit testing without a live gateway.
 */
export function buildPostGenerationUserPrompt(input: PostGenerateInput): string {
  const lines = [`topic: ${JSON.stringify(input.topic)}`]
  const source = input.source
  if (source) {
    lines.push(
      'Write an ORIGINAL article INSPIRED BY the source below — summarize and add a unique local NYC angle, do NOT copy its wording, and attribute it.',
      `source_title: ${JSON.stringify(source.title)}`,
    )
    if (source.url != null && source.url.length > 0) {
      lines.push(`source_url: ${JSON.stringify(source.url)}`)
    }
    if (source.summary != null && source.summary.length > 0) {
      lines.push(`source_summary: ${JSON.stringify(source.summary)}`)
    }
  }
  return lines.join('\n')
}

function looksLikeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractAssistantContent(payload: unknown): string {
  if (!looksLikeRecord(payload)) {
    throw new Error('LLM response was not an object')
  }
  const choices = payload.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('LLM response contained no choices')
  }
  const first = choices[0]
  if (!looksLikeRecord(first) || !looksLikeRecord(first.message)) {
    throw new Error('LLM response choice was missing message payload')
  }
  const content = first.message.content
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (looksLikeRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .join('')
  }
  throw new Error('LLM response choice content was neither string nor array')
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new Error(`blog draft was missing a non-empty string '${key}'`)
  }
  return v.trim()
}

/**
 * Parse the model's JSON into a validated PostGenerateDraft. Exported so it
 * can be unit-tested without a live gateway. Throws on a malformed shape.
 */
export function parsePostGenerationContent(jsonText: string): PostGenerateDraft {
  const parsed: unknown = JSON.parse(jsonText)
  if (!looksLikeRecord(parsed)) {
    throw new Error('blog generation JSON was not an object')
  }
  const slug = requireString(parsed, 'slug').toLowerCase()
  if (!isValidSlug(slug)) {
    throw new Error(`blog generation produced an invalid slug '${slug}' (expected kebab-case)`)
  }
  const tagsRaw = parsed.tags
  if (!Array.isArray(tagsRaw)) {
    throw new Error('blog generation JSON had no "tags" array')
  }
  const tags = tagsRaw
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter((t) => t.length > 0)
  return {
    slug,
    title: requireString(parsed, 'title'),
    meta_description: requireString(parsed, 'meta_description'),
    excerpt: requireString(parsed, 'excerpt'),
    tags,
    body_raw: requireString(parsed, 'body_raw'),
    body_sanitized: requireString(parsed, 'body_sanitized'),
  }
}

function sanitizedLeakWarnings(
  draft: PostGenerateDraft,
): Array<{ field: string; terms: string[] }> {
  const warnings: Array<{ field: string; terms: string[] }> = []
  const checks: Array<{ field: string; text: string }> = [
    { field: 'slug', text: draft.slug.replace(/-/g, ' ') },
    { field: 'title', text: draft.title },
    { field: 'meta_description', text: draft.meta_description },
    { field: 'excerpt', text: draft.excerpt },
    { field: 'tags', text: draft.tags.join(' ') },
    { field: 'body_sanitized', text: draft.body_sanitized },
  ]
  for (const { field, text } of checks) {
    const terms = findPostRawOnlyLeaks(text)
    if (terms.length > 0) {
      warnings.push({ field, terms })
    }
  }
  return warnings
}

/**
 * Generate a blog-post draft from a topic. Never throws — gateway/parse
 * failures map to { kind: 'error' }.
 */
export async function generatePostDraft(input: PostGenerateInput): Promise<PostGenerateResult> {
  const env = getServerEnv()
  if (!env.bedrockMantleBearerToken) {
    return { kind: 'error', message: 'BEDROCK_MANTLE_BEARER_TOKEN not configured' }
  }

  let response: Response
  try {
    response = await fetch(`${env.bedrockMantleBaseUrl}/chat/completions`, {
      body: JSON.stringify({
        max_tokens: 2500,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildPostGenerationUserPrompt(input) },
        ],
        model: POST_GEN_MODEL,
        response_format: { type: 'json_object' },
        temperature: 0.3,
        top_p: 0.9,
      }),
      headers: {
        Authorization: `Bearer ${env.bedrockMantleBearerToken}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(env.llmRequestTimeoutMs),
    })
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
  }

  const responseText = await response.text()
  if (!response.ok) {
    return {
      kind: 'error',
      message: `LLM gateway returned HTTP ${response.status}: ${responseText.slice(0, 200)}`,
    }
  }

  try {
    const rawJson: unknown = JSON.parse(responseText)
    const content = extractAssistantContent(rawJson)
    const draft = parsePostGenerationContent(content)
    return {
      kind: 'ok',
      draft,
      meta: {
        model: POST_GEN_MODEL,
        topic: input.topic,
        generatedAt: new Date().toISOString(),
        sanitizedLeakWarnings: sanitizedLeakWarnings(draft),
      },
    }
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}
