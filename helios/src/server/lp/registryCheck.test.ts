import { describe, expect, it } from 'vitest'

import type { Assets, Bundle, DisabledVariant, Policy } from './contracts.js'
import { checkBundleConsistency, checkDisabledVariantBounds } from './registryCheck.js'

const BUNDLE_ID = 'lpb_2026-06-10_140312_7f3a91'

function bundle(): Bundle {
  return {
    schema: 'freshlybaked.lp.bundle.v1',
    bundle_id: BUNDLE_ID,
    sites: {
      midtown: { host: 'midtown.freshlybaked.us', purpose_max_variant: { compare: 5, deliverance: 4 } },
    },
    families: { 'weed-delivery-near-me': { purpose: 'deliverance', slots: ['X1', 'X2'] } },
    components: { trust_anchor_cash_debit_v1: { component_id: 'trust_anchor_cash_debit_v1', frozen: true } },
  }
}

function assets(approval: 'approved' | 'pending' = 'approved'): Assets {
  return {
    schema: 'freshlybaked.lp.assets.v1',
    bundle_id: BUNDLE_ID,
    variants: [
      { variant_id: 'hero_a', slot: 'X1', source: 'existing', approval_status: 'approved' },
      { variant_id: 'hero_b', slot: 'X1', source: 'generated', approval_status: approval },
    ],
  }
}

function policy(): Policy {
  return {
    schema: 'freshlybaked.lp.policy.v1',
    policy_version_id: 'polv_1',
    selection_algorithm_version: 'v1',
    rules: [
      {
        policy_rule_id: 'r1',
        match: { family: 'weed-delivery-near-me' },
        assignment_key: ['site'],
        experiment_id: 'e1',
        experiment_salt: 's1',
        exploration_rate_bps: 500,
        slots: {
          X1: { exploit: 'hero_a', explore: [{ variant_id: 'hero_b', weight: 60 }] },
          X2: { fixed: 'trust_anchor_cash_debit_v1' },
        },
      },
    ],
  }
}

describe('checkBundleConsistency', () => {
  it('passes for a consistent bundle/policy/assets', () => {
    expect(checkBundleConsistency(bundle(), policy(), assets())).toEqual([])
  })

  it('flags a policy variant missing from assets', () => {
    const p = policy()
    p.rules[0].slots.X1 = { exploit: 'ghost' }
    const errs = checkBundleConsistency(bundle(), p, assets())
    expect(errs.some((e) => e.includes("variant 'ghost' not in assets"))).toBe(true)
  })

  it('flags an unapproved referenced variant', () => {
    const errs = checkBundleConsistency(bundle(), policy(), assets('pending'))
    expect(errs.some((e) => e.includes("'hero_b' is 'pending', not approved"))).toBe(true)
  })

  it('flags a fixed component missing from bundle.components', () => {
    const p = policy()
    p.rules[0].slots.X2 = { fixed: 'nonexistent_component' }
    const errs = checkBundleConsistency(bundle(), p, assets())
    expect(errs.some((e) => e.includes('not in bundle.components'))).toBe(true)
  })

  it('flags a variant declared for the wrong slot', () => {
    const a = assets()
    a.variants[1] = { variant_id: 'hero_b', slot: 'X2', source: 'generated', approval_status: 'approved' }
    const errs = checkBundleConsistency(bundle(), policy(), a)
    expect(errs.some((e) => e.includes('declared for slot X2'))).toBe(true)
  })

  it('flags a match.family not in the bundle', () => {
    const p = policy()
    p.rules[0].match = { family: 'unknown-family' }
    const errs = checkBundleConsistency(bundle(), p, assets())
    expect(errs.some((e) => e.includes("match.family 'unknown-family'"))).toBe(true)
  })
})

describe('checkDisabledVariantBounds', () => {
  const dv = (over: Partial<DisabledVariant>): DisabledVariant => ({
    site: 'midtown',
    purpose: 'compare',
    slug: '*',
    num: 3,
    reason: 'roi_guardrail',
    effective_at: '2026-06-10T00:00:00Z',
    ...over,
  })

  it('accepts an in-bounds NUM', () => {
    expect(checkDisabledVariantBounds(bundle(), dv({ num: 5 }))).toEqual([])
  })

  it('rejects a NUM above MAX_VARIANT_BY_PURPOSE', () => {
    const errs = checkDisabledVariantBounds(bundle(), dv({ num: 6 }))
    expect(errs.some((e) => e.includes('exceeds max 5'))).toBe(true)
  })

  it('rejects a replacement_num above max', () => {
    const errs = checkDisabledVariantBounds(bundle(), dv({ num: 1, replacement_num: 9 }))
    expect(errs.some((e) => e.includes('replacement_num 9 exceeds max 5'))).toBe(true)
  })

  it('rejects an unknown site', () => {
    const errs = checkDisabledVariantBounds(bundle(), dv({ site: 'nope' }))
    expect(errs.some((e) => e.includes("site 'nope' not in bundle.sites"))).toBe(true)
  })

  it('handles wildcard site/purpose', () => {
    expect(checkDisabledVariantBounds(bundle(), dv({ site: '*', purpose: '*', num: 4 }))).toEqual([])
    const errs = checkDisabledVariantBounds(bundle(), dv({ site: '*', purpose: '*', num: 5 }))
    // num 5 exceeds deliverance max (4) but not compare max (5)
    expect(errs.some((e) => e.includes('exceeds max 4'))).toBe(true)
  })
})
