// FB.nyc Reserved Prefix Registry slug for the blog + widget content
// routes — frozen in P0 (parent EPIC_PLAN §0.2, §6.3, operator decision
// 2026-06-11). The blog is HOSTED CONTENT, so it lives under the
// `/sites/<id>/` content zone, NOT at a flat top-level `/whats-new/<slug>`
// (operator rejected the flat path) and NOT forced onto the LP
// `/SITE/PURPOSE/SLUG/NUM` schema.
//
// Canonical blog post path:  /sites/<id>/whats-new/<slug>
//   <id>  = a concrete site id  OR  the reserved global token `all`
//           (`/sites/all/whats-new/<slug>`) for domain-boosting,
//           non-site-specific posts. `all` renders on every site under
//           that site's own host→mode; NO physical site may use `all` as
//           its id.

import { SLUG_RE } from './contracts.js'

export const SITES_PREFIX = '/sites'
export const WHATS_NEW_SEGMENT = 'whats-new'

/** Reserved global scope token. No physical site may use this as its id. */
export const RESERVED_GLOBAL_SITE_ID = 'all'

/** Is `id` the reserved global (`all`) scope token? */
export function isReservedGlobalSiteId(id: string): boolean {
  return id === RESERVED_GLOBAL_SITE_ID
}

/** A scope is valid if it is a concrete site id present in `siteIds` or `all`. */
export function isValidScope(scope: string, siteIds: ReadonlySet<string>): boolean {
  return isReservedGlobalSiteId(scope) || siteIds.has(scope)
}

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug)
}

/**
 * Build the canonical Reserved-Prefix-Registry path for a blog post.
 * Throws on an invalid slug so a bad URL can never be minted.
 */
export function blogPostPath(siteId: string, slug: string): string {
  if (!isValidSlug(slug)) {
    throw new Error(`invalid blog slug '${slug}' (expected lowercase kebab-case)`)
  }
  if (siteId.length === 0) {
    throw new Error('blogPostPath requires a non-empty site id')
  }
  return `${SITES_PREFIX}/${siteId}/${WHATS_NEW_SEGMENT}/${slug}`
}

/** The blog index path for a site/scope: /sites/<id>/whats-new */
export function blogIndexPath(siteId: string): string {
  if (siteId.length === 0) {
    throw new Error('blogIndexPath requires a non-empty site id')
  }
  return `${SITES_PREFIX}/${siteId}/${WHATS_NEW_SEGMENT}`
}
