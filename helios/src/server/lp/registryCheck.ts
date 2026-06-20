// Cross-artifact consistency: the binding guardrail that Helios must
// "never emit a NUM/variant mss can't serve" (parent EPIC_PLAN §6.1,
// child epic automation#42). Pure, no I/O — used by both the compiler
// (pre-publish) and the validator (post-read, fail-closed).

import type { Assets, Bundle, DisabledVariant, Policy } from './contracts.js'

/**
 * The set of opaque branding refs mss can actually serve, keyed by site. It
 * is built from the published branding-opaque manifest (the SINGLE producer,
 * `../branding/`), which mss ingests — so by construction this IS the mss
 * branding registry. `checkBrandingRefParity` uses it as the P3 bundle-compile
 * parity guard: Helios must never sign a `branding` SLUG (kill-list slug or a
 * branding-family policy `cluster_slug`) that mss cannot decode, mirroring the
 * existing `MAX_VARIANT_BY_PURPOSE` / variant-id drift guards.
 */
export interface BrandingOpaqueRegistry {
  /** site_key (e.g. `bronx`) -> the opaque refs valid for that site. */
  readonly bySite: ReadonlyMap<string, ReadonlySet<string>>
}

export interface BundleConsistencyOptions {
  /**
   * The branding registry to validate emitted `branding` refs against. When a
   * branding ref IS emitted but this is absent, the check FAILS CLOSED (a
   * branding ref that cannot be parity-checked is a publish bug, not a skip).
   */
  readonly brandingRegistry?: BrandingOpaqueRegistry
}

/** The `branding` LP purpose; its SLUG must be an opaque ref (parent §0/§2). */
const BRANDING_PURPOSE = 'branding'

/**
 * An opaque branding ref is the 20-char base64url truncation of the shared
 * HMAC scheme (`../branding/opaqueRef.ts`). Anything else (most importantly a
 * leftover literal brand slug like `herb`) must be rejected before signing.
 */
const OPAQUE_BRANDING_REF_RE = /^[A-Za-z0-9_-]{20}$/

/** Returns a list of human-readable problems; empty = consistent. */
export function checkBundleConsistency(
  bundle: Bundle,
  policy: Policy,
  assets: Assets,
  disabledVariants: readonly DisabledVariant[] = [],
  options: BundleConsistencyOptions = {},
): string[] {
  const errors: string[] = []

  const variantById = new Map(assets.variants.map((v) => [v.variant_id, v]))
  const componentIds = new Set(Object.keys(bundle.components))
  const familyIds = new Set(Object.keys(bundle.families))

  // bundle.json and assets.json share a bundle_id; policy.json is keyed
  // by its own version id, so only bundle<->assets must match here.
  if (bundle.bundle_id !== assets.bundle_id) {
    errors.push(`assets.bundle_id (${assets.bundle_id}) != bundle.bundle_id (${bundle.bundle_id})`)
  }

  for (const rule of policy.rules) {
    const ruleFamily = rule.match.family
    if (ruleFamily !== undefined && !familyIds.has(ruleFamily)) {
      errors.push(`policy rule ${rule.policy_rule_id}: match.family '${ruleFamily}' not in bundle.families`)
    }

    for (const [slotId, slot] of Object.entries(rule.slots)) {
      if ('fixed' in slot) {
        if (!componentIds.has(slot.fixed)) {
          errors.push(
            `policy rule ${rule.policy_rule_id} slot ${slotId}: fixed component '${slot.fixed}' not in bundle.components`,
          )
        }
        continue
      }
      if ('data_source' in slot) continue // resolved by mss at request time

      // exploit / explore variant ids must exist, match the slot, and be approved.
      const referenced: string[] = [slot.exploit, ...(slot.explore ?? []).map((e) => e.variant_id)]
      for (const vid of referenced) {
        const v = variantById.get(vid)
        if (!v) {
          errors.push(`policy rule ${rule.policy_rule_id} slot ${slotId}: variant '${vid}' not in assets`)
          continue
        }
        if (v.slot !== slotId) {
          errors.push(
            `policy rule ${rule.policy_rule_id} slot ${slotId}: variant '${vid}' is declared for slot ${v.slot}`,
          )
        }
        if (v.approval_status !== 'approved') {
          errors.push(
            `policy rule ${rule.policy_rule_id} slot ${slotId}: variant '${vid}' is '${v.approval_status}', not approved`,
          )
        }
      }
    }
  }

  for (const dv of disabledVariants) {
    errors.push(...checkDisabledVariantBounds(bundle, dv))
  }

  errors.push(...checkBrandingRefParity(bundle, policy, disabledVariants, options.brandingRegistry))

  return errors
}

/**
 * P3 bundle-compile parity guard: every `branding` SLUG Helios emits in its
 * signed outputs must resolve to an opaque ref the mss branding registry can
 * serve. Branding SLUGs surface in two places (parent §0, automation#48 P3):
 *
 *   1. the kill-list `current.json.disabled_variants[].slug` (for
 *      `purpose === 'branding'`, or a `purpose === '*'` entry that expands to
 *      branding), and
 *   2. a `policy.rules[].match.cluster_slug` on a rule scoped to a
 *      branding-family (`bundle.families[match.family].purpose === 'branding'`).
 *
 * A `slug === '*'` kill-list is purpose-wide, not a specific ref, so it is
 * skipped. A well-formed-but-unknown ref, a malformed (literal) slug, or an
 * emitted ref with no registry to check against are all errors (fail-closed).
 */
export function checkBrandingRefParity(
  bundle: Bundle,
  policy: Policy,
  disabledVariants: readonly DisabledVariant[],
  registry: BrandingOpaqueRegistry | undefined,
): string[] {
  const errors: string[] = []

  // The bundle sites that actually carry the `branding` purpose. A
  // `site === '*'` / unscoped ref resolves if ANY of these serve it (a brand
  // need not be present in every site — mss only generates pages where it is).
  const brandingSites = Object.keys(bundle.sites).filter(
    (s) => bundle.sites[s]?.purpose_max_variant[BRANDING_PURPOSE] !== undefined,
  )

  const checkRef = (label: string, site: string | undefined, slug: string): void => {
    if (!OPAQUE_BRANDING_REF_RE.test(slug)) {
      errors.push(
        `${label}: branding slug '${slug}' is not a well-formed opaque ref ` +
          `(expected a 20-char base64url ref); a literal brand slug must be ` +
          `replaced with its opaque ref before signing`,
      )
      return
    }
    if (registry === undefined) {
      errors.push(
        `${label}: branding ref '${slug}' emitted but no branding-opaque ` +
          `registry was supplied for the parity check (fail-closed; publish the ` +
          `branding manifest and pass it to compile/validate)`,
      )
      return
    }
    const sites = site !== undefined && site !== '*' ? [site] : brandingSites
    const resolves = sites.some((s) => registry.bySite.get(s)?.has(slug) === true)
    if (!resolves) {
      const where =
        site !== undefined && site !== '*'
          ? `site '${site}'`
          : `any branding site (${brandingSites.join(', ') || 'none'})`
      errors.push(
        `${label}: branding ref '${slug}' does not resolve in the mss branding registry for ${where}`,
      )
    }
  }

  // 1. Kill-list entries that target the branding family.
  for (const dv of disabledVariants) {
    if (dv.slug === '*') continue
    let targetsBranding = dv.purpose === BRANDING_PURPOSE
    if (!targetsBranding && dv.purpose === '*') {
      const sites = dv.site === '*' ? Object.keys(bundle.sites) : [dv.site]
      targetsBranding = sites.some(
        (s) => bundle.sites[s]?.purpose_max_variant[BRANDING_PURPOSE] !== undefined,
      )
    }
    if (!targetsBranding) continue
    checkRef(`disabled_variant ${dv.site}/${dv.purpose}/${dv.slug}/${dv.num}`, dv.site, dv.slug)
  }

  // 2. Policy rules scoped to a branding family carrying a per-brand cluster_slug.
  for (const rule of policy.rules) {
    const family = rule.match.family
    if (family === undefined) continue
    if (bundle.families[family]?.purpose !== BRANDING_PURPOSE) continue
    const clusterSlug = rule.match.cluster_slug
    if (clusterSlug === undefined) continue
    checkRef(`policy rule ${rule.policy_rule_id} match.cluster_slug`, rule.match.site, clusterSlug)
  }

  return errors
}

/** A disabled-variant NUM must be within MAX_VARIANT_BY_PURPOSE bounds. */
export function checkDisabledVariantBounds(bundle: Bundle, dv: DisabledVariant): string[] {
  const errors: string[] = []
  const label = `disabled_variant ${dv.site}/${dv.purpose}/${dv.slug}/${dv.num}`

  const siteIds = dv.site === '*' ? Object.keys(bundle.sites) : [dv.site]
  for (const siteId of siteIds) {
    const site = bundle.sites[siteId]
    if (!site) {
      if (dv.site !== '*') errors.push(`${label}: site '${siteId}' not in bundle.sites`)
      continue
    }
    const purposes = dv.purpose === '*' ? Object.keys(site.purpose_max_variant) : [dv.purpose]
    for (const purpose of purposes) {
      const max = site.purpose_max_variant[purpose]
      if (max === undefined) {
        if (dv.purpose !== '*') {
          errors.push(`${label}: purpose '${purpose}' has no max in site '${siteId}'`)
        }
        continue
      }
      if (dv.num > max) {
        errors.push(`${label}: num ${dv.num} exceeds max ${max} for ${siteId}/${purpose}`)
      }
      if (dv.replacement_num !== undefined && dv.replacement_num > max) {
        errors.push(`${label}: replacement_num ${dv.replacement_num} exceeds max ${max} for ${siteId}/${purpose}`)
      }
    }
  }
  return errors
}
