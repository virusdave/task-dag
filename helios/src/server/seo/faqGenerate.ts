// Bedrock-backed FAQ draft generator (P3). Produces a DRAFT PROPOSAL of
// raw + sanitized FAQ items from an operator-supplied topic. It NEVER
// approves or publishes anything — the output is saved as a `draft`
// (source='generated', approval_id=null) for a human to review, edit, and
// approve through the IRONCLAD gate (canon §1).
//
// Reuses the same private Bedrock-mantle gateway as the rest of Helios
// (reviewSentimentGate.ts; canon §4 — private inference for our content).
//
// child FreshlyBakedNYC/automation#44 (P3) · Satisfies: virusdave/top-level#15

import { getServerEnv } from '../config/env.js'
import { findRawOnlyLeaks, type FaqItemInput } from './faqContent.js'

// Same proven-working mantle model as the other Helios callers.
const FAQ_GEN_MODEL = 'google.gemma-3-27b-it'

export interface FaqGenerateInput {
  readonly topic: string
  readonly itemCount: number
}

export interface FaqGenerateMeta {
  readonly model: string
  readonly topic: string
  readonly itemCount: number
  readonly generatedAt: string
  // Items whose sanitized variant tripped the raw-only heuristic at
  // generation time (advisory only — the human still reviews + the approve
  // path re-checks and blocks).
  readonly sanitizedLeakWarnings: ReadonlyArray<{ itemIndex: number; terms: string[] }>
}

export type FaqGenerateResult =
  | { kind: 'ok'; items: FaqItemInput[]; meta: FaqGenerateMeta }
  | { kind: 'error'; message: string }

const SYSTEM_PROMPT = [
  'You write SEO FAQ content for a New York cannabis retailer that runs TWO public sites:',
  'a RAW site (FB.nyc) where cannabis terms are allowed, and a SANITIZED site (FB.us) where NO cannabis-specific terms may appear.',
  'Given a topic, produce a JSON object: {"items": [{"question": string, "answer_raw": string, "answer_sanitized": string}, ...]}.',
  'Rules:',
  '- The shared "question" is shown on BOTH sites, so it must NOT contain cannabis-specific terms (cannabis, marijuana, THC, CBD, weed, dispensary, edibles, vape, pre-roll, etc.).',
  '- "answer_raw" may use cannabis terms freely and accurately.',
  '- "answer_sanitized" must convey the same helpful, truthful information WITHOUT any cannabis-specific terms — rephrase generically (e.g. "our products", "wellness items", "in-store").',
  '- Every answer must be genuinely useful, accurate, and 1-3 sentences. No keyword stuffing, no medical or legal claims.',
  'Output ONLY the JSON object. No prose, no markdown fences.',
].join(' ')

function buildUserPrompt(input: FaqGenerateInput): string {
  return `topic: ${JSON.stringify(input.topic)}\nnumber_of_faq_items: ${input.itemCount}`
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

/**
 * Parse the model's JSON into validated FaqItemInput[]. Exported so it can
 * be unit-tested without a live gateway. Throws on a malformed shape.
 */
export function parseFaqGenerationContent(jsonText: string): FaqItemInput[] {
  const parsed: unknown = JSON.parse(jsonText)
  if (!looksLikeRecord(parsed) || !Array.isArray(parsed.items)) {
    throw new Error('FAQ generation JSON had no "items" array')
  }
  const items: FaqItemInput[] = []
  parsed.items.forEach((raw, index) => {
    if (!looksLikeRecord(raw)) {
      throw new Error(`FAQ item ${index + 1} was not an object`)
    }
    const question = raw.question
    const answerRaw = raw.answer_raw
    const answerSanitized = raw.answer_sanitized
    if (
      typeof question !== 'string' ||
      typeof answerRaw !== 'string' ||
      typeof answerSanitized !== 'string'
    ) {
      throw new Error(`FAQ item ${index + 1} was missing a string question/answer_raw/answer_sanitized`)
    }
    const q = question.trim()
    const ar = answerRaw.trim()
    const asn = answerSanitized.trim()
    if (q.length === 0 || ar.length === 0 || asn.length === 0) {
      throw new Error(`FAQ item ${index + 1} had an empty question or answer`)
    }
    items.push({ question: q, answer_raw: ar, answer_sanitized: asn })
  })
  if (items.length === 0) {
    throw new Error('FAQ generation produced no items')
  }
  return items
}

function sanitizedLeakWarnings(
  items: readonly FaqItemInput[],
): Array<{ itemIndex: number; terms: string[] }> {
  const warnings: Array<{ itemIndex: number; terms: string[] }> = []
  items.forEach((item, itemIndex) => {
    const terms = [
      ...new Set([...findRawOnlyLeaks(item.answer_sanitized), ...findRawOnlyLeaks(item.question)]),
    ]
    if (terms.length > 0) {
      warnings.push({ itemIndex, terms })
    }
  })
  return warnings
}

export interface FaqGatewayRequest {
  readonly systemPrompt: string
  readonly userPrompt: string
  /** Defaults to the shared mantle model. */
  readonly model?: string
  /** Defaults to 1500. */
  readonly maxTokens?: number
}

export type FaqGatewayResult =
  | { kind: 'ok'; items: FaqItemInput[]; model: string }
  | { kind: 'error'; message: string }

/**
 * Low-level Bedrock-mantle call shared by every FAQ generator (topic-based
 * here, family-contextual in faqFamilyGenerate.ts): POST a system+user
 * prompt to the gateway, extract the assistant content, and parse it into
 * validated FaqItemInput[]. Never throws — gateway/parse failures map to
 * { kind: 'error' }. Keeping ONE gateway path means timeout/auth/JSON-shape
 * handling can't drift between callers.
 */
export async function requestFaqItems(request: FaqGatewayRequest): Promise<FaqGatewayResult> {
  const env = getServerEnv()
  if (!env.bedrockMantleBearerToken) {
    return { kind: 'error', message: 'BEDROCK_MANTLE_BEARER_TOKEN not configured' }
  }
  const model = request.model ?? FAQ_GEN_MODEL

  let response: Response
  try {
    response = await fetch(`${env.bedrockMantleBaseUrl}/chat/completions`, {
      body: JSON.stringify({
        max_tokens: request.maxTokens ?? 1500,
        messages: [
          { role: 'system', content: request.systemPrompt },
          { role: 'user', content: request.userPrompt },
        ],
        model,
        response_format: { type: 'json_object' },
        temperature: 0.2,
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

  try {
    const responseText = await response.text()
    if (!response.ok) {
      return {
        kind: 'error',
        message: `LLM gateway returned HTTP ${response.status}: ${responseText.slice(0, 200)}`,
      }
    }
    const rawJson: unknown = JSON.parse(responseText)
    const content = extractAssistantContent(rawJson)
    const items = parseFaqGenerationContent(content)
    return { kind: 'ok', items, model }
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Generate a FAQ draft from a topic. Never throws — gateway/parse failures
 * map to { kind: 'error' }.
 */
export async function generateFaqDraft(input: FaqGenerateInput): Promise<FaqGenerateResult> {
  const result = await requestFaqItems({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(input),
  })
  if (result.kind === 'error') {
    return result
  }
  return {
    kind: 'ok',
    items: result.items,
    meta: {
      model: result.model,
      topic: input.topic,
      itemCount: result.items.length,
      generatedAt: new Date().toISOString(),
      sanitizedLeakWarnings: sanitizedLeakWarnings(result.items),
    },
  }
}
