// Typed (zod) freeze of the SEO bundle contracts — the P0 deliverable for
// the Helios-driven SEO widgets epic (parent EPIC_PLAN §5/§6/§8,
// child epic FreshlyBakedNYC/automation#44, Satisfies: virusdave/top-level#15).
//
// The SEO bundle is a SEPARATE, independently-versioned signed bundle that
// REUSES the unified-landing-engine (#13) publisher/signer/`/cloud`
// pointer/validator pipeline verbatim (see `../lp/`) — it is NOT merged
// into the LP bundle and NOT a parallel crypto stack. These zod schemas
// are the authoritative typed contract on the Helios side; the JSON
// fixtures in `config/seo/examples/` are cross-checked against them by
// `contracts.test.ts`.
//
// Structure mirrors the LP two-tier shape so the mss loader can reuse the
// #13 loader as a thin specialization:
//
//   current.json (mutable, atomic-rename pointer, signed)
//     → manifest.json (signed index: sites + host→mode + file checksums)
//       → widgets.json / content.json / policy.json / assets.json /
//         sitemaps.json  (immutable, content-addressed)
//
// Indexable content is STABLE per URL within a bundle (no cloaking, no
// per-user/crawler variance); raw-vs-sanitized is a host/site policy.

import { z } from 'zod'

// ── id / hash / signature / slug primitives ───────────────────────────

export const SEO_BUNDLE_ID_RE =
  /^seob_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[0-9a-f]{6}$/
export const SHA256_RE = /^[0-9a-f]{64}$/
export const SIGNATURE_RE = /^ed25519:[A-Za-z0-9+/=_-]+$/
// FB.nyc Reserved Prefix Registry blog/content slug (lowercase kebab; see
// routeRegistry.ts). Frozen here so the contract is self-describing.
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const SeoBundleIdSchema = z.string().regex(SEO_BUNDLE_ID_RE)
export const Sha256Schema = z.string().regex(SHA256_RE)
export const SignatureSchema = z.string().regex(SIGNATURE_RE)
export const SlugSchema = z.string().regex(SLUG_RE)

/** Host→render-mode policy. `raw` = FB.nyc, `sanitized` = FB.us. */
export const SeoModeSchema = z.enum(['raw', 'sanitized'])
/** A widget/content scope is a concrete site id OR the reserved `all`. */
export const ScopeSchema = z.string().min(1)

export const SeoEnvironmentSchema = z.enum(['prod', 'preview', 'staging', 'nonprod'])

// ── current.json — the atomic, signed pointer + kill-list ─────────────

export const DisabledContentSchema = z
  .object({
    content_kind: z.enum(['faq_set', 'post', 'related_set', 'head', 'widget']),
    content_id: z.string().min(1),
    reason: z.string().min(1),
    effective_at: z.string(),
  })
  .strict()

export const CurrentPointerSchema = z
  .object({
    schema: z.literal('freshlybaked.seo.current.v1'),
    environment: SeoEnvironmentSchema,
    seo_bundle_id: SeoBundleIdSchema,
    manifest_url: z.string().min(1),
    manifest_sha256: Sha256Schema,
    version: z.number().int().min(1),
    published_at: z.string(),
    previous_bundle_id: SeoBundleIdSchema.optional(),
    signature: SignatureSchema,
    disabled_content: z.array(DisabledContentSchema).optional(),
  })
  .strict()

// ── manifest.json — signed index: sites, host→mode, file checksums ────

export const FileRefSchema = z
  .object({
    // Path relative to the bundle dir; never absolute / never contains '..'.
    url: z.string().min(1),
    sha256: Sha256Schema,
  })
  .strict()

export const SeoSiteSchema = z
  .object({
    hosts: z.array(z.string().min(1)).min(1),
    mode: SeoModeSchema,
  })
  .strict()

export const ManifestSchema = z
  .object({
    schema: z.literal('freshlybaked.seo.bundle-manifest.v1'),
    seo_bundle_id: SeoBundleIdSchema,
    min_renderer_version: z.string().min(1),
    automation_git_sha: z.string().regex(/^[0-9a-f]{7,40}$/),
    generated_from: z
      .object({
        approval_snapshot_id: z.number().int().min(1).optional(),
        seo_policy_version_id: z.string().min(1),
      })
      .strict(),
    // siteId → host list + render mode. `all` is a RESERVED scope token,
    // never a physical site id (enforced in consistency.ts).
    sites: z.record(z.string(), SeoSiteSchema),
    files: z
      .object({
        widgets: FileRefSchema,
        content: FileRefSchema,
        policy: FileRefSchema,
        assets: FileRefSchema,
        sitemaps: FileRefSchema,
      })
      .strict(),
    signature: SignatureSchema,
  })
  .strict()

// ── widgets.json — placement + config of the five shared widgets ──────

export const SeoFaqFoldWidgetSchema = z
  .object({
    widget_id: z.string().min(1),
    type: z.literal('SEOFAQFold'),
    scope: ScopeSchema,
    enabled: z.boolean(),
    route_patterns: z.array(z.string().min(1)).min(1),
    slot_id: z.string().min(1).optional(),
    faq_set_id: z.string().min(1),
  })
  .strict()

export const WhatsNewFeedWidgetSchema = z
  .object({
    widget_id: z.string().min(1),
    type: z.literal('WhatsNewFeed'),
    scope: ScopeSchema,
    enabled: z.boolean(),
    route_patterns: z.array(z.string().min(1)).min(1),
    slot_id: z.string().min(1).optional(),
    max_items: z.number().int().min(1),
    tag_filter: z.array(z.string().min(1)).optional(),
  })
  .strict()

export const BlogPostWidgetSchema = z
  .object({
    widget_id: z.string().min(1),
    type: z.literal('BlogPost'),
    scope: ScopeSchema,
    enabled: z.boolean(),
    // Route is DERIVED from the post slug + scope (routeRegistry.ts) so
    // the URL can never drift from the content it renders.
    post_id: z.string().min(1),
  })
  .strict()

export const RelatedLinksWidgetSchema = z
  .object({
    widget_id: z.string().min(1),
    type: z.literal('RelatedLinks'),
    scope: ScopeSchema,
    enabled: z.boolean(),
    route_patterns: z.array(z.string().min(1)).min(1),
    slot_id: z.string().min(1).optional(),
    related_set_id: z.string().min(1),
  })
  .strict()

export const SeoHeadWidgetSchema = z
  .object({
    widget_id: z.string().min(1),
    type: z.literal('SEOHead'),
    scope: ScopeSchema,
    enabled: z.boolean(),
    route_patterns: z.array(z.string().min(1)).min(1),
    head_id: z.string().min(1),
  })
  .strict()

export const WidgetSchema = z.discriminatedUnion('type', [
  SeoFaqFoldWidgetSchema,
  WhatsNewFeedWidgetSchema,
  BlogPostWidgetSchema,
  RelatedLinksWidgetSchema,
  SeoHeadWidgetSchema,
])

export const WidgetsSchema = z
  .object({
    schema: z.literal('freshlybaked.seo.widgets.v1'),
    seo_bundle_id: SeoBundleIdSchema,
    widgets: z.array(WidgetSchema),
  })
  .strict()

// ── content.json — approved source-of-truth payloads ──────────────────
//
// Every textual item carries BOTH a raw and a sanitized variant so a
// sanitized host (FB.us) can never be left without compliant content and
// raw cannabis copy can never leak by omission. mss picks the variant by
// host mode; Helios never ships raw-only content.

export const FaqItemSchema = z
  .object({
    question: z.string().min(1),
    answer_raw: z.string().min(1),
    answer_sanitized: z.string().min(1),
  })
  .strict()

export const FaqSetSchema = z
  .object({
    faq_set_id: z.string().min(1),
    scope: ScopeSchema,
    approval_id: z.string().min(1),
    items: z.array(FaqItemSchema).min(1),
  })
  .strict()

export const BlogPostContentSchema = z
  .object({
    post_id: z.string().min(1),
    scope: ScopeSchema,
    slug: SlugSchema,
    title: z.string().min(1),
    meta_description: z.string().min(1),
    excerpt: z.string().min(1),
    canonical_url: z.string().min(1),
    published_at: z.string(),
    updated_at: z.string().optional(),
    author: z.string().min(1),
    reviewer: z.string().min(1),
    tags: z.array(z.string().min(1)),
    body_raw: z.string().min(1),
    body_sanitized: z.string().min(1),
    hero_image_sha256: Sha256Schema.optional(),
    og_image_sha256: Sha256Schema.optional(),
    approval_id: z.string().min(1),
    noindex: z.boolean().optional(),
  })
  .strict()

export const RelatedLinkSchema = z
  .object({
    target_url: z.string().min(1),
    anchor_text: z.string().min(1),
    reason: z.string().min(1),
    priority: z.number().int().min(0),
    mode: z.enum(['raw', 'sanitized', 'dual']),
  })
  .strict()

export const RelatedLinkSetSchema = z
  .object({
    related_set_id: z.string().min(1),
    scope: ScopeSchema,
    source_route_pattern: z.string().min(1),
    approval_id: z.string().min(1),
    links: z.array(RelatedLinkSchema).min(1),
  })
  .strict()

export const SeoHeadContentSchema = z
  .object({
    head_id: z.string().min(1),
    scope: ScopeSchema,
    title: z.string().min(1),
    meta_description: z.string().min(1),
    canonical_url: z.string().min(1),
    robots: z.string().min(1).optional(),
    og: z.record(z.string(), z.string()).optional(),
    twitter: z.record(z.string(), z.string()).optional(),
    schema_refs: z.array(z.string().min(1)).optional(),
    approval_id: z.string().min(1),
  })
  .strict()

export const ContentSchema = z
  .object({
    schema: z.literal('freshlybaked.seo.content.v1'),
    seo_bundle_id: SeoBundleIdSchema,
    faq_sets: z.array(FaqSetSchema),
    posts: z.array(BlogPostContentSchema),
    related_link_sets: z.array(RelatedLinkSetSchema),
    heads: z.array(SeoHeadContentSchema),
  })
  .strict()

// ── policy.json — stable, declarative selection policy ────────────────
//
// The placement unit is the widget itself (scope + route_patterns +
// enabled). Policy adds a versioned selection layer for route/site/mode
// holdouts + ordering; the FAQ MVP ships an empty rule set. Experiments
// happen by SEQUENTIAL bundle publishes / route holdouts, never by
// user/crawler-varying rendering (no cloaking).

export const PolicyRuleSchema = z
  .object({
    policy_rule_id: z.string().min(1),
    match: z
      .object({
        site: z.string().min(1).optional(),
        route_pattern: z.string().min(1).optional(),
        mode: SeoModeSchema.optional(),
      })
      .strict()
      .refine((m) => Object.keys(m).length > 0, { message: 'match must be non-empty' }),
    widget_ids: z.array(z.string().min(1)).min(1),
    priority: z.number().int().optional(),
  })
  .strict()

export const PolicySchema = z
  .object({
    schema: z.literal('freshlybaked.seo.policy.v1'),
    seo_policy_version_id: z.string().min(1),
    selection_algorithm_version: z.string().min(1),
    rules: z.array(PolicyRuleSchema),
  })
  .strict()

// ── assets.json — content-addressed images + approval status ──────────

export const SeoAssetSchema = z
  .object({
    sha256: Sha256Schema,
    role: z.enum(['hero', 'og', 'derivative']),
    media_type: z.string().min(1),
    width: z.number().int().min(1).optional(),
    height: z.number().int().min(1).optional(),
    alt_text: z.string().min(1),
    approval_status: z.enum(['approved', 'pending', 'rejected']),
    approval_id: z.string().min(1).optional(),
  })
  .strict()

export const AssetsSchema = z
  .object({
    schema: z.literal('freshlybaked.seo.assets.v1'),
    seo_bundle_id: SeoBundleIdSchema,
    assets: z.array(SeoAssetSchema),
  })
  .strict()

// ── sitemaps.json — sitemap/RSS manifest contents ─────────────────────

export const SitemapUrlSchema = z
  .object({
    loc: z.string().min(1),
    scope: ScopeSchema,
    lastmod: z.string().optional(),
    changefreq: z
      .enum(['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'])
      .optional(),
    priority: z.number().min(0).max(1).optional(),
    // When this URL is a blog post, link it back so the validator can
    // reject draft/noindex/rejected/disabled posts from the sitemap.
    post_id: z.string().min(1).optional(),
  })
  .strict()

export const SitemapsSchema = z
  .object({
    schema: z.literal('freshlybaked.seo.sitemaps.v1'),
    seo_bundle_id: SeoBundleIdSchema,
    urls: z.array(SitemapUrlSchema),
  })
  .strict()

// ── seo-events batch (POST /v1/lp-events/batch SEO extension) ─────────

export const SEO_EVENT_TYPES = [
  'seo_widget_impression',
  'seo_faq_expand',
  'seo_faq_cta_click',
  'seo_blog_view',
  'seo_blog_scroll',
  'seo_blog_cta_click',
  'seo_blog_card_impression',
  'seo_blog_card_click',
  'seo_internal_link_click',
  'seo_social_export_click',
] as const

export const SeoEventSchema = z
  .object({
    event_id: z.string().min(1),
    event_type: z.enum(SEO_EVENT_TYPES),
    event_ts: z.string(),
    replica_id: z.string().min(1),
    seo_bundle_id: z.string().min(1),
    seo_policy_id: z.string().min(1),
    site: z.string().min(1),
    route_key: z.string().min(1),
    mode: SeoModeSchema.optional(),
    widget_id: z.string().optional(),
    post_id: z.string().optional(),
    faq_set_id: z.string().optional(),
    // LP attribution when a widget is embedded on a /SITE/PURPOSE/SLUG/NUM page.
    lp_bundle_id: z.string().optional(),
    lp_policy_id: z.string().optional(),
  })
  .strict()

export const SeoEventsBatchSchema = z
  .object({
    schema: z.literal('freshlybaked.seo.events-batch.v1'),
    replica_id: z.string().min(1),
    sent_at: z.string(),
    events: z.array(SeoEventSchema).min(1),
  })
  .strict()

// ── inferred types ────────────────────────────────────────────────────

export type SeoMode = z.infer<typeof SeoModeSchema>
export type SeoEnvironment = z.infer<typeof SeoEnvironmentSchema>
export type DisabledContent = z.infer<typeof DisabledContentSchema>
export type CurrentPointer = z.infer<typeof CurrentPointerSchema>
export type SeoSite = z.infer<typeof SeoSiteSchema>
export type Manifest = z.infer<typeof ManifestSchema>
export type Widget = z.infer<typeof WidgetSchema>
export type Widgets = z.infer<typeof WidgetsSchema>
export type FaqSet = z.infer<typeof FaqSetSchema>
export type BlogPostContent = z.infer<typeof BlogPostContentSchema>
export type RelatedLinkSet = z.infer<typeof RelatedLinkSetSchema>
export type SeoHeadContent = z.infer<typeof SeoHeadContentSchema>
export type Content = z.infer<typeof ContentSchema>
export type PolicyRule = z.infer<typeof PolicyRuleSchema>
export type Policy = z.infer<typeof PolicySchema>
export type SeoAsset = z.infer<typeof SeoAssetSchema>
export type Assets = z.infer<typeof AssetsSchema>
export type SitemapUrl = z.infer<typeof SitemapUrlSchema>
export type Sitemaps = z.infer<typeof SitemapsSchema>
export type SeoEvent = z.infer<typeof SeoEventSchema>
export type SeoEventsBatch = z.infer<typeof SeoEventsBatchSchema>
