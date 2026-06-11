// Cross-artifact consistency — the binding guardrails that keep Helios
// from ever publishing an SEO bundle mss can't safely render
// (parent EPIC_PLAN §4/§5/§6/§8). Pure, no I/O — used by BOTH the
// compiler (pre-publish) and the validator (post-read, fail-closed).
//
// Enforced invariants:
//   • scope validity — every scope is a concrete site id or `all`; no
//     physical site may be named `all`.
//   • dangling refs — every widget content ref resolves; every policy
//     widget_id resolves; widget scope matches its content scope.
//   • approved-assets-only — referenced hero/og images exist, match the
//     expected role, and are `approved` (rejected/pending never ship).
//   • raw+sanitized completeness — guaranteed structurally (both variants
//     are required, non-empty schema fields) so a sanitized host is never
//     left without compliant content and raw copy can't leak by omission.
//   • blog route integrity — slugs are valid kebab-case and
//     (scope, slug) is unique, so /sites/<id>/whats-new/<slug> is stable.
//   • sitemap hygiene — no draft/noindex/rejected/disabled post in the
//     sitemap; every post_id resolves.
//   • kill-list integrity — every disabled_content id resolves.

import type {
  Assets,
  Content,
  DisabledContent,
  Policy,
  SeoSite,
  Sitemaps,
  Widgets,
} from './contracts.js'
import { isReservedGlobalSiteId, isValidScope, isValidSlug } from './routeRegistry.js'

export interface ConsistencyInput {
  readonly sites: Record<string, SeoSite>
  readonly widgets: Widgets
  readonly content: Content
  readonly policy: Policy
  readonly assets: Assets
  readonly sitemaps: Sitemaps
  readonly disabledContent?: readonly DisabledContent[]
}

/** Returns a list of human-readable problems; empty = consistent. */
export function checkSeoConsistency(input: ConsistencyInput): string[] {
  const errors: string[] = []
  const { sites, widgets, content, policy, assets, sitemaps } = input
  const disabled = input.disabledContent ?? []

  const siteIds = new Set(Object.keys(sites))

  // 0. No physical site may claim the reserved global token `all`.
  for (const id of siteIds) {
    if (isReservedGlobalSiteId(id)) {
      errors.push(`site id '${id}' is the reserved global scope token and cannot be a physical site`)
    }
  }
  const scopeOk = (scope: string): boolean => isValidScope(scope, siteIds)

  // Index content for ref + scope resolution.
  const faqSetById = new Map(content.faq_sets.map((f) => [f.faq_set_id, f]))
  const postById = new Map(content.posts.map((p) => [p.post_id, p]))
  const relatedSetById = new Map(content.related_link_sets.map((r) => [r.related_set_id, r]))
  const headById = new Map(content.heads.map((h) => [h.head_id, h]))
  const widgetIds = new Set(widgets.widgets.map((w) => w.widget_id))

  // Approved assets by sha256 (referenced images must be approved).
  const assetBySha = new Map(assets.assets.map((a) => [a.sha256, a]))

  // 1. Content scope validity.
  for (const f of content.faq_sets) {
    if (!scopeOk(f.scope)) errors.push(`faq_set ${f.faq_set_id}: scope '${f.scope}' is not a site id or 'all'`)
  }
  for (const r of content.related_link_sets) {
    if (!scopeOk(r.scope)) errors.push(`related_set ${r.related_set_id}: scope '${r.scope}' is not a site id or 'all'`)
  }
  for (const h of content.heads) {
    if (!scopeOk(h.scope)) errors.push(`head ${h.head_id}: scope '${h.scope}' is not a site id or 'all'`)
  }

  // 2. Posts: scope, slug, route uniqueness, image refs.
  const seenRoute = new Set<string>()
  for (const p of content.posts) {
    if (!scopeOk(p.scope)) errors.push(`post ${p.post_id}: scope '${p.scope}' is not a site id or 'all'`)
    if (!isValidSlug(p.slug)) errors.push(`post ${p.post_id}: invalid slug '${p.slug}' (expected lowercase kebab-case)`)
    const routeKey = `${p.scope}/${p.slug}`
    if (seenRoute.has(routeKey)) {
      errors.push(`post ${p.post_id}: duplicate blog route /sites/${p.scope}/whats-new/${p.slug}`)
    }
    seenRoute.add(routeKey)
    errors.push(...checkImageRef(`post ${p.post_id}`, 'hero', p.hero_image_sha256, assetBySha))
    errors.push(...checkImageRef(`post ${p.post_id}`, 'og', p.og_image_sha256, assetBySha))
  }

  // 3. Widgets: scope validity, content refs, widget↔content scope match.
  for (const w of widgets.widgets) {
    if (!scopeOk(w.scope)) {
      errors.push(`widget ${w.widget_id} (${w.type}): scope '${w.scope}' is not a site id or 'all'`)
    }
    switch (w.type) {
      case 'SEOFAQFold': {
        const ref = faqSetById.get(w.faq_set_id)
        if (!ref) errors.push(`widget ${w.widget_id}: faq_set_id '${w.faq_set_id}' not in content.faq_sets`)
        else if (ref.scope !== w.scope) {
          errors.push(`widget ${w.widget_id}: scope '${w.scope}' != faq_set ${ref.faq_set_id} scope '${ref.scope}'`)
        }
        break
      }
      case 'WhatsNewFeed':
        // A feed lists posts dynamically by published_at; nothing to ref.
        break
      case 'BlogPost': {
        const ref = postById.get(w.post_id)
        if (!ref) errors.push(`widget ${w.widget_id}: post_id '${w.post_id}' not in content.posts`)
        else if (ref.scope !== w.scope) {
          errors.push(`widget ${w.widget_id}: scope '${w.scope}' != post ${ref.post_id} scope '${ref.scope}'`)
        }
        break
      }
      case 'RelatedLinks': {
        const ref = relatedSetById.get(w.related_set_id)
        if (!ref) errors.push(`widget ${w.widget_id}: related_set_id '${w.related_set_id}' not in content.related_link_sets`)
        else if (ref.scope !== w.scope) {
          errors.push(`widget ${w.widget_id}: scope '${w.scope}' != related_set ${ref.related_set_id} scope '${ref.scope}'`)
        }
        break
      }
      case 'SEOHead': {
        const ref = headById.get(w.head_id)
        if (!ref) errors.push(`widget ${w.widget_id}: head_id '${w.head_id}' not in content.heads`)
        else if (ref.scope !== w.scope) {
          errors.push(`widget ${w.widget_id}: scope '${w.scope}' != head ${ref.head_id} scope '${ref.scope}'`)
        }
        break
      }
    }
  }

  // 4. Policy: rule match site + widget refs.
  for (const rule of policy.rules) {
    if (rule.match.site !== undefined && !scopeOk(rule.match.site)) {
      errors.push(`policy rule ${rule.policy_rule_id}: match.site '${rule.match.site}' is not a site id or 'all'`)
    }
    for (const wid of rule.widget_ids) {
      if (!widgetIds.has(wid)) {
        errors.push(`policy rule ${rule.policy_rule_id}: widget_id '${wid}' not in widgets`)
      }
    }
  }

  // 5. Sitemap hygiene: scope valid; post refs resolve + are indexable.
  const disabledPostIds = new Set(
    disabled.filter((d) => d.content_kind === 'post').map((d) => d.content_id),
  )
  for (const u of sitemaps.urls) {
    if (!scopeOk(u.scope)) errors.push(`sitemap ${u.loc}: scope '${u.scope}' is not a site id or 'all'`)
    if (u.post_id !== undefined) {
      const p = postById.get(u.post_id)
      if (!p) {
        errors.push(`sitemap ${u.loc}: post_id '${u.post_id}' not in content.posts`)
      } else {
        if (p.noindex === true) errors.push(`sitemap ${u.loc}: post ${p.post_id} is noindex and must not be in the sitemap`)
        if (disabledPostIds.has(p.post_id)) {
          errors.push(`sitemap ${u.loc}: post ${p.post_id} is disabled (kill-list) and must not be in the sitemap`)
        }
      }
    }
  }

  // 6. Kill-list integrity: every disabled content id must resolve.
  for (const d of disabled) {
    const exists =
      (d.content_kind === 'faq_set' && faqSetById.has(d.content_id)) ||
      (d.content_kind === 'post' && postById.has(d.content_id)) ||
      (d.content_kind === 'related_set' && relatedSetById.has(d.content_id)) ||
      (d.content_kind === 'head' && headById.has(d.content_id)) ||
      (d.content_kind === 'widget' && widgetIds.has(d.content_id))
    if (!exists) {
      errors.push(`disabled_content ${d.content_kind} '${d.content_id}' does not exist in the bundle`)
    }
  }

  return errors
}

function checkImageRef(
  label: string,
  role: 'hero' | 'og',
  sha256: string | undefined,
  assetBySha: Map<string, { role: string; approval_status: string }>,
): string[] {
  if (sha256 === undefined) return []
  const asset = assetBySha.get(sha256)
  if (!asset) return [`${label}: ${role}_image_sha256 ${sha256} not in assets`]
  const errs: string[] = []
  if (asset.role !== role) errs.push(`${label}: ${role} image ${sha256} has role '${asset.role}', expected '${role}'`)
  if (asset.approval_status !== 'approved') {
    errs.push(`${label}: ${role} image ${sha256} is '${asset.approval_status}', not approved`)
  }
  return errs
}
