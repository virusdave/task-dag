import { z } from 'zod'

import type { JsonValue } from '../../shared/contracts/common/json.js'
import type { NormalizedCatalogGroupLiveState } from '../catalog/liveState.js'
import { normalizeDescriptionText } from '../catalog/liveState.js'
import { getWorkerEnv } from '../config/env.js'
import { RetryableWorkerError } from '../runtime/errors.js'

const MAX_DESCRIPTION_ATTEMPTS = 3
const REQUIRED_PHRASES_ALWAYS = ['Freshly Baked NYC', 'weed shop'] as const
const REQUIRED_PHRASE_DELIVERY = 'fast delivery'
const OPTIONAL_PHRASE_LICENSED = 'licensed cannabis dispensary'
const DELIVERY_EXEMPT_CATEGORY_NAMES = new Set(['Accessories', 'Merchandise'])

const PROHIBITED_DESCRIPTION_PATTERNS = [
  /\b(?:draft|proposal|packet|reconstruct(?:ion|ed)?|internal review|review note|working copy)\b/i,
  /\b(?:treats?|cures?|heals?|therapy|therapeutic|medicinal|medical benefit|pain relief|anxiety relief|helps with)\b/i,
  /\btargeted relief\b/i,
  /\btherapeutic potential\b/i,
  /\bwell-being\b/i,
]
const FORMULAIC_OPENERS = ['Experience', 'Discover', 'Explore', 'Elevate', 'Indulge'] as const
const FORMULAIC_DESCRIPTION_PATTERNS = [/\bshop with confidence\b/i, /\bfind your next favorite\b/i, /\border today\b/i]
const META_DESCRIPTION_PATTERNS = [
  /\b(?:lit alerts|matched lit alerts|matched listings?|external listings?|competitor listings?|statewide listings?)\b/i,
  /\b(?:multiple\s+)?listings?\s+(?:confirm|confirmed|indicate|indicates|show|shows|suggest|suggests)\b/i,
  /\b(?:data|evidence)\s+(?:confirm|confirms|indicate|indicates|show|shows|suggest|suggests)\b/i,
  /\b(?:confirmed|supported|verified)\s+by\s+(?:matched\s+)?(?:lit alerts|listings?|data|evidence)\b/i,
  /\b(?:weight|availability|parentage)\s+confirmation\b/i,
  /\bcompetitor\b/i,
  /\bmarket\b/i,
  /\b(?:cannabis|accessories|edible|edibles|flower|pre-rolls?|vapes?|concentrates?)\s+market\b/i,
  /\bin\s+the\s+market\b/i,
  /\bproduct\s+line\b/i,
  /\b(?:evidence packet|candidateindex|candidate index|search terms?|prompt|system prompt|paragraph\s+[123])\b/i,
]
const BENEFIT_CLAIM_PATTERNS = [
  /\bhelp(?:ing|s|ed)?\s+you\b/i,
  /\bsupport(?:ing|s|ed)?\s+(?:your|a|better|feelings?|creativity|focus|clarity|sleep|wellness|relaxation)\b/i,
  /\bmental\s+clarity\b/i,
  /\bunwind\b/i,
  /\bstress\b/i,
  /\btension\b/i,
  /\bsleep\s+aid\b/i,
  /\bsleep\s+quality\b/i,
  /\bwellness\b/i,
  /\bwell-being\b/i,
  /\blift\s+your\s+spirits\b/i,
  /\bpower\s+your\s+day\b/i,
  /\btackle\s+tasks\b/i,
  /\bproductive\s+activities\b/i,
]
const GENERIC_PRAISE_PATTERNS = [
  /\bpremium(?: quality)?\b/i,
  /\bexceptional\b/i,
  /\btop-shelf\b/i,
  /\bstandout offering\b/i,
  /\bexpertly crafted cannabis\b/i,
]
const EARLY_STORE_LANGUAGE_PATTERNS = [
  /\bfreshly baked nyc\b/i,
  /\bweed shop\b/i,
  /\blicensed cannabis dispensary\b/i,
  /\bfast delivery\b/i,
  /\bdispensary\b/i,
  /\bdelivery\b/i,
  /\bnyc\b/i,
  /\bnew york\b/i,
]

const StoredListingSchema = z.object({
  brand: z.string().default(''),
  category: z.string().default(''),
  dispensaryName: z.string().default(''),
  imageUrl: z.string().default(''),
  name: z.string().default(''),
  price: z.coerce.number().nullable().optional(),
  subcategory: z.string().default(''),
  url: z.string().default(''),
  weight: z.string().default(''),
}).passthrough()

const PreviousEvidenceSchema = z.object({
  attemptCount: z.coerce.number().int().positive().nullable().optional(),
  litalertsCandidateListings: z.array(StoredListingSchema).default([]),
  litalertsMatchedListings: z.array(StoredListingSchema).default([]),
  litalertsSearchTerms: z.array(z.string()).default([]),
  litalertsSelectedListingIndexes: z.array(z.coerce.number().int()).default([]),
  litalertsSourceNote: z.string().nullable().optional(),
  omittedRequiredPhrases: z.array(z.string()).default([]),
  originalDescription: z.string().nullable().optional(),
  requiredPhrasePresence: z.record(z.string(), z.boolean()).default({}),
}).passthrough()

const MerchandisingContextSchema = z.object({
  confidence: z.string().nullable().optional(),
  currentDescription: z.string().nullable().optional(),
  seoKeywords: z.array(z.string()).default([]),
}).passthrough()

type StoredListing = z.infer<typeof StoredListingSchema>
type PreviousEvidence = z.infer<typeof PreviousEvidenceSchema>
type MerchandisingContext = z.infer<typeof MerchandisingContextSchema>

interface PreviousProposalContext {
  evidence: PreviousEvidence
  merchandisingContext: MerchandisingContext
  proposalRowId: number | null
}

interface DescriptionEvidencePacket {
  brand: string
  category: string
  delivery_phrase_required: boolean
  effects: string[]
  existing_description_cleaned: string
  existing_description_removed_meta_examples: string[]
  existing_description_removed_meta_line_count: number
  flavorings: string[]
  group_full_name: string
  group_id: number
  group_name: string
  image_urls: string[]
  litalerts_candidate_listings: Array<StoredListing & { candidateIndex: number }>
  litalerts_search_terms: string[]
  litalerts_source_note: string | null
  product_tabs: string[]
  scents: string[]
  strain: string
  subcategory: string
  tags: string[]
}

interface ChatMessage {
  content: string
  role: 'assistant' | 'system' | 'user'
}

interface StageLog {
  assistantContent: string
  maxTokens: number
  messages: ChatMessage[]
  parsedJson: JsonValue
  repairAttemptCount: number
  stage: 'layout' | 'metadata' | 'paragraph_1' | 'paragraph_2' | 'paragraph_3'
  temperature: number
}

interface GenerationAttemptLog {
  attempt: number
  repairIssues: string[]
  stages: StageLog[]
  validationIssues: string[]
}

interface NormalizedProposalPayload {
  confidence: string
  description: string
  matchedLitalertsListingIndexes: number[] | null
  omittedRequiredPhrases: string[]
  seoKeywords: string[]
}

export interface DescriptionDebugRerunInput {
  forceLiveRefresh: boolean
  liveState: NormalizedCatalogGroupLiveState
  llmRunId: number
  model: string
  previousProposalContext: PreviousProposalContext | null
  promptVersion: string
  purpose: 'debug' | 'description'
}

export interface DescriptionDebugRerunResult {
  inputJson: JsonValue
  parsedOutputJson: JsonValue
  rawOutputText: string
  status: 'invalid' | 'succeeded'
  validationIssues: string[]
}

export async function runDescriptionDebugRerun(
  input: DescriptionDebugRerunInput,
): Promise<DescriptionDebugRerunResult> {
  const evidencePacket = buildEvidencePacket(input.liveState, input.previousProposalContext)
  const attempts: GenerationAttemptLog[] = []

  let repairIssues: string[] = []
  let normalizedProposal: NormalizedProposalPayload | null = null
  let validationIssues: string[] = []

  for (let attempt = 1; attempt <= MAX_DESCRIPTION_ATTEMPTS; attempt += 1) {
    const generation = await buildMultipassDescription({
      evidencePacket,
      model: input.model,
      promptVersion: input.promptVersion,
      repairIssues,
    })

    const nextValidationIssues = validateGeneratedDescription(generation.proposal.description, evidencePacket)
    attempts.push({
      attempt,
      repairIssues,
      stages: generation.stageLogs,
      validationIssues: nextValidationIssues,
    })

    normalizedProposal = generation.proposal
    validationIssues = nextValidationIssues
    if (nextValidationIssues.length === 0) {
      break
    }

    repairIssues = nextValidationIssues
  }

  if (!normalizedProposal) {
    throw new Error('Description rerun produced no proposal payload.')
  }

  const candidateListings = evidencePacket.litalerts_candidate_listings
  const selectedListingIndexes = normalizedProposal.matchedLitalertsListingIndexes ?? []
  const selectedListings = selectListings(candidateListings, selectedListingIndexes)
  const description = normalizedProposal.description

  const parsedOutputJson = toJsonValue({
    attemptCount: attempts.length,
    confidence: normalizedProposal.confidence,
    currentDescription: input.liveState.currentDescription,
    matchedLitalertsListingIndexes: normalizedProposal.matchedLitalertsListingIndexes,
    matchedLitalertsListings: selectedListings,
    omittedRequiredPhrases: normalizedProposal.omittedRequiredPhrases,
    proposedDescription: description,
    purpose: input.purpose,
    requiredPhrasePresence: buildRequiredPhrasePresence(description),
    selectedLitalertsListingsCount: selectedListings.length,
    seoKeywords: normalizedProposal.seoKeywords,
    validationIssues,
  })

  const inputJson = toJsonValue({
    evidencePacket,
    forceLiveRefresh: input.forceLiveRefresh,
    liveState: input.liveState,
    llmRunId: input.llmRunId,
    model: input.model,
    previousProposalContext: input.previousProposalContext
      ? {
          attemptCount: input.previousProposalContext.evidence.attemptCount ?? null,
          confidence: input.previousProposalContext.merchandisingContext.confidence ?? null,
          omittedRequiredPhrases: input.previousProposalContext.evidence.omittedRequiredPhrases,
          previousCurrentDescription: input.previousProposalContext.merchandisingContext.currentDescription ?? null,
          proposalRowId: input.previousProposalContext.proposalRowId,
          searchTerms: input.previousProposalContext.evidence.litalertsSearchTerms,
          selectedListingIndexes: input.previousProposalContext.evidence.litalertsSelectedListingIndexes,
          seoKeywords: input.previousProposalContext.merchandisingContext.seoKeywords,
          sourceNote: input.previousProposalContext.evidence.litalertsSourceNote ?? null,
        }
      : null,
    promptVersion: input.promptVersion,
    purpose: input.purpose,
  })

  const rawOutputText = JSON.stringify(
    {
      attempts,
      finalValidationIssues: validationIssues,
      normalizedProposal,
    },
    null,
    2,
  )

  return {
    inputJson,
    parsedOutputJson,
    rawOutputText,
    status: validationIssues.length > 0 ? 'invalid' : 'succeeded',
    validationIssues,
  }
}

function buildEvidencePacket(
  liveState: NormalizedCatalogGroupLiveState,
  previousProposalContext: PreviousProposalContext | null,
): DescriptionEvidencePacket {
  const cleanedDescription = cleanExistingDescription(liveState.currentDescription)
  const storedEvidence = previousProposalContext?.evidence ?? PreviousEvidenceSchema.parse({})
  const candidateListings = storedEvidence.litalertsCandidateListings.length > 0
    ? storedEvidence.litalertsCandidateListings
    : storedEvidence.litalertsMatchedListings

  return {
    brand: liveState.brand ?? '',
    category: liveState.category ?? '',
    delivery_phrase_required: isDeliveryPhraseRequired(liveState.category),
    effects: [...liveState.effects],
    existing_description_cleaned: cleanedDescription.cleaned,
    existing_description_removed_meta_examples: cleanedDescription.removedLines,
    existing_description_removed_meta_line_count: cleanedDescription.removedLineCount,
    flavorings: [...liveState.flavorings],
    group_full_name: liveState.groupFullName,
    group_id: liveState.groupId,
    group_name: liveState.groupName,
    image_urls: liveState.imageUrl ? [liveState.imageUrl] : [],
    litalerts_candidate_listings: candidateListings.map((listing, index) => ({ ...listing, candidateIndex: index + 1 })),
    litalerts_search_terms: [...storedEvidence.litalertsSearchTerms],
    litalerts_source_note: storedEvidence.litalertsSourceNote ?? null,
    product_tabs: [...liveState.productTabs],
    scents: [...liveState.scents],
    strain: liveState.strain ?? '',
    subcategory: liveState.subcategory ?? '',
    tags: [...liveState.tags],
  }
}

function cleanExistingDescription(text: string | null | undefined): {
  cleaned: string
  removedLineCount: number
  removedLines: string[]
} {
  const removedLines: string[] = []
  const keptLines: string[] = []

  for (const rawLine of decodeHtmlEntities(text ?? '').replace(/\r/g, '').split('\n')) {
    const normalized = normalizeSpace(stripHtmlTags(rawLine))
    if (!normalized) {
      continue
    }

    if (/\b(?:draft|proposal|packet|reconstruct(?:ion|ed)?|internal review|review note|working copy)\b/i.test(normalized)) {
      removedLines.push(normalized)
      continue
    }

    keptLines.push(normalized)
  }

  return {
    cleaned: keptLines.join('\n\n').trim(),
    removedLineCount: removedLines.length,
    removedLines: removedLines.slice(0, 10),
  }
}

function isDeliveryPhraseRequired(categoryName: string | null): boolean {
  return !DELIVERY_EXEMPT_CATEGORY_NAMES.has((categoryName ?? '').trim())
}

function buildCopywritingEvidencePacket(evidencePacket: DescriptionEvidencePacket): JsonValue {
  const {
    existing_description_removed_meta_examples: _removedExamples,
    existing_description_removed_meta_line_count: _removedCount,
    litalerts_candidate_listings: _candidateListings,
    litalerts_search_terms: _searchTerms,
    litalerts_source_note: _sourceNote,
    ...copywritingEvidence
  } = evidencePacket

  return copywritingEvidence
}

function llmRetryGuidance(repairIssues: string[]): string {
  if (repairIssues.length === 0) {
    return ''
  }

  return [
    '',
    'Retry priorities:',
    `- Fix these issues from the previous attempt: ${repairIssues.join('; ')}.`,
    '- Keep the copy in exactly three paragraphs separated by blank lines.',
    '- Keep the first two paragraphs product-first and move all store language to the final paragraph.',
  ].join('\n')
}

function paragraphWriterSystemPrompt(): string {
  return (
    'You write one paragraph of cannabis retail copy at a time. Return only valid JSON. ' +
    'Use only supported facts from the evidence packet. If a detail is not supported, omit it. ' +
    'Never use em dashes. Never mention drafts, packets, internal review, or the evidence packet. ' +
    'Never mention listings, evidence, data, research, search terms, candidate indexes, competitors, market presence, or that any fact was confirmed or supported by an outside source. ' +
    'Do not describe anything as part of a product line, product family, collection, or broader market. ' +
    'Do not describe what the product helps with or supports for the shopper. Avoid phrases such as mental clarity, unwind, stress, tension, sleep aid, better sleep, wellness, productivity, or similar user-outcome language. ' +
    'Never make medical, therapeutic, wellness, symptom-relief, or body-benefit claims. ' +
    'Do not use generic praise words such as premium, exceptional, top-shelf, standout, expertly crafted, or best-in-class unless the evidence explicitly requires them. ' +
    'Never invent effects, flavors, aromas, terpenes, lineage, cultivation details, or potency details that are not explicitly supported. ' +
    'Treat a strain name by itself as insufficient evidence for aroma, flavor, effect, terpene, or lineage claims.'
  )
}

function paragraphLayoutSystemPrompt(): string {
  return (
    'You are planning paragraph structure for cannabis retail product copy. Return only valid JSON. ' +
    'Use only supported facts from the evidence packet. If a detail is not supported there, do not mention it. ' +
    'Plan for three paragraphs. The first two paragraphs must stay product-first. The final paragraph may introduce store and SEO language. ' +
    'Do not plan any references to listings, evidence, data, research, outside confirmation, competitors, market presence, or prompt instructions. ' +
    'Do not plan any product line, product family, collection, or broader market language. ' +
    'Do not plan any shopper-outcome language such as mental clarity, unwind, stress relief, better sleep, wellness, productivity, or similar benefit framing. ' +
    'Never make medical, wellness, symptom-relief, or body-benefit claims. Treat a strain name by itself as insufficient evidence for aroma, flavor, effect, terpene, or lineage claims.'
  )
}

function metadataSystemPrompt(): string {
  return (
    'You return metadata for an already-written cannabis retail product description. Return only valid JSON. ' +
    'Use only supported facts from the evidence packet and the supplied description. ' +
    'Do not rewrite the description. Do not invent unsupported attributes or competitor claims.'
  )
}

async function buildMultipassDescription(input: {
  evidencePacket: DescriptionEvidencePacket
  model: string
  promptVersion: string
  repairIssues: string[]
}): Promise<{ proposal: NormalizedProposalPayload; stageLogs: StageLog[] }> {
  const retryGuidance = llmRetryGuidance(input.repairIssues)
  const evidenceJson = JSON.stringify(buildCopywritingEvidencePacket(input.evidencePacket), null, 2)

  const layoutMessages: ChatMessage[] = [
    { role: 'system', content: paragraphLayoutSystemPrompt() },
    {
      role: 'user',
      content: `Plan where this product description should split into paragraphs.

Rules:
1. Return JSON with exactly these keys:
   - overall_angle
   - paragraph_1_focus
   - paragraph_1_must_include
   - paragraph_1_must_avoid
   - paragraph_2_focus
   - paragraph_2_must_include
   - paragraph_2_must_avoid
   - paragraph_3_focus
   - paragraph_3_must_include
   - paragraph_3_must_avoid
   - split_rationale
2. Each *_must_include and *_must_avoid field must be a short JSON array of strings.
3. Paragraph 1 should explain what the SKU is and why it is distinct.
4. Paragraph 2 should deepen the product detail with supported specifics.
5. Paragraph 3 should handle shopping context and SEO for Freshly Baked NYC.
6. Paragraphs 1 and 2 must not mention Freshly Baked NYC, weed shop, dispensary, delivery, or local shopping language.
7. Paragraph 3 should include Freshly Baked NYC and weed shop, should include fast delivery when delivery_phrase_required is true, and may include licensed cannabis dispensary when it fits naturally.
8. Avoid generic praise or filler in every paragraph.
9. The finished description should target 210 to 320 words across exactly 3 paragraphs with blank lines between them.${retryGuidance}
10. Never mention listings, evidence, data, research, outside confirmation, competitors, the market, or prompt instructions.
11. Convert supported facts into direct product copy, or omit them.

Evidence packet:
${evidenceJson}`,
    },
  ]
  const layout = await runJsonStage({
    maxTokens: 520,
    messages: layoutMessages,
    model: input.model,
    stage: 'layout',
    temperature: input.repairIssues.length > 0 ? 0.05 : 0.15,
  })

  const layoutJson = JSON.stringify(layout.parsed, null, 2)

  const paragraph1 = await runJsonStage({
    maxTokens: 350,
    messages: [
      { role: 'system', content: paragraphWriterSystemPrompt() },
      {
        role: 'user',
        content: `Write paragraph 1 only.

Rules:
1. Return JSON with exactly one key: paragraph.
2. Write 55 to 85 words.
3. Identify the actual SKU in a human-useful way: brand, product family, format, weight or pack, and the most important product distinction.
4. Do not mention Freshly Baked NYC, weed shop, dispensary, delivery, NYC shopping, or local service areas.
5. Do not start with Experience, Discover, Explore, Elevate, or Indulge.
6. Keep the paragraph product-first and concrete.
7. Follow the paragraph plan when provided.
8. Do not use generic praise words such as premium, exceptional, top-shelf, standout, or expertly crafted.${retryGuidance}
9. Never mention listings, evidence, data, research, outside confirmation, competitors, the market, or prompt instructions.

Paragraph plan:
${layoutJson}

Evidence packet:
${evidenceJson}`,
      },
    ],
    model: input.model,
    stage: 'paragraph_1',
    temperature: input.repairIssues.length > 0 ? 0.18 : 0.35,
  })
  const paragraph1Text = normalizeParagraph(readStringField(paragraph1.parsed, 'paragraph'))

  const paragraph2 = await runJsonStage({
    maxTokens: 420,
    messages: [
      { role: 'system', content: paragraphWriterSystemPrompt() },
      {
        role: 'user',
        content: `Write paragraph 2 only.

Rules:
1. Return JSON with exactly one key: paragraph.
2. Write 70 to 110 words.
3. Build on paragraph 1 without repeating it.
4. Focus on grounded product specifics such as process, source, strain, pack structure, supported flavor or aroma details, and any supported production detail.
5. Do not mention Freshly Baked NYC, weed shop, dispensary, delivery, NYC shopping, or local service areas.
6. Avoid generic praise and filler.
7. Follow the paragraph plan when provided.
8. Do not use generic praise words such as premium, exceptional, top-shelf, standout, or expertly crafted.${retryGuidance}
9. Never mention listings, evidence, data, research, outside confirmation, competitors, the market, or prompt instructions.

Paragraph 1:
${paragraph1Text}

Paragraph plan:
${layoutJson}

Evidence packet:
${evidenceJson}`,
      },
    ],
    model: input.model,
    stage: 'paragraph_2',
    temperature: input.repairIssues.length > 0 ? 0.15 : 0.3,
  })
  const paragraph2Text = normalizeParagraph(readStringField(paragraph2.parsed, 'paragraph'))

  const paragraph3 = await runJsonStage({
    maxTokens: 320,
    messages: [
      { role: 'system', content: paragraphWriterSystemPrompt() },
      {
        role: 'user',
        content: `Write paragraph 3 only.

Rules:
1. Return JSON with exactly one key: paragraph.
2. Write 55 to 90 words.
3. This is the only paragraph that may mention the store or shopping context.
4. Include the exact phrases "Freshly Baked NYC" and "weed shop" naturally.
5. If delivery_phrase_required is true, include the exact phrase "fast delivery" naturally unless it would be clearly awkward.
6. Include the exact phrase "licensed cannabis dispensary" when it fits naturally.
7. Keep this paragraph local-search aware, but avoid generic filler like top-shelf, exceptional, premium quality, or find your next favorite.
8. Follow the paragraph plan when provided.
9. Do not use generic praise words such as premium, exceptional, top-shelf, standout, or expertly crafted.${retryGuidance}
10. Never mention listings, evidence, data, research, outside confirmation, competitors, the market, or prompt instructions.

Paragraph 1:
${paragraph1Text}

Paragraph 2:
${paragraph2Text}

Paragraph plan:
${layoutJson}

Evidence packet:
${evidenceJson}`,
      },
    ],
    model: input.model,
    stage: 'paragraph_3',
    temperature: input.repairIssues.length > 0 ? 0.1 : 0.25,
  })
  const paragraph3Text = normalizeParagraph(readStringField(paragraph3.parsed, 'paragraph'))
  const description = normalizeGeneratedDescription([paragraph1Text, paragraph2Text, paragraph3Text].join('\n\n'))

  const metadata = await runJsonStage({
    maxTokens: 420,
    messages: [
      { role: 'system', content: metadataSystemPrompt() },
      {
        role: 'user',
        content: `Return metadata for this already-written catalog description.

Rules:
1. Return JSON with exactly these keys: confidence, seo_keywords, omitted_required_phrases, matched_litalerts_listing_indexes.
2. Do not rewrite the description.
3. confidence must be one of high, medium, or low.
4. seo_keywords must be evidence-grounded.
5. omitted_required_phrases must list only exact required phrases intentionally omitted.
6. matched_litalerts_listing_indexes must include only clearly matching candidateIndex values.${retryGuidance}

Description:
${description}

Evidence packet:
${evidenceJson}`,
      },
    ],
    model: input.model,
    stage: 'metadata',
    temperature: 0,
  })

  return {
    proposal: normalizeProposalPayload({ ...metadata.parsed, description }, input.promptVersion),
    stageLogs: [layout.log, paragraph1.log, paragraph2.log, paragraph3.log, metadata.log],
  }
}

async function runJsonStage(input: {
  maxTokens: number
  messages: ChatMessage[]
  model: string
  stage: StageLog['stage']
  temperature: number
}): Promise<{ log: StageLog; parsed: Record<string, unknown> }> {
  let repairMessages = [...input.messages]
  let repairAttemptCount = 0
  let finalAssistantContent = ''
  let parsedJson: Record<string, unknown> | null = null

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await requestMantleJson({
      maxTokens: input.maxTokens + attempt * 200,
      messages: repairMessages,
      model: input.model,
      temperature: attempt === 0 ? input.temperature : 0,
    })
    finalAssistantContent = response.assistantContent
    try {
      parsedJson = parseJsonObject(response.assistantContent)
      break
    } catch (error) {
      if (attempt === 2) {
        const message = error instanceof Error ? error.message : 'Model returned invalid JSON.'
        throw new Error(`${input.stage} response could not be parsed as JSON: ${message}`)
      }

      repairAttemptCount += 1
      repairMessages = [
        ...input.messages,
        { role: 'assistant', content: response.assistantContent },
        {
          role: 'user',
          content: 'Return the same answer as valid JSON only. Do not add commentary, markdown fences, or partial strings.',
        },
      ]
    }
  }

  if (!parsedJson) {
    throw new Error(`${input.stage} returned no parsed JSON payload.`)
  }

  return {
    log: {
      assistantContent: finalAssistantContent,
      maxTokens: input.maxTokens,
      messages: repairMessages,
      parsedJson: parsedJson as JsonValue,
      repairAttemptCount,
      stage: input.stage,
      temperature: input.temperature,
    },
    parsed: parsedJson,
  }
}

async function requestMantleJson(input: {
  maxTokens: number
  messages: ChatMessage[]
  model: string
  temperature: number
}): Promise<{ assistantContent: string }> {
  const env = getWorkerEnv()
  if (!env.bedrockMantleBearerToken) {
    throw new Error('BEDROCK_MANTLE_BEARER_TOKEN is required for description reruns.')
  }

  let response: Response
  try {
    response = await fetch(`${env.bedrockMantleBaseUrl}/chat/completions`, {
      body: JSON.stringify({
        max_tokens: input.maxTokens,
        messages: input.messages,
        model: input.model,
        response_format: { type: 'json_object' },
        temperature: input.temperature,
        top_p: 0.2,
      }),
      headers: {
        Authorization: `Bearer ${env.bedrockMantleBearerToken}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(env.llmRequestTimeoutMs),
    })
  } catch (error) {
    throw new RetryableWorkerError(buildTransportErrorMessage(error))
  }

  const responseText = await response.text()
  if (!response.ok) {
    const message = `LLM request returned HTTP ${response.status}: ${truncate(responseText)}`
    if (isRetryableStatusCode(response.status)) {
      throw new RetryableWorkerError(message)
    }

    throw new Error(message)
  }

  let parsedResponse: unknown
  try {
    parsedResponse = JSON.parse(responseText)
  } catch {
    throw new RetryableWorkerError(`LLM request returned invalid JSON: ${truncate(responseText)}`)
  }

  const assistantContent = extractAssistantContent(parsedResponse)
  return { assistantContent }
}

function extractAssistantContent(payload: unknown): string {
  if (!isRecord(payload)) {
    throw new Error('LLM response payload was not an object.')
  }

  const choices = payload.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('LLM response contained no choices.')
  }

  const firstChoice = choices[0]
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw new Error('LLM response contained no message payload.')
  }

  const content = firstChoice.message.content
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    const joined = content
      .map((item) => {
        if (isRecord(item) && typeof item.text === 'string') {
          return item.text
        }

        return ''
      })
      .join('')
      .trim()
    if (joined) {
      return joined
    }
  }

  throw new Error('LLM response did not include assistant text content.')
}

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const parsed = JSON.parse(trimmed) as unknown
  if (!isRecord(parsed)) {
    throw new Error('Parsed value was not a JSON object.')
  }

  return parsed
}

function normalizeProposalPayload(parsed: Record<string, unknown>, promptVersion: string): NormalizedProposalPayload {
  void promptVersion
  return {
    confidence: normalizeConfidence(parsed.confidence),
    description: normalizeGeneratedDescription(typeof parsed.description === 'string' ? parsed.description : ''),
    matchedLitalertsListingIndexes: normalizeIntList(parsed.matched_litalerts_listing_indexes),
    omittedRequiredPhrases: normalizeStringList(parsed.omitted_required_phrases),
    seoKeywords: normalizeStringList(parsed.seo_keywords),
  }
}

function validateGeneratedDescription(description: string, evidencePacket: DescriptionEvidencePacket): string[] {
  const issues: string[] = []
  const cleaned = description.trim()
  const paragraphs = splitParagraphs(cleaned)

  if (cleaned.includes('—')) {
    issues.push('contains em dash')
  }

  for (const pattern of PROHIBITED_DESCRIPTION_PATTERNS) {
    if (pattern.test(cleaned)) {
      issues.push(`matched prohibited pattern: ${pattern.source}`)
    }
  }
  for (const pattern of FORMULAIC_DESCRIPTION_PATTERNS) {
    if (pattern.test(cleaned)) {
      issues.push(`matched formulaic pattern: ${pattern.source}`)
    }
  }
  for (const pattern of META_DESCRIPTION_PATTERNS) {
    if (pattern.test(cleaned)) {
      issues.push(`matched meta pattern: ${pattern.source}`)
    }
  }
  for (const pattern of BENEFIT_CLAIM_PATTERNS) {
    if (pattern.test(cleaned)) {
      issues.push(`matched benefit claim pattern: ${pattern.source}`)
    }
  }
  for (const pattern of GENERIC_PRAISE_PATTERNS) {
    if (pattern.test(cleaned)) {
      issues.push(`matched generic praise pattern: ${pattern.source}`)
    }
  }
  if (FORMULAIC_OPENERS.some((opener) => cleaned.startsWith(`${opener} `))) {
    issues.push('starts with formulaic opener')
  }
  for (const phrase of REQUIRED_PHRASES_ALWAYS) {
    if (!cleaned.includes(phrase)) {
      issues.push(`missing required phrase: ${phrase}`)
    }
  }
  if (evidencePacket.delivery_phrase_required && !cleaned.includes(REQUIRED_PHRASE_DELIVERY)) {
    issues.push(`missing required phrase: ${REQUIRED_PHRASE_DELIVERY}`)
  }
  if (cleaned.split(/\s+/).length < 180) {
    issues.push('shorter than target range')
  }
  if (paragraphs.length !== 3) {
    issues.push('not exactly 3 paragraphs')
  }
  issues.push(...paragraphWordIssues(paragraphs))

  if (paragraphs.length >= 2) {
    const earlyText = paragraphs.slice(0, 2).join('\n\n')
    if (EARLY_STORE_LANGUAGE_PATTERNS.some((pattern) => pattern.test(earlyText))) {
      issues.push('store or SEO language appears before final paragraph')
    }
  }

  return issues
}

function paragraphWordIssues(paragraphs: string[]): string[] {
  if (paragraphs.length !== 3) {
    return []
  }

  const wordCounts = paragraphs.map((paragraph) => paragraph.split(/\s+/).filter((word) => word.length > 0).length)
  const issues: string[] = []

  if (wordCounts[0] < 50 || wordCounts[0] > 95) {
    issues.push(`paragraph 1 word count out of range: ${wordCounts[0]}`)
  }
  if (wordCounts[1] < 65 || wordCounts[1] > 125) {
    issues.push(`paragraph 2 word count out of range: ${wordCounts[1]}`)
  }
  if (wordCounts[2] < 50 || wordCounts[2] > 100) {
    issues.push(`paragraph 3 word count out of range: ${wordCounts[2]}`)
  }

  return issues
}

function selectListings(
  candidateListings: Array<StoredListing & { candidateIndex: number }>,
  selectedIndexes: number[],
): Array<StoredListing & { candidateIndex: number }> {
  if (selectedIndexes.length === 0) {
    return candidateListings
  }

  const wanted = new Set(selectedIndexes)
  return candidateListings.filter((listing) => wanted.has(listing.candidateIndex))
}

function buildRequiredPhrasePresence(description: string): Record<string, boolean> {
  return {
    [OPTIONAL_PHRASE_LICENSED]: description.includes(OPTIONAL_PHRASE_LICENSED),
    [REQUIRED_PHRASE_DELIVERY]: description.includes(REQUIRED_PHRASE_DELIVERY),
    [REQUIRED_PHRASES_ALWAYS[0]]: description.includes(REQUIRED_PHRASES_ALWAYS[0]),
    [REQUIRED_PHRASES_ALWAYS[1]]: description.includes(REQUIRED_PHRASES_ALWAYS[1]),
  }
}

function normalizeGeneratedDescription(text: string): string {
  return normalizeDescriptionText(text).replace(/—/g, '-')
}

function normalizeParagraph(text: string): string {
  return normalizeGeneratedDescription(text)
}

function splitParagraphs(description: string): string[] {
  return description
    .split('\n\n')
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
}

function normalizeConfidence(value: unknown): string {
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase()
    if (lowered === 'high' || lowered === 'medium' || lowered === 'low') {
      return lowered
    }
    if (lowered === 'strong' || lowered === 'very high') {
      return 'high'
    }
    if (lowered === 'moderate' || lowered === 'mid') {
      return 'medium'
    }
    if (lowered === 'weak' || lowered === 'very low') {
      return 'low'
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 0.8) {
      return 'high'
    }
    if (value >= 0.45) {
      return 'medium'
    }
    return 'low'
  }

  return 'unknown'
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => normalizeSpace(String(item)))
      .filter((item) => item.length > 0)
    return dedupeCaseInsensitive(items)
  }

  if (typeof value === 'string') {
    return dedupeCaseInsensitive(value.split(',').map((item) => item.trim()).filter((item) => item.length > 0))
  }

  return []
}

function normalizeIntList(value: unknown): number[] | null {
  if (value === null || value === undefined) {
    return null
  }

  if (!Array.isArray(value)) {
    return []
  }

  const output: number[] = []
  const seen = new Set<number>()
  for (const item of value) {
    const parsed = typeof item === 'number' ? item : Number.parseInt(String(item), 10)
    if (!Number.isInteger(parsed) || seen.has(parsed)) {
      continue
    }
    seen.add(parsed)
    output.push(parsed)
  }

  return output
}

function dedupeCaseInsensitive(values: string[]): string[] {
  const output: string[] = []
  const seen = new Set<string>()

  for (const value of values) {
    const key = value.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    output.push(value)
  }

  return output
}

function normalizeSpace(text: string): string {
  return text.trim().split(/\s+/).filter((part) => part.length > 0).join(' ')
}

function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, ' ')
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function readStringField(parsed: Record<string, unknown>, key: string): string {
  const value = parsed[key]
  return typeof value === 'string' ? value : ''
}

function isRetryableStatusCode(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || (statusCode >= 500 && statusCode <= 504)
}

function buildTransportErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return `LLM request transport failed: ${error.message}`
  }

  return 'LLM request transport failed.'
}

function truncate(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 239)}…`
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parsePreviousProposalContext(input: {
  evidenceJson: unknown
  merchandisingContextJson: unknown
  proposalRowId: number | null
}): PreviousProposalContext {
  const evidence = PreviousEvidenceSchema.safeParse(input.evidenceJson)
  const merchandisingContext = MerchandisingContextSchema.safeParse(input.merchandisingContextJson)

  return {
    evidence: evidence.success ? evidence.data : PreviousEvidenceSchema.parse({}),
    merchandisingContext: merchandisingContext.success ? merchandisingContext.data : MerchandisingContextSchema.parse({}),
    proposalRowId: input.proposalRowId,
  }
}
