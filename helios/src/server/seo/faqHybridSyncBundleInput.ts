// Pure builder for the prod SEO bundle-input the FAQ hybrid-sync job
// publishes (child FreshlyBakedNYC/automation#46, P1, task cfa2dc0).
//
// The CLI (`seo-bundle publish --config <json> --faq-from-db`) reads a
// hand-authored bundle-input JSON and overlays the approved FAQ sets. The
// recurring hybrid-sync job has no operator to hand it that JSON, so this
// module is the canonical, code-defined prod bundle-input for the FAQ-only
// bundle. It is PURE (no I/O): it takes the ledger-verified approved FAQ
// sets (from faqBundleSource.loadApprovedFaqSetsForBundle) and emits the
// `CompileInput` that compile.ts + publish.ts consume.
//
// Scope of P1: the single global FB-NYC loyalty FAQ, rendered from the
// reserved global scope (`all`) at `/sites/all/loyalty-faq` on BOTH hosts
// (fb.nyc raw, fb.us sanitized — the renderer picks the variant per host
// mode; no cloaking). Per-family FAQ widgets are P5 and are intentionally
// NOT placed here yet; an approved family set still ships in
// `content.faq_sets` (so it is ledger-covered) but renders no widget until
// P5 adds its placement.
//
// IRONCLAD gate (canon §1): this module never decides what is approved. It
// only lays out approved content the caller already verified against the
// approval ledger. The widget is emitted ONLY when the global set is
// actually among the approved sets, so an unapproved global set can never
// produce a dangling widget ref (which would fail compile anyway).
//
// Satisfies: virusdave/top-level#17 · Phase: P1

import type { CompileInput } from './compile.js'
import type { FaqSet, SeoSite } from './contracts.js'
import { RESERVED_GLOBAL_SITE_ID } from './routeRegistry.js'

/** Stable seo_policy_version_id stamped on the hybrid-sync FAQ bundle. */
export const FAQ_HYBRID_SYNC_SEO_POLICY_VERSION_ID = 'faq-hybrid-sync-v1'
/** Stable selection-algorithm version (widget self-placement; empty rules). */
export const FAQ_HYBRID_SYNC_SELECTION_ALGORITHM_VERSION = 'static-faq-route-v1'
/** Min mss renderer the bundle requires (matches the example/config default). */
export const FAQ_HYBRID_SYNC_MIN_RENDERER_VERSION = 'mss-seo-runtime>=0.1.0'

/** Canonical route the global loyalty FAQ renders at (both hosts, via `all`). */
export const FB_NYC_FAQ_ROUTE = `/sites/${RESERVED_GLOBAL_SITE_ID}/loyalty-faq`
/** Stable widget id for the global loyalty-FAQ fold. */
export const FB_NYC_FAQ_WIDGET_ID = 'faq_fbus_global_loyalty'

/**
 * The two physical sites the FAQ bundle targets. fb.nyc renders the raw
 * (cannabis) variant; fb.us renders the sanitized variant. The reserved
 * `all` scope renders on both under each host's own mode.
 */
export const FAQ_HYBRID_SYNC_SITES: Record<string, SeoSite> = {
  fb_nyc: { hosts: ['freshlybaked.nyc'], mode: 'raw' },
  fb_us: { hosts: ['freshlybaked.us'], mode: 'sanitized' },
}

export interface BuildFaqHybridBundleInputArgs {
  /**
   * The ledger-verified approved FAQ sets to ship, exactly as returned by
   * loadApprovedFaqSetsForBundle (already hash/ledger-checked). These are
   * the ONLY content this bundle publishes.
   */
  readonly approvedFaqSets: readonly FaqSet[]
  /**
   * The DB faq_set_id of the global FB-NYC loyalty FAQ set
   * (source_key `fbus-global-faq`), or null if it is not currently
   * approved. When null (or not present in approvedFaqSets) NO loyalty-FAQ
   * widget is emitted.
   */
  readonly globalFaqSetId: string | null
  readonly seoPolicyVersionId?: string
}

/**
 * Build the prod `CompileInput` for the FAQ-only SEO bundle from the
 * already-approved FAQ sets. Pure: same inputs always yield the same input.
 */
export function buildFaqHybridBundleInput(args: BuildFaqHybridBundleInputArgs): CompileInput {
  const seoPolicyVersionId = args.seoPolicyVersionId ?? FAQ_HYBRID_SYNC_SEO_POLICY_VERSION_ID

  // Emit the loyalty-FAQ widget only when the global set is genuinely among
  // the approved sets (so widget.faq_set_id always resolves, and its scope
  // matches the set's scope — consistency.ts enforces both).
  const globalSet =
    args.globalFaqSetId === null
      ? undefined
      : args.approvedFaqSets.find((s) => s.faq_set_id === args.globalFaqSetId)

  const widgets: CompileInput['widgets'] = globalSet
    ? [
        {
          widget_id: FB_NYC_FAQ_WIDGET_ID,
          type: 'SEOFAQFold',
          scope: globalSet.scope,
          enabled: true,
          route_patterns: [FB_NYC_FAQ_ROUTE],
          slot_id: 'faq',
          faq_set_id: globalSet.faq_set_id,
        },
      ]
    : []

  return {
    sites: FAQ_HYBRID_SYNC_SITES,
    widgets,
    content: {
      faq_sets: [...args.approvedFaqSets],
      posts: [],
      related_link_sets: [],
      heads: [],
    },
    policy: {
      seo_policy_version_id: seoPolicyVersionId,
      selection_algorithm_version: FAQ_HYBRID_SYNC_SELECTION_ALGORITHM_VERSION,
      // Widgets self-place via scope + route_patterns; the FAQ MVP ships an
      // empty selection rule set (contracts.ts policy.json note).
      rules: [],
    },
    assets: [],
    sitemaps: [],
  }
}
