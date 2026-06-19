// Bedrock-backed FAMILY-CONTEXTUAL FAQ draft generator (#46 P5).
//
// Where faqGenerate.ts generates from a free-text topic, this module
// generates a DRAFT FAQ set tuned to one FBUS landing-page FAMILY (e.g.
// `deliverance`, `tours`, `compare`). The family — its id, canonical
// representative route, widget `route_patterns`, sample routes, and
// indexability policy — is read from the SINGLE source of truth, the
// vendored mss LP-family registry artifact (`lpFamilyRegistry.ts`). We do
// NOT keep a second hand-edited family list here (parent EPIC_PLAN §5 / Q1);
// every per-family draft is keyed by the registry id and stamped with the
// registry's source SHA for provenance.
//
// Like every generator in this control plane it produces a DRAFT ONLY
// (source='generated', approval_id=null) — it NEVER approves or publishes.
// A human reviews raw + sanitized side-by-side and approves the EXACT
// content through the IRONCLAD gate (canon §1).
//
// Reuses the shared Bedrock-mantle gateway path (`requestFaqItems`,
// faqGenerate.ts; canon §4 — private inference for our content).
//
// child FreshlyBakedNYC/automation#46 · Satisfies: virusdave/top-level#17 ·
// Phase: P5

import { findFbusLeaks, type FaqItemInput } from './faqContent.js'
import { requestFaqItems } from './faqGenerate.js'
import { describeFaqGovernanceProblems } from './faqGovernance.js'
import {
  getLpFamily,
  getLpFamilyRegistry,
  LP_FAMILY_REGISTRY_PROVENANCE,
  lpFamilyFaqSourceKey,
  type LpFamily,
} from './lpFamilyRegistry.js'

export interface FamilyFaqGenerateInput {
  /** A registry family id OR a known alias (e.g. `conquest` → `compare`). */
  readonly familyId: string
  readonly itemCount: number
  /**
   * Optional operator-supplied focus/angle for this family's FAQs (the
   * human provides the intent; the registry provides the route scoping and
   * provenance). Kept short — it is a hint, not invented facts.
   */
  readonly focus?: string
}

export interface FamilyFaqRegistryProvenance {
  readonly repo: string
  readonly path: string
  readonly commitSha: string
  readonly blobSha: string
  readonly schema: string
  /** The registry artifact's own build-time source commit. */
  readonly artifactSourceCommit: string
}

export interface FamilyFaqGenerateMeta {
  readonly model: string
  /** Canonical family id (aliases resolved). */
  readonly familyId: string
  /** The FBUS source key the draft is persisted under (`fbus-<id>-faq`). */
  readonly sourceKey: string
  /** The registry site-id scope (`freshlybakedus`). */
  readonly siteId: string
  /** The family's canonical representative route, for the reviewer. */
  readonly canonicalRepresentativeRoute: string
  /** The widget route patterns the FAQ is scoped onto (verbatim from registry). */
  readonly routePatterns: readonly string[]
  /** The family's indexability policy (verbatim from registry). */
  readonly indexabilityPolicy: LpFamily['indexability_policy']
  readonly focus: string | null
  readonly itemCount: number
  readonly generatedAt: string
  /** Pinned provenance of the LP-family registry the family came from. */
  readonly registryProvenance: FamilyFaqRegistryProvenance
  // Items whose sanitized variant / shared question tripped the stricter
  // FBUS leak heuristic at generation time (advisory only — the human still
  // reviews and the approve path re-checks + blocks fail-closed).
  readonly sanitizedLeakWarnings: ReadonlyArray<{ itemIndex: number; terms: string[] }>
  // Pre-review governance problems (caps, draft markers, dup/near-dup) on the
  // generated set. Advisory here — surfaced for the reviewer / review page;
  // empty = clean. (parent EPIC_PLAN §5: governance before review.)
  readonly governanceWarnings: readonly string[]
}

export type FamilyFaqGenerateResult =
  | { kind: 'ok'; items: FaqItemInput[]; meta: FamilyFaqGenerateMeta }
  | { kind: 'error'; message: string }

const SYSTEM_PROMPT = [
  'You write SEO FAQ content for a New York cannabis retailer that runs TWO public sites:',
  'a RAW site (FB.nyc) where cannabis terms are allowed, and a SANITIZED site (FB.us) where NO cannabis-specific terms may appear.',
  'You are writing FAQs for ONE specific FB.us landing-page family — the FAQs must be relevant to a visitor who arrived on that family of pages.',
  'Produce a JSON object: {"items": [{"question": string, "answer_raw": string, "answer_sanitized": string}, ...]}.',
  'Rules:',
  '- The shared "question" is shown on BOTH sites, so it must NOT contain cannabis-specific terms (cannabis, marijuana, THC, CBD, weed, dispensary, edibles, vape, pre-roll, flower, strain, etc.).',
  '- "answer_raw" may use cannabis terms freely and accurately.',
  '- "answer_sanitized" must convey the same helpful, truthful information WITHOUT any cannabis-specific terms — rephrase generically (e.g. "our products", "wellness items", "in-store"). It must also avoid the "Freshly Baked NYC" brand phrase and any .nyc URL.',
  '- Every answer must be genuinely useful, accurate, and 1-3 sentences. Do NOT invent specific facts (prices, hours, addresses, legal claims); keep answers general and truthful — a human will verify and edit before approval.',
  '- No keyword stuffing, no medical or legal claims.',
  'Output ONLY the JSON object. No prose, no markdown fences.',
].join(' ')

/**
 * Build the family-contextual user prompt. Exported for unit testing without
 * a live gateway. The context is sourced ENTIRELY from the registry entry
 * (id, representative route, sample routes) plus the optional operator focus
 * — no second hand-edited per-family description list.
 */
export function buildFamilyFaqUserPrompt(family: LpFamily, input: FamilyFaqGenerateInput): string {
  const sampleRoutes = family.sample_crawl_routes.map((r) => r.path)
  const pathTemplates = family.route_patterns.map((p) => p.path_template)
  const lines = [
    `landing_page_family: ${JSON.stringify(family.id)}`,
    `canonical_representative_route: ${JSON.stringify(family.canonical_representative_route)}`,
    `route_path_templates: ${JSON.stringify(pathTemplates)}`,
    `sample_routes: ${JSON.stringify(sampleRoutes)}`,
    `slug_kind: ${JSON.stringify(family.slug_kind)}`,
    `indexability: ${JSON.stringify(family.indexability_policy.kind)}`,
    `number_of_faq_items: ${input.itemCount}`,
  ]
  const focus = input.focus?.trim()
  if (focus && focus.length > 0) {
    lines.push(`operator_focus: ${JSON.stringify(focus)}`)
  }
  lines.push(
    'Write FAQs a visitor on these pages would actually ask. Infer the page intent from the family name and routes; if an operator_focus is given, prioritize it.',
    'If the route/family intent is ambiguous, write GENERAL ordering / delivery / location / payment / customer-support FAQs for the retailer — do NOT invent a campaign or product meaning from the family id.',
  )
  return lines.join('\n')
}

function sanitizedLeakWarnings(
  items: readonly FaqItemInput[],
): Array<{ itemIndex: number; terms: string[] }> {
  const warnings: Array<{ itemIndex: number; terms: string[] }> = []
  items.forEach((item, itemIndex) => {
    // FBUS sets are held to the STRICTER FBUS denylist (cannabis meta-terms,
    // .nyc hosts, brand phrase) on the shared question + sanitized answer.
    const sanitized = findFbusLeaks(item.answer_sanitized)
    const question = findFbusLeaks(item.question)
    const terms = [
      ...new Set([
        ...sanitized.terms,
        ...sanitized.nycHosts,
        ...question.terms,
        ...question.nycHosts,
        ...(sanitized.nycBrandPhrase ? ['Freshly Baked NYC'] : []),
        ...(question.nycBrandPhrase ? ['Freshly Baked NYC'] : []),
      ]),
    ]
    if (terms.length > 0) {
      warnings.push({ itemIndex, terms })
    }
  })
  return warnings
}

/**
 * Generate a family-contextual FAQ draft. Never throws — an unknown family
 * or a gateway/parse failure maps to { kind: 'error' }.
 */
export async function generateFamilyFaqDraft(
  input: FamilyFaqGenerateInput,
): Promise<FamilyFaqGenerateResult> {
  const family = getLpFamily(input.familyId)
  if (!family) {
    return {
      kind: 'error',
      message: `Unknown LP family ${JSON.stringify(input.familyId)}.`,
    }
  }

  const result = await requestFaqItems({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildFamilyFaqUserPrompt(family, input),
  })
  if (result.kind === 'error') {
    return result
  }

  const registry = getLpFamilyRegistry()
  const focus = input.focus?.trim()
  return {
    kind: 'ok',
    items: result.items,
    meta: {
      model: result.model,
      familyId: family.id,
      sourceKey: lpFamilyFaqSourceKey(family.id),
      siteId: registry.site_id,
      canonicalRepresentativeRoute: family.canonical_representative_route,
      routePatterns: family.widget_route_patterns,
      indexabilityPolicy: family.indexability_policy,
      focus: focus && focus.length > 0 ? focus : null,
      itemCount: result.items.length,
      generatedAt: new Date().toISOString(),
      registryProvenance: {
        repo: LP_FAMILY_REGISTRY_PROVENANCE.repo,
        path: LP_FAMILY_REGISTRY_PROVENANCE.path,
        commitSha: LP_FAMILY_REGISTRY_PROVENANCE.commitSha,
        blobSha: LP_FAMILY_REGISTRY_PROVENANCE.blobSha,
        schema: registry.schema,
        artifactSourceCommit: registry.provenance.source_commit,
      },
      sanitizedLeakWarnings: sanitizedLeakWarnings(result.items),
      governanceWarnings: describeFaqGovernanceProblems(result.items),
    },
  }
}
