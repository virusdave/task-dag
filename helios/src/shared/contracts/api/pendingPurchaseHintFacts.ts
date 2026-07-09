import { z } from 'zod'

import { PendingPurchaseHintDocumentKindSchema } from './pendingPurchaseHints.js'

// Contracts for the prospective pending-purchase classifier's HINT FACT
// EXTRACTION pass (child FreshlyBakedNYC/automation#54, task C3, parent
// virusdave/top-level#33).
//
// C2 stored operator-pasted hint documents (a distributor's wholesale menu, a
// sibling store's purchase order, a free-text note) as UNTRUSTED DATA. C3 is
// the two-step pipeline that turns each document into INERT, CITED facts the
// classifier (C4) reasons over:
//
//   1. Intent classification — LLM-parse the hint for HOW it helps, because
//      the operator may paste very different things (a canonical vendor SKU
//      list / the specific items ordered = a PO-like expectation set / a
//      free-text description / a line-item delivery list). The detected
//      intent changes how each fact is later used.
//   2. Fact extraction — turn the document into a list of cited facts
//      (item name, SKU/code, brand, strain, taxonomy, size, pack count,
//      wholesale price, source line/row), IGNORING any embedded
//      instructions. Sweed purchase-order JSON is parsed deterministically
//      (no LLM); everything else goes through a Bedrock JSON extractor.
//
// Every fact carries a citation back into the source so a downstream
// hint-based claim (C4) can point at exactly where it came from. The facts
// are DATA, never instructions: nothing here is ever executed or trusted as a
// command.
//
// The extracted_facts JSONB column and the hint_intent / extraction_status /
// extraction_error columns were pre-created by migration 094 (C2), so C3
// needs no second migration. The hint_intent COLUMN is deliberately
// unconstrained text in the DB so the taxonomy can evolve without a widening
// migration; this enum is the app-level source of truth.
//
// Satisfies: virusdave/top-level#33

// How the operator's hint helps (operator decision 2). Mirrored by the
// extractor prompt + the deterministic Sweed-PO mapping.
export const PendingPurchaseHintIntentSchema = z.enum([
  // A canonical vendor SKU/catalog list to match rows against (hard SKU
  // candidates).
  'canonical_sku_list',
  // The specific items ordered/expected — a PO-like expectation set to
  // reconcile rows against.
  'ordered_items_expectation',
  // A general free-text description ("we ordered a bunch of 2g AIO vapes")
  // used to weight the classifier toward those taxonomies (soft priors).
  'free_text_description',
  // A line-item delivery/manifest list.
  'line_item_list',
])
export type PendingPurchaseHintIntent = z.infer<typeof PendingPurchaseHintIntentSchema>

// Which engine produced the facts: the deterministic Sweed-PO-JSON parser
// (no LLM, fully reproducible) or the Bedrock JSON extractor.
export const PendingPurchaseHintExtractorSchema = z.enum(['deterministic-sweed-po', 'llm'])
export type PendingPurchaseHintExtractor = z.infer<typeof PendingPurchaseHintExtractorSchema>

// Wholesale-price basis so a number is never ambiguous between a per-unit
// price, a pack/case price, or a line total.
export const PendingPurchaseHintPriceBasisSchema = z.enum([
  'unit',
  'pack',
  'case',
  'line_total',
  'unknown',
])
export type PendingPurchaseHintPriceBasis = z.infer<typeof PendingPurchaseHintPriceBasisSchema>

// Quantity basis, likewise disambiguated.
export const PendingPurchaseHintQuantityBasisSchema = z.enum([
  'ordered_units',
  'case_count',
  'available_units',
  'unknown',
])
export type PendingPurchaseHintQuantityBasis = z.infer<typeof PendingPurchaseHintQuantityBasisSchema>

// Bounded string fields keep an arbitrary admin paste / hostile model output
// from bloating the JSONB blob. Empty strings are normalized to null by the
// extractor before validation.
const BoundedNullableString = (max: number) => z.string().trim().min(1).max(max).nullable()

// Where a fact came from in the source document. All positional fields are
// 1-based and human-facing (the extractor numbers lines before prompting).
// `snippet` is the exact bounded excerpt the fact was read from — never a
// paraphrase — so a reviewer can verify the citation.
export const PendingPurchaseHintFactCitationSchema = z
  .object({
    // 1-based page (reserved for future PDF/file uploads — FT-1).
    page: z.number().int().positive().nullable(),
    // 1-based inclusive human line span in the normalized pasted text.
    lineStart: z.number().int().positive().nullable(),
    lineEnd: z.number().int().positive().nullable(),
    // 1-based row in a table / position index in structured JSON.
    row: z.number().int().positive().nullable(),
    // JSON pointer into structured source (e.g. Sweed PO `/positions/0`).
    jsonPointer: z.string().trim().min(1).max(200).nullable(),
    snippet: z.string().trim().min(1).max(2000),
  })
  .strict()
  .superRefine((citation, ctx) => {
    // A line span is present as a pair or not at all, and is ordered.
    const hasLineStart = citation.lineStart !== null
    const hasLineEnd = citation.lineEnd !== null
    if (hasLineStart !== hasLineEnd) {
      ctx.addIssue({
        code: 'custom',
        message: 'lineStart and lineEnd must both be present or both null.',
      })
    } else if (hasLineStart && hasLineEnd && citation.lineEnd! < citation.lineStart!) {
      ctx.addIssue({ code: 'custom', message: 'lineEnd must be >= lineStart.' })
    }
    // Every citation must anchor to SOMETHING in the source so a consumer
    // (C4/C6) can always point a reviewer at the origin.
    if (citation.lineStart === null && citation.row === null && citation.jsonPointer === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'citation needs at least one anchor: a line span, a row, or a jsonPointer.',
      })
    }
  })
export type PendingPurchaseHintFactCitation = z.infer<typeof PendingPurchaseHintFactCitationSchema>

// One inert, cited fact extracted from a hint document. Every non-null field
// must be supported by `citation`; the extractor uses null rather than
// guessing. `sku` is a printed vendor SKU/UPC-like code; `vendorProductCode`
// is a distributor/Sweed product id or menu code — kept separate so future
// code never conflates the two.
export const PendingPurchaseHintFactSchema = z
  .object({
    // Stable within a single document (assigned deterministically by C3 as
    // f1, f2, …; the model never picks ids).
    factId: z.string().regex(/^f[1-9][0-9]*$/),
    itemName: BoundedNullableString(300),
    sku: BoundedNullableString(120),
    vendorProductCode: BoundedNullableString(120),
    brand: BoundedNullableString(160),
    strain: BoundedNullableString(160),
    // Indica / Sativa / Hybrid / CBD / Mixed when a doc states the lane
    // without naming a strain. Left as bounded string (not an enum) so the
    // extractor can pass through whatever the doc literally says.
    prevalence: BoundedNullableString(40),
    category: BoundedNullableString(120),
    subcategory: BoundedNullableString(120),
    size: BoundedNullableString(80),
    packCount: z.number().int().positive().max(1000).nullable(),
    wholesalePrice: z.number().nonnegative().max(1_000_000).nullable(),
    wholesalePriceBasis: PendingPurchaseHintPriceBasisSchema.nullable(),
    quantity: z.number().nonnegative().max(10_000_000).nullable(),
    quantityBasis: PendingPurchaseHintQuantityBasisSchema.nullable(),
    citation: PendingPurchaseHintFactCitationSchema,
  })
  .strict()
  .superRefine((fact, ctx) => {
    // A fact with no content is noise — C4 should never have to filter empties.
    const hasContent =
      fact.itemName !== null ||
      fact.sku !== null ||
      fact.vendorProductCode !== null ||
      fact.brand !== null ||
      fact.strain !== null ||
      fact.prevalence !== null ||
      fact.category !== null ||
      fact.subcategory !== null ||
      fact.size !== null ||
      fact.packCount !== null ||
      fact.wholesalePrice !== null ||
      fact.quantity !== null
    if (!hasContent) {
      ctx.addIssue({
        code: 'custom',
        message: 'a fact must carry at least one non-null content field.',
      })
    }
    // Price and its basis travel together so a consumer never sees one
    // without the other.
    if ((fact.wholesalePrice === null) !== (fact.wholesalePriceBasis === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'wholesalePrice and wholesalePriceBasis must both be null or both set.',
      })
    }
    if ((fact.quantity === null) !== (fact.quantityBasis === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'quantity and quantityBasis must both be null or both set.',
      })
    }
  })
export type PendingPurchaseHintFact = z.infer<typeof PendingPurchaseHintFactSchema>

// Bounds for glossary/term-expansion evidence. A hint document sometimes
// explains HOW to read a delivery rather than listing products — e.g. "PR =
// Preroll; FL = Flower; METRC = Marijuana Enforcement Tracking Reporting
// Compliance". None of that is a product fact, so it can never live on
// PendingPurchaseHintFactSchema; it is modeled as a SEPARATE kind of cited,
// inert evidence. These bounds keep a hostile/verbose paste from bloating the
// JSONB blob or the downstream LLM prompt.
const GLOSSARY_TERM_MAX_LENGTH = 120
const GLOSSARY_EXPANSION_MAX_LENGTH = 300
const GLOSSARY_NOTE_MAX_LENGTH = 500
export const PENDING_PURCHASE_HINT_MAX_GLOSSARY_ENTRIES = 500

// One inert, CITED glossary / term-expansion entry: an abbreviation or term
// mapped to its literal expansion, both quoted from the source document. This
// is DATA, never an instruction — `note` is an optional inert clarification
// (e.g. "vendor-specific abbreviation"), NOT guidance the classifier must
// follow. `factId` shares the same `fN` namespace as product facts so a
// downstream cited id ("<hintDocumentId>#<factId>") is uniform across every
// evidence kind; ids are unique across facts AND glossary entries within a
// document (enforced on PendingPurchaseHintExtractedFactsSchema).
export const PendingPurchaseHintGlossaryEntrySchema = z
  .object({
    factId: z.string().regex(/^f[1-9][0-9]*$/),
    // The abbreviation/term exactly as printed in the source, e.g. "PR",
    // "FL", "METRC".
    term: z.string().trim().min(1).max(GLOSSARY_TERM_MAX_LENGTH),
    // Its literal expansion as the document states it, e.g. "Preroll".
    expansion: z.string().trim().min(1).max(GLOSSARY_EXPANSION_MAX_LENGTH),
    // Optional inert clarification. Never an instruction to the classifier.
    note: BoundedNullableString(GLOSSARY_NOTE_MAX_LENGTH),
    citation: PendingPurchaseHintFactCitationSchema,
  })
  .strict()
export type PendingPurchaseHintGlossaryEntry = z.infer<
  typeof PendingPurchaseHintGlossaryEntrySchema
>

// The full `extracted_facts` JSONB payload persisted on a document row.
// `schemaVersion` lets C4/C5/C6 (and any later version) detect the shape.
// `warnings` are inert extractor notes (e.g. "table columns ambiguous"); C4
// must NOT treat them as evidence — only cited `facts`/`glossaryEntries` are
// evidence.
//
// v2 adds `glossaryEntries` (cited term/acronym expansions). The parser stays
// BACK-COMPATIBLE: stored v1 rows (schemaVersion=1, no `glossaryEntries` key)
// still parse — `schemaVersion` accepts 1 or 2 and `glossaryEntries` defaults
// to []. extracted_facts stays JSONB, so no DB migration is needed; the app
// contract absorbs both shapes.
export const PENDING_PURCHASE_HINT_FACTS_SCHEMA_VERSION = 2 as const

export const PendingPurchaseHintExtractedFactsSchema = z
  .object({
    // Accept every version this parser understands so a stored v1 payload is
    // never rejected (and silently dropped by the loader). New writes stamp
    // the current version; reads transparently upgrade older ones.
    schemaVersion: z.union([z.literal(1), z.literal(PENDING_PURCHASE_HINT_FACTS_SCHEMA_VERSION)]),
    intent: PendingPurchaseHintIntentSchema,
    extractor: PendingPurchaseHintExtractorSchema,
    // Bedrock model id when extractor='llm'; null for the deterministic path.
    model: z.string().trim().min(1).max(200).nullable(),
    facts: z.array(PendingPurchaseHintFactSchema).max(5000),
    // Cited term/acronym expansions. Absent in v1 payloads → defaults to [].
    glossaryEntries: z
      .array(PendingPurchaseHintGlossaryEntrySchema)
      .max(PENDING_PURCHASE_HINT_MAX_GLOSSARY_ENTRIES)
      .default([]),
    warnings: z.array(z.string().trim().min(1).max(500)).max(50),
  })
  .strict()
  .superRefine((payload, ctx) => {
    // Product facts and glossary entries share one `fN` id namespace so a
    // downstream cited id ("<hintDocumentId>#<factId>") is unambiguous. A
    // collision would make a citation point at two different pieces of
    // evidence, so reject it here rather than letting C4 resolve it wrong.
    const seen = new Set<string>()
    const duplicates = new Set<string>()
    for (const fact of payload.facts) {
      if (seen.has(fact.factId)) {
        duplicates.add(fact.factId)
      }
      seen.add(fact.factId)
    }
    for (const entry of payload.glossaryEntries) {
      if (seen.has(entry.factId)) {
        duplicates.add(entry.factId)
      }
      seen.add(entry.factId)
    }
    if (duplicates.size > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `factId must be unique across facts and glossaryEntries; duplicated: ${[...duplicates].sort().join(', ')}.`,
      })
    }
  })
export type PendingPurchaseHintExtractedFacts = z.infer<
  typeof PendingPurchaseHintExtractedFactsSchema
>

// One fact flattened with its owning-document context, for C4/C5/C6. Avoids
// duplicating the document id inside every per-document fact while still
// giving every citation object the document it belongs to.
export const PendingPurchaseHintBundleFactSchema = z.object({
  hintBundleId: z.string().min(1),
  hintDocumentId: z.string().min(1),
  kind: PendingPurchaseHintDocumentKindSchema,
  sourceLabel: z.string().nullable(),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  intent: PendingPurchaseHintIntentSchema,
  extractor: PendingPurchaseHintExtractorSchema,
  fact: PendingPurchaseHintFactSchema,
})
export type PendingPurchaseHintBundleFact = z.infer<typeof PendingPurchaseHintBundleFactSchema>

// One glossary/acronym-expansion entry flattened with its owning-document
// context, for C4. Mirrors PendingPurchaseHintBundleFact but carries a cited
// glossary `entry` instead of a product `fact`, keeping the two evidence kinds
// on separate read surfaces (the loader that flattens facts never conflates
// them with glossary rows).
export const PendingPurchaseHintBundleGlossaryEntrySchema = z.object({
  hintBundleId: z.string().min(1),
  hintDocumentId: z.string().min(1),
  kind: PendingPurchaseHintDocumentKindSchema,
  sourceLabel: z.string().nullable(),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  intent: PendingPurchaseHintIntentSchema,
  extractor: PendingPurchaseHintExtractorSchema,
  entry: PendingPurchaseHintGlossaryEntrySchema,
})
export type PendingPurchaseHintBundleGlossaryEntry = z.infer<
  typeof PendingPurchaseHintBundleGlossaryEntrySchema
>

// ── re-extract route ──────────────────────────────────────────────────

// POST .../hint-bundles/:hintBundleId/extract — operator triggers a fresh
// extraction pass (e.g. after a model/config recovery, or to re-run a failed
// document). Returns the enqueued job id so the UI (C6) can link to it.
export const TriggerPendingPurchaseHintExtractionBodySchema = z
  .object({
    // Optional single-document scope; omit to (re)extract the whole bundle.
    hintDocumentId: z
      .string()
      .trim()
      .regex(/^pphdoc_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[0-9a-f]{6}$/, 'invalid hint document id')
      .optional(),
    // When true, also re-extract documents already in 'extracted' state.
    force: z.boolean().optional(),
  })
  .strict()
export type TriggerPendingPurchaseHintExtractionBody = z.infer<
  typeof TriggerPendingPurchaseHintExtractionBodySchema
>

export const TriggerPendingPurchaseHintExtractionResponseSchema = z.object({
  jobId: z.number().int().positive(),
})
export type TriggerPendingPurchaseHintExtractionResponse = z.infer<
  typeof TriggerPendingPurchaseHintExtractionResponseSchema
>
