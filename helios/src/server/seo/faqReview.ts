// SEO FAQ review-bundle assembler (P5 review page).
//
// Builds the single, server-derived "everything a reviewer needs to decide"
// bundle for one FAQ set: the approval blockers (`checkFaqSetApprovable`),
// the advisory governance warnings (`checkFaqSetGovernance`), the per-field
// sanitized-host leak markers, the route placement the set will publish to
// (resolved from its PERSISTED source key, never client input), and the
// FAQPage JSON-LD preview for both host modes.
//
// All of it is derived from the persisted set so the review page never has
// to stitch together several partially-authoritative sources. Pure (no I/O)
// so it is unit-testable without a DB.
//
// task dce1a56 (P5) · child FreshlyBakedNYC/automation#46 · Satisfies: virusdave/top-level#17

import {
  buildFaqPageJsonLd,
  checkFaqSetApprovable,
  describeFbusLeaks,
  type FaqComplianceProblem,
  type FaqItemInput,
} from './faqContent.js'
import { checkFaqSetGovernance, type FaqGovernanceProblem } from './faqGovernance.js'
import { parseFaqSourceKey } from './faqSourceKey.js'
import { getLpFamily } from './lpFamilyRegistry.js'

// The sanitized-host (`.us`) leak rule only applies to fields that render on
// the sanitized host: the shared question and the sanitized answer. The raw
// answer is the FB.nyc variant and is allowed to carry raw NYC copy, so it
// is deliberately excluded here.
export type FaqReviewLeakField = 'question' | 'answer_sanitized'

export interface FaqReviewLeakMarkers {
  readonly itemIndex: number
  readonly field: FaqReviewLeakField
  /** Human-readable leak markers (terms, `.nyc-url:<host>`, `nyc-brand-phrase`). */
  readonly markers: string[]
}

// Where this FAQ set's content will appear once published, resolved from the
// set's persisted source key. Every shape is explicit so the page never
// pretends a non-LP / unknown / keyless set maps to LP route patterns.
export type FaqReviewPlacement =
  | {
      readonly kind: 'lp_family'
      readonly sourceKey: string
      readonly familyId: string
      readonly canonicalRepresentativeRoute: string
      readonly routePatterns: string[]
      readonly indexabilityPolicy: unknown
    }
  | {
      // A structurally-valid FBUS key whose family slug is not an LP family
      // (the structural `global` / `dedicated` sets, or a family the
      // vendored registry does not know).
      readonly kind: 'non_lp_source_key'
      readonly sourceKey: string
      readonly familySlug: string
    }
  | {
      // A non-null source key that is not a recognized source key at all.
      readonly kind: 'unknown_source_key'
      readonly sourceKey: string
    }
  | {
      // A manual / legacy set with no source identity.
      readonly kind: 'no_source_key'
      readonly sourceKey: null
    }

export interface FaqReviewBundle {
  readonly compliance: {
    readonly ok: boolean
    readonly problems: FaqComplianceProblem[]
  }
  readonly governance: {
    readonly ok: boolean
    readonly problems: FaqGovernanceProblem[]
  }
  /** Per-item field leak markers for the sanitized host, in item order. */
  readonly sanitizedHostLeakMarkers: FaqReviewLeakMarkers[]
  readonly placement: FaqReviewPlacement
  readonly preview: {
    readonly rawJsonLd: Record<string, unknown>
    readonly sanitizedJsonLd: Record<string, unknown>
  }
}

export interface BuildFaqReviewBundleInput {
  readonly items: readonly FaqItemInput[]
  /** The set's PERSISTED source key (never a client-supplied one). */
  readonly sourceKey: string | null
}

/** Resolve where a FAQ set publishes from its persisted source key. */
export function resolveFaqReviewPlacement(sourceKey: string | null): FaqReviewPlacement {
  if (sourceKey === null) {
    return { kind: 'no_source_key', sourceKey: null }
  }
  const parsed = parseFaqSourceKey(sourceKey)
  if (parsed === null) {
    return { kind: 'unknown_source_key', sourceKey }
  }
  const family = getLpFamily(parsed.family)
  if (family === null) {
    return { kind: 'non_lp_source_key', sourceKey, familySlug: parsed.family }
  }
  return {
    kind: 'lp_family',
    sourceKey,
    familyId: family.id,
    canonicalRepresentativeRoute: family.canonical_representative_route,
    routePatterns: [...family.widget_route_patterns],
    indexabilityPolicy: family.indexability_policy,
  }
}

/**
 * Assemble the full review bundle for a FAQ set. Compliance problems are
 * the hard approval blockers (same check the approve path enforces, keyed
 * by the PERSISTED source key); governance problems are advisory warnings;
 * leak markers annotate the sanitized-host fields; placement is derived
 * from the source key; preview is the no-cloaking JSON-LD for both modes.
 */
export function buildFaqReviewBundle(input: BuildFaqReviewBundleInput): FaqReviewBundle {
  const { items, sourceKey } = input

  const complianceProblems = checkFaqSetApprovable(items, { sourceKey })
  const governanceProblems = checkFaqSetGovernance(items)

  const sanitizedHostLeakMarkers: FaqReviewLeakMarkers[] = []
  items.forEach((item, itemIndex) => {
    const questionMarkers = describeFbusLeaks(item.question)
    if (questionMarkers.length > 0) {
      sanitizedHostLeakMarkers.push({ itemIndex, field: 'question', markers: questionMarkers })
    }
    const sanitizedMarkers = describeFbusLeaks(item.answer_sanitized)
    if (sanitizedMarkers.length > 0) {
      sanitizedHostLeakMarkers.push({
        itemIndex,
        field: 'answer_sanitized',
        markers: sanitizedMarkers,
      })
    }
  })

  return {
    compliance: { ok: complianceProblems.length === 0, problems: complianceProblems },
    governance: { ok: governanceProblems.length === 0, problems: governanceProblems },
    sanitizedHostLeakMarkers,
    placement: resolveFaqReviewPlacement(sourceKey),
    preview: {
      rawJsonLd: buildFaqPageJsonLd(items, 'raw'),
      sanitizedJsonLd: buildFaqPageJsonLd(items, 'sanitized'),
    },
  }
}
