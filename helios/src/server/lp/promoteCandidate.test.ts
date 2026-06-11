import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { compileBundle, type CompileInput } from './compile.js'
import { publishBundle } from './publish.js'
import { publishApprovedContentCandidate } from './publishCandidate.js'
import { promoteCandidate, rollbackToBundle } from './promoteCandidate.js'
import { generateEd25519Pem } from './signing.js'

const { publicKeyPem, privateKeyPem } = generateEd25519Pem()
const other = generateEd25519Pem()

function content(bundleId?: string): CompileInput {
  return {
    ...(bundleId ? { bundleId } : {}),
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

function publishCandidate(root: string) {
  return publishApprovedContentCandidate({
    approvedContent: content(),
    privateKeyPem,
    publicKeyPem,
    artifactRoot: root,
    environment: 'prod',
    minRendererVersion: 'mss-lp-runtime>=0.4.0',
    automationGitSha: '6c9e1f2',
    generatedFrom: { policy_version_id: 'polv_1' },
    verifyRendererVersion: '0.4.0',
  })
}

function publishLive(root: string, bundleId?: string) {
  return publishBundle({
    compiled: compileBundle(content(bundleId)),
    privateKeyPem,
    artifactRoot: root,
    environment: 'prod',
    minRendererVersion: 'mss-lp-runtime>=0.4.0',
    automationGitSha: '6c9e1f2',
    generatedFrom: { policy_version_id: 'polv_1' },
  })
}

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lp-promote-test-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('P6 promoteCandidate', () => {
  it('promotes a fresh candidate to live v1 when no live pointer exists', () => {
    const cand = publishCandidate(root)
    expect(cand.ok).toBe(true)

    const res = promoteCandidate({
      artifactRoot: root,
      environment: 'prod',
      privateKeyPem,
      publicKeyPem,
      runningRendererVersion: '0.4.0',
    })
    expect(res.ok).toBe(true)
    expect(res.fromVersion).toBe(0)
    expect(res.toVersion).toBe(1)
    expect(res.bundleId).toBe(cand.bundleId)
    const live = JSON.parse(readFileSync(join(root, 'prod', 'current.json'), 'utf8'))
    expect(live.version).toBe(1)
    expect(live.bundle_id).toBe(cand.bundleId)
  })

  it('increments version and records previous_bundle_id', () => {
    const live1 = publishLive(root)
    const cand = publishCandidate(root) // built against live v1 → candidate v2
    expect(cand.version).toBe(2)

    const res = promoteCandidate({
      artifactRoot: root,
      environment: 'prod',
      privateKeyPem,
      publicKeyPem,
      runningRendererVersion: '0.4.0',
    })
    expect(res.ok).toBe(true)
    expect(res.toVersion).toBe(2)
    expect(res.previousBundleId).toBe(live1.bundleId)
    const live = JSON.parse(readFileSync(join(root, 'prod', 'current.json'), 'utf8'))
    expect(live.previous_bundle_id).toBe(live1.bundleId)
    expect(res.rollbackHint).toContain(live1.bundleId)
  })

  it('rejects a stale candidate (live advanced) unless --allow-version-rebase', () => {
    const cand = publishCandidate(root) // no live yet → candidate v1
    publishLive(root) // live becomes v1; candidate is now stale (1 != live+1=2)

    const stale = promoteCandidate({
      artifactRoot: root,
      environment: 'prod',
      privateKeyPem,
      publicKeyPem,
      runningRendererVersion: '0.4.0',
    })
    expect(stale.ok).toBe(false)
    expect(stale.errors.some((e) => e.includes('stale candidate'))).toBe(true)

    const forced = promoteCandidate({
      artifactRoot: root,
      environment: 'prod',
      privateKeyPem,
      publicKeyPem,
      runningRendererVersion: '0.4.0',
      allowVersionRebase: true,
    })
    expect(forced.ok).toBe(true)
    expect(forced.toVersion).toBe(2)
    expect(forced.bundleId).toBe(cand.bundleId)
  })

  it('fails closed (and leaves live untouched) when the candidate does not validate', () => {
    const live1 = publishLive(root)
    const liveBefore = readFileSync(join(root, 'prod', 'current.json'), 'utf8')
    publishCandidate(root)

    // Promote checking against the WRONG public key → candidate invalid.
    const res = promoteCandidate({
      artifactRoot: root,
      environment: 'prod',
      privateKeyPem,
      publicKeyPem: other.publicKeyPem,
      runningRendererVersion: '0.4.0',
    })
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('failed validation'))).toBe(true)
    // Live pointer unchanged.
    expect(readFileSync(join(root, 'prod', 'current.json'), 'utf8')).toBe(liveBefore)
    expect(live1.bundleId).toBeDefined()
  })

  it('fails when there is no candidate to promote', () => {
    const res = promoteCandidate({
      artifactRoot: root,
      environment: 'prod',
      privateKeyPem,
      publicKeyPem,
      runningRendererVersion: '0.4.0',
    })
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('no valid candidate'))).toBe(true)
  })
})

describe('P6 rollbackToBundle', () => {
  it('publishes a NEW higher version pointing at a previous good bundle', () => {
    const a = publishLive(root, 'lpb_2026-06-01_010101_aaaaaa') // v1
    const b = publishLive(root, 'lpb_2026-06-02_020202_bbbbbb') // v2 (live)

    const res = rollbackToBundle({
      artifactRoot: root,
      environment: 'prod',
      toBundleId: a.bundleId,
      privateKeyPem,
      publicKeyPem,
      runningRendererVersion: '0.4.0',
    })
    expect(res.ok).toBe(true)
    expect(res.toVersion).toBe(3) // forward publish, never a rewrite
    expect(res.bundleId).toBe(a.bundleId)
    expect(res.previousBundleId).toBe(b.bundleId)
    const live = JSON.parse(readFileSync(join(root, 'prod', 'current.json'), 'utf8'))
    expect(live.version).toBe(3)
    expect(live.bundle_id).toBe(a.bundleId)
  })

  it('fails closed on an unknown target bundle', () => {
    publishLive(root)
    const res = rollbackToBundle({
      artifactRoot: root,
      environment: 'prod',
      toBundleId: 'lpb_2026-06-09_090909_cccccc',
      privateKeyPem,
      publicKeyPem,
      runningRendererVersion: '0.4.0',
    })
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('no readable manifest'))).toBe(true)
  })
})
