// Cross-artifact consistency: the binding guardrail that Helios must
// "never emit a NUM/variant mss can't serve" (parent EPIC_PLAN §6.1,
// child epic automation#42). Pure, no I/O — used by both the compiler
// (pre-publish) and the validator (post-read, fail-closed).

import type { Assets, Bundle, DisabledVariant, Policy } from './contracts.js'

/** Returns a list of human-readable problems; empty = consistent. */
export function checkBundleConsistency(
  bundle: Bundle,
  policy: Policy,
  assets: Assets,
  disabledVariants: readonly DisabledVariant[] = [],
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
