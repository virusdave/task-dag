import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { compileBundle, CompileError, type CompileInput } from './compile.js'
import { publishBundle } from './publish.js'
import { generateEd25519Pem } from './signing.js'
import { validateBundle } from './validate.js'

const { publicKeyPem, privateKeyPem } = generateEd25519Pem()
const other = generateEd25519Pem()

function input(): CompileInput {
  return {
    sites: { midtown: { host: 'midtown.freshlybaked.us', purpose_max_variant: { deliverance: 4 } } },
    families: { 'weed-delivery-near-me': { purpose: 'deliverance', slots: ['X1', 'X2'] } },
    components: { trust_anchor_cash_debit_v1: { component_id: 'trust_anchor_cash_debit_v1', frozen: true } },
    variants: [
      { variant_id: 'hero_a', slot: 'X1', source: 'existing', approval_status: 'approved' },
      { variant_id: 'hero_b', slot: 'X1', source: 'generated', approval_status: 'approved' },
    ],
    policy: {
      policy_version_id: 'polv_1',
      selection_algorithm_version: 'hmac-bucket-weighted-v1',
      rules: [
        {
          policy_rule_id: 'r1',
          match: { family: 'weed-delivery-near-me' },
          assignment_key: ['site', 'family'],
          experiment_id: 'e1',
          experiment_salt: 's1',
          exploration_rate_bps: 500,
          slots: {
            X1: { exploit: 'hero_a', explore: [{ variant_id: 'hero_b', weight: 60 }] },
            X2: { fixed: 'trust_anchor_cash_debit_v1' },
          },
        },
      ],
    },
  }
}

function publishOpts(root: string, extra: Record<string, unknown> = {}) {
  return {
    compiled: compileBundle(input()),
    privateKeyPem,
    artifactRoot: root,
    environment: 'prod' as const,
    minRendererVersion: 'mss-lp-runtime>=0.4.0',
    automationGitSha: '6c9e1f2',
    generatedFrom: { policy_version_id: 'polv_1' },
    ...extra,
  }
}

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lp-test-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('compile', () => {
  it('rejects an inconsistent bundle (variant not in assets)', () => {
    const bad = input()
    bad.policy.rules[0].slots.X1 = { exploit: 'ghost' }
    expect(() => compileBundle(bad)).toThrow(CompileError)
  })
})

describe('publish + validate roundtrip', () => {
  it('publishes and validates successfully', () => {
    const res = publishBundle(publishOpts(root))
    expect(res.version).toBe(1)
    expect(res.dryRun).toBe(false)

    const v = validateBundle({ artifactRoot: root, environment: 'prod', publicKeyPem, runningRendererVersion: '0.4.0' })
    expect(v.errors).toEqual([])
    expect(v.ok).toBe(true)
    expect(v.bundleId).toBe(res.bundleId)
  })

  it('increments version monotonically and rejects a stale active version', () => {
    publishBundle(publishOpts(root))
    const second = publishBundle(publishOpts(root))
    expect(second.version).toBe(2)

    const stale = validateBundle({
      artifactRoot: root,
      environment: 'prod',
      publicKeyPem,
      runningRendererVersion: '0.4.0',
      activeVersion: 2,
    })
    expect(stale.ok).toBe(false)
    expect(stale.errors.some((e) => e.includes('stale'))).toBe(true)
  })

  it('dry-run writes a candidate pointer and does NOT create current.json', () => {
    const res = publishBundle(publishOpts(root, { dryRun: true }))
    expect(res.dryRun).toBe(true)
    expect(res.pointerPath.endsWith('current.candidate.json')).toBe(true)
    const v = validateBundle({ artifactRoot: root, pointerPath: res.pointerPath, publicKeyPem, runningRendererVersion: '0.4.0' })
    expect(v.ok).toBe(true)
    // No real pointer was created.
    expect(() => readFileSync(join(root, 'prod', 'current.json'), 'utf8')).toThrow()
  })

  it('fails closed when a content file is tampered (sha256 mismatch)', () => {
    const res = publishBundle(publishOpts(root))
    const policyPath = join(res.bundleDir, 'policy.json')
    const tampered = JSON.parse(readFileSync(policyPath, 'utf8'))
    tampered.selection_algorithm_version = 'evil'
    writeFileSync(policyPath, JSON.stringify(tampered))

    const v = validateBundle({ artifactRoot: root, environment: 'prod', publicKeyPem, runningRendererVersion: '0.4.0' })
    expect(v.ok).toBe(false)
    expect(v.errors.some((e) => e.includes('policy sha256 mismatch'))).toBe(true)
  })

  it('fails closed against the wrong public key', () => {
    publishBundle(publishOpts(root))
    const v = validateBundle({ artifactRoot: root, environment: 'prod', publicKeyPem: other.publicKeyPem, runningRendererVersion: '0.4.0' })
    expect(v.ok).toBe(false)
    expect(v.errors.some((e) => e.includes('signature invalid'))).toBe(true)
  })

  it('fails closed when the running renderer is too old', () => {
    publishBundle(publishOpts(root))
    const v = validateBundle({ artifactRoot: root, environment: 'prod', publicKeyPem, runningRendererVersion: '0.3.0' })
    expect(v.ok).toBe(false)
    expect(v.errors.some((e) => e.includes('does not satisfy'))).toBe(true)
  })

  it('fails closed on an unsafe manifest_url (path traversal)', () => {
    const res = publishBundle(publishOpts(root))
    const pointerPath = join(root, 'prod', 'current.json')
    const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'))
    pointer.manifest_url = '../../etc/passwd'
    writeFileSync(pointerPath, JSON.stringify(pointer))
    const v = validateBundle({ artifactRoot: root, environment: 'prod', publicKeyPem, runningRendererVersion: '0.4.0' })
    expect(v.ok).toBe(false)
    expect(v.errors.some((e) => e.includes('unsafe manifest_url'))).toBe(true)
    expect(res.bundleId).toBeDefined()
  })

  it('carries and validates a signed kill-list', () => {
    const res = publishBundle(
      publishOpts(root, {
        disabledVariants: [
          { site: 'midtown', purpose: 'deliverance', slug: '*', num: 3, replacement_num: 1, reason: 'roi_guardrail', effective_at: '2026-06-10T00:00:00Z' },
        ],
      }),
    )
    const v = validateBundle({ artifactRoot: root, pointerPath: res.pointerPath, publicKeyPem, runningRendererVersion: '0.4.0' })
    expect(v.ok).toBe(true)
  })
})
