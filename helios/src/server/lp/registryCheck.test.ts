import { describe, expect, it } from 'vitest'

import type { Assets, Bundle, DisabledVariant, Policy } from './contracts.js'
import {
  checkBrandingRefParity,
  checkBundleConsistency,
  checkDisabledVariantBounds,
  type BrandingOpaqueRegistry,
} from './registryCheck.js'

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

describe('checkBrandingRefParity', () => {
  // Golden opaque refs (20-char base64url) from the shared scheme's frozen
  // vectors (branding/opaqueRef.test.ts). Each maps to a sweed_brand_id.
  const REF_BRONX = 'h78SFgtcQNLHNzKo37r1' // brand 1234
  const REF_MIDTOWN = '43HM0632radpVvEdiYWj' // brand 1
  const REF_UNKNOWN = '7UJAMUE0KiXD3vZgHQiU' // valid form, not in the registry

  // A bundle that actually carries the `branding` purpose in both sites.
  function brandingBundle(): Bundle {
    return {
      schema: 'freshlybaked.lp.bundle.v1',
      bundle_id: BUNDLE_ID,
      sites: {
        bronx: { host: 'bronx.freshlybaked.us', purpose_max_variant: { branding: 5 } },
        midtown: { host: 'midtown.freshlybaked.us', purpose_max_variant: { branding: 5, deliverance: 4 } },
      },
      families: {
        'brand-x': { purpose: 'branding', slots: ['X1'] },
        'weed-delivery-near-me': { purpose: 'deliverance', slots: ['X1'] },
      },
      components: {},
    }
  }

  function emptyPolicy(): Policy {
    return {
      schema: 'freshlybaked.lp.policy.v1',
      policy_version_id: 'polv_1',
      selection_algorithm_version: 'v1',
      rules: [],
    }
  }

  const registry: BrandingOpaqueRegistry = {
    bySite: new Map([
      ['bronx', new Set([REF_BRONX])],
      ['midtown', new Set([REF_MIDTOWN])],
    ]),
  }

  const killList = (over: Partial<DisabledVariant>): DisabledVariant => ({
    site: 'bronx',
    purpose: 'branding',
    slug: REF_BRONX,
    num: 2,
    reason: 'roi_guardrail',
    effective_at: '2026-06-10T00:00:00Z',
    ...over,
  })

  it('accepts a known opaque ref for a concrete site', () => {
    expect(checkBrandingRefParity(brandingBundle(), emptyPolicy(), [killList({})], registry)).toEqual([])
  })

  it('rejects a well-formed-but-unknown opaque ref for a site', () => {
    const errs = checkBrandingRefParity(brandingBundle(), emptyPolicy(), [killList({ slug: REF_UNKNOWN })], registry)
    expect(errs.some((e) => e.includes('does not resolve in the mss branding registry'))).toBe(true)
  })

  it('rejects a literal (malformed) brand slug even without a registry', () => {
    const errs = checkBrandingRefParity(brandingBundle(), emptyPolicy(), [killList({ slug: 'herb' })], undefined)
    expect(errs.some((e) => e.includes('not a well-formed opaque ref'))).toBe(true)
  })

  it('fails closed when a well-formed branding ref is emitted with no registry', () => {
    const errs = checkBrandingRefParity(brandingBundle(), emptyPolicy(), [killList({})], undefined)
    expect(errs.some((e) => e.includes('no branding-opaque'))).toBe(true)
  })

  it('skips a purpose-wide (slug "*") kill-list', () => {
    expect(checkBrandingRefParity(brandingBundle(), emptyPolicy(), [killList({ slug: '*' })], registry)).toEqual([])
  })

  it('accepts a site="*" ref present in at least one branding site', () => {
    expect(
      checkBrandingRefParity(brandingBundle(), emptyPolicy(), [killList({ site: '*', slug: REF_MIDTOWN })], registry),
    ).toEqual([])
  })

  it('rejects a site="*" ref absent from every branding site', () => {
    const errs = checkBrandingRefParity(
      brandingBundle(),
      emptyPolicy(),
      [killList({ site: '*', slug: REF_UNKNOWN })],
      registry,
    )
    expect(errs.some((e) => e.includes('does not resolve'))).toBe(true)
  })

  it('rejects a concrete ref aimed at the wrong site', () => {
    // REF_MIDTOWN is valid in midtown but not bronx.
    const errs = checkBrandingRefParity(brandingBundle(), emptyPolicy(), [killList({ site: 'bronx', slug: REF_MIDTOWN })], registry)
    expect(errs.some((e) => e.includes("site 'bronx'"))).toBe(true)
  })

  it('treats a purpose="*" concrete-slug entry as branding-targeting when branding exists', () => {
    const errs = checkBrandingRefParity(
      brandingBundle(),
      emptyPolicy(),
      [killList({ purpose: '*', slug: REF_UNKNOWN })],
      registry,
    )
    expect(errs.some((e) => e.includes('does not resolve'))).toBe(true)
  })

  it('ignores a purpose="*" entry when the bundle has no branding purpose', () => {
    const noBranding: Bundle = {
      ...brandingBundle(),
      sites: { midtown: { host: 'm', purpose_max_variant: { deliverance: 4 } } },
    }
    expect(
      checkBrandingRefParity(noBranding, emptyPolicy(), [killList({ site: 'midtown', purpose: '*', slug: 'midtown' })], registry),
    ).toEqual([])
  })

  it('ignores non-branding kill-list entries', () => {
    const dvCompare = killList({ purpose: 'compare', slug: 'some-literal-competitor' })
    expect(checkBrandingRefParity(brandingBundle(), emptyPolicy(), [dvCompare], registry)).toEqual([])
  })

  it('validates a branding-family policy cluster_slug', () => {
    const p = emptyPolicy()
    p.rules.push({
      policy_rule_id: 'rb',
      match: { site: 'bronx', family: 'brand-x', cluster_slug: REF_BRONX },
      assignment_key: ['site'],
      experiment_id: 'e',
      experiment_salt: 's',
      exploration_rate_bps: 0,
      slots: {},
    })
    expect(checkBrandingRefParity(brandingBundle(), p, [], registry)).toEqual([])

    p.rules[0].match = { site: 'bronx', family: 'brand-x', cluster_slug: 'literal-brand' }
    const errs = checkBrandingRefParity(brandingBundle(), p, [], registry)
    expect(errs.some((e) => e.includes('match.cluster_slug'))).toBe(true)
  })

  it('leaves a non-branding-family policy cluster_slug untouched', () => {
    const p = emptyPolicy()
    p.rules.push({
      policy_rule_id: 'rd',
      match: { family: 'weed-delivery-near-me', cluster_slug: 'delivery-near-me' },
      assignment_key: ['site'],
      experiment_id: 'e',
      experiment_salt: 's',
      exploration_rate_bps: 0,
      slots: {},
    })
    expect(checkBrandingRefParity(brandingBundle(), p, [], registry)).toEqual([])
  })

  it('runs as part of checkBundleConsistency (wired)', () => {
    const errs = checkBundleConsistency(
      brandingBundle(),
      emptyPolicy(),
      { schema: 'freshlybaked.lp.assets.v1', bundle_id: BUNDLE_ID, variants: [{ variant_id: 'v', slot: 'X1', source: 'existing', approval_status: 'approved' }] },
      [killList({ slug: 'herb' })],
      { brandingRegistry: registry },
    )
    expect(errs.some((e) => e.includes('not a well-formed opaque ref'))).toBe(true)
  })
})
